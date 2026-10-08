# Mac guard foundation (#387, dependent on #530)

This slice implements a nonce-scoped draft lease and a reservation of the app-owned
managed target. It does not enable Mac updates or claim the complete guard adapter is
ready for production. PR #530 stays pinned at
`16da467644ed2c9c9ab9ce0effcd22604b6dbda6`; this draft stacks directly on it.
The source inspection also checked main
`6abcdbaa72f26972adfc1ce6f9ef03e0232b47a9`, including #526 shutdown changes.
No shutdown blocks, dependency manifests, lockfile, or native tooling are changed.

## Implemented boundary

`NonceDraftGuard` acquires the main-owned window barrier before capturing document
IDs and generations. A fresh nonce binds prepare and release acknowledgements to
that lease, document, sender, and phase. Unrelated, stale, and replayed messages
cannot acknowledge it. A renderer draft refusal is known only after every captured
document positively acknowledges release. Timeout, lifecycle change, or uncertain
release retains the barrier and returns unknown. A stale lease cannot release its
replacement. `valid()` rechecks the barrier immediately before use.

The `DraftWindowBoundary` is an internal composition port. Its acquire operation must
synchronously fence window creation, document replacement, and interaction before
snapshot; its listener must authenticate main-frame senders and report all lifecycle
changes. The tests provide a bounded synthetic registry. The real Electron registry,
nonce-aware preload acknowledgement, and renderer unlock composition are **not wired**
in this slice. Existing Windows string/null draft messages cannot own this new lease.
Do not compose this port with an ordinary snapshot/broadcast and call it safe.

`Workspace.captureMacUpdateTarget` reserves connection changes before awaiting a
fresh authenticated hello. It requires the owned daemon object, positive PID, explicit
owned token file (environment credentials are ignored), loopback endpoint, the current
UI identity and epoch, compatible protocol, and the exact expected store directory.
External/development, parked, read-only, pending, and staged-connection targets are
refused before contacting them. A staged connection is tracked from before asynchronous
startup until activation/disposal, avoiding a new-target race. A reservation validates
current ownership again after hello and remains checkable until explicit release.
Only the local reservation is released; no remote resume is issued.

Store comparison currently conservatively refuses alternate/symlink spellings. There
is no state reset, migration, credential creation, process kill, or installation.

## Missing authoritative activity fence

`MacUpdateGuards.prepareAdmission` always refuses readiness. Verified ownership returns
`blocked/activity`; identity refusal returns `blocked/identity`; authentication or
transport uncertainty returns unknown. It issues **no maintenance request**. The
existing `maintenance.ready` covers RPC lifetimes, not attached execution after an
acknowledgement, nor live callback/renewal lifetimes. An empty result is not idle proof.

Completing this needs coordinated source-bound runtime observations:

- `packages/engine/src/orchestrator.ts`: authoritative attached/running activity;
- `packages/engine/src/live-input.ts`: pending and accepting callback activity;
- `packages/daemon/src/execution-runtime.ts`: retained origin/authority and renewal activity;
- `packages/daemon/src/maintenance.ts`: atomic admission plus these observations;
- daemon/CLI composition in `packages/daemon/src/server.ts` and
  `packages/cli/src/commands/index.ts` to bind the actual serving runtime.

Those hooks and their wire proof are not invented here. The next owner must establish
how an authenticated app distinguishes the authoritative idle implementation from an
older RPC-only daemon, and verify retained capabilities/operator callbacks cannot create
activity behind the fence. No public grants or protocol schema are changed in this draft.
The #526 handler-drain changes must remain intact during composition.

## Validation and remaining gates

Tests cover scoped acknowledgements, document replacement/creation/destruction signals,
unknown unlocks, a disposable authenticated daemon, wrong PID/store/epoch/instance,
external/parked/read-only/staged targets, and coordinator refusal without maintenance,
stop, or activation. These are Linux-hosted local/synthetic checks, not signed Mac
native acceptance.

Remaining production gates include the real Electron window binding and authoritative
activity proof above, trusted candidate resolution, complete protected-state plus
matching-binary recovery, restart/reconnect identity validation, and native activation.
Physical signed N→N+1, `dev.orca.desktop` → `com.schadewitz.orca` Keychain/intent-journal/TCC
continuity, and unassisted tester acceptance (#390/#388) remain explicitly unrun.
