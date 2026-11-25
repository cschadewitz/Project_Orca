# Shared native lifecycle integration — 8 October

Base main: `db579fb7ac9cfce2e4e6901713088a80602311da`. This draft consumes
exact #560 `4a2deee66be0a34dcbac51084dd249335c440775` (including #556),
#561 `8dcdc0bd9b23c9582374c87b6d0aae40e62ad827` (including #557), and
#559 `61ffe6ddebf1e5e0946e8cf237d9d1218bfa6664`. Their original handoffs and
historical evidence remain intact. Read [Mac native handoff](mac-native-handoff.md)
and [native storage slice](../preparation/crash-recovery/native-storage-slice.md)
alongside this integration delta.

## Shared interface for root and first-run owner

Main mounts `createDiagnosticsInitializer({root, safeStorage, chooseDestination})`
over the existing app-owned diagnostics root, async safeStorage and Save picker.
The returned controller owns the existing subscriptions, IPC and renderer/consent
generation fences. Readiness calls `initialize`; every Workspace bundled startup
passes the enum-only `startupObserver`. Quit calls the initializer's `close`, which
waits for controller cleanup and actual disk settlement before closing native handles.
The ordinary app quit deadline remains bounded; timing out is not storage settlement
or an updater-stop receipt. Production capture remains disabled with no enable option.

Bridge/preload composition retains both #560's `macUpdates` and #559's `guidedLaunch`.
The latter continues using the same main-owned protected intent journal and generic
inspect/reconcile/abandon paths. The separate first-run/sample owner should consume
these existing bridges and leave diagnostics, Workspace and updater lifecycle wiring
to this slice. No first-run screen/sample behavior is added here.

An actual `MacUpdateGuards.prepareAdmission` lease now offers the main-only optional
`stopOwned(signal, operationMs)`. It delegates through the exact Workspace reservation
to the `BundledDaemon.stopForMacUpdate` capability over the captured ChildProcess.
Workspace captures the process ID and stop function; it never looks up or kills a PID,
substitutes another child, touches an external/parked daemon or falls back to normal stop.
Fresh authenticated `maintenance.runtime` proof uses the same token and exact target,
an abort signal, no credential refresh/retry, and existing runtime activity/authority
checks. Draft ownership is checked before proof, immediately before signalling and
after close. Existing `MacUpdateOwnedStop` permits one SIGTERM and requires observed
code-zero, signal-free close plus the child's matching exit fields to mint its receipt.

Starting the stop seals a process-local restart-admission fence before callbacks:
resource IPC (including queued calls/late results), connection changes, live return,
legacy update cancellation and hello identity adoption cannot reopen it. The existing
reconnect stream closes. The admission lease cannot resume after entering stop, and
unknown admission release prevents the coordinator from releasing drafts. Ordinary
quit does not escalate an owned update attempt to SIGKILL or mint a clean stop receipt.
Timeout, lost/malformed/mismatched proof, crash, invalidated drafts and late clean close
retain unknown; wrapper/lease reuse cannot retry or turn unknown into stopped.

This receipt proves only the owned old daemon's clean stop. The local fence is not
durable across app replacement and does not implement a fresh replacement bootstrap.
No positive native commit/recovery owner, `startClosed` producer or full-state restore
port is fabricated. Existing native and restart adapters remain gated; verified startup
alone does not authorize restoration or admissions. A commit owner must retain the
fence and treat any unsuccessful stop as insufficient commit evidence, even if the
stop result itself says refused. No production updater constructor/feed/installation
is enabled, and the preparation-only candidate session remains negative-only.

## Narrow Casey decision

The missing #394–396 restore policy must say what happens to work written after the
selected recovery snapshot. Minimal recommendation for approval: **no automatic
rollback once newer work may exist**. Keep the current complete generation intact,
retain the verified earlier complete protected-state snapshot together with its
matching binary, and keep admissions closed. Explicit operator recovery may select
the earlier pair only after preserving the newer generation separately; never merge,
erase, replay or relabel newer work as compatible merely because a store epoch matches.
Missing/partial protected state or uncertain newer-work detection must stay unavailable
or recovery-required. Diagnostics/export is not a full recovery snapshot.

Generic recovery, parked work, protected intent journals and preserved historical
state remain required. JEV is explicitly deferred and is not made an acceptance
dependency. This proposal is not approval or a restoration implementation. Approved
catalog trust/freshness/revocation and final signed engine/ordinary-quit lifecycle
selection remain independent production-activation gates from #560's handoff.

## Exact portable evidence and handoff

Node 24.21.0, pnpm 12.4.2. No dependency or lockfile changes. Local skill locations
were inspected; no applicable repository/native-integration skill was present.

- Final focused run: **301 tests passed in 15 files**, `--maxWorkers=2`: new native
  lifecycle integration, daemon process, Mac admission/guards/restart/rehearsal,
  workspace, Windows updates, Mac coordinator/native handoff/application,
  actual sandboxed preload, diagnostics native storage/startup producer, and
  guided-launch adapter. The Linux storage syscall fixture is included.
- Nine new integration cases attach the production bundled owner to the existing
  independently spawned disposable authenticated daemon fixture's exact ChildProcess.
  The fixture supplies bootstrap metadata/spawn attachment and window ACKs; actual
  owner-token RPC, runtime admission, SIGTERM, close and exit fields are exercised.
  They cover clean once-only stop, unknown timeout/late close, no quit-time escalation,
  lost/legacy/wrong-instance/wrong-process proof, invalidated drafts, external/wrong
  target no-touch, queued/late call fences and retained drafts/admissions.
- Root TypeScript no-emit check, renderer typecheck, focused main/preload compilation,
  changed-file ESLint, changed-code Prettier and diff checks passed. No broad suite,
  coverage, release workflow, addon build or native host installation was run.
- Initial 66-test run passed; its static checks found test-only use of
  `Promise.withResolvers` beyond the repo's library target and an unbound method.
  Both were corrected without changing compiler settings or weakening assertions;
  final statics and focused regression run passed.

Mac/Windows hosts were unavailable for this task. Packaged native addon placement/load,
Keychain/DPAPI and native storage/clock durability/privacy, signed N→N+1 engine/ATS/quit
behavior, complete protected-state capture and matching-binary restore, durable
replacement admission identity and physical acceptance remain unproven. No signing,
credential/access/security change, provider or live host operation occurred.

Root owns full CI, independent review and merges. Root reported #559's known
`JSON.parse(String(init?.body))` lint failure in `guided-launch-adapter.test.ts`;
the separate first-run owner is correcting it. This draft preserves that source file
and requires root to compose that fix before combined CI acceptance. This author
publishes one coherent draft PR, pushes once and stops without beginning another slice.
