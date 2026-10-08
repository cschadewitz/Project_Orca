# Disabled coherent Mac restart verification (#387)

This slice starts at reviewed #537 `78af5c8683b46e88d5230c0b5a47fc9988ecd836`
([review5450485166](https://github.com/cschadewitz/Project_Orca/pull/537#pullrequestreview-5450485166)).
It adds only the six reserved restart source/fixture/documentation paths. Prior
#530/#533/#535/#536/#537 heads and their candidate, draft, admission, renewal and
shutdown source remain stable. There is no production constructor call or IPC,
installation, staging, rollback, recovery import, provider use or admission reopening.

The accepted [#439 update contract](https://github.com/cschadewitz/Project_Orca/blob/39d4cf75b9e46dd267ccf0ae044f29f220fe667d/docs/preparation/beta-update-support/update-contract.md)
requires the expected app/daemon/protocol/capabilities/store/workspace identity
before reopening. The existing #402 manifest and raw sealed identity remain the
candidate source. No manifest, wire schema, capability, permission, dependency or
backup policy is added.

## Owned stop

`MacUpdateOwnedStop` captures an actual owned child reference, exact UUID workspace/
boot/PID target and owner callbacks. The owner must preserve the all-window and
local target reservation. A fresh authenticated runtime-v1 held/idle proof is
required before signalling. Blocked or initially unowned targets are refused
without a signal; malformed/lost/wrong-target proof or a lost reservation is unknown.

There is one SIGTERM to that captured child and no PID-based signalling, SIGKILL,
forced timeout termination or retry. The ordinary `BundledDaemon.stop` currently
escalates and is deliberately not used. A positive clean close with the reservation
still held and matching native exit fields mints a process-local receipt. Crash,
signalled exit, timeout, cancellation, lost close acknowledgement or lost ownership
cannot mint one. The receipt is tracked in a private WeakMap and permits one
replacement launch. Copies and serialized receipts cannot claim it; a second
verifier cannot replay an already-claimed receipt. This is not a durable app-relaunch
handoff.

The disposable daemon's SIGTERM handler awaits the existing `daemon.close` before
closing its runtime and IPC. Existing #526 pending-handler and #534 queued admission
verification/close drains and #536 renewal settlement are unmodified. A clean child
close is evidence for this fixture's shutdown path, not proof every production
writer, external CLI/ACP store or native lifecycle is quiescent.

## Replacement startup remains closed

`MacRestartVerification` snapshots exact candidate bytes/references, the old target,
canonical configured store directory and explicit required capabilities/methods.
It consumes the owned-stop receipt and launches once through a required trusted
`startClosed` port. Missing adapters refuse; lost/partial launch stays unknown.
No unknown outcome automatically stops, retries, resumes or substitutes a process.

The captured replacement must have a distinct boot UUID and fresh live child
reference. Its independent spawn metadata supplies expected PID/boot and fence ID;
HTTP hello cannot invent its own expected identity. Every read is bounded, parsed
and checked against the current child and local reservation. Finite initial/final
reads check:

- The same startup fence, guaranteed installed before listen and producer admission.
- Actual whole-app matching through a required native owner, the exact candidate
  digest, raw sealed build/app identity and actual bundled-daemon SHA-256.
- Fresh authenticated hello: exact daemon version and protocol, required authorized
  capabilities and methods, UUID workspace/boot, owned PID and configured store path.
- Supported owner observations of the same store directory, workspace/boot/PID,
  expected store epoch and absence of parked/unsupported historical work.

The app/build/daemon, hello and store observations are repeated before the final
fence confirmation. Late changed bytes, store epoch or parked classification refuse.
Missing/malformed/throwing/lost reads, dead children or changed fence ownership are
unknown. A fully parsed identity/image/store mismatch is a startup refusal, not a
claim that the previous app/state is usable or has been restored. Neither result
opens admission. Duplicate verification/rechecks share the active operation; an
unknown/refused recheck cannot return cached success or launch again.

The only positive terminal result is **`verified-closed`, `scope: startup-only`**.
`recheck` obtains fresh same-child evidence for a test caller immediately before
its separate simulated opening; the verifier itself has no reopening method.
No #394–396 restoration proof is implemented, so parked work and unsupported
plugin generations always refuse. No historical callback, permission answer,
provider effect or run is restored/replayed by this slice.

## Missing production seams and recovery separation

Existing authenticated hello has no whole-app identity, store-epoch or startup-fence
acknowledgement. Existing CLI/server startup accepts an initial maintenance token,
but its runtime-v1 acquisition does not adopt that legacy startup token. The fixture
uses the real initial token before server construction and producer binding, then
same-owner maintenance confirmation; it does not add or infer a production RPC.
The main-only fence/image/store ports still need reviewed production ownership,
selected native lifecycle and read-only supported observations. No new persistent
marker or release policy is invented.

A surviving supervisor holds these receipts. Actual UI/app process replacement,
persistent recovery identity, all-writer quiescence, restart/reconnect activation and
protected Keychain/TCC access remain later work. Session consent is not resurrected
through these process-local receipts. Native engine selection remains open; the
ordinary launcher must not be repurposed as an updater stop adapter.

The independent recovery worker reserves only new store recovery inventory/manifest/
validation paths. This slice imports none of them and consumes no recovery receipt.
Production reopening will need separately reviewed candidate-bound evidence of a
complete consistent protected-state set plus its matching binary, all configured
writers/roots, supported credential restoration and approved newer-work treatment.
Equal store epochs do not prove read/write compatibility, backup completeness,
rollback safety or historical restoration. Binary-only rollback, deleting/resetting
state, or a synthetic startup pass used as full recovery evidence is unsafe.

## Disposable evidence and release gates

Tests compile the source fixture with the already-declared esbuild dependency and
source tsconfig mappings. Captured graph/control hashes and emitted bytes are checked
before each fresh fork. The replacement executes the same resource daemon file whose
hash is inspected. Both old/replacement processes use actual authenticated daemon
composition, runtime producer fencing and existing drains, with a synthetic
provider-free start/end workflow in a private temporary workspace. No installed
app or host process is stopped. Failed test cleanup preserves files if child closure
is uncertain; cleanup uses a separate owned-fixture IPC close, never SIGKILL.

The test's whole-app port compares a synthetic app-image file, and its store-epoch
port reads a clearly named fixture witness. These are not a signed Mac image or a
production store marker/reader. Candidate-shaped metadata and image ports supply
only local test evidence. A positive test keeps real RPC admission refused until
fresh verification succeeds and the test explicitly releases its own token; it
then starts only the provider-free workflow. This is simulated opening, not a
production updater or a full-state snapshot/restore proof.

Cases cover real new PIDs/boot identities, duplicate/forged/replayed receipts,
no-touch stop refusal, lost/malformed idle proof, ignored SIGTERM, clean exit with
lost acknowledgement, crashes and lost reads at initial/final boundaries, resource
and hello identity mismatches, late bytes/store/work changes, startup fence identity,
unknown sealing and auth refusal. Earlier candidate/nonce, runtime, renewal and
server-drain tests remain regression evidence.

Signed Apple Silicon N → N+1, actual native binaries/packaging and ordinary-exit/
relaunch behavior, `dev.orca.desktop` → `com.schadewitz.orca` Keychain/encrypted-intent/
TCC continuity, full protected-state recovery and unassisted #390/#388 acceptance
remain **unrun**. No signing, real credentials/access, releases, live feed/provider,
settings or deployment is performed. Parent owns exact-head independent review and
CI; this slice does not dispatch or poll CI.
