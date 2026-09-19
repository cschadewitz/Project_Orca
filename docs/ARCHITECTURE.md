# Architecture

## Goals

1. **Sit above the agents.** Accept a large request, decompose it, and drive each
   piece through the AI‑native SDLC loop. Humans concentrate on gates, not on
   typing the next prompt.
2. **Artifacts, not transcripts, cross step boundaries.** Every step ends with a
   durable artifact (a markdown file with YAML front matter, committed in the
   workspace). The next step's instructions are `template ⊕ artifacts`.
3. **Watch and hand off.** The orchestrator observes each agent session, detects
   completion, validates the promised artifacts, and routes to the next node.
4. **User‑defined workflows** with decision steps, loops, parallelism,
   sub‑workflows and human gates.
5. **Agents anywhere** via ACP: local subprocess or a remote machine over SSH.
6. **Fit existing tools**: run inside/in front of GitKraken Kepler, or drive T3
   Code, rather than replacing them.
7. **Extensible**: new node types, artifact kinds, hosts, workspace providers,
   human‑input channels and templates plug in without touching the core.
8. **Plan over time.** Work items from many requests live in one plan with
   dependencies (on items, stages of items, decisions, externals), risks and
   decisions; the scheduler orders agents' work from that graph and can explain
   every choice.

## Layering

```
 app ──▶ protocol ◀── daemon
 (electron)  │           │
             ▼           ▼
 cli ─────────────▶ integrations ──▶ engine ──▶ agents ──▶ core
  │                   (acp-facade,     │ (orchestrator, (acp,      (model, events,
  │                    kepler, t3code) │  plan service)  ssh, local) plan algorithms,
  │                                    │                            expr, templates)
  └────────────────────────────────────┴──▶ store (events, artifacts, docs, plan + journal)
```

Dependencies only point right/down. `core` has no I/O beyond parsing files.
`engine` depends on the *ports* in `store` and `agents`, never on concrete
transports, so tests use in‑memory stores and a scripted ACP agent.

`protocol` is the wire contract (Zod schemas, depends on `core` only). `daemon`
serves it over the network in front of the engine; `cli` starts one with `orca
serve`. `app` depends on `protocol` and nothing else in the workspace, enforced by
the lint config: the desktop app can only see what a daemon tells it, so attaching
to a daemon on another machine is the same code path as the local one (ADR 0008).

## The interpreter

A **run** is one token walking a **graph** from `start` to an `end` node
(`packages/engine/src/orchestrator.ts`). For each node the orchestrator:

1. appends `step.scheduled`, builds a `StepContext`, appends `step.started`;
2. calls the node's **executor** (`packages/engine/src/executors/`), which appends
   `step.inputs` for every artifact it resolves (that is the audit record of what the
   step read — `step.started` precedes input resolution);
3. appends `step.completed` / `step.failed` (retrying a retryable failure up to the
   node's `maxAttempts` — agent nodes may instead set `completion.maxAttempts`);
4. **routes**: evaluates outgoing edges in order, first `when` that is truthy
   wins, else the single unconditional edge;
5. ends the run with `run.completed` whenever the step's result carries an `outcome`
   (that is what the `end` executor returns, and how a plugin node can be terminal).

Concurrency never happens inside one run. `loop`, `parallel` and `subworkflow`
nodes **spawn child runs** (each with its own event log and id) and wait for
them. That keeps the interpreter tiny and makes any node type usable inside any
container. Inline nested graphs get ids like `program::decide` (or
`parent::parallelNode::branch`) so a child run can always be re‑resolved from
its parent definition on resume.

Every transition is an **event** (`packages/core/src/events/events.ts`); run
state is a pure projection (`reduce.ts`). A crashed process resumes by
re‑reducing the log: a completed last step is routed onward, an interrupted one
is re‑attempted. When the interrupted step is a container (`loop`, `parallel`,
`subworkflow`) the new attempt does not start over:
`ctx.runChild` re‑attaches to the child runs the interrupted attempt recorded
(`child.spawned` carries a per‑branch key), reuses the ones that already finished
and resumes the unfinished ones from their own logs, recursively. Only branches
that never started get a fresh child run.

## The hand‑off (agent step)

`packages/engine/src/executors/agent-step.ts`:

1. Resolve **input artifacts** (`inputs:` refs by kind/name/producing node;
   visibility = own run + ancestors + descendants + earlier finished siblings of
   each ancestor, newest version wins).
2. Render the **prompt**: template body (`templates/…md`) against the step
   context, then append the **deliverables block** — a human list *and* an
   HTML‑comment YAML block listing every artifact the step must produce with its
   absolute path and validation rules (`renderDeliverablesBlock`).
3. Open (or reuse, `sessionMode: per-run`) an **ACP session** on the agent's
   host. ORCA is the ACP *client*: it serves `fs/read_text_file`,
   `fs/write_text_file` from the host file system (scoped to the workspace) and
   answers `session/request_permission` through the agent's permission policy.
   An `ask` decision becomes its own human‑input request (`human.requested` /
   `human.answered`, one `hi_*` id per ask), so several pending tool calls can be
   listed and answered independently.
4. `session/prompt`. Session updates stream into the event log as
   `agent.update` (text chunks are coalesced; tool calls, plan entries and
   locations are kept as a compact `AgentUpdateSummary`, not the raw ACP payload).
5. When the turn ends (`turn-end` mode) — or as soon as the files appear
   (`artifact-present` mode) — **collect**: read each promised file through the
   host FS, parse front matter, validate required fields / allowed values /
   minimum length, store the content (content‑addressed), and append
   `artifact.recorded` with provenance (run, step, node, session, agent, host,
   parent artifacts).
6. If a required artifact is missing or invalid, send a bounded **follow‑up
   prompt** listing exactly what is wrong (`completion.maxFollowUps`), else fail
   the step (`ARTIFACT_MISSING`) so the run's retry policy can kick in.

Decisions then read front matter (`source: { kind: artifact, artifact: review,
field: verdict }`), so a reviewer's `verdict: changes-requested` routes the graph
back to `build` with the review as an extra input. That *is* the hand‑off.

## The level above (program)

`workflows/program.yaml` + `packages/engine/src/program/` + `packages/engine/src/plan/`:

- `decompose` (agent) → `decomposition` artifact whose front matter lists work
  items with slugs, acceptance criteria, priorities, `dependsOn` references,
  risks and open decisions.
- `custom:plan-register` → `WorkItem` records **in the plan**, plus
  `Dependency`, `Risk` and `Decision` records; references to items from earlier
  requests resolve plan‑wide, references to items not registered yet become
  placeholders bound later.
- `assess-risks` (agent) → `risk-register` artifact, lifted into the plan.
- `decide` (loop) → one `decision-matrix` artifact per open decision, scored
  by `custom:decision-matrix`; items waiting on the decision unblock.
- `custom:plan-schedule` → the schedule (ready order with reasons, waiting and
  why, held for risk, waves, critical path) as `vars.schedule` and a
  `schedule.md` artifact.
- `plan-gate` → auto‑approves unless the breakdown is large, a risk is critical
  or something can never run.
- `custom:plan-dispatch` → runs the item workflow for whatever the scheduler
  says is ready, re‑scheduling after every completion and on every plan change.
  The workflow per item is the item's own `workflowId`, else `vars.itemWorkflow`
  (seeded from `program.itemWorkflow`, default `ai-sdlc`); each item gets its
  own **workspace** from the `WorkspaceProvider` (a git worktree per item, a
  Kepler task worktree, or the current directory). Items waiting on other
  requests are deferred and picked up by `workflows/plan-resume.yaml`
  (`orca plan dispatch`). Unlike a `parallel` fan‑out, the set of branches is
  not known up front: it is re‑computed from the live plan on every wake, which
  is why this node drives the fan‑out itself — over the same `FanOut`
  (`executors/containers.ts`), so concurrency, cancellation and `failFast` behave
  as they do in `parallel`.
- `summarize` (agent) → a program summary artifact.

A `WorkItem`'s `status` is a **projection** of that fan-out, not a side-write:
`packages/engine/src/program/work-items.ts` derives it from the `child.spawned` /
`child.finished` / `branch.skipped` events the step recorded and mirrors it onto the
document store, which is a cache. A process that dies mid-dispatch cannot strand an item
in `in-progress`: `execute()` recomputes every status from the log before resuming.

One run's log says nothing about what *other* runs are doing, so ownership of an item is
settled outside the logs: each branch claims its item through the `ClaimStore`
(`packages/store/src/claim-store.ts`) before spawning a child run — an atomic create, so
it holds across processes. A second dispatcher over the same plan skips what it does not
own instead of starting a rival child run: a `parallel` fan‑out records `branch.skipped`
with `reason: claimed`, `custom:plan-dispatch` journals `dispatch.deferred` and reports
the item as `claimed` in `vars.dispatched`. Neither writes that item's status. Nothing
releases a claim on its own; taking an item away from a run that died is the operator's
act (`Orchestrator.releaseClaim`, `orca claims release`), refused while the owner could
still resume.

The logs themselves are safe to share the same way. The JSONL event store and the plan
journal are one primitive, `JsonlLogDir` (`packages/store/src/jsonl-log.ts`): every append
takes a lock file next to the log and numbers the record after the last one *on disk*, so
two processes over one store directory — an `orca acp` facade beside an `orca resume` —
extend one log with one gap‑free `seq` instead of each counting from its own cache. A
process that dies mid‑append leaves a torn last line; reads skip it with a warning and the
next append truncates it before writing, so a crash never disables a run or a plan.

`ProgramService.submit()` is the single entry point used by the CLI and the ACP
facade. The original request‑scoped node (`custom:materialize-work-items`,
fanned out by a plain `parallel` `forEach` over `vars.leafWorkItems`) remains
available for workflows that do not want a plan.

## The planning layer

`PlanService` (`packages/engine/src/plan/service.ts`) owns every change to the
plan and journals it. The orchestrator calls it inline: after each
`artifact.recorded` it records what the item produced (stage‑level dependencies)
and lifts planning signals from the artifact's front matter (`risks:`,
`dependencies:`, `decisions:`, risk registers, decision matrices); when a run
finishes it marks the item and reconciles dependencies. The scheduler
(`packages/core/src/plan/schedule.ts`) is pure and evaluates dependencies live.
Inside `ai-sdlc`, `custom:plan-await` holds the build until the item's
build‑phase dependencies are satisfied and passes upstream artifacts into the
prompt as `vars.upstream`. Full description: `docs/PLANNING.md`.

## Hosts and transports

`packages/agents`:

- `LocalHost` spawns the agent binary; `SshHost` spawns
  `ssh -T -o BatchMode=yes user@host -- bash -lc 'cd <cwd> && exec <agent>'`.
  Because ACP's stdio transport is newline‑delimited JSON‑RPC, the SSH child's
  stdin/stdout *is* the ACP stream; no remote daemon is needed.
- Every host exposes `fs` (read/write/exists/mkdirp) and `exec` so artifact
  pickup and workspace provisioning work identically for remote agents (`cat`,
  `test -e`, `git worktree add` over SSH).
- `openAcpSession()` performs `initialize` → `session/new` with a handshake
  timeout and surfaces the agent's stderr tail on failure.
- Alternative transports implement `AgentSession` and are injected as
  `Orchestrator.sessionFactory` (HTTP ACP; T3 Code threads once its transport lands).

## Where ORCA sits relative to Kepler and T3 Code

See `docs/INTEGRATIONS.md`. Short version: ORCA is transport‑ and host‑agnostic;
it is **an ACP agent to the tools above it** and **an ACP client to the agents
below it**. Kepler launches `orca acp` like any agent; ORCA in turn launches
Claude Code / Codex on the task's worktrees (locally or over SSH). T3 Code is
not ACP in either direction: it cannot launch `orca acp`, and adapting its
threads as `AgentSession`s over its WebSocket RPC is groundwork, not a working
transport.

## Key design decisions

Recorded as ADRs in `docs/adr/`:

- 0001 Event‑sourced runs
- 0002 Artifacts as the only hand‑off medium (+ deliverables block)
- 0003 Single‑token interpreter with child runs for containers
- 0004 ACP as the agent boundary; SSH as a transport, not a host daemon
- 0005 Standalone engine + facades instead of forking Kepler or T3 Code
- 0006 The plan as a persistent cross‑request dependency graph, scheduled live
- 0007 Risks and decisions as plan entities fed by artifacts, computed by ORCA
- 0008 Daemon, protocol package and desktop app in one workspace; the app sees only the protocol
