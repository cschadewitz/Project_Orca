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
 design ◀── app ──▶ protocol ◀── daemon
 (tokens,  (electron)  │           │
  css)                 ▼           ▼
 cli ─────────────▶ integrations ──▶ engine ──▶ agents ──▶ core
  │                   (acp-facade,     │ (orchestrator, (acp,      (model, events,
  │                    kepler, t3code) │  plan service)  ssh, local) plan algorithms,
  │                                    │                            expr, templates)
  └────────────────────────────────────┴──▶ store (events, artifacts, docs, plan + journal)
```

Dependencies only point right/down. `core` has no I/O beyond parsing files.
`engine` uses the ports in `store` and `agents`; the orchestrator also supplies a concrete
`openAcpSession` default when no session factory is injected. CLI bootstrap injects its
configured factory. Tests use in-memory stores and a scripted ACP agent.

`protocol` is the wire contract (Zod schemas, depends on `core` only) — the envelope, the
`hello` handshake, and the display read models the read methods answer with, including the
one fold from the engine's statuses to the eight the design system draws
(`packages/protocol/README.md`). `daemon` serves it over the network in front of the engine:
it depends on `engine`, `store` and `agents` to project them — `store` for the stores it
reads and for the file lock the config write takes, `agents` for the sidecar writer — and
`cli` starts one with `orca serve`.
The default daemon authenticates token-bearing HTTP/WebSocket clients; local unauthenticated
compatibility must be explicit. Operation/resource checks precede typed launch validation,
and protected execution records are separate from public event projections. See
[runtime integration](runtime-foundation-integration.md) for the combined admission,
ownership, client and resume boundaries.

Since v0.4.0 that daemon is a **writer**, not a reader: it drives runs under a single‑writer
lease of its own (`orca-serve@<host>:<pid>`), advertises the `runs.control` capability, and
answers `inputs.answer`, `runs.resume`, `runs.cancel` and `runs.start`. At protocol 1.7 the
read half is ten methods — `runs.list`, `runs.get`, `runs.events`, `inputs.list`,
`claims.list`, `artifacts.list`, `artifacts.get`, `workflows.list`, `workflows.get` and
`config.get` — beside the agent methods (`agents.list`, `agents.ping`), the nine plan reads
under `plan.read`, and ten writes in all. `orca serve --read-only` opts back out of every one
of those writes, and then they are *absent* from `hello.methods` rather than present and
refusing, which is what makes "can this client write" a question about the handshake rather
than about a failed call. The lease is the guard against a second writer; it is not access
control, and any local process can reach the control methods on the loopback port (ADR 0008).

Three things v0.5.0 added to that inventory are worth reading together. The **workflow
files** come over as a display graph (#174): nodes with the per‑type fields the viewer shows,
edges with their conditions, and the graphs written inline inside a `loop` or a `parallel`
under the `parent::node` ids the engine addresses them by, plus a `traversal` on `runs.get` —
the nodes a run took in order with their attempts and the edges between them — so the viewer
(#177) can overlay a run on its graph. Both are reads, so `--read-only` answers them. As of
v0.6.0 they can also serve an *old* version (#179): `startRun` keeps the definition a run
starts on in the store's **workflow‑version store** (`workflows/<id>@v<version>.json`, one
immutable file per version, written once), and marks the run `workflowStored` in
`run.created`. A resumed run is loaded through `Orchestrator.definitionFor(id, version)` —
the file on disk when it is still at that version, otherwise the stored copy — so publishing
a new version affects runs started afterwards and a run under way finishes on the version it
began with. A run that predates versioning carries no `workflowStored` and resumes on
whatever file is current, as before; a run that does carry it but whose version is neither
stored nor on disk refuses to resume with `WORKFLOW_VERSION_NOT_FOUND`, naming what exists.
`workflows.get({ id, version })` answers from the store for a non‑current version,
`WorkflowView.pinned` says the answer is not the version on disk, and `runs.get` carries
`workflowPinned` for the same reason (the `◷ pinned` chip in
`docs/design/70-workflow-editing.md`). A file edited *without* bumping `version` still wins
over the stored copy. `workflows.changed` is on the wire with nothing emitting it — there is
no workflow reload path yet — so a client may subscribe before the editor (#181) can send one.

The **configuration** is two documents (#174, #266). `config.get` returns `orca.config.yaml`
and the ADR 0009 permission sidecar `orca.permissions.json`, each with its own path, raw text
and content-hash revision, plus a description of the config schema a form can render and the
effective permission policy the two — and the built‑in defaults under them (#140) — layer up
to. `config.set` writes exactly one of them: it refuses a stale revision with `CONFIG_STALE`,
decided *under* the write lock rather than before it; it edits the YAML through the
comment-preserving `yaml` `Document` rather than re-serialising it, so no schema default is
materialised into the file; and it routes a sidecar write through `@orca/agents`' `link()`
lock so an operator's edit and a run answering "always" both land. Writing the config reloads
nothing: the orchestrator goes on serving the configuration it booted with until the next
`orca serve`, and a `config.set` while a run is in flight takes no lease and appends no event.

The **plan** is served over `PlanService` (#169): `plans.list`, `plan.get`, `items.list`,
`schedule.get`, `schedule.explain`, `dependencies.list`, `risks.list`, `decisions.list` and
`journal.list` under `plan.read`, and `dependencies.waive`, `decisions.decide`,
`decisions.reopen`, `risks.update` and `claims.release` under `plan.write`. The reads are one
projection (`daemon/src/plan-model.ts`): one snapshot and one `computeSchedule` per call,
which is where an item's classification, its priority reasons, its risk exposure and the live
state of every dependency all come from at once — and `schedule.explain` returns `core`'s own
`explainWorkItem` lines verbatim, the same ones `orca plan explain` prints, so the popover and
the terminal cannot drift. A plan write is not a run write: it takes no lease, drives no
interpreter, and journals through `PlanService`'s per‑plan lock with
`PlanOrigin { kind: "human", actor: "daemon" }`.

The daemon has **two transports on one port**. `socket.ts` upgrades `/socket` in `ws`'s
`noServer` mode, so `/health` and `/rpc` still reach the HTTP handler untouched; a connection
carries the ordinary method table plus `subscribe` / `unsubscribe`, whose state is the
connection's. `subscriptions.ts` owns one client's stream — replay, fan-out and agent
batching — over a narrow `SubscriptionSource` seam (`subscribe(listener, filter)` +
`events(runId)`) that `Orchestrator` satisfies structurally, and `notifications.ts` is the
pure event→notification fold. Four of the ten notifications carry no `runId`:
`agent.changed`, `workflows.changed`, `config.changed` — pushed by *both* config writers, so
a screen watching the policy sees a grant a run just recorded — and `plan.changed`, folded
from the plan journal's own listener seam, saying only which *kinds* of thing moved and never
reading the store to enrich itself. The socket fans out this process's event store and this
process's plan journal, so a run or a plan change written by a separate CLI process still
lands only on the next read. That is an in-memory listener list, not a stale store: the
stores are safe for two processes now that documents are written under a file lock and
re-read before every write (#196). A push is this process's; a read is everyone's.

`app` depends on `protocol` and `design` and nothing
else in the workspace, enforced by the lint config: the desktop app can only see what a
daemon tells it, so attaching to a daemon on another machine is the same code path as the
local one (ADR 0008). Its main process holds one store-wide subscription and broadcasts to
every window over an IPC channel; the renderer turns those envelopes into a typed stream
with `createNotificationStream`, which imports `@orca/protocol` and nothing else. `design` is the design system as code — generated tokens in CSS and
TypeScript, the CSS component layer, the typed status maps — with no dependencies at
all; the brand book and surface specs it implements are in `docs/design/`.

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
   The declared directory and filename select the output location, with
   `.orca-attempts/<runId>/<stepRunId>/` inserted before the filename. A back-edge
   or retry has a new step id, so an old passing report cannot be credited to a
   new attempt. Agents must use the exact deliverable paths, and only the supplied
   artifact inputs as prior workflow context. Earlier reports remain in the
   content-addressed store as explicit inputs, including after an interrupted turn.
3. Open (or reuse, `sessionMode: per-run`) an **ACP session** on the agent's
   host. The agent is resolved through the run's **selection record** (#186):
   `run.created` carries an optional `overrides` — `roles` (role → agent id),
   `model` (one id, or agent id → model id), `itemWorkflow` and `templatePack` —
   and every step sees the registry through `AgentRegistry.withOverrides(...)`,
   a read‑only view that consults `overrides.roles` before the config's role
   mapping and never changes the shared registry. Because the record is in the
   event log, a replay resolves the same agents the live run did even after the
   config's roles changed; a log without the field is a run with no overrides.
   Child runs inherit their parent's record unless the node sets its own, and an
   unknown agent or an unfilled role is refused at `startRun` with
   `AGENT_NOT_FOUND` rather than on the first step that needs it.
   ORCA is the ACP *client*: it serves `fs/read_text_file`,
   `fs/write_text_file` from the host file system (scoped to the workspace) and
   answers `session/request_permission` through the agent's permission policy —
   the rules configured on the agent first, then any the workspace sidecar has
   recorded (ADR 0009), then — unless the config set `default:` itself — ORCA's
   own defaults, which allow work inside the workspace and ask for anything else
   (#140); first match wins, so a configured `deny` can never be undone by
   something a machine wrote. The sidecar is **re‑read per ask**, not
   per session (#271), so an "allow always" answered while the run is in flight
   decides that run's next tool call rather than only the next session's.
   An `ask` decision becomes its own human‑input request (`human.requested` /
   `human.answered`, one `hi_*` id per ask), so several pending tool calls can be
   listed and answered independently.
   `AgentSession` also keeps what `session/new` advertised as the agent's
   **session config options** (a model list, a mode, a reasoning level),
   normalised into ORCA's own `SessionConfigOption` (`packages/core`) so the
   engine never sees the SDK's shape: an agent's legacy `modes` become one
   select with `category: "mode"`, and `configOptions` wins when it sends both.
   `setConfigOption` sends `session/set_config_option` and replaces the cache
   from the full list the agent returns; an unsolicited `config_option_update`
   does the same and is logged as an `agent.update` (#185). ORCA advertises
   that it can set boolean options, so agents may offer them. The persisted
   `agent.session.opened` event records that a session opened but carries no
   session, so `Orchestrator.onAgentSessionOpened(listener)` hands each live
   session to in‑process listeners as it opens (not persisted, not on the
   wire); the ACP facade uses it to learn which models an agent offers (#189).
   **The run's model goes on before any turn** (#187, `session-model.ts`):
   `run.overrides.model` (one id, or the map keyed by the resolved agent id),
   else the agent's `defaultModel`, is set through the session's
   `category: "model"` option; an agent that offers none can only run on an id
   its config declares in `models`, recorded as declared since there is
   nothing to set; an id in neither place fails the step with
   `AGENT_MODEL_NOT_FOUND`, listing what is available, with no retry. The
   applied model is recorded as `agent.session.opened.model` (or the agent's
   own current model when the run selected none), which is what `orca status`
   and the daemon's step view show. A per‑run pooled session whose agent has
   switched model itself is re‑applied before the next step and the re‑apply
   logged as an `agent.update`; if the agent refuses, the pooled session is
   closed and a fresh one opened.
4. `session/prompt`. Session updates stream into the event log as
   `agent.update` (text chunks are coalesced; tool calls, plan entries and
   locations are kept as a compact `AgentUpdateSummary`, not the raw ACP payload).
   A tool call's args and result travel with it, each capped at 2,000 characters
   when the event is written and stored with the length it had before the cap.
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
  The workflow per item is the item's own `workflowId`, else the node's
  `workflow` pin, else `overrides.itemWorkflow` from the run's selection
  record, else `vars.itemWorkflow` (seeded from `program.itemWorkflow`, default
  `ai-sdlc`); the result's `itemWorkflowSource` says which (`node`, `override`
  or `var`). Each item gets its own **workspace** from the `WorkspaceProvider`
  (a git worktree per item, a Kepler task worktree, or the current directory).
  The `local` provider is one shared checkout, so in a git checkout a work‑item
  run switches it to `orca/<slug>` (created from the current HEAD, or reused)
  and records the branch it replaced as `workspace.previousBranch` in
  `run.created`; ORCA does not switch it back, and two items running at once in
  one `local` checkout will switch the branch under each other. Use
  `git-worktree` when runs must not share a checkout (#139). Items waiting on other
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

A well‑numbered log is still not a single‑authored one. Two interpreters over one run id
would each reduce the same log, each pick the next node, and each append their own steps,
so **driving a run takes a lease** (`packages/store/src/lease-store.ts`): `run()` acquires
`run:<runId>` before it writes anything, heartbeats for as long as it is attached, and
gives the lease back when the run finishes, fails or parks. A second interpreter is
refused with `RUN_LEASED` and told which pid on which host holds it. A holder that stops
heartbeating — or whose process is visibly gone on this host — has **lapsed**, and the
next attach takes the lease over without an operator in the loop, so a crash never wedges
a run. Breaking a lease that is still live is the operator's act, the way releasing a
claim is: `orca leases` lists them, `orca leases break <runId> --force` takes one, and
because a resumed parent drives the children its interrupted attempt spawned, `break`
covers the run's subtree unless `--keep` says otherwise. The broken holder finds out at
its next heartbeat and stops there, **without writing** — not even the `step.cancelled` and
`run.cancelled` it would append for a cancel of its own, because the log is the new holder's
now and a cancellation written into it would cancel the run the operator was taking over.
It logs why and raises `RUN_LEASED` to whoever called `run()`; the run itself is left
exactly as the last write found it, still running, its interrupted step still open, for the
new holder to re-attempt.

Ownership validation and execution writes now share the lease mutation mutex. A
broken holder's next write is refused immediately, even before its heartbeat notices.
The keeper also stops local execution at the last successful heartbeat's deadline
when renewals error or hang. Parked input acceptance and cancellation use this same
ownership boundary and reread the durable log under it. The backward-readable lease
fence and legacy-writer refusals are documented in
[ownership compatibility](v0.5.2-ownership-compatibility.md).

Claims and leases answer different questions and neither replaces the other: a claim says
who *owns a work item*, outlives the process that took it, and is never released on its
own; a lease says who is *interpreting a run right now*, and is meant to expire.

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
(`packages/core/src/plan/schedule.ts`) is pure and evaluates open/failed dependencies live;
satisfied/waived edges are sticky until an explicit reopening path changes them.
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
- 0009 "Allow always" writes to a workspace sidecar, layered under the configured rules —
  and, since #140, over the built‑in default rules, which are the last layer of the three
