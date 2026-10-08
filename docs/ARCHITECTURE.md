# Architecture

Reconciled against main `dcccd2bb849ae26c7fe0fb202431f11a6ab909c1` on
7 October 2026. This describes source behavior. See the
[capability ledger](ROADMAP.md) and [evidence map](reviews/2026-10-07-living-docs.md)
for deployment, actual-client and native acceptance limits.

## Goals

1. **Sit above the agents.** Accept a large request, decompose it, and drive each
   piece through the AI‑native SDLC loop. Humans concentrate on gates, not on
   typing the next prompt.
2. **Artifacts, not transcripts, cross step boundaries.** Every step ends with a
   durable artifact (normally Markdown with YAML front matter, collected into the
   content-addressed store). Workflows/agents may commit workspace files; ORCA does
   not automatically commit every artifact. The next step's instructions are
   `template ⊕ artifacts`.
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

The daemon drives runs under a single-writer lease (`orca-serve@<host>:<pid>`).
Its current contract is protocol **2.0**, with store epoch `operator-journals-v4`.
`hello.methods` reflects installed providers, read-only mode and the caller's current
grants. Each call still checks operation and resource authority; handshake discovery
does not authorize an arbitrary run. `orca serve --read-only` omits run/config/plan
mutation methods. Supervisor maintenance admission is separate and remains available
when authorized. The lease prevents competing execution writers; bearer authentication
and resource authorization control access. Loopback binding alone establishes neither.
See [daemon security](daemon-security.md) and the [protocol reference](../packages/protocol/README.md)
instead of treating an old method count as a current inventory.

Three things v0.5.0 added to that inventory are worth reading together. The **workflow
files** come over as a display graph (#174): nodes with the per‑type fields the viewer shows,
edges with their conditions, and the graphs written inline inside a `loop` or a `parallel`
under the `parent::node` ids the engine addresses them by, plus a `traversal` on `runs.get` —
the nodes a run took in order with their attempts and the edges between them — so the viewer
(#177) can overlay a run on its graph. Both are reads, so `--read-only` answers them. As of
v0.6.0 they can also serve an *old* version (#179): `startRun` keeps the definition a run
starts on in the store's **workflow-version store** (protected persisted definitions),
and marks the run `workflowStored` in
`run.created`. A resumed run is loaded through `Orchestrator.definitionFor(id, version)` —
the stored copy first, with a matching-version loaded definition as the low-level fallback.
Generation-backed restoration additionally verifies protected material and the recorded
digest and fails closed when missing or corrupt. New unversioned launches reject changed
content at an already stored `(id, version)`; bump the version. A legacy run without
`workflowStored` retains its historical current-definition fallback; a run whose version is neither
stored nor on disk refuses to resume with `WORKFLOW_VERSION_NOT_FOUND`, naming what exists.
`workflows.get({ id, version })` answers from the store for a non‑current version,
`WorkflowView.pinned` says the answer is not the version on disk, and `runs.get` carries
`workflowPinned` for the same reason (the `◷ pinned` chip in
`docs/design/70-workflow-editing.md`). `config.apply` reloads and validates assets and emits
`workflows.changed` for activated changes/removals. There is no filesystem watcher or
workflow editor. [Configuration generations](configuration-generations.md) documents
the exact activation and historical restoration rules.

The **configuration** is two documents (#174, #266). `config.get` returns `orca.config.yaml`
and the ADR 0009 permission sidecar `orca.permissions.json`, each with its own path, raw text
and content-hash revision, plus a description of the config schema a form can render and the
effective permission policy the two — and the built‑in defaults under them (#140) — layer up
to. `config.set` writes exactly one of them: it refuses a stale revision with `CONFIG_STALE`,
decided *under* the write lock rather than before it; it edits the YAML through the
comment-preserving `yaml` `Document` rather than re-serialising it, so no schema default is
materialised into the file; and it routes a sidecar write through `@orca/agents`' `link()`
lock so an operator's edit and a run answering "always" both land. Editor bytes require
`config.read` and are unredacted; config writes require `config.write`. Saving does not
activate the main config. A separately guarded `config.apply` activates reloadable roles,
program defaults and workflow/template assets for new admissions; agent, host, workspace
and other bootstrap settings require restart. Existing admitted work retains captured
generation material. Permission sidecars remain live and independent of apply.

The **plan** is served over `PlanService` (#169): `plans.list`, `plan.get`, `items.list`,
`schedule.get`, `schedule.explain`, `dependencies.list`, `risks.list`, `decisions.list` and
`journal.list` under `plan.read`, and `dependencies.waive`, `decisions.decide`,
`decisions.reopen` and `risks.update` under `plan.write`. `claims.release` requires its
own `claims.release` permission and claim resource authority. These are operation
permissions, distinct from coarse discovery capabilities; the
[operation matrix](../packages/daemon/src/auth/operations.ts) is authoritative. The reads are one
projection (`daemon/src/plan-model.ts`): one snapshot and one `computeSchedule` per call,
which is where an item's classification, its priority reasons, its risk exposure and the live
state of every dependency all come from at once — and `schedule.explain` returns `core`'s own
`explainWorkItem` lines verbatim, the same ones `orca plan explain` prints, so the popover and
the terminal cannot drift. A plan write is not a run write: it takes no lease, drives no
interpreter, and journals through `PlanService`'s per‑plan lock with
`PlanOrigin { kind: "human", actor }`, with the model's configured actor defaulting
to `"daemon"`; transport authorization/audit is separate from that journal origin.
Instance-local serialization and per-file locks do not make plan documents and their
journal one atomic transaction.

The daemon has **two transports on one port**. `socket.ts` upgrades `/socket` in `ws`'s
`noServer` mode, so `/health` and `/rpc` still reach the HTTP handler untouched; a connection
carries the ordinary method table plus `subscribe` / `unsubscribe`, whose state is the
connection's. `subscriptions.ts` owns one client's stream — replay, fan-out and agent
batching — over a narrow `SubscriptionSource` seam (`subscribe(listener, filter)` +
`events(runId)`) that `Orchestrator` satisfies structurally, and `notifications.ts` is the
pure event→notification fold. The [notification contract](../packages/protocol/src/subscriptions.ts)
has eleven methods: six log-derived run notifications, ephemeral `input.invalidated`
and four store-wide notifications. `input.invalidated` identifies an owner-local
callback and carries `runId` but no `seq`; it is not replayed and never advances a
run cursor. Four of the eleven notifications carry no `runId`:
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

## Live permission continuity

Supported permission callbacks can use `LiveHumanInput` while their owning
interpreter retains its execution lease. Acceptance names exact run/step/input,
daemon boot, session, turn and invocation, revalidates the responder's authority,
and records the actor before delivering once to the original callback. Workflow
gates keep their durable parked lifecycle. Expired callbacks cannot be replayed;
other processes report owner-unavailable rather than taking a live session over.
See [live permission continuity](live-input-continuity.md) for the two lifetimes,
standing-write failure ordering, resumption fallbacks and integration requirements.

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

Durable continuation attachment and receipt settlement are separate fenced writes.
Before attachment, lease contention refuses the competing reconciliation with
`RUN_LEASED` and preserves the shared receipt. This includes the interval after an
interpreter reserves its local running slot but before it acquires the durable
execution lease, and an incumbent releasing its lease before the refusal is handled.
An accepted receipt records durable intent; it does not promise execution ownership.
The winning continuation records attachment and settlement once, without a transient
`blocked / leased` publication from the loser. Authority, generation and boundary
failures still publish their existing fenced blocked states when safe to do so.
Execution releases its lease before the final receipt write. A competing replay
that previously read `dispatch: needed` must reread the verified journal and run
history under the fence: a now-attached terminal run settles, while a nonterminal
attachment with uncertain execution remains blocked as ambiguous. A fence or store
refusal after successful execution preserves the existing receipt for later
authorized reconciliation; it is not evidence of unsafe execution. Reconciliation
verifies and synchronizes the durable marker without repeating the decision or
execution. Receipt inspection remains read-only.

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
  timeout and surfaces the agent's stderr tail on failure. Handshake failure and
  ordinary session termination share one idempotent direct-child cleanup: wait up to
  two seconds after SIGTERM, then up to two seconds after SIGKILL. Startup therefore
  takes at most four additional seconds to clean up after a handshake failure (subject
  to event-loop scheduling). An already-observed exit needs no signal; concurrent closes
  share the same operation and clear their grace timers. If exit remains unobserved,
  cleanup fails explicitly rather than claiming the process stopped. Handshake errors
  retain their code/message and original cause, with the separate cleanup failure in
  `details.cleanup` and a warning in the logger. Ordinary `close()` rejects on incomplete
  cleanup; cancellation-triggered cleanup also logs that failure.
- The orchestrator owns a newly created session through model setup and the
  `agent.session.opened` append, until it returns a release function or registers the
  per-run pool entry. Startup bookkeeping failure closes that session in either mode;
  a close failure is logged separately and never replaces the original startup error.
  These guarantees concern only the owned direct child (the local SSH client for SSH
  sessions), not descendant processes, remote agent exit, or daemon-wide draining.
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

Request admission and recovery are described in [Request submission](request-submission.md).
Opt-in built-in root isolation and its retained-evidence recovery limits are described in
[Owned root worktrees](root-worktree-isolation.md).
The admission lifecycle is shared by daemon, configured ProgramService/CLI and ACP;
`runs.start` remains an explicit workflow launch.

The inbound MCP operator adapter uses authenticated daemon projections and the same
admission, retry, continuation and revision services. Stdio and Streamable HTTP are
implemented; remote HTTP still needs a trusted TLS listener/approved bridge. Production
mutation aliases are conditionally mounted by writable token-mode `serve`; no adapter
ledger or automatic mutation retry is added. See [MCP operator](mcp-operator.md) for the
bounded read contract and actual-client acceptance. Downstream `agents[].mcpServers`
are a different direction. Generic scoped MCP/skill/secret delivery and verification
remain separate work (#335–#337).

The desktop main process owns authentication, connection identity/epochs, protected
retry intents and bundled-daemon lifecycle. Renderer/preload use the protocol bridge;
credentials and protected text are not ordinary renderer preferences. Native `safeStorage`
restart/UI tests are separate from source and Linux reference tests. Windows NSIS has
an update driver; main's driver returns unavailable for macOS. Managed Debian daemon
updates are a supervisor operation, not an RPC installation method. [Updating](UPDATING.md)
and [Releasing](RELEASING.md) describe mechanisms; signed Apple Silicon delivery and
native upgrade/privacy/physical acceptance remain separate gates.

The advisory daemon-machine resource contract and bounded collection/authorized-summary
ports are described in [Host resources](host-resources.md). They are not registered
as transport methods and make no admission decisions; authenticated consumers are
separate work.

The injected host-resource MCP read is a bounded, separately authorized composition seam;
its [access-policy proposal](host-resource-access-policy.md) requires review before production
mounting or grants. The shared snapshot and fixtures are pinned to #495; the daemon/MCP slice
constructs no collector and supplies no runtime workstream index.
