# ADR 0008 — Daemon, protocol package and desktop app in one workspace; the app sees only the protocol

**Status:** accepted

## Context
ORCA is getting a graphical surface: an Electron desktop app for watching runs, then for
configuration and monitoring as a first‑class interface, later for orchestration. The app
and the long‑lived daemon it talks to (`orca serve`, roadmap item 1) must keep their view
of the domain aligned, and the app must also work against a daemon on another machine.
Two questions: where does the app live, and what is it allowed to depend on?

Options considered:

1. A separate `orca-app` repository consuming a published `@orca/protocol` package.
2. The app in this pnpm workspace, importing `core`/`engine` directly for convenience.
3. The app in this workspace, importing a `protocol` package and nothing else from it.

## Decision
Option 3.

- **`packages/protocol`** is the wire contract: message envelope (`request` /
  `response` / `notification`), the `hello` handshake, error codes and a `major.minor`
  protocol version. Zod schemas, so both ends validate at the boundary and the TypeScript
  types fall out of them. It depends on `core` for the domain types and on nothing else.
- **`packages/daemon`** serves that contract in front of the engine. The transport knows
  nothing about any method; a method is one table entry (params schema + handler) plus
  its schemas in `protocol`. HTTP request/response today; a WebSocket carrying
  `notification` messages arrives with the first subscribe method.
- **`packages/app`** depends on `protocol` only, enforced by `no-restricted-imports` in the
  lint config. The renderer is sandboxed and reaches the daemon through a preload bridge
  and the main process's `DaemonClient`.
- Both artifacts (daemon only, and desktop with the daemon bundled) are built from one
  commit, so their protocol versions agree by construction. `hello` still exchanges the
  version, because a desktop build will attach to an older daemon eventually.

## Consequences
+ One repository, one lockfile, one commit per protocol change: adding a method touches
  `protocol`, `daemon` and `app` in the same pull request, and a mismatch is a type error.
+ The app cannot grow a private path into the engine or the stores. "Attach to a remote
  daemon" is the same code as the local case, and the read model is deliberately shaped
  for display rather than leaking `RunState` wholesale.
+ **File mode cost the renderer nothing, because it is the same code path (#164, v0.4.0).**
  "Open an event log without a live daemon" was the one requirement that looked like it needed
  a second store path in the renderer, and it was met by not giving it one: **File ▸ Open a
  store…** stops the daemon this process started and starts one over the chosen workspace with
  `orca serve --read-only`, then rebuilds the client and the subscription. A store on disk is
  read through the protocol like anything else, the control methods are absent from `hello`
  rather than present and refusing, so the writes are already hidden, and what file mode adds
  to the app is a banner and a menu item. The one thing it costs: the mode is an *input* to the
  connection state machine rather than something it can deduce, because nothing about the
  socket or the handshake distinguishes a read-only daemon from a writable one.
+ The daemon stays the single owner of the domain model; the CLI can become a thin client
  of it later without another contract. `orca ping` is the first step of that: it calls
  `agents.ping` when a daemon answers, and falls back to an in-process handshake — saying
  that it recorded nothing — when none does.
− **The daemon is a writer, under a lease (v0.4.0).** It was a projection of somebody else's
  store when this was written; with the control methods it drives runs itself — it answers
  gates, resumes, cancels and starts them, in its own process. Two things follow. First, the
  single-writer guarantee is no longer "one interpreter, several readers" but "one
  interpreter *per run*": the daemon takes each run's lease before it appends, exactly as a
  CLI does, and refuses a run another live process holds with that holder's pid and host
  (#101). A lease that has lapsed is taken over; a live one is never waited on, because a
  client on an open HTTP call cannot tell waiting from hanging. Second, `orca serve
  --read-only` is the way back to the old shape, and it is an omission rather than a refusal:
  the control methods are absent from the dispatch table and from `hello.methods`, and
  `runs.control` is absent from `capabilities`, so a client hides a button instead of
  pressing one that fails.
− **The control port is unauthenticated, and that is accepted.** `orca serve` binds loopback
  and asks nobody who they are, so any process running as the same user can answer a gate,
  cancel a run or start one. The lease is a correctness guard against two interpreters
  appending to one log; it is not access control, and nothing here should be read as if it
  were. `orca serve --help` says so in those words. If that is the wrong trade for a machine,
  `--read-only` is the answer today; authentication on the port is not on the roadmap.
− **The daemon still may not write documents.** Requests, work items and plan records live in
  `JsonFileDocumentStore`, which holds a collection in memory and rewrites it whole, so a
  daemon and a CLI would clobber each other's (#196). That is why `runs.start` takes a
  workflow and vars only and passes `requestId` / `workItemId` straight through onto
  `run.created` without creating either document. Run logs are unaffected — the event store
  re-reads them — which is exactly what makes appending safe and writing documents not.
− Electron and its builder are a large dependency closure. CI skips the binary download
  (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) and never launches the app; desktop packaging gets its
  own workflow with platform runners.
− Every new screen needs a protocol method first, which is more ceremony than importing
  `engine`. That ceremony is the point.
− A separate repository would suit a different team or release cadence for the UI. Neither
  exists today; if one appears, `protocol` is already the package to publish.
