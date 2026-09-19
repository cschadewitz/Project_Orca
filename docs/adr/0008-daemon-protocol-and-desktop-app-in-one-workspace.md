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
+ The daemon stays the single owner of the domain model; the CLI can become a thin client
  of it later without another contract.
− Electron and its builder are a large dependency closure. CI skips the binary download
  (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`) and never launches the app; desktop packaging gets its
  own workflow with platform runners.
− Every new screen needs a protocol method first, which is more ceremony than importing
  `engine`. That ceremony is the point.
− A separate repository would suit a different team or release cadence for the UI. Neither
  exists today; if one appears, `protocol` is already the package to publish.
