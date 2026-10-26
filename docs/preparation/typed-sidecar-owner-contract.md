# Inactive typed sidecar owner contract — Refs #702 / #699

Draft for parent/source/protocol and recovery-owner review. Persistence owns only
`packages/agents` and this document; UI, wire registration and managed recovery
remain with their existing owners. No activation is requested. There is no live
permission mutation, automatic migration or new policy store.

## Canonical on-disk representation

The existing `orca.permissions.json` path uses an explicit version 2 envelope:
`{version:2, agents:<legacy map>, scopedRules:{version:1, records:[...]}}`.
Each ordered record has exactly `rule` (the existing StrictPermissionRule),
`approvalRecordRef`, `scopeEvidenceRef`, `actor` (existing MutationActor), and
`authorityRevision` (the current original-principal permissions.grant check).
All levels reject unknown keys/versions. Rule revision remains its canonical
content binding; file revision is SHA-256 of exact bytes. Neither authenticates
an approval. Legacy agents remain legacy and cannot qualify typed authority.
No additional rule representation, policy store or implicit legacy conversion.
Fresh absent-file explicit initialization only; existing files are never upgraded.

## Persistence-only command and receipt

Internal `createScopedRule({rule, expectedRevision, approvalRecordRef}, owner)`
snapshots all input before awaiting. `expectedRevision` is mandatory exact byte
revision, never an optional unconditional write. The protected owner verifies the
exact reviewed rule and approval reference, supplies scopeEvidenceRef and actor,
and rechecks current original-principal permissions.grant under the shared policy
lock and immediately before publication. Original credential, scope, captured
ceiling and grant authority cannot be replaced by client fields. Current authority
must stay identical through the attempt; refusal requires a fresh review/read.

Successful receipt: `{outcome:"saved", rule, previousRevision, revision,
approvalRecordRef, scopeEvidenceRef, actor, authorityRevision}`. The exact rule is
what was saved, including its content revision. This receipt says only Saved;
saving neither answers a current ask nor dispatches anything. UI may not synthesize
it from input. There is no Allow once or Deny standing-write command. An explicit
revoke command changes only the selected existing rule status/revision under the
same compare/authority checks and returns the same receipt shape.

Uncertain publication throws with `publication:"uncertain"` and intended revision;
never retry automatically, deliver an approval, or reconstruct a callback. Explicit
read-only reconciliation under current authority compares exact bytes and retained
records. Any combined answer remains in LiveInputRegistry: record human.answered,
then standing write, then delivery. Uncertain append never writes standing policy;
failed/uncertain standing write parks and consumes the callback. Restart cannot
recreate it from the durable record.

## Minimal managed compatibility marker/receipt

Recovery owner must establish a protected, owner-bound workspace marker before
first typed bytes. Marker content: `{version:1, workspaceRef, sidecarRef,
format:"orca-permissions-v2", minimumWriterContract:"orca-typed-sidecar-v1",
generationRef}`. Refs are protected-owner identities, never caller paths. No
semver floor is invented before a release containing the full gate exists.
The contract capability is the compatible-version floor; release owner must bind
it to actual signed artifact versions/digests before activation.

The owner returns an in-memory receipt bound to that exact marker and exclusive
managed writer generation. Check it before reading/mutating and immediately before
publication. Recovery must retain the marker independently of rollbackable roots,
block incompatible binary/whole-root rollback and concurrent older writers, retain
the exact current typed generation (revocations included), and refuse missing,
malformed, unknown marker state. A sidecar field cannot compel an old executable.
Manual launch, direct file edits or unmanaged backups bypassing managed ownership
are unsupported; no filesystem/OS-security workaround is claimed.

Until those managed paths and acceptance exist, the factory requires an injected
trusted-owner capability; no production constructor, CLI flag, RPC or environment
switch creates one. A plain marker/JSON receipt is never accepted as that capability.
This is deliberately incomplete runtime integration, default-off. Tests may supply
synthetic trusted owners for disposable stores only. No UI/recovery source edits
will be made by this owner before parent review of this contract.
