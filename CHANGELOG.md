# Changelog

Notable changes to ORCA, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the versioning policy, the
milestone-driven release flow and what counts as a breaking change are in
[docs/RELEASING.md](docs/RELEASING.md).

Every release carries a **Store format** section, because ORCA is event-sourced: a change
to the event log, plan journal, artifact index or config schema can invalidate an existing
`.orca` store, and that is the change most likely to bite an operator who upgrades.

Add your entry to `## Unreleased` in the PR that makes the change, prefixed with the area
the commit uses (`engine:`, `plan:`, `store:`, `cli:`, …). Releasing only dates that
heading, so nothing has to be reconstructed from commit subjects later.

Releases start at 0.2.0. `0.1.0` was the untagged groundwork commit (`8645f28`,
2026-09-15); everything below landed on top of it.

## Unreleased

### Store format

New directory `.orca/leases/`, one JSON file per held lease. Nothing reads it except the
process that wrote it, and an ORCA that never sees it behaves as before, so an existing
store needs no migration; leftover files from a killed process lapse and are cleaned up on
the next attach.

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

### Changed

- **protocol:** version 1.1 — `HelloResult.methods` lists the methods a daemon answers, so a
  newer client can degrade per screen rather than per daemon. Additive: a 1.0 client is
  unaffected.
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
