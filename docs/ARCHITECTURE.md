# Architecture

This page is for developers who want to understand how ORCA is built before they change it. It
covers the package layers, how a run executes, how one agent hands work to the next, the
planning layer, storage, and how ORCA reaches agents and other machines. It describes the
source. For what is accepted on real installs, see the [capability ledger](ROADMAP.md).

## Goals

1. **Sit above the agents.** Take a large request, break it up, and drive each piece through
   the AI-native SDLC loop. People handle gates, not the next prompt.
2. **Artifacts, not transcripts, cross step boundaries.** Every step ends with a durable
   artifact, usually Markdown with YAML front matter, kept in a content-addressed store. The
   next step's prompt is `template ⊕ artifacts`. ORCA does not commit artifacts to git by
   itself.
3. **Watch and hand off.** Watch each agent session, detect completion, validate the promised
   artifacts, and move to the next node.
4. **User-defined workflows** with decisions, loops, parallel branches, sub-workflows and human
   gates.
5. **Agents anywhere** over ACP: a local process, or another machine over SSH.
6. **Fit existing tools** such as GitKraken Kepler, instead of replacing them.
7. **Extensible:** node types, artifact kinds, hosts, workspace providers, human-input channels
   and templates plug in without changing the core.
8. **Plan over time.** Work items from many requests share one plan with dependencies, risks
   and decisions. The scheduler orders work from that graph and can explain every choice.

## Layers

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

Dependencies point only right or down.

| Package | Role |
| --- | --- |
| `core` | Model, events, planning algorithms, expressions, templates. No I/O beyond reading files. |
| `store` | Ports and implementations for events, artifacts, documents, plans, claims and leases. |
| `agents` | Hosts, ACP sessions, permission policies. |
| `engine` | The orchestrator and executors. Uses the ports in `store` and `agents`. It opens a real ACP session by default unless a session factory is injected; the CLI injects its configured one, and tests use in-memory stores and a scripted agent. |
| `protocol` | The wire contract: Zod schemas, the envelope, the `hello` handshake, and the read models. It maps the engine's statuses onto the eight the design system draws. Depends only on `core`. |
| `daemon` | Serves the protocol in front of the engine. Depends on `engine`, `store` and `agents`. `orca serve` starts it. |
| `app` | The Electron app. Depends only on `protocol` and `design`; lint enforces this. A remote daemon uses the same code path as a local one (ADR 0008). |
| `design` | Tokens, the CSS component layer and status maps. No dependencies. The specs it implements are in `docs/design/`. |

## The daemon

- **Authentication.** By default the daemon requires a bearer token over HTTP and WebSocket.
  Unauthenticated local use must be turned on explicitly. Loopback binding alone is not
  access control. See [daemon security](daemon-security.md).
- **Discovery is not authority.** `hello.methods` reflects installed providers, read-only mode
  and the caller's grants. Every call still checks operation and resource permission.
- **Read-only.** `orca serve --read-only` leaves out run, config and plan write methods.
  Supervisor maintenance admission is separate and still works when authorized.
- **One writer per run.** The daemon drives runs under a lease held as
  `orca-serve@<host>:<pid>`.
- **Versions.** The [protocol reference](../packages/protocol/README.md) is the current method
  inventory and version history. Upgrade daemon and clients together.

### Transports

One port carries both:

- `POST /rpc` and `GET /health` go to the HTTP handler.
- `/socket` is upgraded to a WebSocket (`ws` in `noServer` mode). A connection has the normal
  method table plus `subscribe` and `unsubscribe`.

`subscriptions.ts` owns one client's stream (replay, fan-out, agent batching) over a small
`SubscriptionSource` seam that `Orchestrator` satisfies. `notifications.ts` turns events into
notifications.

The [notification contract](../packages/protocol/src/subscriptions.ts) has eleven methods:

| Kind | Methods | Carries |
| --- | --- | --- |
| Run, from the log | `run.changed`, `step.changed`, `agent.update`, `input.opened`, `input.answered`, `event.appended` | `runId` and `seq` |
| Run, ephemeral | `input.invalidated` | `runId`, no `seq`. Not replayed; never moves a cursor. |
| Store-wide | `agent.changed`, `workflows.changed`, `config.changed`, `plan.changed` | No `runId` |

`config.changed` is sent by both config writers, so a screen showing a policy sees a grant a
run just recorded. `plan.changed` says only which kinds of thing moved.

A push comes only from this process. A run or plan change written by a separate CLI process
shows up on the next read. The stores are safe for two processes, because documents are
written under a file lock and re-read before every write (#196).

The app's main process holds one store-wide subscription and broadcasts it to every window over
IPC. The renderer turns it into a typed stream with `createNotificationStream`.

### What the daemon serves

| Area | Behaviour |
| --- | --- |
| Workflows | Served as a display graph (#174): nodes, edges with conditions, inline `loop` and `parallel` graphs under `parent::node` ids. `runs.get` adds a `traversal` so the viewer can overlay a run (#177). |
| Workflow versions | `startRun` stores the definition a run starts on and marks the run `workflowStored` (#179). Resume loads the stored copy first. New launches refuse changed content under an existing `(id, version)`; bump the version. A run whose version is neither stored nor on disk refuses to resume with `WORKFLOW_VERSION_NOT_FOUND`. `workflows.get({ id, version })` can serve an old version; `pinned` and `workflowPinned` say so. |
| Configuration | Two documents (#174, #266): `orca.config.yaml` and the permission sidecar `orca.permissions.json`, each with path, raw text and a content-hash revision. `config.get` also returns the config schema and the effective permission policy. `config.set` writes one document, refuses a stale revision with `CONFIG_STALE` under the write lock, and edits YAML through the comment-preserving `yaml` `Document`. Sidecar writes go through `@orca/agents`' lock. Reading needs `config.read`; writing needs `config.write`. |
| Activation | Saving does not activate. `config.apply` activates roles, program defaults and workflow and template assets for new admissions, and emits `workflows.changed`. Agent, host and workspace settings need a restart. Admitted work keeps its captured generation. Sidecars stay live. See [configuration generations](configuration-generations.md). |
| Plan | Served over `PlanService` (#169). Reads (`plans.list`, `plan.get`, `items.list`, `schedule.get`, `schedule.explain`, `dependencies.list`, `risks.list`, `decisions.list`, `journal.list`) need `plan.read`. Writes (`dependencies.waive`, `decisions.decide`, `decisions.reopen`, `risks.update`) need `plan.write`. `claims.release` needs its own permission. [`operations.ts`](../packages/daemon/src/auth/operations.ts) is authoritative. |

Plan reads come from one projection (`daemon/src/plan-model.ts`): one snapshot and one
`computeSchedule` per call. `schedule.explain` returns `core`'s `explainWorkItem` lines, the
same text `orca plan explain` prints. A plan write takes no lease and journals through
`PlanService`'s per-plan lock with `PlanOrigin { kind: "human", actor }`. Plan documents and
their journal are not one atomic transaction.

## The interpreter

A **run** is one token walking a **graph** from `start` to an `end` node
(`packages/engine/src/orchestrator.ts`). For each node the orchestrator:

1. appends `step.scheduled`, builds a `StepContext`, appends `step.started`;
2. calls the node's executor (`packages/engine/src/executors/`). The executor appends
   `step.inputs` for each artifact it resolves, which records what the step read;
3. appends `step.completed` or `step.failed`. A retryable failure is retried up to the node's
   `maxAttempts` (agent nodes may set `completion.maxAttempts`), unless the attempt may have
   acted outside ORCA ([recovery](recovery.md));
4. **routes**: the first outgoing edge whose `when` is truthy wins, otherwise the single
   unconditional edge;
5. ends the run with `run.completed` when the step's result carries an `outcome`. The `end`
   executor returns one; a plugin node can too.

There is no concurrency inside one run. `loop`, `parallel` and `subworkflow` nodes **spawn child
runs**, each with its own log and id, and wait for them. Inline nested graphs get ids like
`program::decide` or `parent::parallelNode::branch`, so a child can be re-resolved from its
parent on resume.

Every transition is an **event** (`packages/core/src/events/events.ts`). Run state is a pure
projection (`reduce.ts`). On resume ORCA re-reduces the log: a completed last step is routed
onward; an interrupted one is tried again. An interrupted container re-attaches to the child
runs it recorded (`child.spawned` has a per-branch key), reuses finished ones and resumes the
rest. Only branches that never started get a new child run.

## The hand-off (agent step)

`packages/engine/src/executors/agent-step.ts`:

1. **Resolve input artifacts** by kind, name or producing node. A step sees its own run, its
   ancestors, its descendants, and earlier finished siblings of each ancestor for the same work
   item, never fan-out branches. The newest version wins ([data model](DATA-MODEL.md)).
2. **Render the prompt** from the template (`templates/…md`) and the step context, then append
   the **deliverables block**: a list for people and an HTML-comment YAML block giving each
   required artifact's absolute path and validation rules. ORCA inserts
   `.orca-attempts/<runId>/<stepRunId>/` before each filename. A retry has a new step id, so an
   old report cannot count for a new attempt.
3. **Open an ACP session** on the agent's host, or reuse one with `sessionMode: per-run`. See
   [Agent selection and sessions](#agent-selection-and-sessions).
4. **Send `session/prompt`.** Updates stream into the log as `agent.update`. Text chunks are
   coalesced. Tool calls, plan entries and locations are kept as a compact
   `AgentUpdateSummary`. Tool call args and results are capped at 2,000 characters each, with
   the original length recorded.
5. **Collect.** When the turn ends (`turn-end`), or as soon as the files appear
   (`artifact-present`), read each promised file through the host, parse front matter, check
   required fields, allowed values and minimum length, store the content, and append
   `artifact.recorded` with provenance.
6. **Follow up or fail.** If an artifact is missing or invalid, send a follow-up prompt that
   says exactly what is wrong, up to `completion.maxFollowUps`. Then fail the step with
   `ARTIFACT_MISSING` so the retry policy applies.

Decisions read front matter (`source: { kind: artifact, artifact: review, field: verdict }`).
A reviewer's `verdict: changes-requested` routes back to `build` with the review as an input.
That is the hand-off.

### Agent selection and sessions

- **Selection record (#186).** `run.created` can carry `overrides`: `roles` (role → agent id),
  `model` (one id, or agent id → model id), `itemWorkflow` and `templatePack`. Steps see the
  registry through `AgentRegistry.withOverrides(...)`, a read-only view. Because the record is in
  the log, a replay picks the same agents even if config changed. Child runs inherit it unless
  their node sets its own. An unknown agent or unfilled role is refused at `startRun` with
  `AGENT_NOT_FOUND`.
- **File access.** ORCA is the ACP client. It serves `fs/read_text_file` and
  `fs/write_text_file`, scoped to the workspace. It never lets an agent write ORCA's config,
  sidecar or store, or read `auth/`, whatever the rules say.
- **Permissions.** `session/request_permission` is answered by the agent's policy: its
  configured rules, then sidecar grants (ADR 0009), then ORCA's defaults unless the config sets
  `default:` (#140). First match wins, so a configured `deny` cannot be undone by a machine-written
  grant. The sidecar is re-read on every ask (#271). An `ask` becomes its own human-input
  request (`human.requested` / `human.answered`, one `hi_*` id each).
- **Session config options (#185).** `AgentSession` keeps the options `session/new` advertised
  (models, modes, reasoning level) as ORCA's `SessionConfigOption`. Legacy `modes` become one
  select with `category: "mode"`; `configOptions` wins if both are sent. ORCA advertises that it
  can set boolean options.
- **Model (#187, `session-model.ts`).** Before any turn, ORCA sets `run.overrides.model`, else
  the agent's `defaultModel`, through the `category: "model"` option. An agent that offers no
  model option can only run an id listed in its config's `models`. An id found in neither place
  fails the step with `AGENT_MODEL_NOT_FOUND`, with no retry. The applied model is recorded on
  `agent.session.opened`. A pooled session whose agent switched model is reset before the next
  step; if the agent refuses, the session is replaced.
- `Orchestrator.onAgentSessionOpened(listener)` hands each live session to in-process listeners.
  The ACP facade uses it to learn an agent's models (#189).

## Live permission asks

A permission ask can stay live while its interpreter holds the run's lease. Accepting an answer
checks the exact run, step, input, daemon boot, session, turn and invocation, re-checks the
responder's authority, and records who answered before delivering it once. Workflow gates park
durably instead. An expired ask cannot be replayed. Another process reports the owner as
unavailable instead of taking the session over. See
[live input continuity](live-input-continuity.md).

## The program level

`workflows/program.yaml`, `packages/engine/src/program/` and `packages/engine/src/plan/`:

| Node | Does |
| --- | --- |
| `decompose` (agent) | Writes a `decomposition` artifact listing work items with slugs, acceptance criteria, priorities, `dependsOn`, risks and open decisions. |
| `custom:plan-register` | Records `WorkItem`, `Dependency`, `Risk` and `Decision` entries in the plan. References to earlier requests resolve plan-wide; unknown ones become placeholders. |
| `assess-risks` (agent) | Writes a `risk-register` artifact, lifted into the plan. |
| `decide` (loop) | One `decision-matrix` artifact per open decision, scored by `custom:decision-matrix`. |
| `custom:plan-schedule` | Writes the schedule (ready order with reasons, waiting and why, held for risk, waves, critical path) to `vars.schedule` and a `schedule.md` artifact. |
| `plan-gate` | Approves unless the breakdown is large, a risk is critical, or something can never run. |
| `custom:plan-dispatch` | Runs the item workflow for whatever is ready, rescheduling after each completion and plan change. |
| `summarize` (agent) | Writes a program summary. |

**Which workflow an item runs**, first match wins: the item's `workflowId`; the node's
`workflow`; `overrides.itemWorkflow`; `vars.itemWorkflow` (from `program.itemWorkflow`, default
`ai-sdlc`). `itemWorkflowSource` records which.

**Workspaces.** Each item gets a workspace from the `WorkspaceProvider`: a git worktree, a
Kepler task worktree, or the current directory. The `local` provider is one shared checkout. In
a git checkout, a work-item run switches it to `orca/<slug>` and records the old branch as
`workspace.previousBranch`. ORCA does not switch back, and two items running at once in one
`local` checkout switch the branch under each other. Use `git-worktree` when runs must not share
a checkout (#139).

Items waiting on other requests are deferred and picked up by `workflows/plan-resume.yaml`
(`orca plan dispatch`). `custom:plan-dispatch` recomputes its branches from the live plan on
every wake, over the same `FanOut` as `parallel` (`executors/containers.ts`).

A `WorkItem`'s `status` is a projection of the fan-out events (`child.spawned`,
`child.finished`, `branch.skipped`), computed in `packages/engine/src/program/work-items.ts` and
mirrored to the document store as a cache. A crash mid-dispatch cannot strand an item
`in-progress`.

`ProgramService.submit()` is the single entry point for the CLI and the ACP facade. The older
request-scoped node `custom:materialize-work-items` remains for workflows without a plan.
Request admission is described in [request submission](request-submission.md).

## The planning layer

`PlanService` (`packages/engine/src/plan/service.ts`) owns every plan change and journals it.
After each `artifact.recorded`, the orchestrator records what the item produced and lifts
planning signals from front matter (`risks:`, `dependencies:`, `decisions:`, risk registers,
decision matrices). When a run finishes, it marks the item and reconciles dependencies.

The scheduler (`packages/core/src/plan/schedule.ts`) is pure. It evaluates open and failed
dependencies live. Satisfied and waived edges stay that way until explicitly reopened. Inside
`ai-sdlc`, `custom:plan-await` holds the build until build-phase dependencies are met and passes
upstream artifacts in as `vars.upstream`. See [PLANNING](PLANNING.md).

## Storage, claims and leases

| Mechanism | Answers | Where |
| --- | --- | --- |
| Claim | Who owns a work item. Outlives its process; never released by itself. | `packages/store/src/claim-store.ts` |
| Lease | Who is interpreting a run right now. Meant to expire. | `packages/store/src/lease-store.ts` |
| Log | What happened, in order. | `packages/store/src/jsonl-log.ts` |
| Blobs | Artifact content, by SHA-256. | `packages/store/src/artifact-store.ts` |

**Claims.** Each branch claims its item with an atomic create before spawning a child, so a
second dispatcher skips items it does not own: `parallel` records `branch.skipped` with
`reason: claimed`, and `custom:plan-dispatch` journals `dispatch.deferred`. Taking an item from a
dead run is an operator act (`orca claims release`), refused while the owner could still resume.

**Logs.** The event store and the plan journal share `JsonlLogDir`. Every append takes a lock
file and numbers the record after the last one on disk, so two processes extend one gap-free
`seq`. A torn last line from a crash is skipped on read and truncated on the next append.

**Blobs.** A blob's file name is the SHA-256 of its bytes. `put` checks the hash, writes and
fsyncs a scratch file, then publishes it with an exclusive hard link. An existing blob is
verified, never overwritten. Corruption fails with `ARTIFACT_INVALID`; a missing indexed blob
with `ARTIFACT_MISSING`. On POSIX the directory is synced before the index is appended; Windows
has no portable guarantee for directory entries. A file system without hard links fails
publication. Blob write and index append are separate, so a failed append can leave an unused
blob that a retry reuses (#338).

**Leases.** `run()` takes `run:<runId>` before writing, heartbeats while attached, and releases
it when the run finishes, fails or parks. A second interpreter gets `RUN_LEASED`, naming the
holder's pid and host. A holder that stops heartbeating, or whose process is gone on this host,
has lapsed, and the next attach takes over. To break a live lease: `orca leases` lists them;
`orca leases break <runId> --force` takes one and its subtree unless `--keep` is given. The
broken holder stops at its next heartbeat without writing anything, and raises `RUN_LEASED`.
Ownership checks and execution writes share one mutex, so a broken holder's next write is
refused at once. The keeper also stops local execution at the last good heartbeat's deadline
if renewals fail.

**Backends.** A store runs on files or on SQLite metadata (#339,
[SQLite metadata](storage/sqlite-metadata.md), ADR 0011). A store must be on one host's local
disk ([file locks](storage/file-locks.md)).

Continuation and retry receipts build on these fences. Their ordering rules are in
[admission retry](admission-retry.md) and [request submission](request-submission.md).

## Hosts and transports

`packages/agents`:

- `LocalHost` spawns the agent. `SshHost` spawns
  `ssh -T -o BatchMode=yes user@host -- bash -lc 'cd <cwd> && exec <agent>'`. ACP over stdio is
  newline-delimited JSON-RPC, so the SSH child's stdin and stdout are the ACP stream. No remote
  daemon is needed.
- Every host exposes `fs` and `exec`, so artifact pickup and workspace setup work the same for
  remote agents (`cat`, `test -e`, `git worktree add` over SSH).
- `openAcpSession()` runs `initialize` then `session/new` with a timeout, and shows the agent's
  stderr tail on failure. Cleanup sends SIGTERM, waits up to two seconds, then SIGKILL and up to
  two more. If the exit is never seen, cleanup fails explicitly. This covers only the direct
  child (the local SSH client for SSH sessions).
- The orchestrator owns a new session until `agent.session.opened` is appended. A startup
  failure closes it; a close failure is logged and never replaces the original error.
- Other transports implement `AgentSession` and are injected as `Orchestrator.sessionFactory`.

### Daemon-to-daemon delegation

`packages/daemon/src/delegation` lets one daemon run a step on another (#883, #884):

- An agent of `type: orca-daemon` opens no process. Its step is admitted as a run on the remote
  daemon, reached through the same SSH tunnel as the app's profiles (`ssh -W` to the remote's
  loopback port, with enrolled host keys and credential). The parent forwards gates and cancels,
  reattaches from a durable receipt after a dropped connection, and copies artifacts back after
  checking them.
- `SessionSlots` limits delegated sessions to each remote's `limits.maxAgentSessions`.
- CI tests two daemons in separate containers over a real sshd. [Running across
  machines](MULTI-MACHINE.md) compares the options.

## Kepler and T3 Code

ORCA is an ACP agent to the tools above it and an ACP client to the agents below it. Kepler
launches `orca acp` like any agent; ORCA launches Claude Code or Codex on the task's worktrees.
T3 Code speaks neither direction of ACP; the adapter is groundwork. See
[INTEGRATIONS](INTEGRATIONS.md).

## Other boundaries

| Area | Summary | Details |
| --- | --- | --- |
| MCP operator | An inbound MCP adapter over the daemon's authenticated services. Stdio and Streamable HTTP. Write tools mount only on a writable token-mode `serve`. Different from `agents[].mcpServers`, which ORCA offers to agents. | [MCP operator](mcp-operator.md) |
| Desktop main process | Owns authentication, connection identity, protected retry intents and the bundled daemon. Credentials are not renderer preferences. | [Daemon connections](daemon-connection.md) |
| Updates | Windows (NSIS) has an update driver. Managed Debian daemon updates are a supervisor operation. | [Updating](UPDATING.md), [Releasing](RELEASING.md) |
| Host resources | Advisory measurement ports. Not transport methods; make no admission decisions. | [Host resources](host-resources.md) |
| Root isolation | Opt-in local Linux worktree isolation. | [Owned root worktrees](root-worktree-isolation.md) |

## Key decisions

Recorded in [docs/adr/](adr/):

| ADR | Decision |
| --- | --- |
| 0001 | Event-sourced runs |
| 0002 | Artifacts as the only hand-off, with the deliverables block |
| 0003 | Single-token interpreter, child runs for containers |
| 0004 | ACP is the agent boundary; SSH is a transport, not a host daemon |
| 0005 | A standalone engine with facades, not a fork of Kepler or T3 Code |
| 0006 | The plan as a persistent cross-request dependency graph |
| 0007 | Risks and decisions as plan entities fed by artifacts |
| 0008 | Daemon, protocol and app in one workspace; the app sees only the protocol |
| 0009 | "Allow always" writes to a workspace sidecar under the configured rules and over the defaults |
| 0010 | Versioned tool execution guard ports |
| 0011 | SQLite for durable metadata; graph and key-value stores deferred |
