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
while durable gate answering uses current responder authority. This does not prove
continued execution after credential rotation: the original execution credential is
still required at the reviewed head (see below).
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
plugins can restore if compatibility checks succeed. The reverse-direction gap (old
unbound generation, new plugin overriding a built-in executor) remains unresolved.
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
connected callback expiry and connection epochs. These fixtures do not establish full
credential-rotation recovery or eliminate the review findings below. The PR records
current commands/counts, exact CI runs and any blocked checks. After an environment
reset, pre-reset check results are historical evidence only; recovered code is revalidated.

## Review status and final reconciliation

This documentation pass is checked against `27411de95ad31f014097f31e8c8ff44f65769549`,
not against later runtime fixes. The [PR #397 review](https://github.com/cschadewitz/Project_Orca/pull/397#pullrequestreview-5388884922)
reported passing typechecks and 471 focused tests, but CI #341 failed its Node 22 demo
time bound. That is not a passing combined acceptance result or proof of performance repair.

Cal must reconcile these passages with the final implementation and new evidence:

- **Request submission — durable boundary/recovery:** fresh-submit full-store scans can
  fail on unrelated unreadable runs; workflow-scope changes can break admission listing;
  concurrent ownership flushes can report failure after creating a run. CLI/ACP/app have
  no admission inspection/reconciliation surface, and daemon recovery cannot impersonate
  a standalone OS-user principal. See [scan](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374801),
  [listing](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374805),
  [ownership](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374814) and
  [recovery surface](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374833).
- **Configuration generations — saving/activation, reloadability and secrets:** verify
  same-version workflow-edit startup behavior, generation-wide plugin restoration in
  both directions, missing `workspaceInputs` fallback, and the final redaction policy.
  See [startup](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374816),
  [redaction](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374810) and
  [bootstrap](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374868).
- **Live continuity and daemon connections:** test daemon credential rotation with
  app-started runs and long-lived ACP submission authorities, distinguishing durable
  gate acceptance from subsequent live tool permission. Verify behavior when an agent
  offers only remembered permission options (the reviewed code leaves an empty ask).
  See [empty options](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374828).
- **Daemon connections — connecting and target identity:** reconcile dialog URL handling,
  banner errors, no-window store opening, malformed environment URLs and epoch races with
  the app fixes. See [dialog](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374843),
  [main process](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374850) and
  [epochs](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374854).
- **Verification and release claims:** rerun combined gates, including performance and
  real App smoke. At this head generation-launched runs protect every event; repeated
  restoration and synchronous ownership reads also add cost. See the
  [performance finding](https://github.com/cschadewitz/Project_Orca/pull/397#discussion_r4163374822).
  The review's `RunSummarySchema` provenance omission, protocol method inventories and
  missing `inputs.live` release capability require code/metadata owner fixes outside
  this documentation scope. Do not treat this pass as resolving those findings.
