# Roadmap / open items

Groundwork is complete and tested end‑to‑end. Deliberately left for follow‑up:

1. **Daemon mode** — `orca serve` exists (`packages/daemon`) with the transport, the method
   table and the `hello` handshake over HTTP, and the desktop app (`packages/app`) completes
   that handshake through `packages/protocol` (ADR 0008). Still to do, in the order the app
   needs them: the read methods over `Orchestrator` (`runs.list`, `runs.get`, `runs.events`,
   `inputs.list`, `claims.list`), a WebSocket carrying `notification` messages for
   `Orchestrator.subscribe()`, the control methods (`answer`, `resume`, `cancel`, `startRun`),
   then the plan methods over `PlanService`. Human input already survives process
   boundaries: `pause` mode parks the run in its event log and `orca answer <requestId>
   <option>` resumes it; the daemon exposes the same `answer()` / `resume()` over the wire
   and keeps agent sessions alive across the wait. Two processes over one store are now
   safe to the extent the run log is concerned: every interpreter holds a single‑writer
   lease per run (#101). The document stores are not — `JsonFileDocumentStore` caches the
   whole collection and rewrites it, so a daemon and a CLI command would lose each other's
   requests, work items and plan records (#196).
2. **T3 Code WebSocket transport** — implement `T3CodeRpc` over T3's Effect‑RPC envelope and
   depend on `@t3tools/contracts`; map `thread.meta-updated.worktreePath` into the workspace.
3. **SQLite stores** — `EventStore`/`ArtifactStore`/`DocumentStore`/`ClaimStore` over
   `node:sqlite` for large histories; JSONL remains the reviewable default.
4. **Maintain stage** — a `custom:metrics-watch` node (or a scheduled trigger) that turns
   breached production controls into new Requests, closing the playbook's loop.
5. **Remote workspace sync** — optional rsync/`git push` step for SSH hosts that do not share
   a filesystem with the orchestrator.
6. **ACP terminal capability** — serve `terminal/*` so agents that require it can run tests
   through ORCA (currently `terminal: false`).
7. **Session resume** — use `session/load` for agents that support it so a retried step can
   continue the same conversation.
8. **Client‑surfaced selection of agent, model and workflow** — the client above ORCA should
   pick these the way Kepler picks a model for Claude Code. The mechanism is ACP
   [session config options](https://agentclientprotocol.com/protocol/session-config-options)
   (the successor to session modes, already in `@agentclientprotocol/sdk@^1.4.0`): the facade
   advertises `configOptions` from `session/new` and honours `session/set_config_option`
   (#188), proxying the sub‑agents' own model lists upstream with `config_option_update`
   (#189, over the downstream session surface #185). Underneath it, a run needs an override
   record for role→agent, model and item workflow that replays faithfully and children
   inherit (#186), the model has to reach the turn (#187), the CLI needs the same flags so
   it is not ACP‑only (#190), and prompt templates become selectable packs (#191). `/run`
   and `/status` become advertised slash commands in the same pass (#192).
9. **Desktop app** — the Electron shell in `packages/app` is a placeholder renderer that
   proves the app → preload → main → daemon path, styled with the design system's CSS.
   The design system itself is done: tokens in both themes, the CSS component layer, the
   typed status maps (`packages/design`) and the brand book, rules and surface specs
   (`docs/design/`). Next, in order: bundle IBM Plex Sans/Mono as woff2 (the `type.fonts`
   list in `tokens.json` is empty, so the fallback stacks are in use); pick the renderer
   bundler and build the React layer over `components.css` to the props in
   `component-api.d.ts`; then phase 1, run monitoring (attention, run tree, event timeline,
   artifacts, answering gates) against the daemon methods of item 1. Phase 2 makes it the
   first‑class configuration and monitoring surface (config, agents, plan); the dependency
   graph goes in as a mode of Plan with a docked inspector unless use shows it is a
   starting point (`docs/design/80-dependency-graph-options.md`). Workflow editing
   (`docs/design/70-workflow-editing.md`) comes after the viewer and needs the runtime to
   execute a run against the workflow version it started with, not only the newest; a run
   already records its workflow version.
10. **Planning: capacity and milestones** — the scheduler orders by dependencies, risk and
    priority but has no notion of agent capacity per host, calendar milestones or due dates
    beyond `Decision.dueBy`; add `Milestone` records and a capacity model per host/agent.
11. **Planning: realised risks reopen work** — `risk.status: realized` is recorded but does
    not yet create a follow‑up Request (ties into the Maintain stage, item 4).
12. **Planning: matrix confidence gates** — the shipped program auto‑decides from the matrix;
    a `decision` node with `source: matrix` plus a gate on `confidence == 'close'` would
    route close calls to a human. All inputs exist.
13. **Planning: cross‑plan dependencies and indexes** — one plan per product is assumed and
    the scheduler re‑reads the whole plan per pass.
14. **Planning: review findings** — filed as issues #71–#84 when the planning layer was
    rebased onto main. Done: cycle detection ignores `soft` edges (#71); a work‑item claim
    stops two dispatchers from launching one item twice (#72); artifact intake is
    serialised per plan (#73); work‑item status is projected from the event log, with the
    plan side following it (#74); `custom:plan-dispatch` drives the same `FanOut` as
    `parallel`, so `failFast` cancels in‑flight items, the journal is watched before the
    plan is read, and `onWaiting: wait` logs one event per reason under a default timeout
    (#96, consolidating #75/#76; the per‑wake full‑plan recompute #83 named there is item
    13's); scheduler explanations, the critical path and cycle messages agree with each
    other (#80; the remaining critical‑path overlaps are #108); the JSONL event store and
    plan journal number events on disk under a lock file, so two processes over one store
    extend one log (#97, consolidating #78/#87); driving a run takes a single‑writer lease
    that is heartbeated while an interpreter is attached, so a second one is refused rather
    than interleaved, and `orca leases` lists and breaks them (#101); `custom:decision-matrix`
    no longer re-decides a decision the artifact intake already made (#79); `orca claims`
    lists and releases a dead run's work‑item claims (#88; the released item still reads
    `in-progress` to the dispatcher, #123). The rest are smaller:
    #77, #81, #82, #84, #104 (a
    `decided` decision is re-decided by a different choice without reopening it, so the
    decide loop can undo a human's pick), #105 (intake reconciles on unchanged signals), and
    the #97 follow‑ups still open: the artifact index appended without the lock (#102), and
    lock liveness across pid namespaces (#103) — the lease's heartbeat answers that question
    for runs, the lock file still decides on pid and age alone. #101 left two of its own:
    the document stores rewrite whole collections from a cache that is never invalidated, so
    the lease's guarantee stops at the run log (#196), and breaking a live lease leaves a
    one‑heartbeat window in which the old interpreter can still append (#197).
