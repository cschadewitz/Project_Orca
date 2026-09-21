# Changelog

Notable changes to ORCA, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the versioning policy, the
milestone-driven release flow and what counts as a breaking change are in
[docs/RELEASING.md](docs/RELEASING.md).

Every release carries a **Store format** section, because ORCA is event-sourced: a change
to the event log, plan journal, artifact index or config schema can invalidate an existing
`.orca` store, and that is the change most likely to bite an operator who upgrades.

Entries are not written into this file. The PR that makes the change adds a fragment to
[`changelog.d/`](changelog.d/), prefixed with the area the commit uses (`engine:`, `plan:`,
`store:`, `cli:`, …); preparing a release renders the fragments into a dated section here
and deletes them. One file per entry is why two pull requests in flight no longer conflict
over this one. `changelog.d/README.md` has the naming.

Releases start at 0.2.0. `0.1.0` was the untagged groundwork commit (`8645f28`,
2026-09-15); everything below landed on top of it.

## Unreleased

Pending entries live in [`changelog.d/`](changelog.d/), one file per entry; preparing a
release renders them into a dated section below. Run `node tools/release.js notes --unreleased`
to read them as they stand.

## 0.4.0 - 2026-09-21

### Store format

Two event payloads grew, and both old shapes still read, so **an existing `.orca` store needs
no migration** — point this release at one and it replays as it did, including runs parked at a
gate.

`agent.update` now carries the tool call's arguments and its result alongside the title and
status it already had. Each is capped at 2,000 characters when the event is written, and stored
with the length it had before the cap, so a reader can say "this was 48,000 characters, you are
seeing 2,000" rather than guess: a tool call that reads a large file does not put the file in the
log. Both fields are optional, and every `agent.update` written before this release simply has
neither — a tool call row from an older run shows its title and offers nothing to expand.

`human.requested.options` was a list of strings and is now a list of records —
`{ id, label, consequence?, destructive? }`. `id` is what an answer carries, so a label can be
reworded without invalidating a `human.answered` already in a log. A bare string in an older log
reads as `{ id: s, label: s }`, which is exactly what it meant: the words were both the identity
and the label, and the answer recorded against them still matches. Gates written from here on
store records, so the two shapes coexist in one log without either being rewritten. Nothing in
this release produces a `consequence` or a `destructive` option yet; the fields exist so the
attention surface can carry them without a second store change.

Both changes are in the same discriminated union and landed together, deliberately: this is the
only store-format change in v0.4.0, and the cost of one grows with every real event log.

No change to an existing `.orca` store: the event log, plan journal and artifact index are
untouched, and so is `orca.config.yaml`.

There is one new file, and it is not in the store. `orca.permissions.json` appears beside
`orca.config.yaml` the first time someone answers an agent's permission prompt with
"always"; until then it does not exist, and a workspace without one evaluates permissions
exactly as before. It is a project file rather than store state on purpose — the grants in
it are meant to be reviewed — so decide whether to commit it or ignore it the way you would
any other file in the repository. Committing it is the intended default.

The `permissions:` rules in `orca.config.yaml` keep their meaning and keep their precedence:
they are evaluated before anything in the sidecar. A rule may now match on `path:` (one
exact location, resolved against the run's workspace when relative) as well as the existing
`pathPrefix:`; configs written before this release parse and behave unchanged.

Two event payloads grew, both additively, and neither old shape stops reading, so **an
existing `.orca` store needs no migration** — point this release at one and it replays as it
did, including runs parked at a gate.

`human.answered` gains `note`: the free text a person writes beside their answer. It was
accepted by `inputs.answer` and by `orca answer` before, and it went to the *operator's* log,
because the event had nowhere to put it — reasoning that a person believed they had attached
to a decision, living instead in whichever terminal the daemon was logging to. It is now
recorded with the answer. The run still branches on the answer alone. The field is absent on
every answer written before this release and on every answer given without a note, and it
must stay absent rather than render as empty.

`human.requested` gains `agent`: `{ id, hostId }`, the agent whose turn a permission ask is
holding open (#248). It is recorded rather than looked up because the `input.opened`
notification is a pure function of this one event, and a push that had to scan a log to say
who is waiting would turn every append into a projection. Only what the moment of asking
knows is stored; a host's *transport* is configuration, so it is resolved from the registry on
a read and never frozen here. A workflow gate has no agent and writes no field, and a
permission ask recorded before this release has none either — `inputs.list` answers for those
logs from the `agent.session.opened` scan it already did.

Not a store change, but in the same area and worth reading together: a workflow's gate and
decision options may now be records rather than words (#247). That is the *authoring* shape
in `orca.config.yaml`'s workflows; what the log holds has been
`{ id, label, consequence?, destructive? }` since v0.4.0's wave zero, and a bare word still
reads as an option that is its own id and label.

### Added

- **app:** `VirtualList`, the list substrate every list surface is built on: a window over
  fixed-height rows read from `--row-h`, a clickable status minimap over the whole list, a
  sticky context header that lifts only once content is beneath it, and `J`/`K`, the arrows,
  `Home`/`End` and the page keys registered in the keyboard map's `list` scope. The Runs
  surface is the first to adopt it, so a store of fifty thousand runs is a few dozen rows in
  the document.
- **app:** the Runs surface is a run tree. A run opens into its step groups, its earlier
  attempts, its child runs and the fan-out branches that never ran, from one `runs.get` per
  run and then `run.changed` and `step.changed` — never `agent.update`. `→`, `←`, `⇧→`,
  `Enter` and `F` are registered in the `run-tree` scope beside the substrate's movement
  keys, indentation stops at six levels with the ancestor chain in the sticky header, and a
  running run draws an indeterminate meter: ORCA has no completion percentage and none is
  invented.
- **app:** the event timeline, under the run tree: the selected run's log, paged backwards
  from `runs.events` and tailed forwards from `event.appended` and `agent.update`. A
  coalesced batch of agent updates is one row and says how many; a gate a policy settled
  renders quietly and names `gate:auto` rather than a condition the event does not carry.
  The sticky header shows the current step and the run's own cursor — "as of event *n*" —
  because sequence numbers are per run and the status bar's store-wide cell has no single
  number to show.
- **protocol/daemon:** `runs.events` takes a `stepRunId` filter beside `types`, which is how a
  step's output is read (#158). A step's output *is* the `agent.update` events it appended, so
  it is one filter on one method rather than the `steps.output` method the issue sketched — a
  second method would have meant a second cursor semantics for file mode and the read-only
  daemon to support. The filters are an AND, run-level events match no step, and the cursors
  stay the run's own sequence numbers, so paging back from a page's `prevCursor` crosses a trim
  boundary with no gap and no duplicate. One consequence worth knowing: a client buffers
  **events, not lines** — one `agent.update` renders many lines, so the design's "last 50,000
  lines" is a count of events on this wire.
- **app:** step detail and the agent output pane. A step says its node, attempt, agent, host
  and duration, lists the artifacts it produced as chips, folds its `agent.update` events into
  tool-call rows — arguments, result, and the permission ask that settled it — and streams its
  output as fixed-height lines at `row-log` over the list substrate. The stream follows or is
  held, offers **Jump to latest** with the count of new lines, buffers the last 50,000 events
  and pages backwards across the trim boundary with **Load earlier output**; `G`, `⇧G`, `/`
  and `N` / `⇧N` are on the keyboard map in the `stream` scope. A reconnection leaves
  `◷ paused — reconnecting` and `── reconnected hh:mm:ss ──` inline, where the gap fell. With
  a run selected and no step, the same pane is a minimal run summary. No cost and no token
  count: ORCA cannot supply either, so the header's sixth metric slot stays empty.
- **app:** the docked artifact panel. An artifact chip, a version strip and the panel's open
  state are one seam: the artifact is an address — `{ runId, name, version, compareWith? }` —
  held above every surface, so a step's chip opens it today and a deep link can open it later.
  `[` and `]` step versions in the `panel` scope, a body the daemon declines shows its reason
  in words where the body would have been, consumed-by links come from the run's steps, and a
  comparison renders as a line diff with `+` / `−` gutters, never colour alone. Markdown is
  raw: the rendered toggle is absent rather than disabled, because a renderer is a dependency
  decision (#245).
- **protocol/daemon:** `artifacts.list` and `artifacts.get` — the artifact index filtered by
  run, name, kind or producing step, and one artifact with its body (#159). `version` is
  monotonic per (run, name), so asking `artifacts.list` for one name in one run is the version
  list the docked panel steps through, and `artifacts.get` takes either an `artifactId` or the
  `runId`/`name`/`version?` triple a deep link carries. A body that is not text, or is past the
  call's `maxBytes`, is declined with the reason rather than served or refused: the panel still
  shows what the artifact is. Both are in `READ_METHODS`, so `hello` advertises them and a
  read-only daemon answers them; protocol version is now 1.3.
- **app:** `inputs.answer`, `runs.cancel` and `runs.resume` on the preload bridge, and an
  `alerts` channel beside it for the OS-notification half. `runs.start` is deliberately not
  there: starting a run needs a workflow picker the app does not have yet (#178).
- **protocol/daemon:** the control methods (protocol 1.4) — `inputs.answer`, `runs.resume`,
  `runs.cancel` and `runs.start`. The daemon takes each run's single-writer lease before it
  appends and refuses a run another live process holds, with that holder's pid and host,
  rather than waiting on it. Four new error codes say which refusal it was:
  `INPUT_ANSWERED`, `INPUT_OPTION_UNKNOWN`, `RUN_NOT_WAITING`, `RUN_LEASED_ELSEWHERE`.
- **cli:** `orca serve` drives runs by default and `--read-only` opts out, leaving the
  control methods out of the dispatch table *and* out of `hello.methods` and dropping
  `runs.control` from `hello.capabilities`. The port carries no authentication: any local
  process can call them, and the lease guards against a second writer rather than against a
  caller — said plainly in `orca serve --help` and in ADR 0008.
- **cli/daemon:** `orca answer` and `inputs.answer` are one shared function, so the CLI and
  the wire cannot drift on what answering a gate does.
- **app:** the Attention surface, and the first writes the desktop app makes. Permission
  asks and gates are cards — the question, the run and work item it belongs to, how long it
  has waited, the artifacts the decision is about as chips that open the docked panel, and
  the options with their consequence clauses — answered in place with `1`–`9`, `Enter`,
  `⇧Enter` for a note and `J`/`K` between cards, so five gates clear in five keystrokes and
  the count goes five to zero without navigating. The destructive option is never bound to
  `1` and is never the selection a card opens with — a person may still choose it, and then
  `Enter` sends it, because the rule is that it is never hit by accident, not that it is
  unreachable. A gate whose artifacts did not load has its
  options disabled with that reason on the control, and so does every answer when the
  connection cannot write — `useWritability()`'s sentence, verbatim, on a read-only daemon
  as much as on a dead socket. Answering "always" writes a standing rule into the workspace
  sidecar and the card reports what was actually written: it says "ORCA will not ask again"
  only when a rule was added, and says ORCA *will* ask again when the daemon could derive
  none. Failed runs are listed below the waits, out of the count. The same two cards are
  exported for step detail to render inline in a run.
- **app:** a step parked on a gate or an agent's permission ask renders that ask **inline in
  the run**, as the same card the Attention list draws and with the same controls — the
  design's requirement that a card be answerable where a person finds it, rather than only
  on the surface that collects them. It reads the one waiting feed the title bar's count
  comes from, so answering in either place moves the other and neither holds a second
  opinion about the number.
- **app:** one waiting count, in three places. `inputs.list` sends the number so that no
  client recounts it, and the title bar's `◆ n waiting`, the sidebar's Attention row and the
  dock badge are all that number — permission asks and gates summed, hidden at zero. It is
  read once, in the chrome, so it is live on whichever surface is showing.
- **app:** OS notifications, per the tier table and opt-in per tier. A permission ask
  notifies immediately, a gate sixty seconds after it was asked, a failed run when it fails;
  the default is permission asks only, with an unfocused-escalation interval that lets gates
  through when the window has been ignored. They coalesce — a second ask updates the count on
  the notification already showing rather than stacking a second behind it — and clicking one
  goes through the same route table a pasted link does: a waiting ask lands on its card, a
  failed run on that run, and an alert whose ask has since been answered on the surface,
  which is all there is left to say about it. A permission ask may take the person's attention
  only inside a window that already has focus, and nothing in the app raises a window at
  anybody. The preference lives beside the theme and the densities in `preferences.json`.
- **app:** the five connection states, decided once. A state machine in the main process
  (`src/main/connection-state.ts`) folds the WebSocket's own state, the bundled daemon's
  exit and the `hello` handshake into `live`, `reconnecting`, `disconnected` or `mismatch`,
  and pushes it to every window over a new `connection` bridge namespace. Leaving `live` is
  silent for five seconds, so a blip that resolves in 400ms changes nothing on screen; after
  that the status bar changes and a 2px stale rule appears under the chrome. The connection
  indicator has moved from the title bar to the status bar and carries the event cursor. A
  daemon that comes back speaking a protocol the app cannot type-check blocks once, with
  both versions, and leaves a persistent bar behind. The app also derives "can write, or why
  not" from the state plus the daemon's `runs.control` capability — absent means writes are
  unavailable and says so calmly, which is every daemon today.
- **app:** file mode. **File ▸ Open a store…** points the running app at any workspace,
  read-only: the daemon this process started is stopped, one is started with `--read-only` on
  the chosen directory, the client and the push stream are rebuilt and the connection machine
  is reset — with every bridge call in flight waiting on the switch rather than reading from a
  daemon that is being killed. There is no second store path in the renderer (ADR 0008): the
  read-only daemon omits `runs.control`, so every write is already absent, and the banner names
  the store and offers **Connect to a daemon**. The app also has an application menu for the
  first time, which is what carries those two commands and the standard clipboard roles.
- **app:** `orca://` deep links. The scheme is registered, the app takes the single-instance
  lock — so a second launch focuses the window that is open rather than opening another onto
  the same store — and a URL arriving on a cold start, through macOS's `open-url` or through a
  second launch's command line is resolved by one route table with the palette's jump row and
  **Copy link**, which every object header now offers. A link that arrives while no daemon is
  answering lands on the object's surface with its id shown rather than being dropped, and a
  URL this version does not understand says so with the URL in it. Two corrections to the
  design's table, made in the same pull request: an artifact link carries `?run=`, because
  versions are monotonic per (run, name) and a bare name addresses nothing; and
  `orca://item/…` and `orca://workflow/…` land on their unbuilt surfaces honestly rather than
  being errors.
- **app:** an `orca://run/<id>/step/<node>[.<attempt>]` link selects the row it names, not
  just the surface it is on: the run in the tree, the step in the pane beside it, and the
  timeline moved to that step's first event. Without an attempt the link means the latest
  one, which is the row the tree shows. A notification click is the same journey — it builds
  the ask's canonical URL and goes through the one route table every other arrival uses.
- **app:** the Agents surface. Every configured agent as a health card, grouped by the host
  it is spawned on, with the handshake state as a glyph and a word, both of its timestamps,
  the round trip of the last successful handshake, and — on a card that is down — the error
  that explains it. An agent nothing has contacted reads `unknown` and says so ("not
  contacted since the daemon started"): health is tracked in the daemon's process and never
  persisted, so that is the honest answer rather than a missing one. The list is read once
  and every later change arrives as an `agent.changed` push; nothing polls and nothing
  re-reads. What is claimed right now travels with the same read and is shown beside the
  agents, as the work item and the run holding it.
- **app:** the app has one polite live region, and the output pane is a `log` region that
  never speaks. The announcer is mounted once by the chrome and fed from the notification
  stream every surface already listens on — step transitions and terminal states only, in the
  design's own words ("build step failed, 3 attempts"), with a step's node name remembered
  from the frame that introduced it and its id said when no frame ever named it. The output
  pane now carries `role="log"` and the name of the step it belongs to, with an explicit
  `aria-live="off"` beside it: the role is what puts a step's output in the region list a
  person navigates by, and the `off` is what keeps forty lines a second out of their ear
  (RULES.md rule 11).
- **app:** an interruption card is named by its tier first — "gate, Ship release 1?" — the
  same status-first ordering the run rows and the agent cards already take, which is what
  makes a greyscale screenshot and a screen reader say the same thing.
- **release:** desktop and daemon artifacts, built from the tagged commit and attached to
  the release. The desktop app is packaged per platform by electron-builder — AppImage and
  archive on Linux, dmg and zip on macOS, NSIS installer and zip on Windows — and the
  daemon is the CLI bundled to one ESM file, shipped both inside the app and beside it.
  **Both are unsigned**: macOS quarantines them and Windows SmartScreen warns about them,
  and `docs/RELEASING.md` names the secrets that fixing it needs.
- **app:** a packaged desktop app starts its own daemon. It picks `ORCA_DAEMON_URL` if set,
  then the bundled daemon on a free loopback port, then the default local `orca serve`, and
  stops what it started when it quits. The workspace it serves is `ORCA_WORKSPACE` or the
  user's home directory until the app can choose one.
- **app:** a shortcut may have no key. `Shortcut.key` is optional, a keyless command takes a
  slot of its own in the registry (so the duplicate-key throw that finds real collisions is
  untouched), `handle()` cannot dispatch to one, and the palette renders its row with no chip
  beside it. **Cancel the run this is waiting on** and **Resume the run this is waiting on**
  are the first two: real write actions, reachable from the palette and nowhere else.
- **app:** the command palette lists objects. Navigation carries the ten most recent runs and
  the configured agents with their handshake health; Search covers step and artifact names.
  Every row is a canonical `orca://` URL opened through the route table, which is what keeps
  one resolver rather than three, and nothing polls: each source reads once and a `run.changed`
  or `agent.changed` drops what it holds. Event text and artifact contents are not searched —
  the protocol has no text-search method, and scanning every log in the store per keystroke is
  not a search.
- **app:** the bundled faces are checked by machine on Linux, macOS and Windows. A second
  job in the app smoke workflow launches the dev-only `#type` surface on all three runners
  and diffs committed per-platform screenshots of its two theme columns, with the bundled
  faces on and off, so a glyph that quietly falls through to the operating system fails a
  pull request instead of going unnoticed on the machine that happens to have the typeface
  installed (#213). It also asserts, without needing a baseline, that no bundled
  `@font-face` ended at `error` and that flipping the fallback toggle actually changes what
  is drawn. `#type` stays out of production builds exactly as before: the spec starts a Vite
  dev server and points the main process at it through `ORCA_RENDERER_URL`, the seam
  `pnpm --filter @orca/app dev` already uses. `docs/DEVELOPMENT.md` ("Screenshot baselines")
  has how the baselines are created and the one honest way to update them.
- **core:** a permission policy can be written, not only read. Answering an agent's
  permission prompt with "always" derives a rule from that one request and appends it to
  `orca.permissions.json`, a sidecar beside `orca.config.yaml`, layered *after* the agent's
  configured `permissions:` rules so configuration always wins. Rules carry the time they
  were added and the tool call they were granted for, because a standing permission grant
  should be readable in a diff. Paths are workspace-relative, so a grant still applies in the
  next run's git worktree; a `path:` match on a rule is new and exact, where `pathPrefix:`
  stays the hand-written broad form. The derivation refuses to widen — never a parent
  directory, never anything outside the workspace, and an `execute` grant is scoped to its
  command rather than to the directory it ran in — and refuses to write a rule around a run
  id or a temp path that could never match again, reporting the refusal so the caller can
  honour the answer just once. See ADR 0009.
- **agents:** handshake health per agent (#222). `AgentRegistry` now carries an
  `AgentHealthTracker`: every agent session the interpreter opens records a successful
  handshake with its round trip, and every spawn or handshake that fails records the
  opposite, so the Agents surface has a state to read instead of inventing one. The states
  are `unknown`, `ok`, `degraded` and `down`. `degraded` means the handshake succeeded only
  after a retry — there is deliberately no latency threshold, because ORCA has no data yet
  for a defensible round-trip bound over ssh; the round trip is recorded either way so one
  can be added later. Nothing polls: health only ever reflects sessions a run asked for.
  Health is held in memory only, so a restarted daemon reports every agent as `unknown`
  until it is next contacted rather than claiming `ok`.
- **protocol/daemon:** `agents.list` and `agents.ping`, and the `agent.changed` push behind
  them. Both are answered by a `--read-only` daemon: neither touches a run, a lease or a log.
  `agents.list` reports every *configured* agent — `unknown` for one nothing has contacted,
  never a fabricated default — alongside the claims that say what is being worked right now.
- **agents:** two timestamps per agent instead of one. `lastHandshakeAt` is when ORCA last
  established a connection; `lastSeenAt` moves with the agent's output, so a pooled per-run
  session that handshook an hour ago and spoke a second ago can say both. `agent.changed`
  fires from a listener on the health tracker — a handshake succeeding or failing, never the
  per-batch `lastSeenAt` refresh.
- **cli:** `orca ping <agentId>` calls the daemon's `agents.ping` when one answers on the
  configured address, so the result lands where the Agents surface can see it. With no
  daemon it handshakes in-process as before and says, in those words, that it recorded
  nothing.
- **app:** `VirtualList` takes a `scope` — `list`, `run-tree` or `stream` — so one screen can
  hold three lists and `J` still means "next" in whichever one the focus is in. One list per
  *scope* rather than one per screen; two in one scope still throws, which remains how a
  collision is found. It also takes `follow` with an `onHold` that fires once when a scroll
  leaves the end, and exposes `reveal(index)` and `shiftBy(rows)` on a ref — `shiftBy` being
  what a list that pages *backwards* needs, since without it "load earlier" throws a person
  back by exactly the page they asked for.
- **protocol/daemon:** `OpenInputView` and the `input.opened` notification carry `agent` —
  `{ id, hostId, hostType? }`, the same three fields and the same names as `AgentView`, so a
  client folds one vocabulary. A permission ask holds an agent's turn open and the card has
  to say whose; until now that was an `agents.list` away, and the attention surface's design
  forbids a card that needs a further call. It is optional because a workflow gate is nobody's
  agent: absence means no agent is blocked, never a field that failed to load. `hostType` is
  absent when the host has left the config, rather than guessing the commoner transport.
  Protocol version 1.6.

### Changed

- **tests:** the suite caps itself at four workers, or the machine's own default where that
  is lower (`VITEST_MAX_WORKERS` overrides). Vitest's default is one worker per core less
  one, so the suite's memory footprint was a property of whichever machine it ran on and
  nothing bounded what two concurrent runs cost. Measured on an 8-core box: 7 workers is 45s
  at 3,249 MB peak, 4 is 50s at 2,217 MB — 11% slower for a third less memory, since the
  suite is startup- and I/O-bound well before it is CPU-bound. The cap can only reduce
  concurrency, never add to it, so a 2- or 4-core CI runner is unaffected.
- **protocol:** `OpenInputView.options` and `input.opened`'s `options` carry the whole
  `GateOption` — `{ id, label, consequence?, destructive? }` — instead of an array of ids.
  A client could answer a gate it had no way to render; it can now show the label, the
  consequence clause and the destructive flag the design requires before offering a choice.
  `id` is still the whole of the answer, and a log written before the model changed still
  reads as options that are their own ids and labels.
- **app:** the Electron smoke test audits every surface that has been built rather than
  whichever one the window opened on. axe runs over Attention, Runs and Agents in both
  themes, with the failing rule ids in the message so a red run says what broke without
  anyone opening the report, and Plan and Config are asserted to be the unbuilt `StateView`s
  they still are — a screen that says "not built yet" would pass an audit and mean nothing
  by it. Alongside it, the greyscale guarantee is now checked rather than eyeballed: every
  status on the attention list, the run tree and the status bar is read out of the DOM and
  compared against the design system's own presentation maps, so a status carried by colour
  alone fails the build, and a `filter: grayscale(1)` screenshot of each is attached beside
  the assertion for the times the guarantee turns out wrong (#167). The audit's fixture adds
  a parked gate, a failed run and a second host on top of the `orca demo` store — the demo
  itself is unchanged, because it runs the workflow to completion on purpose.
- **app:** every element in the renderer that takes a component class now also takes the
  `.orca-text-*` class that class expects (#211). `components.css` stopped setting a type size
  in wave zero, so until now the chrome, the command palette, the Runs surface and the `ui/`
  primitives were all inheriting the shell's 14px instead of the chip's, the crumb's or the
  row's intended size — visible, but not obviously wrong, and nothing failed. 46 elements
  across 16 files change class names only; no markup, behaviour, prop or accessible name
  moved. `#preview` now renders each primitive at the size the design system intends.
- **app:** a test sweeps the `type:` notes out of `components.css` and asserts, over the
  rendered chrome, palette, Runs surface and every `ui/` primitive, that nothing carrying a
  noted class is missing its type class, carrying the wrong one, or carrying two (#211). The
  expected side is read from the stylesheet with `querySelectorAll`, so adding a `type:` note
  to a new component class is enough to put every element that takes it under the test — this
  is the guard the later v0.4.0 surfaces inherit rather than re-deriving.
- **design:** `components.css` no longer sets a type size anywhere (#211). The scale in
  `tokens.json` reaches CSS only as the `.orca-text-*` classes, so a style has one definition
  rather than two: a component class carries the ground, the box, the weight and the track,
  and the element it sits on carries its type class, named by a `type:` note on the rule. The
  two rules that need a size without the rest of a style — the shell root and the empty-state
  glyph — reference the new `--text-<style>-size` and `--text-<style>-line-height` custom
  properties, which the token build now emits beside the classes. 117 literal `font-size` and
  `line-height` declarations and 23 literal box dimensions went; `pnpm run lint:css` checks
  `components.css` in full, colours and lengths both, rather than for colours only.
- **build:** release notes are written as fragments in `changelog.d/`, one file per entry
  named `<issue>-<slug>.<section>.md`, and `node tools/release.js prepare` renders them into
  the dated `CHANGELOG.md` section and deletes them (#216). Two pull requests in flight no
  longer edit the same region of the same file; `## Unreleased` holds a pointer instead of a
  list, and `node tools/release.js notes --unreleased` prints what is pending. `notes
  <version>` still reads the committed changelog, so the published release body is unchanged.
- **build:** CI fails a pull request that changes `packages/` and adds no fragment under
  `changelog.d/`, so a missing release note is caught while the change is fresh rather than
  at release time (#218). Label the pull request `no-changelog` when the change genuinely
  needs no note.
- **cli/daemon:** the note on an answered gate is recorded in the run's log. `orca answer`
  takes `--note <text>` and `inputs.answer`'s existing `note` reaches `human.answered`
  instead of the daemon's own logger, so a client may show it as something the run holds —
  which the field's documentation previously had to tell it not to do. The run still branches
  on the option id alone; the note is the record of why.
- **app:** `reconnecting` becomes `disconnected` at backoff saturation — three consecutive
  failures at the 5s cap, about twenty seconds of silence. Against a daemon that has gone for
  good the status bar no longer reads "reconnecting… 4m" indefinitely. The rule is a fact about
  the retry loop rather than a stopwatch, so it survives a change to the backoff, and the
  subscription keeps retrying: this changes what is rendered, not what is attempted.
- **design:** the eight classes v0.4.0 wave 1 had to write in the app because nothing in the
  component layer named them are now in `components.css`, beside the things they vary:
  `.orca-stale-rule` (the 2px bar a reconnecting screen wears), the `.orca-dialog` family,
  `.orca-list` / `__scroller` / `__rows` and the two-line row variant, `.orca-bare` (the reset
  a mark that is also a button needs), and `.orca-minimap__tick--current`.
  `.orca-pane__head--sticky` no longer carries the lift — that is `--lifted`, so "sticks" and
  "something is passing under it" are two statements rather than one. `renderer/src/list.css`
  and `renderer/src/chrome/connection.css` are gone; the app writes no CSS of its own again.
- **design:** five tokens the layer kept reaching past — `row-log` (a line of streamed output
  is a row, derived from `mono-log`'s line height rather than restating it), `hit-min`,
  `mark-sm`, `col-time` and `col-lineno`. Five `orca-allow-literal` notes went with them, 38
  to 33. The minimap gutter is no longer a 4×3px click target: the mark still draws at
  `mark-sm` and the button around it is `hit-min` tall.
- **design:** `semantics.json` gains `agentHealth` — `unknown`, `ok`, `degraded`, `down`, each
  with the word and the glyph an agent health card renders, never colour alone, exported as
  `AGENT_HEALTH_PRESENTATION`. `unknown` is first because it is the honest default: health is
  tracked in the daemon's process and never persisted, so a daemon that has just started knows
  nothing about an agent until it contacts one. All four glyphs were already bundled.
- **protocol:** `agent.changed` is now one of the notification methods rather than a push
  beside them. It joins `NOTIFICATION_METHODS` and the `DaemonNotification` union, so
  `parseNotification` validates it and a client routes it off the one stream by name;
  `parseAgentChanged` is gone. It still carries no `runId` and no `seq`, because agent health
  lives in the daemon's memory and has nothing to resume from — a client that folds the
  cursor now tests for a `seq` rather than assuming one, which is the bug this fixes: the
  previous guard compared `runId`s, and on a store-wide subscription that comparison was
  already true. A daemon still sends it only to subscriptions that did not scope themselves
  to a run, and now honours `methods` for it like any other notification.
- **protocol:** `AgentView` gains `hostType` (`local` or `ssh`), taken from the host spec the
  agent's `hostId` names. It is absent when that host has left the config, rather than
  guessing the commoner transport.
- **protocol:** version 1.5. Both changes are additions — a method joins a list clients read
  by name, an optional field joins a view — so a 1.4 client keeps working and goes on dropping
  `agent.changed` as a method it has never heard of.
- **design:** the 32 `orca-allow-literal` notes left in `components.css` are gone, and the
  count is now zero (#244). They were never 32 numbers. `size` gains `bar-*` for a band of
  chrome — `bar-status`, `bar-pane`, `bar-title`, `bar-object` — because a bar is a height you
  read, not a height you click; `badge-*` (`badge-sm`, `badge-md`) for a mark that carries a
  word, which is why a chip, a key cap and a schedule badge sit below `hit-min` on purpose and
  a control may never borrow one; `mark-md` beside `mark-sm`, with `mark-port`,
  `mark-skeleton` and `mark-swatch` for the marks whose size is dictated by what they sit on;
  and `col-label`, `col-label-narrow`, `col-node-kind` and `col-matrix-axis` beside `col-time`
  and `col-lineno`. `control-*` keeps meaning "pointer target" and grows two rungs that do not
  loosen it — `control-xs` (a segment inside a group, where the group is the target) and
  `control-sm-5` (the half rung, named the way `space-0-5` is). `spacing` gains the other two
  half rungs, `space-1-5` and `space-2-5`, for the inline padding of a chip and of a button —
  `10px` had been written out twice for the same button. `border` gains `stroke-double`,
  because `border-style: double` needs three widths to draw two lines.
- **design:** two of those literals were arithmetic someone had written out as a number, and
  are now the arithmetic: a config label's top inset is half of what the control beside it is
  taller by, and the log caret is one hairline proud of the mono-log glyph. Both follow the
  type scale now instead of being re-measured against it.
- **design:** the hatch over the risk matrix's severe band is `hatch-period` with a
  `stroke-hairline` stripe rather than #244's proposed first permanent exemption. Rule 4 makes
  that hatch the second channel on severity, so its geometry is a design decision the system
  should be able to name, and a token it is. `components.css` and `docs/DEVELOPMENT.md` both
  say what a new note would now have to argue: not "no token names this yet" but "no token
  could sensibly name this".
- **core:** a `gate` or `decision` node's `options` may now be records —
  `{ id, label, consequence?, destructive? }` — as well as bare words. A workflow can
  therefore say what choosing an option *does*, and mark the one that destroys something, so
  the attention surface's two safety properties (show the consequence, never bind the
  destructive option to a number key) are properties of real gates rather than of fixtures.
  A bare word still reads as an option that is its own id and its own label: every workflow
  on disk keeps working and there is no migration.
- **core/engine:** everything mechanical about an option is its **id**, and always was —
  `defaultOption`, `autoOption`, the `when: "choice == '<option>'"` on an outgoing edge, the
  value a decision source has to produce, and the answer recorded on `human.answered`. A
  label is for a person and may be reworded without touching the graph or invalidating an
  answer already in a log. `vars.options` and the `fieldValues` an agent-sourced decision is
  validated against carry the ids, so a consequence clause never reaches a prompt as though
  it were a choice.

### Fixed

- **design:** `prefers-contrast: more` is honoured. `docs/design/50-accessibility-and-keyboard.md`
  has asked for it since the design system was written — swap `border-hairline` for
  `border-control`, fold `ink-tertiary` into `ink-secondary`, introduce no new palette — and
  nothing in the tree did it; only the `prefers-reduced-motion` half of that paragraph was
  ever implemented. It is two custom properties rebound on the shell root under the media
  query, so both themes keep their own values and no rule has to know the preference exists.
- **design:** stream rules and run-tree guides are drawn with CSS hairline borders instead of
  box-drawing glyphs, so a continuous guide reads as continuous (#212). At `mono-log`'s
  12px/18px a `│` is shorter than its line box, which left a gap at every line boundary and
  made a guide read as dashed. The line height stays — it is what makes a screen of log worth
  scrolling — and `docs/design/30-long-running-content.md` now records why the structure is
  borders rather than glyphs. The `#type` proof surface still draws its frame with real
  U+2500–257F glyphs, because proving the bundled faces carry them is its job, and it now says
  on the page that the gap there is expected.
- **cli:** `orca --version`, the `orca serve` banner and `hello.orcaVersion` report the
  release version — the root `package.json`, the one the tag and this changelog carry —
  instead of `@orca/cli`'s own `0.1.0`, which no release has ever been. Observable output
  changes: a `v0.4.0` daemon now announces `orca daemon 0.4.0` where it announced
  `orca daemon 0.1.0`, and the desktop app's connection details show the same string.
  `orca --version` is also a flag the CLI now answers at all: it printed the usage text and
  exited 1.
- **app:** a run that ended cancelled no longer reads as a run that failed. The timeline's
  gutter derived its marker from `run.completed` by treating every outcome that was not
  `success` as a failure, but `RunOutcome` has three values — so a run somebody stopped on
  purpose drew the same red tick as one that broke, while the *same* run ending through
  `run.cancelled` drew it correctly. The two now agree, which matters because the gutter is
  what a long run is scanned with (#249).

## 0.3.0 - 2026-09-19

### Store format

New directory `.orca/leases/`, one JSON file per held lease. Nothing reads it except the
process that wrote it, and an ORCA that never sees it behaves as before, so an existing
store needs no migration; leftover files from a killed process lapse and are cleaned up on
the next attach.

Nothing else in this release touches the store. The daemon and the desktop app only read
it — the read methods and the notification stream both project from the event log without
writing to it — and the app's own preferences live in `preferences.json` under the Electron
user-data directory, deliberately not in the workspace. An existing `.orca` store works
unchanged with everything below.

### Added

- **store:** `LeaseStore` — a single-writer lease with a TTL and a heartbeat
  (`InMemoryLeaseStore`, `FileLeaseStore`, `keepLease`), reusing the lock file's
  holder-identity and take-over logic. `Stores.leases` is new.
- **engine:** driving a run now takes the lease `run:<runId>` and heartbeats while attached,
  so a second interpreter over one store is refused with `RUN_LEASED` instead of
  interleaving its steps into the same log (#101). A lease whose holder stopped heartbeating
  — or whose process is gone on this host — lapses and is taken over on the next attach.
  `Orchestrator.listLeases()` / `breakLease()` are the operator's way in.
- **cli:** `orca leases [list | break <runId> [--force] [--keep]]`.
- **daemon:** `orca serve` and the packages behind the desktop app — `protocol` (the wire
  contract: envelope, `hello` handshake, versioning, error codes), `daemon` (HTTP transport
  and the method table; only `hello` so far) and `app` (an Electron shell that completes
  the handshake through the protocol package and nothing else). ADR 0008 records the
  layering.
- **design:** the desktop app's design system — `packages/design` (token sources, the
  generator, generated CSS and TypeScript tokens for light and dark, the CSS component
  layer, WCAG AA contrast tests) and `docs/design/` (the brief, brand book, UI rules and
  surface specs). `pnpm run design:check` in CI keeps the generated files current.
- **app:** the renderer is React, bundled by Vite, with `pnpm --filter @orca/app dev` for a
  hot-reloading dev loop against a running daemon (#145). Main and preload stay on the
  workspace's `tsc -b`; `pnpm run build` produces `packages/app/dist/renderer` alongside
  them. The production CSP (`default-src 'self'`, no `unsafe-inline`) is what ships — the
  dev server's wider policy exists only in memory. The import boundary from ADR 0008 now
  covers the renderer as well as `packages/app/src`.
- **app:** the React primitives over `components.css`, in `packages/app/renderer/src/ui`
  (#147) — `StatusChip` and `StatusDot`, `ScheduleBadge`, `ConnectionIndicator`, `Button`,
  `Chip`, `Card`, `Well`, `ConfigField`, `ObjectHeader` with the counterpart menu per crumb
  type, `StateView`, and `Text` / `Duration` / `Time` over the generated type styles. No
  primitive carries a literal colour, size or glyph: the statuses come from
  `STATUS_PRESENTATION` and the durations render two units at most, ticking at 1Hz off one
  clock shared by the whole renderer.
- **app:** `#preview` in a dev build renders every primitive in both themes side by side,
  driven by the design system's own lists. It is the visual review surface for the rest of
  the desktop-app milestone and is dead code in a production build.
- **design:** `STATE_VIEW_PRESENTATION` and `CHROME_GLYPHS` are generated from a new
  `stateView` and `chrome` section in `semantics.json`, so the state views' glyphs and the
  breadcrumb separator are covered by the bundled-font check like every other glyph.
  `components.css` gains `orca-well`, `orca-menu` and the object header's trail and
  disclosure classes.
- **app:** theme and density (#146). `data-theme` on `<html>` with a persisted preference of
  system, light or dark, cycled by `⌘⇧L`; `data-density="compact"` per surface root,
  toggled on the focused surface by `⌘⇧D` and remembered per surface. Preferences live in
  `preferences.json` under the Electron user-data directory, never in the ORCA YAML. The
  window's native background is the theme's `surface-canvas`, so opening in dark no longer
  flashes white. `installAppearance` sets the attributes before React mounts and
  `AppearanceProvider` hands components its actions, never its state; the keyboard map
  every shortcut registers with (`KeyboardMap`) is the seed of the palette's registry (#149).
- **design:** the generated `prefers-color-scheme` block now sets `color-scheme` too, so
  native scrollbars and form controls follow the OS theme when no `data-theme` is set.
- **app:** the window chrome (#148) — title bar (drag region, platform-detected insets, the
  connection state, the ⌘K affordance), a sidebar over the five surfaces that collapses to
  icon-only below 960px, a primary pane with an object-header slot, a docked panel that
  becomes an overlay below 1100px, and a status bar. Routing between the five surfaces
  lands on Attention by default; the primary pane is the surface root density is remembered
  by, and ⌘1–⌘5 and ⌘\ register in the keyboard map like every other shortcut, so the
  palette (#149) will list them. New tokens: `sidebar-width-collapsed`, the title bar's
  platform insets, and a `breakpoint` family for the two layout thresholds, exported as
  `BREAKPOINTS` in plain numbers because a CSS media query cannot read a custom property.
- **app:** the command palette and the keyboard map registry (#149). `⌘K` opens a palette
  on `surface-raised` over a scrim, with three sections in the order the information
  architecture sets — actions on the current object, navigation, search — and every
  registered shortcut listed with its key beside it. It opens and drives entirely from the
  keyboard, focus returns to where it was on close, and the title bar's `⌘K` affordance is
  now a button, so nothing here is reachable by keyboard alone or by mouse alone. Typing a
  run id or an `orca://` URL offers a jump row; resolving it is #165, so until then the row
  is listed and disabled rather than silently doing nothing. Search sources arrive with the
  surfaces that hold the data — no source is registered yet and the palette says so rather
  than inventing results.
- **app:** the keyboard map now resolves a keypress's scope from focus. A component owns a
  scope by marking its subtree `data-kbd-scope` (`scopeProps`), and a press is offered to
  each scope from the focused element outwards before `global`, so two surfaces can bind
  `F` without colliding. Inside a text entry only modified keys and `Escape` dispatch.
  `Shortcut` gained `section` and `detail`, for where the palette files it and what it
  says underneath.
- **app:** `Esc` goes through a transient layer stack (`LayerStack`): it closes the layer
  that opened last — the palette above an overlaid panel — and a layer holding an unsent
  draft swallows the key instead of discarding it. Nothing takes a draft yet; the rule now
  has somewhere to live when gate cards do.
- **design:** a `z` token family (`z-panel-overlay`, `z-palette`) so a floating layer's
  stacking order is a token like every other value, and `palette-width`,
  `palette-max-height` and `palette-offset-top` for the palette itself.
- **daemon:** the five read methods over `Orchestrator` — `runs.list`, `runs.get`,
  `runs.events`, `inputs.list`, `claims.list` (#150). They answer display read models from
  `@orca/protocol` (`packages/protocol/README.md` is the reference), not `RunState`: a run
  carries a name (work item, else request, else workflow), the eight-value `DisplayStatus`,
  durations and the wait it is in; a run tree carries every attempt, its child runs and the
  fan-out branches that never ran; `runs.events` pages a log by sequence number in both
  directions. `orca serve` now bootstraps the workspace's store, reports `runs.read` and
  lists the methods it serves in `hello`.
- **protocol:** `DisplayStatus` and the one fold onto it (`displayStatusForRun`,
  `displayStatusForStep`) — the engine's run statuses, outcomes and step statuses become the
  eight words `packages/design/semantics.json` draws, in one place, tested against that file
  so the two lists cannot drift. A run that claims to be running with no live lease behind it
  is `stale`.
- **core:** `@orca/core/schemas`, a node-free subpath carrying the domain model and event
  schemas. `protocol` takes its runtime schemas from there rather than the package root, so
  bundling the protocol for the renderer no longer drags `node:crypto` and `node:fs` in with
  it. The root still re-exports every one of them; only a browser bundle needs the subpath.

- **daemon:** `WS /socket` beside the HTTP endpoint, carrying the six `notification`
  messages off `Orchestrator.subscribe()` — `run.changed`, `step.changed`, `agent.update`,
  `input.opened`, `input.answered`, `event.appended`, each with the sequence number (#151).
  The HTTP path is unchanged and a read-only client never opens a socket; `subscribe` over
  `/rpc` answers `NOT_SUPPORTED` rather than "unknown method", and `hello` advertises the
  methods either way. Reconnect costs latency and never data: the daemon attaches its
  listener before reading the log and drops what it already replayed, so resume from cursor
  `n` yields `n+1` onwards with no gap and no duplicate. Agent output is coalesced to one
  frame per step per 100ms, and a held batch is flushed before any other notification for
  the run, so output never lands after the `step.completed` that ended it. `run.changed`
  and `step.changed` never carry `stale` — a lapsed lease is the absence of events, which
  no stream can announce. The socket fans out this process's event store, so a run appended
  by a separate CLI process still appears only on the next read (#196).
- **app:** the Runs surface (#152) — the first screen with real data behind it, and the
  proof of the whole path live. Fixed-height rows from `--row-h` with a status chip, the run
  name in mono, the workflow and version, elapsed or total duration and the agent; `J`/`K`
  and the arrows select, in the `list` scope of the keyboard map. Status filtering is a
  `runs.list` parameter so the daemon filters the whole store; text filtering is local to
  what is held, because the protocol has no text parameter. Updates arrive on `run.changed`
  and nothing re-reads the list; a notification for an unknown run is resolved with one
  `runs.get` and inserted. A lost connection keeps the rows, marks them stale and stops the
  clock rather than accruing an elapsed time against a daemon that is not talking.
- **app:** one `Menu` primitive carrying the popover contract for every popover after it
  (#202) — roving focus, `Home`/`End`, typeahead, `Enter`, and focus returning to the
  trigger on close including on `Esc`. Placement flips rather than clips, decided by a pure
  function over rects so it is testable where there is no layout engine. `ObjectHeader`
  consumes it; its own open state, `Escape` handler and outside-click listener are gone, and
  `Esc` is now only the layer stack's.
- **design:** `#type` in a dev build (#194), the proof surface for the bundled faces — every
  type style with real sample text, the statuses and connection states with their glyphs,
  `mono-id` pairs and a `mono-log` block, in both themes, all derived from `tokens.json` and
  `semantics.json` rather than re-declared. Its toggle swaps the bundled faces for the OS
  stack, which is the only way to see the silent failure #144 could not rule out: a glyph
  that falls through still renders, just in another typeface.
- **tests:** the renderer test kit (#154) — a helper that mounts a component in both themes
  against the real `tokens.css` and asserts on the token it resolves to, and a fake preload
  bridge whose read methods page and filter the way the daemon's does, from fixtures dumped
  from a real `ReadModel` run. Plus an Electron smoke test (Playwright's Electron driver
  against the built app and a demo daemon: the bridge loaded, the handshake reached the
  daemon, both themes, axe clean) in its own workflow, since `ci.yml` installs without the
  Electron binary. The renderer joins the coverage report.
- **tooling:** `pnpm run lint` now enforces rule 1 of `docs/design/RULES.md` (#153) — a CSS
  check rejecting hex colours, colour functions and names, `px`/`rem`/`ms`/`s` quantities
  and bare `z-index` values, and an ESLint rule rejecting colour and length literals in
  inline `style` objects. `0`, percentages and the relative units are allowed. The escape
  hatch is to add the token and rebuild, and both messages say so. `components.css` is
  checked for colours and stacking order only for now; the ~190 literal type sizes and box
  heights it still carries need a type-scale vocabulary `tokens.json` does not have yet.

### Changed

- **protocol:** version 1.2 — `subscribe` / `unsubscribe` and the notification schemas.
  Additive, like 1.1 before it.
- **protocol:** version 1.1 — `HelloResult.methods` lists the methods a daemon answers, so a
  newer client can degrade per screen rather than per daemon. Additive: a 1.0 client is
  unaffected.
- **app:** the preload is built as CommonJS to `dist/preload/index.cjs` (#198). `packages/app`
  is `"type": "module"`, so it was emitted as ESM while the window was created with
  `sandbox: true` — and Electron refuses an ESM preload in a sandboxed window, reporting it
  to the renderer's console rather than failing the launch. `window.orca` was therefore
  `undefined` and every screen would have landed on a renderer with no bridge. The sandbox
  is kept and the module format gives way; the source is now `src/preload/index.cts` with
  its own tsconfig project.
- **engine:** `Orchestrator.cancel()` on a run this process is *not* driving now takes the
  run's lease before closing it, so cancelling a run another interpreter holds fails with
  `RUN_LEASED` rather than racing `run.cancelled` into a log that keeps growing.

### Fixed

- **engine:** `Orchestrator.pendingInputs()` no longer fails for a whole run tree when one
  child's log is missing from the store; that child is skipped, as `runTree` already did.

## 0.2.0 - 2026-09-19

### Store format

No change since the groundwork commit, but two additions an existing store predates:
the plan journal (`plan-journal.jsonl`), and work-item claims. Event sequence numbers are
now assigned on disk under a lock file rather than from an in-process counter, so two
processes writing one store no longer collide (#97).

### Added

- **plan:** a planning layer over the engine — cross-request dependencies, a risk matrix,
  decision matrices and an explainable scheduler that orders work by dependency, risk and
  priority (#85).
- **plan:** `custom:plan-dispatch` drives work items through the same fan-out `parallel`
  uses, so `failFast` cancels in-flight items and `onWaiting: wait` logs one event per
  reason under a default timeout (#96).
- **cli:** `orca claims` lists who holds which work item and `orca claims release <id>`
  frees an item whose owning run died (#88).
- **engine:** human waits survive the process in `pause` mode; `orca answer <requestId>
  <option>` resumes a parked run (#35).
- **agents:** a wedged agent that ignores `session/cancel` is killed rather than hung on
  (#50), with SIGKILL escalation after SIGTERM actually taking effect (#41).
- **build:** ESLint, Prettier and coverage reporting, with thresholds enforced in CI and
  a per-package coverage table on the run summary (#43).

### Changed

- **engine:** one fan-out implementation behind `parallel`, loops and plan dispatch, and
  work-item status projected from the event log rather than tracked twice (#70, #74).
- **engine:** a work item is claimed before it is launched, so two dispatchers cannot run
  the same item twice (#72); artifact intake is serialised per plan (#73).
- **store:** the JSONL event store and plan journal share one on-disk sequencing and
  append primitive, guarded by a lock file (#97).
- **build:** migrated from npm to pnpm, which lets several checkouts on one machine share
  a content-addressed store instead of a full `node_modules` each (#48).
- **cli:** `orca --help` exits 0, and `orca demo` cleans up its temporary workspace unless
  `--keep` is passed (#93).
- **perf:** `orca runs` reads a summary projection instead of replaying every event (#61);
  artifact-presence checks are batched and paced (#54).

### Fixed

- **plan:** `custom:decision-matrix` no longer re-decides a decision that artifact intake
  already settled (#79); risk-matrix thresholds follow the configured scale and reject
  out-of-range ratings (#81).
- **plan:** object-form dependency refs honour `on`, and every intake path rejects what the
  dependency grammar rejects (#77).
- **plan:** scheduler explanations, the critical path and cycle messages agree with each
  other (#80); cycle detection ignores `soft` edges (#71).
- **plan-resume:** dispatch reads `vars.itemWorkflow`, so `program.itemWorkflow` actually
  steers `orca plan dispatch` (#92).
- **engine:** `cancel()` unblocks a run parked on human input (#34); resume re-attaches
  container steps to their child runs (#40); retries and run termination no longer
  hard-code node types (#69); loop iterations see earlier siblings' artifacts (#68).
- **core:** artifact ids are merged on `step.completed` instead of overwritten (#37).
- **acp-facade:** human input is routed per run rather than to one global target (#57).
