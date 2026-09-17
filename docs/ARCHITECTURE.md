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

## Layering

```
 cli ─────────────▶ integrations ──▶ engine ──▶ agents ──▶ core
  │                   (acp-facade,     │          (acp,        (model, events,
  │                    kepler, t3code) │           ssh, local)  expr, templates)
  └────────────────────────────────────┴──▶ store (events, artifacts, docs)
```

Dependencies only point right/down. `core` has no I/O beyond parsing files.
`engine` depends on the *ports* in `store` and `agents`, never on concrete
transports, so tests use in‑memory stores and a scripted ACP agent.

## The interpreter

A **run** is one token walking a **graph** from `start` to an `end` node
(`packages/engine/src/orchestrator.ts`). For each node the orchestrator:

1. appends `step.scheduled`, builds a `StepContext`, appends `step.started`;
2. calls the node's **executor** (`packages/engine/src/executors/`), which appends
   `step.inputs` for every artifact it resolves (that is the audit record of what the
   step read — `step.started` precedes input resolution);
3. appends `step.completed` / `step.failed` (retrying agent steps up to
   `completion.maxAttempts`);
4. **routes**: evaluates outgoing edges in order, first `when` that is truthy
   wins, else the single unconditional edge;
5. on an `end` node appends `run.completed` with the node's outcome.

Concurrency never happens inside one run. `loop`, `parallel` and `subworkflow`
nodes **spawn child runs** (each with its own event log and id) and wait for
them. That keeps the interpreter tiny and makes any node type usable inside any
container. Inline nested graphs get ids like `ai-sdlc::fix-loop` so a child run
can always be re‑resolved from its parent definition on resume.

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
   visibility = own run + ancestors + descendants, newest version wins).
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
   `agent.update` (text chunks are coalesced; tool calls, plans and locations are
   kept verbatim).
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

`workflows/program.yaml` + `packages/engine/src/program/`:

- `decompose` (agent) → `decomposition` artifact whose front matter lists work
  items with slugs, acceptance criteria and `dependsOn`.
- `custom:materialize-work-items` → `WorkItem` records in the store.
- `plan-gate` → auto‑approves small breakdowns, asks a human for big ones.
- `dispatch` → a plain `parallel` node fanning out over `vars.leafWorkItems`, with
  `forEach.key`/`dependsOn` giving the decomposition's dependency order and
  `forEach.workItemId` binding each branch to its item; each item therefore gets its
  own **workspace** from the `WorkspaceProvider` (a git worktree per item, a Kepler
  task worktree, or the current directory). There is no second fan-out engine.
- `summarize` (agent) → a program summary artifact.

A `WorkItem`'s `status` is a **projection** of that fan-out, not a side-write:
`packages/engine/src/program/work-items.ts` derives it from the `child.spawned` /
`child.finished` / `branch.skipped` events the step recorded and mirrors it onto the
document store, which is a cache. A process that dies mid-dispatch cannot strand an item
in `in-progress`: `execute()` recomputes every status from the log before resuming.

`ProgramService.submit()` is the single entry point used by the CLI and the ACP
facade.

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
  `Orchestrator.sessionFactory` (T3 Code threads, HTTP ACP).

## Where ORCA sits relative to Kepler and T3 Code

See `docs/INTEGRATIONS.md`. Short version: ORCA is transport‑ and host‑agnostic;
it is **an ACP agent to the tools above it** and **an ACP client to the agents
below it**. Kepler launches `orca acp` like any agent; ORCA in turn launches
Claude Code / Codex on the task's worktrees (locally or over SSH). T3 Code is
not ACP, so its threads are adapted as `AgentSession`s over its WebSocket RPC.

## Key design decisions

Recorded as ADRs in `docs/adr/`:

- 0001 Event‑sourced runs
- 0002 Artifacts as the only hand‑off medium (+ deliverables block)
- 0003 Single‑token interpreter with child runs for containers
- 0004 ACP as the agent boundary; SSH as a transport, not a host daemon
- 0005 Standalone engine + facades instead of forking Kepler or T3 Code
