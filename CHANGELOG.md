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

No change.

### Added

### Changed

### Fixed

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
