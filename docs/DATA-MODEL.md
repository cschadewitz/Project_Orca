# Data model

All types are zod schemas in `packages/core/src/model/` and exported from `@orca/core`, and
from `@orca/core/schemas` for code that has to run in a browser (see `packages/core/src/schemas.ts`).
Identifiers are prefixed ULIDs (`req_…`, `wi_…`, `run_…`, `step_…`, `art_…`, `evt_…`, `sess_…`,
`plan_…`, `dep_…`, `risk_…`, `dec_…`, `pev_…`, `hi_…` for human‑input requests).

```
Plan 1──* Request 1──* WorkItem 1──? Run 1──* StepRun 1──* Artifact
 │                      │  ▲          │          │
 │                      │  │          │          └──* child Run (loop / parallel / subworkflow / dispatch)
 │                      │  │          └──* OrcaEvent (the source of truth for runs)
 ├──* Dependency ───────┘──┘ (from item → item@stage | decision | external)
 ├──* Risk (affects / mitigatedBy items)
 ├──* Decision (matrix; blocks items)
 └──* PlanEvent (journal: the audit trail for the plan)
```

## Request (`model/request.ts`)

The large ask. `source` records where it came from (`manual`, `issue`, `kepler-task`,
`t3code-thread`, `acp-session`, `api`). `programRunId` links to the program run.

## WorkItem

One deliverable slice. `slug` is stable and human‑readable (used in artifact paths and
branch names; unique per plan). `dependsOn` holds the dependency *references* as written
(see below); once registered, `Dependency` records are authoritative. `parentId` builds an
epic → feature → task tree. `status` moves `pending → in-progress → done | failed | cancelled | blocked` (the schema
also declares `ready`, which nothing writes today).
`runId` links to the SDLC run that delivered it. Both are *projected* from the dispatching
run's event log rather than written by the dispatcher (`blocked` excepted - see
`docs/PLANNING.md`). Planning fields: `planId`, `priority`
(`critical | high | normal | low`), `produced` (artifact kind → newest artifact id, what
stage‑level dependencies test) and `deferredReason`. The `decomposition` artifact's front
matter (`DecompositionSchema`: `items[]`, `risks[]`, `decisions[]`, `rationale`) is the
agent‑facing shape that `custom:plan-register` turns into plan records.

## Plan, Dependency, Risk, Decision (`model/plan.ts`)

| entity | fields worth knowing |
| --- | --- |
| `Plan` | `key`, `requestIds`, `policy` (`strategy`, `concurrency`, `riskAppetite`, `holdAboveAppetite`, `mitigateFirst`, `orderSoftDependencies`, `weights`), `riskMatrix` (`scale`, `thresholds`) |
| `Dependency` | `from` (item id), `target` (`{kind: work-item, workItemId, stage?}` \| `{kind: decision, decisionId}` \| `{kind: external, key}`), `type` (`blocks` \| `soft` \| `informs`), `requiredBy` (phase, default `start`), `status` (`open` \| `satisfied` \| `failed` \| `waived`), `origin`, `resolution` |
| `Risk` | `key`, `category`, `likelihood`, `impact`, `status` (`open → mitigating → mitigated | accepted | realized → closed`), `mitigation`, `contingency`, `triggers`, `affects[]`, `mitigatedBy[]` |
| `Decision` | `key`, `question`, `criteria[]` (`weight`, `direction`), `options[]` (`scores{}`), `scale`, `result` (ranking, margin, confidence, pivotal criteria), `chosen`, `decidedBy` (`matrix` \| `agent` \| `human`); the items it gates are derived from `Dependency` records (`decisionBlocks`) |

Dependency references (`DependencyRef`, string or `{ on, type, stage, requiredBy, rationale }`):
`other`, `other@spec`, `other#build`, `soft:other`, `informs:other@spec`, `decision:key`,
`external:key`. `parseDependencyRef()` normalises them; `on` takes the same grammar as the
string form, and an object field that contradicts a prefix or suffix in `on` is an error.
Only `parseDependencyRef()` checks the grammar (the schema checks shape), so every intake
path runs it and reports failures. Agent‑facing input shapes are
`RiskInputSchema`, `DecisionInputSchema`, `RiskRegisterSchema` (front matter of a
`risk-register`) and `DecisionMatrixArtifactSchema` (front matter of a `decision-matrix`).

A plan key (`PlanKeySchema`) is kebab‑case, at most 48 characters (`SLUG_MAX_LENGTH`, kept
beside the schema so `slugify` cannot drift from it) and never starts or ends with `-` —
the same shape whether ORCA generated it or an agent wrote it in front matter (#117).

## Plan journal (`model/plan-events.ts`)

`{ id, seq, planId, at, type, origin, payload }` with `origin.kind` ∈ `decomposition | artifact |
agent | human | api | system` (+ `runId`, `artifactId`, `actor`). Types: `plan.created/updated`,
`request.linked`, `work-item.added/updated`, `dependency.added/resolved/bound`,
`risk.raised/updated`, `signals.rejected`, `decision.opened/updated/resolved`, `schedule.computed`,
`dispatch.started/finished/deferred`. Stored as `plans/<planId>.jsonl`, sequenced on disk the
same way as a run's event log: an append holds `plans/<planId>.jsonl.lock` while it numbers
and writes the record, so two processes over one store extend one journal.

## Artifact (`model/artifact.ts`)

| field | meaning |
| --- | --- |
| `kind` | kebab‑case category: `intent`, `spec`, `plan`, `implementation`, `test-report`, `review`, `deploy-report`, `decomposition`, `decision`, `risk-register`, `decision-matrix`, `schedule`, `request`, `metrics-report`, `generic`, or any plugin‑registered kind |
| `name` | logical name within a run (`testReport`, `review`); defaults to kind |
| `version` | increments each time a step produces an artifact with the same name (re‑runs, loops) |
| `path` | where it was materialised on the host (absolute) |
| `mediaType` | taken from the deliverable's `mediaType`, default `text/markdown` |
| `contentHash` / `size` | content‑addressed blob in the ArtifactStore: sha‑256 over the body's **bytes**, and its length in bytes |
| `data` | structured part: YAML front matter (or the JSON body for `.json`) |
| `producedBy` | run, step, node, agent session, agent id, host id |
| `parents` | ids of the input artifacts the producing step saw |

A body is bytes in the store (#226): `ArtifactStore.put` takes a `string` or a `Uint8Array`,
`content(id)` decodes UTF‑8 for the text callers that are all of ORCA today, and `bytes(id)`
returns the blob untouched, so a PNG or a PDF round‑trips. `mediaType` is what says which of
the two views is meaningful — the index records nothing else about it.

`ArtifactSpec` (on a node's `produces:`) says what to expect: kind, name, `path` template,
`required`, and `validate` (`requiredFields`, `fieldValues`, `minBodyLength`).
`ArtifactRef` (on `inputs:`) says how to find one: by `kind`, `name` or `fromNode`, with
an `as` alias for the template context.

## Workflow (`model/workflow.ts`)

`WorkflowDefinition = { id, name, version, vars, inputs } + WorkflowGraph`,
`WorkflowGraph = { start, nodes: Record<id, NodeDef>, edges: Edge[] }`,
`Edge = { from, to, when?, label? }`.

Node types: `start`, `end`, `agent`, `decision`, `gate`, `set`, `loop`, `parallel`,
`subworkflow`, `custom:<name>`. Container nodes hold `SubworkflowRef = { workflow } | { graph }`.
Decision sources: `expression`, `artifact`, `agent`, `human`, `matrix`. Shipped custom nodes:
`custom:plan-register`, `custom:decision-matrix`, `custom:plan-schedule`, `custom:plan-dispatch`,
`custom:plan-await` (and the request‑scoped `custom:materialize-work-items`, whose
items a plain `parallel` `forEach` fans out over). See `docs/WORKFLOWS.md` for the
authoring guide.

## Run / StepRun / RunState (`model/run.ts`)

`Run` carries workflow id+version, status (`created → running ⇄ waiting → completed | failed | cancelled`,
plus `paused` while parked at a human gate awaiting `orca answer`),
outcome, `workspace` (host id + cwd + repo/branch, plus `previousBranch` when the `local`
provider switched a shared checkout to the work item's `orca/<slug>` branch), `vars`,
parent links, and `overrides` — the run's selection record (`RunOverrides`: `roles`,
`model`, `itemWorkflow`, `templatePack`), present only on runs started with one.
`StepRun` is one execution attempt of one node: attempt number, iteration, agent session id,
input artifact ids (accumulated from `step.inputs` as the executor resolves them), `result` (`choice`, `outcome`, `message`, `artifactIds`, `data`), error, child run ids.
`children` lists the same child runs with their `branch` key (loop index, branch name, work‑item
slug), last known status/outcome, and `resumed: true` when a re‑attempted step re‑attached to a
child spawned by the interrupted attempt instead of spawning a new one. `skippedBranches`
lists the branches the step decided not to run (`reason`: `dependency`, `claimed`, …);
the WorkItem projection reads it alongside `children`.
`RunState` is the projection: run, steps (+ order), artifacts, human‑input requests, last seq.

## Events (`events/events.ts`)

Every event is `{ id, seq, runId, at, type, payload }`. Types:

- run: `created started paused resumed completed failed cancelled`, `vars.set`
- step: `scheduled started inputs waiting completed failed cancelled skipped`
- agent: `session.opened turn.started update permission turn.completed session.closed`
- `artifact.recorded`, `artifact.rejected`, `plan.signals.rejected`
- `decision.resolved`, `loop.iteration`, `child.spawned`, `child.finished`, `branch.skipped`
- `human.requested`, `human.answered`

`agent.update` stores a compact `AgentUpdateSummary` (kind, text, tool call id/title/kind/status,
locations, args, result, plan entries) rather than the raw ACP payload; text chunks are coalesced.
A tool call's `args` and `result` are each capped at `TOOL_BODY_MAX_CHARS` (2,000) when the event
is written, and stored as `{ text, length }` where `length` is what the body measured before the
cap — so a tool call that reads a large file leaves the size in the log, not the file.

`human.requested.options` is a list of `{ id, label, consequence?, destructive? }`. `human.answered`
carries the chosen option's `id`, never its label, so rewording a label cannot orphan an answer
already in a log. A log written before v0.4.0 holds bare strings here; each reads as
`{ id: s, label: s }` (`toGateOption`), which needs no migration. `human.requested` also
carries `agent?` (`{ id, hostId }`) — whose turn the ask is holding open, recorded at the
moment of asking so the `input.opened` push stays a pure function of one event — and
`human.answered` carries `note?`, the free text a person wrote beside the answer. Both are
absent on older logs and on the cases that have nothing to say (a workflow gate has no agent,
an answer given without a note has no note), and a reader must not turn that into an empty
string on screen.

`run.created` carries `workspace` and `vars` and, since v0.6.0, two optional additions: the
`overrides` record described above, which a replay uses to resolve the same agents the live
run did, and `workspace.previousBranch`. Both are absent on older logs and read as "none".

## Expression / template context

Built by `RunContext.evalContext()` (`packages/engine/src/run-context.ts`):

| key | contents |
| --- | --- |
| `vars` | run vars (workflow defaults ⊕ run inputs ⊕ `set` nodes ⊕ loop scope) |
| `artifacts` | visible artifacts by **name**, each with `content` and `data` |
| `artifactsByKind` | newest visible artifact per **kind** |
| `inputs` | (agent steps) the node's resolved `inputs:` keyed by `as` alias |
| `steps` | latest StepRun per node id in this run |
| `step` | the StepRun being executed (and, while routing, `result` = its result) |
| `choice` | most recent decision choice in this run |
| `iteration`, `item`, `index` | loop scope (also present in `vars`) |
| `request`, `workItem`, `workspace`, `run`, `now` | context records |
| `riskMatrix` | (step context) current plan's `scale` and `thresholds`, or configured planning defaults before registration |
| `deliverables` | (agent steps) the planned outputs with absolute paths |
| `vars.schedule` | (after `custom:plan-schedule`) compact schedule: `ready[]`, `waiting[]`, `held[]`, `unschedulable[]`, `waves`, `criticalPath` + `criticalPathLength` (remaining work only), `risk`, `openDecisions` (each with the items its still-waiting `blocks` dependencies hold back) |
| `vars.upstream` | (item runs in a plan) upstream items this item depends on, with their artifacts (`slug`, `title`, `status`, `type`, `stage`, `requiredBy`, `artifacts{kind: {id, path, data}}`) |
| `vars.openDecisions`, `vars.decision` | (program) decisions to make; the current one inside the `decide` loop |
| `vars.planId`, `vars.plan`, `vars.workItems`, `vars.workItemIds`, `vars.registration` | (after `custom:plan-register`) the plan and the items this request registered |
| `vars.dispatched`, `vars.dispatchOutcome` | (after `custom:plan-dispatch`) per‑item summary (`status`, `runId`, `reason`) and `complete` \| `partial` \| `failed` |

Visibility of artifacts is own run + all ancestors + all descendants + each
ancestor's *earlier siblings* (children of the same container step that were
spawned before it and had already finished when it was created), newest
`version` per name — so a sub‑workflow sees its caller's spec, a caller sees what
its loop body produced, and loop iteration N sees what iteration N‑1 produced.
Concurrent `parallel` branches do not precede one another, so they stay isolated.

## Config (`config.ts`)

`orca.config.yaml`: `storeDir`, `hosts[]` (`local` | `ssh`), `agents[]` (command, args, env,
hostId, roles, permissions, mcpServers, sessionMode, turnTimeoutMs, cancelGraceMs, and the
declared `models[]` — `{ id, name, description? }` — with `defaultModel`, which a run's
`overrides.model` is checked against), `roles{}`,
`workflows[]`/`templates[]` globs, `program{workflow,itemWorkflow}`,
`planning{plan, planName, policy, riskMatrix}`, `workspace`
(`local` | `git-worktree` | `kepler`), `humanInput` (`pause` | `cli` | `auto`), `plugins[]`.
