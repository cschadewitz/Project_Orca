# Runtime-next combined integration

The frozen baseline is `7abc2342aa672ee9d2f10d565ca4f8eb546184df`. Exact reviewed inputs:

- #381 / #329: `393596f27754d3c0bda965c80ac71372219ebdb1`
- #382 / #318: `77059a0285ca84786fb19f32a52b028e6f8e0a68`
- #383 / #237: `fe7dbff79770e6f23eac64210cd0e017e2cf5fdc`
- #384 / #332: `c93d40d4104fe26c74e3c17ac594f2595524af03`

Feature ancestry is retained. Original `docs/patches/` files are historical handoffs;
their shared wiring is reconciled here. Do not reapply them.

## Shared runtime

Protocol 1.10 combines identity, configuration and live-input changes. The store epoch
is `config-generations-v3`: rollback to a binary ignoring recorded generations is
incompatible. Protected-execution-v2 encryption and keys remain intact, with no
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
while currently authorized durable gates remain recoverable after credential rotation.
UI disconnection is not execution revocation.

The ephemeral exact-target `input.invalidated` notification is authorized per reader,
has no event sequence and performs no durable append. Connected Attention/inline cards
expire, including initial-read races and old-connection results.

Switching and return to an environment-pinned endpoint both use authenticated probe,
draft guard and atomic commit. Failure or cancellation preserves connection/preferences.
The exact environment return writes no override preference.

Arbitrary plugin provider/host closures stay bootstrap-bound when their registration
inputs cannot be reconstructed. Historical restoration fails before provisioning;
unchanged no-op and recorded declarative agent/role cases remain supported.

## Verification

Feature CI is not combined acceptance. The exact combined head requires typechecks,
format/lint/design checks, Node 22/24 tests and coverage, builds, compiled smoke and
independent review. Real Electron-window App smoke is a separate required gate.
Runner prerequisite/runtime-library failure is blocked, never a pass.

Regression coverage includes crash recovery across generation changes, strict
correlation, local authority/revocation, concurrent ownership, plugin wrong-workspace
and unchanged-plugin controls, original actor/child lineage, credential-rotation
durable recovery, connected callback expiry and connection epochs. The PR records
current commands/counts, exact CI runs and any blocked checks. After an environment
reset, pre-reset check results are historical evidence only; recovered code is revalidated.
