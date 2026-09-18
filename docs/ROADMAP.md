# Roadmap / open items

Groundwork is complete and tested end‑to‑end. Deliberately left for follow‑up:

1. **Daemon mode** — a long‑lived `orca serve` (HTTP/WebSocket) so runs can be watched by
   several clients and Kepler/T3 UIs can attach. Human input already survives process
   boundaries: `pause` mode parks the run in its event log and `orca answer <requestId>
   <option>` resumes it; a daemon would expose the same `Orchestrator.answer()` / `resume()`
   over the wire and keep agent sessions alive across the wait.
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
8. **Visual editor** — the graph model and `toMermaid` are UI‑ready; a web editor for
   nodes/edges/conditions is the natural next surface.
9. **Planning: capacity and milestones** — the scheduler orders by dependencies, risk and
   priority but has no notion of agent capacity per host, calendar milestones or due dates
   beyond `Decision.dueBy`; add `Milestone` records and a capacity model per host/agent.
10. **Planning: realised risks reopen work** — `risk.status: realized` is recorded but does
    not yet create a follow‑up Request (ties into the Maintain stage, item 4).
11. **Planning: matrix confidence gates** — the shipped program auto‑decides from the matrix;
    a `decision` node with `source: matrix` plus a gate on `confidence == 'close'` would
    route close calls to a human. All inputs exist.
12. **Planning: cross‑plan dependencies and indexes** — one plan per product is assumed and
    the scheduler re‑reads the whole plan per pass.
13. **Planning: review findings** — filed as issues #71–#84 when the planning layer was
    rebased onto main. Done: cycle detection ignores `soft` edges (#71); a work‑item claim
    stops two dispatchers from launching one item twice (#72); artifact intake is
    serialised per plan (#73); work‑item status is projected from the event log, with the
    plan side following it (#74); `custom:decision-matrix` no longer re-decides a decision
    the artifact intake already made (#79). Two that still shape the design: `custom:plan-dispatch`
    keeps its own fan‑out loop next to `runBranches` (#96, consolidating #75/#76/#83), and
    the JSONL event store and plan journal assign `seq` from an in‑process cache, so two
    processes over one store collide (#97, consolidating #78/#87; the prerequisite for
    daemon mode, item 1). The rest are smaller: #77, #80–#82, #84, #88 (no command
    releases a dead run's work‑item claims), #104 (a decided decision can be overridden
    without reopening it) and #105 (intake reconciles on unchanged signals).
