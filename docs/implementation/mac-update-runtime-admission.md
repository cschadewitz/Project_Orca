# Mac runtime admission slice (#387)

This dependent slice starts at #535 head `03b4ea7572f0a355f14022d2f703ca40d6c2fab5`
and incorporates the four files from reviewed #534 head
`ae4f3e2601ae0d27b0a2dad3be0ce492d4ffdcbd` in a separate prerequisite commit.
It supersedes the missing runtime proof described in the preceding
[guard](mac-update-guards.md) and [window binding](mac-update-window-binding.md)
slices. Their pinned branches remain unchanged. The accepted preparation contracts
remain #439 head `39d4cf75b9e46dd267ccf0ae044f29f220fe667d`.

## Serving runtime and idle acquisition

`RuntimeActivity` reserves producer work synchronously before asynchronous entry.
Reservations cover ordinary/continuation interpreter attachments through full
completion, pending callbacks and answer processing, execution authority preflight
and renewal operations, queued request dispatch through settlement, queued direct
receipt verification and its separately detached execution, and queued/attached
continuation work plus startup/timer discovery. Existing interpreter, input,
origin/renewal and continuation task registries supplement reservations. No work
is cancelled, replayed, or awaited as a prerequisite to acquisition: busy work
returns a known blocker so the coordinator can defer.

`startDaemon` binds the actual serving orchestrator, input port, control and all
three admission models to the same runtime. It also checks the UUID boot/workspace
identity and the actual credential/ownership store objects. Incomplete, read-only,
unauthenticated, differently bound, closed, or unavailable composition cannot
advertise authoritative proof. Binding is rechecked on acquisition and release.
The production CLI supplies these models and producer hooks. Arbitrary unbound
embedders retain legacy maintenance only.

The additive `maintenance.runtime` method uses the existing `daemon.maintenance`
grant and mutation audit; it adds no permission or capability enum member. Requests
carry `prepare|resume`, an opaque owner token, and exact UUID workspace/instance
plus positive PID. Strict results carry `proof: runtime-v1`, the same target,
`held|blocked|released`, and closed activity reasons. Held/released results must
have no active reasons. Wrong targets and foreign owner tokens fail before changing
admission. Missing/unavailable runtime returns no positive proof.

Acquisition checks active application handlers and runtime producers, then publishes
the producer and RPC fence synchronously. It rechecks reservations after source
observations to cover reentrant entry. New interpreter, callback, renewal, dispatch
and recovery entry is refused while held. The daemon timer skips recovery behind
the fence. Legacy maintenance cannot release a runtime-owned fence, even using the
same token. A durable admission file cannot be overridden by this method.

#526's transport-handler drain and #534's queued verification ownership/close drain
remain intact. Detached execution has a separate activity lifetime; closing a daemon
still does not await or cancel that execution. The activity gate is an idle proof,
not a protected-state snapshot, process-stop proof, or recovery implementation.

Lease keepers remain in the orchestrator's authoritative registry through their
already-scheduled heartbeat chain. The store exposes that chain as `renewalSettled`
after release begins. A last-confirmed-TTL release can return while renewal still
owns the mutation mutex; that return does not clear runtime activity. The daemon
reports `blocked/renewal` until actual settlement, including a late filesystem write.
No additional shutdown wait, timer, TTL, or takeover rule is introduced. A renewal
that never settles keeps idle acquisition blocked.

The deterministic owned-file regression fails at the original #536 head
`311d265caf3c56056756bcbb3a354fcf119ec070`: both schedules return `held/active:[]`
after execution ends while the renewal's mutation lock remains owned. The correction
checks busy before releasing that same write, then observes changed lease bytes and
idle only after mutation settlement. Its shutdown variant returns before that
renewal settles, preserving the bounded release and daemon shutdown contracts.

## Concrete app admission lease

The app requires a fresh authenticated hello advertising this exact method from its
already verified managed target. Missing proof sends no maintenance mutation.
The owned target reservation persists across the RPC. The app validates strict
runtime-v1 proof and the exact workspace/instance/PID, rechecks local ownership and
the draft lease, then returns ready only on `held`.

Known busy responses release the local target reservation. Lost, malformed, wrong
target, changed-owner or otherwise uncertain responses retain it. Only a positive
owner-scoped `released` result releases local ownership. Duplicate/uncertain release
never resends resume. Target changes cannot redirect cleanup to another daemon.
External, parked, staged, read-only and wrong-target daemons retain the preceding
no-touch behavior. The native window/draft lease remains separately owned.

## Validation scope and next gates

Local tests use real CLI bootstrap, protected file stores, current production models,
authenticated disposable daemons, and synthetic native-window acknowledgements.
They cover missing/mismatched composition, owner grant/target refusal, handler and
producer entry races, queued work, interpreter completion, pending/late callbacks,
renewal lifetime, continuation recovery/settlement, owner resume, legacy refusal,
and lost/mismatched prepare/resume results. They preserve #534 shutdown regressions.

Independent exact-schema/runtime review remains a release gate. No Mac candidate
feed, approval/install IPC, native installer, signed bundle switch, restart/reconnect
activation, or full recovery path is wired by this slice. Installation stays disabled.
Next implementation needs candidate trust/owner approval and approved native
activation/recovery contracts before any material installation change. Recovery
must pair complete protected state with the matching binary; binary-only rollback
or state deletion/reset is unsafe.

Physical signed N→N+1, Apple Silicon packaging/native binary acceptance, legacy
`dev.orca.desktop` to `com.schadewitz.orca` Keychain/intent-journal/TCC continuity,
and unassisted tester acceptance #390/#388 remain explicitly unrun. Linux fixtures
prove none of those gates. No manifests/lockfile, dependency branches, signing,
credentials, releases, deployments, CI dispatch, system settings, or real user
updates are changed.
