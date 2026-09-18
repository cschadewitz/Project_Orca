# Data model

All types are zod schemas in `packages/core/src/model/` and exported from `@orca/core`.
Identifiers are prefixed ULIDs (`req_…`, `wi_…`, `run_…`, `step_…`, `art_…`, `evt_…`, `sess_…`,
`plan_…`, `dep_…`, `risk_…`, `dec_…`, `pev_…`).

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
epic → feature → task tree. `status` moves `pending → in-progress → done | failed | blocked`.
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
| `Plan` | `key`, `requestIds`, `policy` (`strategy`, `concurrency`, `riskAppetite`, `holdAboveAppetite`, `mitigateFirst`, `weights`), `riskMatrix` (`scale`, `thresholds`) |
| `Dependency` | `from` (item id), `target` (`{kind: work-item, workItemId, stage?}` \| `{kind: decision, decisionId}` \| `{kind: external, key}`), `type` (`blocks` \| `soft` \| `informs`), `requiredBy` (phase, default `start`), `status` (`open` \| `satisfied` \| `failed` \| `waived`), `origin`, `resolution` |
| `Risk` | `key`, `category`, `likelihood`, `impact`, `status` (`open → mitigating → mitigated | accepted | realized → closed`), `mitigation`, `contingency`, `triggers`, `affects[]`, `mitigatedBy[]` |
| `Decision` | `key`, `question`, `criteria[]` (`weight`, `direction`), `options[]` (`scores{}`), `scale`, `result` (ranking, margin, confidence, pivotal criteria), `chosen`, `decidedBy` (`matrix` \| `agent` \| `human`), `blocks[]` |

Dependency references (`DependencyRef`, string or `{ on, type, stage, requiredBy }`):
`other`, `other@spec`, `other#build`, `soft:other`, `informs:other@spec`, `decision:key`,
`external:key`. `parseDependencyRef()` normalises them. Agent‑facing input shapes are
`RiskInputSchema`, `DecisionInputSchema`, `RiskRegisterSchema` (front matter of a
`risk-register`) and `DecisionMatrixArtifactSchema` (front matter of a `decision-matrix`).

## Plan journal (`model/plan-events.ts`)

`{ id, seq, planId, at, type, origin, payload }` with `origin.kind` ∈ `decomposition | artifact |
agent | human | api | system` (+ `runId`, `artifactId`, `actor`). Types: `plan.created/updated`,
`request.linked`, `work-item.added/updated`, `dependency.added/resolved/bound`,
`risk.raised/updated`, `signals.rejected`, `decision.opened/updated/resolved`, `schedule.computed`,
`dispatch.started/finished/deferred`. Stored as `plans/<planId>.jsonl`.

## Artifact (`model/artifact.ts`)

| field | meaning |
| --- | --- |
| `kind` | kebab‑case category: `intent`, `spec`, `plan`, `implementation`, `test-report`, `review`, `deploy-report`, `decomposition`, `decision`, `risk-register`, `decision-matrix`, `schedule`, `generic`, or any plugin‑registered kind |
| `name` | logical name within a run (`testReport`, `review`); defaults to kind |
| `version` | increments each time a step produces an artifact with the same name (re‑runs, loops) |
| `path` | where it was materialised on the host (absolute) |
| `contentHash` / `size` | content‑addressed blob in the ArtifactStore |
| `data` | structured part: YAML front matter (or the JSON body for `.json`) |
| `producedBy` | run, step, node, agent session, agent id, host id |
| `parents` | ids of the input artifacts the producing step saw |

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
outcome, `workspace` (host id + cwd + repo/branch), `vars`, and parent links.
`StepRun` is one execution attempt of one node: attempt number, iteration, agent session id,
input artifact ids (accumulated from `step.inputs` as the executor resolves them), `result` (`choice`, `outcome`, `message`, `artifactIds`, `data`), error, child run ids.
`children` lists the same child runs with their `branch` key (loop index, branch name, work‑item
slug), last known status/outcome, and `resumed: true` when a re‑attempted step re‑attached to a
child spawned by the interrupted attempt instead of spawning a new one.
`RunState` is the projection: run, steps (+ order), artifacts, human‑input requests, last seq.

## Events (`events/events.ts`)

Every event is `{ id, seq, runId, at, type, payload }`. Types:

- run: `created started paused resumed completed failed cancelled`, `vars.set`
- step: `scheduled started inputs waiting completed failed cancelled skipped`
- agent: `session.opened turn.started update permission turn.completed session.closed`
- `artifact.recorded`, `artifact.rejected`, `plan.signals.rejected`
- `decision.resolved`, `loop.iteration`, `child.spawned`, `child.finished`
- `human.requested`, `human.answered`

`agent.update` stores a compact `AgentUpdateSummary` (kind, text, tool call id/title/kind/status,
locations, plan entries) rather than the raw ACP payload; text chunks are coalesced.

## Expression / template context

Built by `RunContext.evalContext()` (`packages/engine/src/run-context.ts`):

| key | contents |
| --- | --- |
| `vars` | run vars (workflow defaults ⊕ run inputs ⊕ `set` nodes ⊕ loop scope) |
| `artifacts` | visible artifacts by **name**, each with `content` and `data` |
| `artifactsByKind` | newest visible artifact per **kind** |
| `inputs` | (agent steps) the node's resolved `inputs:` keyed by `as` alias |
| `steps` | latest StepRun per node id in this run |
| `choice` | most recent decision choice in this run |
| `iteration`, `item`, `index` | loop scope (also present in `vars`) |
| `request`, `workItem`, `workspace`, `run`, `now` | context records |
| `deliverables` | (agent steps) the planned outputs with absolute paths |
| `vars.schedule` | (after `custom:plan-schedule`) compact schedule: `ready[]`, `waiting[]`, `held[]`, `unschedulable[]`, `waves`, `criticalPath` + `criticalPathLength` (remaining work only), `risk`, `openDecisions` (each with the items its still-waiting `blocks` dependencies hold back) |
| `vars.upstream` | (item runs in a plan) upstream items this item depends on, with their artifacts (`slug`, `status`, `type`, `stage`, `requiredBy`, `artifacts{kind: {path, data}}`) |
| `vars.openDecisions`, `vars.decision` | (program) decisions to make; the current one inside the `decide` loop |

Visibility of artifacts is own run + all ancestors + all descendants + each
ancestor's *earlier siblings* (children of the same container step that were
spawned before it and had already finished when it was created), newest
`version` per name — so a sub‑workflow sees its caller's spec, a caller sees what
its loop body produced, and loop iteration N sees what iteration N‑1 produced.
Concurrent `parallel` branches do not precede one another, so they stay isolated.

## Config (`config.ts`)

`orca.config.yaml`: `storeDir`, `hosts[]` (`local` | `ssh`), `agents[]` (command, args, env,
hostId, roles, permissions, mcpServers, sessionMode, turnTimeoutMs, cancelGraceMs), `roles{}`,
`workflows[]`/`templates[]` globs, `program{workflow,itemWorkflow}`,
`planning{plan, planName, policy, riskMatrix}`, `workspace`
(`local` | `git-worktree` | `kepler`), `humanInput` (`pause` | `cli` | `auto`), `plugins[]`.
