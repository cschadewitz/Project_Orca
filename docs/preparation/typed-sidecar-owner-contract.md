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
rootBindingRef, enrollmentRef, state:"enrolled"}`. Refs are protected-owner identities, never caller paths. No
semver floor is invented before a release containing the full gate exists.
The contract capability is the compatible-version floor; release owner must bind
it to actual signed artifact versions/digests before activation.

The owner returns an in-memory receipt bound to that exact marker and exclusive
managed writer lifetime. `rootBindingRef` binds the original complete physical
config/sidecar/store/control relationship, `workspaceRef` is its original identity,
and `enrollmentRef` is the retained opt-in identity (not a per-write policy generation). Check it before reading/mutating and immediately before
publication. Recovery must retain the marker independently of rollbackable roots,
block incompatible binary/whole-root rollback and concurrent older writers, retain
the exact current typed generation (revocations included), and refuse missing,
malformed, unknown marker state. A sidecar field cannot compel an old executable.
Manual launch, direct file edits or unmanaged backups bypassing managed ownership
are unsupported; no filesystem/OS-security workaround is claimed.

Until those managed paths and acceptance exist, the factory requires an injected
trusted-owner capability; no production caller, CLI flag, RPC or environment
switch creates one. A plain marker/JSON receipt is never accepted as that capability.
This is deliberately incomplete runtime integration, default-off. Tests may supply
synthetic trusted owners for disposable stores only. No UI/recovery source edits
will be made by this owner before parent review of this contract.

## Implemented draft and ownership boundaries

The implementation is [typed-sidecar.ts](../../packages/agents/src/typed-sidecar.ts).
`bindInactiveTypedSidecarOwner` is the trusted construction seam, returning an
identity-bound WeakMap capability. A JSON marker, copied object, structural cast,
receipt from another owner, CLI flag or environment setting cannot manufacture
that capability. Trusted application code can deliberately construct a synthetic
owner; that is exactly how disposable tests inject it, and is **not** evidence of a
managed production gate. No bootstrap, UI, protocol method or recovery path calls
the constructor. Parent owns those integrations after review.

The owner supplies `file`, the exact marker, `checkCompatibility`, and `qualify`.
The first binds the existing sidecar path under existing protected-path ownership;
`sidecarRef` is a protected identity, not a client pathname. `checkCompatibility`
must freshly observe the retained marker and exclusive writer generation, including
all managed launch/update/rollback paths. `qualify` verifies every retained record's
protected approval and scope evidence against the current action/authority and
returns projection-level references, using the existing StrictRuleRead provenance
shape. Old record.authorityRevision is audit provenance, never current authority.
The adapter supplies exact current byte/projection digests and rejects a revision
change during qualification. The existing source then double-reads the current
boundary. Missing/invalid state or failed qualification stays unavailable/unknown.
No public reference or hash substitutes for these trusted checks.

`createInactiveTypedSidecarStore(owner)` offers:

```ts
initializeFresh(): Promise<TypedSidecarSnapshot>;
read(): Promise<TypedSidecarSnapshot>;
createScopedRule(command: CreateScopedRule, authority: ScopedRuleGrantAuthority): Promise<ScopedRuleReceipt>;
revokeScopedRule(command: RevokeScopedRule, authority: ScopedRuleGrantAuthority): Promise<ScopedRuleReceipt>;
readRules(action: ActionEvidenceV1, signal: AbortSignal): Promise<StrictRuleRead>;
```

`initializeFresh` accepts only an absent file after the trusted marker check; any
existing bytes, including a legacy empty document, refuse. The initialized legacy
map is empty. The envelope retains the existing legacy map representation so typed
edits need not strip unrelated legacy records; no transition/import/migration is
implemented. StrictPermissionRule validation is shared with the existing source;
there is one canonical StrictPermissionRule type, content revision and read model.
Every nested typed key and legacy schema transformation is checked before writing.
Invalid UTF-8 and duplicate JSON names (including escaped aliases) also refuse.

Create requires an approved `allow` rule. Deny/require-human create commands refuse:
Deny on the current ask is never a standing grant. Revoke uses exactly
`{ruleId, ruleRevision, expectedRevision, approvalRecordRef}` and changes only that
existing approved rule's status to revoked, computes its new content revision and
retains its position. The protected owner must explicitly approve that exact
resulting revoked rule; no supplied reference can revoke by itself. Used rule IDs
cannot be recycled, even after expiry/revocation, and stale/duplicate/replayed
commands are refused rather than merged or returned as a new successful save.

`ScopedRuleGrantAuthority` binds actor, `authorizeGrant(): Promise<string>` and
`verifyApproval(exactCommand, actor): Promise<{scopeEvidenceRef}>`. Approval and
original-principal grant authority are checked under the shared lock and again
immediately before rename; the grant revision and protected scope proof must remain
identical. [Authorizer.scopedRuleGrantAuthority](../../packages/daemon/src/auth/guard.ts)
captures the original actor/credential and initial permissions.grant ceiling, uses
the existing `holds`/currentPrincipal resolver, and checks again across an awaited
protected authority-revision read. It registers no endpoint. The protected owner
must supply the real current authority revision and exact explicit-review lookup;
that lookup is an integration responsibility, not a permissive default.

The existing lock/revision helpers moved to
[permission-file.ts](../../packages/agents/src/permission-file.ts). Legacy v1
locking/repair remains unchanged; typed mutations select strict ownership in the
**same `.lock` namespace**, using a directory with a unique owner token. Typed
contenders never remove it by mtime, PID or timeout. The legacy file-lock breaker's
`unlink` cannot remove a directory, including after a delayed stat/unlink attempt.
A dead/empty/unknown strict lock stays closed for explicit recovery. Both readers
and qualified rule reads reject a present/pending lock; diagnostic raw file parsing
alone cannot confer authority. #728 is still preparatory, not the typed-safe floor.
Supported activation also requires the managed exclusive lifetime/root owner.
Before activation, the real managed gate must also prevent these legacy writer
paths from touching an active typed workspace, including missing/truncated typed
files. Until then there is no released compatible version floor or runtime-safety
claim. A future compatible release must enforce this contract before every writer
and managed startup/restore path. No activation is allowed based on these unit tests.

A publication exception after rename is attempted carries
`details:{publication:"uncertain", intendedRevision:<exact hash>}`. It may or may
not have reached disk. `read` provides explicit read-only reconciliation; the
caller must compare the exact retained rule/approval/actor/current authority and
revision and must never retry automatically. Even a confirmed retained policy
record cannot recreate or replay a live callback. A returned Saved receipt means
rename was observed; it does not add a crash-durability guarantee beyond the existing
sidecar filesystem mechanics.

## Disposable acceptance evidence

- [typed-sidecar.test.ts](../../packages/agents/test/typed-sidecar.test.ts): actual
  temporary sidecar reads/writes, fresh opt-in refusal, required-state failures,
  exact versions/unknown fields/duplicate keys, preserved legacy and unrelated typed
  records, concurrent/stale edits, input snapshots, repeated/expired/revoked rules,
  restarted reads, qualification races and before/after-rename uncertainty.
- [typed-sidecar-authority.test.ts](../../packages/daemon/test/typed-sidecar-authority.test.ts):
  original credential identity, current grant/restriction/revocation, captured
  ceiling, actor snapshot and awaited authority-read recheck.
- [typed-sidecar-live-input.test.ts](../../packages/daemon/test/typed-sidecar-live-input.test.ts):
  actual file-backed answer events and typed sidecar under the existing lease,
  record-before-policy-before-delivery, once/deny without standing writes, failed
  writes, uncertain recorded answers, uncertain published rules and restart/no replay.

These are synthetic owner/approval/coverage fixtures, not installed-provider or
managed-recovery acceptance. No live policy, old workspace, OS-security setting,
credential, dependency lock/policy, provider/hook, release or deployment is changed.
Refs #702/#699 remain open; parent owns source/protocol review, exact-head CI and merge.


## Coordination with managed gate draft #730

Read corrected, parent-approved #730 at `f90c3dbf681f4cb19454767ae558f60a539da086` before selecting the
persistence handoff. This draft proposes **one enrollment fence** outside managed
restore targets, not an independent per-policy high-water witness. The enrollment
encoding above is a persistence-owner draft; it has no filesystem registry/writer.
The managed owner must independently establish/validate the original full physical
root set and its opaque `rootBindingRef`, keep pending/missing/corrupt/unknown state
closed, and exclude all incompatible writers for the lifetime of typed operation.
`state:"enrolled"` is the only admitted ordinary-access marker state; a caller boolean
cannot satisfy the WeakMap token or the trusted check. The per-write content binding
is already the exact sidecar byte revision; create/revoke changes it and retains
revoked records. No second persisted rule or policy-generation representation is
introduced here. Parent-approved first managed Linux semantics categorically refuse enrolled update,
recovery, retarget and reset, so no external per-edit high-water transaction is
required. Future typed-safe recovery remains separate reviewed work.

The gate owner can consume `TypedCompatibilityMarker` and the store's `read()`
under its trusted owner/lifetime fence. Successful read means only validated typed
material/current marker, not executable approval. The owner must separately bind
the contract floor to the independently accepted exact build identity before launch.
A thrown read/owner check is unavailable; no failed read becomes legacy. Proving
never-typed legacy requires the managed enrollment owner's authoritative registry
inspection; this store does not infer it from file absence/v1 or implement a second
marker reader. Legacy writers keep #728 semantics until the managed path can route
or reject them under the original enrollment. Parent must review the missing-file
and corrupt-file repair exclusion before the build can be called typed compatible.

Lock order proposal: acquire the existing managed lifetime/root ownership first,
then the existing sidecar lock for mutations; `checkCompatibility` only inspects
retained ownership and marker while that lifetime fence is already held. It must
never acquire an inverse sidecar/root lock. All writes recheck before publication.
External enrollment publication/recovery sequencing remains with the managed owner;
`initializeFresh` publishes no marker and refuses existing files. No generic beta
startup, unsupported platform, Mac/Windows updater or release path is modified by
this persistence stage. Unsupported platforms cannot obtain a production typed owner.


Root binding clarification: config, sidecar and store are exact **logical roles**;
their physical protection/restore targets may intentionally be contained in one
another. The ordinary configDir with nested `.orca` store is supported by the
proposed contract. The managed owner retains every original logical role binding
while collapsing duplicate/descendant physical protection targets. Refuse ambiguous
aliases, omitted/changed roles or independently restored overlapping physical
targets; do not blanket-reject intentional nested layout. `rootBindingRef` binds
that complete role-to-physical-target relationship; persistence does not invent a
second root resolver or independently reinterpret it.


## Strict-lock publication checkpoint

Typed mutation acquires managed lifetime/root ownership first (trusted injected
port), then creates the existing sidecar `.lock` name as a directory, publishes a
unique owner token, snapshots/compares current bytes, verifies explicit approval
and original-principal grant authority, writes a temporary file, rechecks approval,
managed ownership/current grant, exact token/directory identity and expected bytes,
then renames. All participating typed writers use that directory without takeover.
A legacy mtime waiter can only unlink a file and cannot remove the typed directory.
Only the owner that successfully unlinks its exact unique token may remove the
empty directory. Lost ownership never removes a successor's token/directory.
An uncertainty or owner-release failure after a completed transaction carries
`publication:"uncertain"` rather than inviting replay.

The publication exclusion argument relies on **no supported destructive takeover**,
not on a last revision check alone. A paused typed writer retains its critical
section indefinitely; a competing revoke/refusal cannot publish until it releases.
A crashed writer therefore requires explicit reviewed recovery, not age-based
reclaim. No such recovery implementation or bypass is supplied. All pre-existing
legacy holders must be excluded before opt-in by the managed owner; this helper
cannot retrofit fencing into an already-running old executable. Arbitrary same-user
namespace edits are outside the managed guarantee. An additional deterministic
fault test displaces ownership, commits a newer revocation, and verifies that the
old paused owner refuses publication and preserves the new bytes/retired evidence.
That defense check does not claim protection against an adversary repeatedly
changing the namespace in the final syscall window.

[typed-sidecar-lock-child.ts](../../packages/agents/test/typed-sidecar-lock-child.ts)
uses real subprocesses and disposable paths. Tests age the paused owner's directory
with `utimes` (no sleep), attempt typed revoke and legacy replacement, and assert
`STORE_LOCK_TIMEOUT` with exact byte preservation. After release, an explicit fresh
revision revoke succeeds and remains retained. Killing a paused owner leaves a
single protected token; both typed and legacy contenders refuse, and authoritative
reads return unavailable. No test changes OS security settings or live locks.

Checkpoint base is exact reviewed #728 (`9e892d56ad3648e512dd7fc6c44bbd2f2fb23f57`)
on `df2e623`; parent main subsequently reached `bc0c57d`. The canonical checkpoint
branch is `calcifer/702-typed-sidecar`. The earlier contract-only
`calcifer/702-typed-persistence` branch is superseded; no PR was created for it.
All new canonical-branch commits use Calcifer Schadewitz
`<schadewitzcalcifer@gmail.com>` as author and committer. No history was force-pushed.


### Enrollment initialization phase (final handoff)

`TypedCompatibilityMarker.state` is exactly `"enrollment-pending" | "enrolled"`.
The managed owner first durably publishes enrollment intent outside every restore
root under exclusive lifetime/root ownership, then binds an **enrollment-pending**
token. Only `initializeFresh` accepts that phase; ordinary `read`, `readRules`,
create and revoke refuse it. The initializer rechecks the pending owner immediately
before publishing fresh v2 bytes and returns their exact revision. The managed
owner then durably commits enrolled status and binds a new **enrolled** token.
Only that token permits ordinary typed access. An enrolled token cannot initialize.
The intent must not be erased/reclassified as legacy after failure; a crash or lost
acknowledgement stays pending/unavailable for explicit inspection, with no automatic
initialization retry over existing bytes. This is a one-time enrollment transition,
not a per-edit external witness. No marker filesystem writer is implemented here.

Parent confirmed #730's corrected bounded design is approved. Remaining decisions
are concrete owner implementation/acceptance and protocol/UI integration against
this seam, rather than an external per-edit witness requirement. No source in UI,
launch, update or recovery has been changed by this persistence owner.


Shared source names for consumers: `TypedSidecar`, `TypedRuleRecord`,
`TypedSidecarSnapshot`, `TypedCompatibilityMarker`, `TypedSidecarOwnerPorts`,
`InactiveTypedSidecarOwner`, `ScopedRuleGrantAuthority`, `CreateScopedRule`,
`RevokeScopedRule` and `ScopedRuleReceipt` are exported from `@orca/agents`.
`parseTypedSidecar`/`readTypedSidecar` are structural/raw diagnostics only.
`bindInactiveTypedSidecarOwner` is trusted injection, and
`createInactiveTypedSidecarStore` returns the sole owner-bound read/write port.
Do not add a second UI grant endpoint or public marker/approval-authority input.
