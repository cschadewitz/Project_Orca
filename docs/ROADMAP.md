# Roadmap / open items

Groundwork is complete and tested end‑to‑end. Deliberately left for follow‑up:

1. **Daemon mode** — `orca serve` exists (`packages/daemon`) with the transport, the
   `hello` handshake over HTTP and the seven read methods it started with over `Orchestrator`
   — `runs.list`, `runs.get`, `runs.events`, `inputs.list`, `claims.list` (#150), `artifacts.list`,
   `artifacts.get` (#159), answering the display read
   models in `packages/protocol` (its README is the method reference). A step's output is
   `runs.events` filtered by `stepRunId` rather than a method of its own (#158). The desktop app
   (`packages/app`) reaches them through `packages/protocol` and nothing else (ADR 0008).
   `WS /socket` carries the six run `notification` messages off `Orchestrator.subscribe()`, with
   a per‑run cursor a client resumes from and agent output coalesced to one frame per step
   per 100ms (#151); the HTTP path is unchanged and a read‑only client never opens a socket.
   The **control methods** landed in v0.4.0 — `inputs.answer`, `runs.resume`, `runs.cancel`
   and `runs.start` (protocol 1.4), with `agents.list` / `agents.ping` and the `agent.changed`
   push beside them. `orca serve` drives runs **by default**; `--read-only` opts out and
   leaves the four methods out of the dispatch table *and* out of `hello.methods`, and drops
   `runs.control` from `capabilities`. The port carries no authentication: any process on the
   machine can reach the control methods over loopback, and the per‑run lease guards against
   a second *writer* rather than against a caller — an accepted cost, said plainly in
   `orca serve --help`. What a gate has to *say* caught up with them at protocol 1.6: a
   workflow's options may be written as `{ id, label, consequence?, destructive? }` and bare
   strings still parse (#247), an open ask names the agent whose turn it is holding and the
   host it runs on (#248), and the note a person writes beside an answer is recorded on
   `human.answered` rather than in the operator's log (#238, `orca answer --note`).
   **v0.5.0 finished the method inventory at protocol 1.7.** The reads are ten —
   `workflows.list` and `workflows.get` draw the workflow files as a display graph and
   `runs.get` gained a `traversal` of the nodes a run took (#174), and `config.get` answers
   with the workspace's two configuration documents (#174, #266). The **plan methods** over
   `PlanService` landed (#169): nine reads under `plan.read` and five writes under
   `plan.write`, `claims.release` among them (#88), with a `plan.changed` push. `config.set`
   writes one of the two documents (#174, #266). That makes ten methods behind
   `runs.control`, all ten absent from a `--read-only` daemon's `hello.methods`. Two things
   are declared and not done: `config.set` **reloads nothing** — the daemon serves the
   configuration it booted with until the next `orca serve` — and `workflows.changed` is on
   the wire with nothing emitting it, because there is no workflow reload path yet. Making a
   running agent session read the permission sidecar as it stands rather than as it booted is
   #271, in flight for this wave.
   Human input survives process boundaries: `pause` mode parks the run in its event log and
   `orca answer <requestId> <option>` resumes it, through the same shared function
   `inputs.answer` calls. What the daemon does **not** do is keep an agent session alive
   across the wait — a gate parks the run to the log, the interpreter lets go, and the step
   that resumes afterwards opens a **fresh** session, so the agent loses the conversation it
   was in the middle of (#237, split out of #160; unmilestoned). `runs.start` takes a
   workflow and vars only: it records `requestId` / `workItemId` on `run.created` and writes
   no request or work‑item document, for the reason below.
   Two processes over one store are safe now. Every interpreter holds a single‑writer lease
   per run (#101), and since v0.5.0 the document stores are safe too: `JsonFileDocumentStore`
   re‑reads a collection under a file lock before every write and renames a uniquely named,
   flushed temp file over it, so a daemon and a CLI command no longer lose each other's
   requests, work items and plan records (#196). What is *not* closed is the push channel:
   the socket fans out *this process's* event store and plan journal, so a run a separate CLI
   process appends is not pushed and only appears on the next read. That is an in‑memory
   listener list rather than a stale store, and a store watcher is what would close it.
   **Open decision for Casey:** `runs.start` stays narrow **by decision**, not because of the
   store. Submitting a request and decomposing it is a workflow with an agent and an artifact
   in it, not a record insert, and growing `runs.start` into it would settle that design
   inside the schema of a method whose job is "run this workflow". A `requests.submit` method
   goes beside it when somebody designs one; until then the daemon cannot create a request.
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
   and `/status` become advertised slash commands in the same pass (#192). **Moved out of
   v0.5.0:** #185–#192, with #126 and #127 beside them, are the milestone **"Model and agent
   selection"** rather than part of the configuration and monitoring wave — picking a model
   is a different question from seeing what the system is wired to.
9. **Desktop app** — the foundation is complete (milestone v0.3.0). The design system is
   done: tokens in both themes, the CSS component layer, the typed status maps
   (`packages/design`) and the brand book, rules and surface specs (`docs/design/`), with
   IBM Plex bundled as woff2 (#144) and a dev‑only `#type` route that proves the bundled
   faces render against the OS stack rather than assuming it (#194). The app is a React
   renderer on Vite with a hot‑reloading dev loop (#145), theme and density through its own
   preferences file (#146), the primitives over `components.css` (#147), the window chrome
   (#148), the command palette over the keyboard map (#149), one `Menu` primitive carrying
   the popover keyboard and focus contract for every popover after it (#202), and the Runs
   surface reading `runs.list` and keeping up from the notification stream (#152) — the
   first screen with real data behind it. The preload is built as CommonJS because a
   sandboxed preload cannot be ESM (#198), literal colours and sizes are rejected by lint
   (#153), and the renderer is tested in both themes against the real tokens with an
   Electron smoke test beside it (#154). v0.4.0 added the three things every later surface
   builds on: the type scale reaches an element as a second class and a test sweeps the
   rendered trees to keep it true (#211); `renderer/src/list/` is the virtualised row
   substrate, with the height read back off `--row-h`, the status gutter over the whole list
   and the list keys on the keyboard map, adopted by the Runs surface (#155); and the
   connection is a state machine in the main process pushed over its own bridge channel,
   which is also where "can write, or why not" comes from (#163). Phase 1's read half is now
   in: the Runs surface is a run tree over an event timeline with step detail beside it and
   artifacts in the dock (#155, #156, #157, #158, #159), and Agents is a grid of health cards
   fed by `agent.changed` (#166). The run's cursor is drawn per run in the timeline's header,
   which is where it belongs — the status bar outlives any one run's selection and has no
   single number to show. Phase 1's write half is in too: Attention is the surface, and a gate
   or a permission ask is answered in place from it or inline in the run it came from, with
   one count (`inputs.list`'s `waiting`) on the title bar, the sidebar and the dock badge and
   OS notifications per tier behind the preference (#161, #162); a command may have no key at
   all and live in the palette alone (#205). The ways in are one route table: `orca://` deep
   links with the single‑instance lock, **Copy link** on every object header, and the palette
   listing recent runs, agents and a search over step and artifact names (#165, #206). File
   mode is real (#164) — **File ▸ Open a store…** re‑points the running app at any workspace
   with `orca serve --read-only` behind it, so the writes are absent rather than disabled —
   and `reconnecting` now gives up at backoff saturation (#239). One thing in that list is
   still not true: writes are not queued while reconnecting, and a control says the daemon is
   not answering rather than promising a send. The accessibility pass and the cross‑platform
   screenshots have landed (#167, #213), which **completes phase 1**: the app announces step
   transitions and terminal states through one polite live region, the output pane is a
   labelled `log` region rather than a narrated flood, `prefers-contrast: more` is honoured,
   axe runs over every built surface in both themes, and the bundled type faces are checked by
   machine on Linux, macOS and Windows against committed baselines. What those checks do *not*
   reach is written down beside them in `docs/design/50-accessibility-and-keyboard.md`, which
   now names the check that enforces each of its paragraphs. **Phase 2 shipped in v0.5.0**,
   "configuration and monitoring": all five surfaces have content. Config is
   `orca.config.yaml` as a form over the schema the daemon describes, beside the raw file,
   with the ADR 0009 permission sidecar as its second document (#175, #266); Agents grew the
   write half — each agent's policy edited where the grants actually live, and `claims.release`
   (#176); the workflow viewer draws a workflow as a derived graph with a run overlaid on it
   (#177); Plan is the schedule table, the scheduler's own explanations, a requests sidebar
   and the journal (#170); and every write the daemon serves is a keyless action in the
   command palette — answer, cancel, resume, start a run, waive, decide, reopen, risk,
   release — with nothing added to any screen's chrome (#178). The sidebar's five surfaces
   have designed glyphs (#261), and #245 is decided: the artifact panel stays raw.
   **Deferred to v0.6.0:** the dependency graph (#171), the risk matrix (#172) and the
   decision matrix (#173) — the three remaining modes of Plan. They are *absent* from the
   object header's mode control rather than disabled, because a segment that never does
   anything is a dead end; the docked-inspector shape they go in as is
   `docs/design/80-dependency-graph-options.md`. **Still not done anywhere:** notification
   tiers (#162), auto‑approval counts (ORCA does not collect that data, and the policy panel
   says so where a count would have gone), a handshake retry from an agent card, and vars on
   `runs.start` — nothing in the protocol says what a workflow's inputs are called, so the
   palette's picker starts a workflow with the workflow's own vars rather than inventing a
   form. Workflow editing (`docs/design/70-workflow-editing.md`, #181) comes after the viewer
   and needs the runtime to execute a run against the workflow version it started with, not
   only the newest; a run already records its workflow version, and `workflows.changed` is on
   the wire waiting for it.
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
    lists and releases a dead run's work‑item claims (#88, over the wire as `claims.release`
    since v0.5.0; the released item still reads `in-progress` to the dispatcher, #123); and
    the document stores write under a file lock and re‑read the collection first, so the
    lease's guarantee no longer stops at the run log and two processes over one store keep
    each other's documents (#196). The rest are smaller:
    #77, #81, #82, #84, #104 (a
    `decided` decision is re-decided by a different choice without reopening it, so the
    decide loop can undo a human's pick), #105 (intake reconciles on unchanged signals), and
    the #97 follow‑ups still open: the artifact index appended without the lock (#102), and
    lock liveness across pid namespaces (#103) — the lease's heartbeat answers that question
    for runs, the lock file still decides on pid and age alone. Of the two #101 left of its
    own, #196 is fixed above; breaking a live lease still leaves a one‑heartbeat window in
    which the old interpreter can append (#197). Carried over and fixed in v0.5.0 besides: a
    lease lost while the context loads refuses the run rather than writing (#267), a streamed
    agent append that fails fails the step (#268), a failed file‑mode daemon start is a failed
    open (#269), an unreadable artifact body fails the step instead of rendering as `""`
    (#270), and an empty artifact version has no lines to remove (#250). #237 and #255 are
    unmilestoned.
