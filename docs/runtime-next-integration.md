# Runtime-next combined integration

The frozen baseline is `7abc2342aa672ee9d2f10d565ca4f8eb546184df`. Exact reviewed inputs:

- #381 / #329: `393596f27754d3c0bda965c80ac71372219ebdb1`
- #382 / #318: `77059a0285ca84786fb19f32a52b028e6f8e0a68`
- #383 / #237: `fe7dbff79770e6f23eac64210cd0e017e2cf5fdc`
- #384 / #332: `c93d40d4104fe26c74e3c17ac594f2595524af03`

Feature ancestry is retained. Original `docs/patches/` files are historical handoffs;
their shared wiring is reconciled here. Do not reapply them.

## Shared runtime

Protocol 1.10 combines Request admission, identity, configuration and live-input changes.
The store epoch is `config-generations-v3`. Managed Debian activation/rollback compares
release metadata and refuses different epochs. Direct daemon/CLI startup does not check
this epoch; an older binary is not guaranteed to refuse a newer store. Binary-only rollback
is not a migration. Keep a complete pre-upgrade store backup with its matching binary. Protected-execution-v2 encryption and keys remain intact, with no
plaintext migration or secret-bearing public fingerprints.

Production bootstrap supplies one durable Request admission service. Fresh capture
uses active guards; authorized run-missing reconciliation separately restores the
recorded generation, Request identity and workflow digest. Internal correlation is
outside application vars and authenticated in creation. Unknown inputs still fail.
CLI/ACP authority is explicit and live. Cross-process ownership merges before acceptance.

One daemon boot identity is shared by hello and live callbacks. The interpreter
restores the initiating actor and child lineage from authenticated creation. Current
credential/workflow grants and durable ownership govern live callback authority;
a responder cannot substitute their identity. Revocation expires live callbacks,
while durable gate answering uses current responder authority. An expired execution credential requires an explicit
`runs.resume` attachment using the original principal's current launch/control grants,
checked again under the lease. Gate answering never supplies that renewal.
UI disconnection is not execution revocation.

The ephemeral exact-target `input.invalidated` notification is authorized per reader,
has no event sequence and performs no durable append. Connected Attention/inline cards
expire, including initial-read races and old-connection results.

Switching and return to an environment-pinned endpoint both use authenticated probe,
draft guard and atomic commit. Failure or cancellation preserves connection/preferences.
The exact environment return writes no override preference.

Custom executors, plan callbacks and plugin provider/host closures with unrecorded state
bind the entire generation to its original bootstrap lifetime, even for workflows that
never call them. Same-process operation and UI reconnects to that process can continue;
restarting the engine process crosses the restoration boundary. No-op and declarative-only
plugins can restore if compatibility checks succeed. A bootstrap with executable mutations also rejects older unbound generations rather
than substituting its new callbacks. Built-in executor objects are isolated per bootstrap.
See [configuration generations](configuration-generations.md#reloadability),
[#394](https://github.com/cschadewitz/Project_Orca/issues/394),
[#395](https://github.com/cschadewitz/Project_Orca/issues/395) and
[#396](https://github.com/cschadewitz/Project_Orca/issues/396).

## Verification

Feature CI is not combined acceptance. The exact combined head requires typechecks,
format/lint/design checks, Node 22/24 tests and coverage, builds, compiled smoke and
independent review. Real Electron-window App smoke is a separate required gate.
Runner prerequisite/runtime-library failure is blocked, never a pass.

Regression coverage includes crash recovery across generation changes, strict
correlation, local authority/revocation, concurrent ownership, plugin wrong-workspace
and unchanged-plugin controls, original actor/child lineage, durable gate answering,
connected callback expiry and connection epochs. New regression fixtures also reconstruct memory/file-backed runtime state across
bootstrap rotation and exercise explicit renewal through authenticated HTTP. This is
not a substitute for actual process/window acceptance at the final head. The PR records
current commands/counts, exact CI runs and any blocked checks. After an environment
reset, pre-reset check results are historical evidence only; recovered code is revalidated.

## Review status and final reconciliation

The [review at `27411de95ad31f014097f31e8c8ff44f65769549`](https://github.com/cschadewitz/Project_Orca/pull/397#pullrequestreview-5388884922)
identified runtime, connection, documentation and performance gaps. #400 reconciled the
docs and #404 corrected connection handling. The subsequent runtime corrections include:

- Fresh Request admission skips unrelated-store scans; historical ambiguous recovery
  remains fail-closed. Scope-filtered discovery and exact per-run ownership flushes have
  corrupt-store and concurrency regressions. CLI/ACP expose local receipt recovery.
- Encrypted generations retain their workflow catalog without reserving unused versions
  at boot; actual launch pins remain immutable. Plugin compatibility is symmetric,
  provider construction requires recorded inputs, and ordinary config literals are no
  longer global redaction needles.
- Explicit current-authority resume preserves the original principal and immutable
  creation record while opening fresh permission invocations. ACP refreshes credentials
  only at a new intent boundary. Remembered-only asks do not create unanswerable cards.
- Run-summary parsing preserves safe provenance. Protocol inventories classify activation
  and admission inspection under their control service; release metadata includes
  `inputs.live`. No grant is expanded by method discovery.
- The Attention waiting section retains its intrinsic height instead of hiding its
  controls under Failed runs; real-window hit-testing at normal and short heights is
  part of the combined smoke regression.

Protected events remain encrypted and durable. Replay batches authenticate inputs and
sensitivity overlays once per run per call. Bounded reuse of ciphertext/key bytes still
checks current file/directory identity, permissions and nanosecond modification metadata;
every payload is authenticated and decoded. Deletion, replacement, tampering and missing
sensitivity material still fail closed, and write/fsync ordering is unchanged.

Three same-machine compiled-demo comparisons measured median elapsed times of 6.07 s
on main `7abc2342`, 13.58 s on the reviewed integration and 8.95 s after the corrections.
The correction improves the reviewed candidate by about 34%, but retains about 47%
overhead versus main; do not describe that as performance parity. These are local
measurements, not CI deadlines. Exact-head Node 22/24 CI, coverage, native App smoke and
independent re-review remain required. The former 60 s demo bounds are unchanged.
