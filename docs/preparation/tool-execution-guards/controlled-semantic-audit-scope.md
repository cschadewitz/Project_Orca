# Controlled bootstrap original-authority predicates — incomplete

This bounded #706 semantic-audit delta starts at draft #748 exact
`0e2045ce714103adc1bd435a83c8fdccc237fa19`. It changes only
`controlled_semantics.py`, its dedicated controls, and this scope note. It does
not qualify #748, add an accepting exit/launcher, or release a connected token.

The reviewed producer uses the real policy evaluation, permit and dispatch path;
it is not raw calibration. Its protected owner remains the source of the formulas
below. This independent audit checks necessary predicates, not global policy
semantics, new-grant precedence, or a change to the mandatory-judge ceiling.

## Input contract for integration

The existing supervisor originals supply `base`, `immutable` identity/witness
bytes and physical identities, `directories`, leader PID, integer start/finish
clock samples and exact reviewed source/image bindings. Replay supplies actual
file bytes, physical roots, resource identity/stamps and validated pread entries.
No report JSON, child flags, or producer-authored digest is an authority input.
The observer also compares the lease's actual guarded hostname to local
`os.uname().nodename`; stable local hostname is assumed along with stable mounts.

The only required additive provider field is each protected semantic file's
`durable_publication_completion`: a **zero-based raw trace line index**, set by
the kernel owner only after validated writer close/data sync, exclusive physical
publication, directory sync and temporary cleanup. Baseline, capture and
authorization must each have this integer field. Their creation and durable line
indices and the actual service-pread entries must exist in replay's existing
`entry_times` map. Missing data refuses; there is no fallback to old
`publication_completion`, which proves only publication syscall completion.
No supervisor interface is modified in this delta. If the provider cannot meet
this contract, the parent must coordinate the precise missing observation first.

Source-reviewed order is **baseline durable completion < capture creation**,
**capture durable completion < authorization creation**, and **authorization
durable completion < service pread entry**, followed by producer observation.
The fence defers `recordCapture` until `evaluate()`, after the producer has awaited
baseline publication/observation. This order is checked using raw trace intervals.
Ordinary one-line syscall prefixes are entry samples, not measured absolute
completion times. Currency checks conservatively cover the observed record
entries through process finish; no exact completion timestamp is synthesized.

## Bounded predicates

* Reconstruct the exact root-binding JSON construction order from original physical
  config/sidecar/store/control/releases roots and original workspace identity.
  Check the retained never-typed witness, actual intent/enrolled correspondence,
  enrollment UUID and baseline enrollment binding. Independently check the
  action's resource projection as described below. Markers corroborate original
  ownership; they do not create it.
* Require the actual initial sidecar to have empty agents and empty version-1
  scopedRules within format version 2. Require `baseline.initialRevision ==
  SHA256(actual sidecar bytes) == action.authority.currentPolicyRevision`.
* Reconstruct `protected-scoped-permission-owner.ts`'s revocation digest from the
  actual designated operator credential: ordered principalId, credentialId, sorted
  permissions, schema-ordered scope, nullable expiresAt and createdAt. Reconstruct
  lease epoch from `[resource, holder, guardedId, acquiredAt, pid, guardedHost]`
  and authority revision from `[bindingIdentity, revocationEpoch, leaseEpoch]`.
  Encoding is compact UTF-8 JSON with construction order preserved, matching
  `JSON.stringify`; no sorted-key encoding is substituted.
* Require two distinct fixed operator/reviewer credentials, designated permissions
  and unrestricted workflow/run scopes, original creation and current validity.
  Check the actual guarded lease for `run:controlled`, actual original leader PID,
  holder/incarnation UUIDs, local host, guarded representation and 60-second logical
  TTL. Acquisition/renewal must precede the observed original resource creation,
  and the lease must remain live through finish.
* Require the existing exact bootstrap rule, match, revision, decision and approved
  status; no delegation or extra rule fields. Check inclusive notBefore and
  exclusive expiry over independently observed record/effect times through finish.

The fixed designated operator/reviewer, trusted reviewed source/image and kernel,
stable realtime/monotonic clock contract, stable mounts/hostname and cooperative
same-UID owned process group remain explicit assumptions. This is not protection
against arbitrary same-UID memory tampering. Original identity, actual retained
credential and lease bytes, and the provider's validated publication sequence are
required; producer equality alone cannot establish those facts.

The existing integer clock model is unchanged:
`S <= resource-create-entry <= F < E <= resource-create-entry + 55_000_000_000`.
The monotonic process limit remains 60 seconds. Resource-create entry is a
conservative post-owner anchor under reviewed source order, not exact issuance.
Candidate verifier, replay/kernel owner files, producer/runtime/sharedcore and
production security behavior are outside this delta.

## Validation and remaining gate

Dedicated tests include full synthetic predicate positives labeled **synthetic**,
AES-GCM reauthenticated tampering with wrong binding, revision, authority epochs,
lease, credential scope/currency, rule dates and causal order, plus independent
Node JSON.stringify golden digests. Every semantic tamper is re-encrypted and
roundtripped successfully before refusal is checked. A positive result still says
`authority: none`; it is not fresh observed evidence.

Validation: `python3 -B -m unittest discover -s tools/owned-read-proof -p
 'test_controlled_semantics.py' -v` initially passed **21 tests**. That checkpoint's
complete Python control suite passed **108 tests**; `git diff --check` passes. These results are local
controls, not an integrated bootstrap. No services, native/Mac providers,
credentials, security/network settings or user workspaces are changed.

At the initial #755 checkpoint the final integrated bootstrap was pending the
kernel field provider and the parent-reviewed exact image. The integration
follow-up below supersedes that provider status; full qualification is still pending. #748 remains draft/incomplete with no
accepting exit or connected token. Source-reviewed facts above are separate from
fresh evidence, which this delta does not claim.


## Enrollment authority versus owned-resource projection correction

This follow-up starts at #756 exact
`1d2dd1c6602526e9e2db52925f55928551808f0c`, on separate semantic-owner branch
`cal/706-enrollment-resource-projection`. Ownership remains limited to this note,
`controlled_semantics.py` and its dedicated tests. Kernel replay/provider/tests,
supervisor, candidate verifier and producer/runtime/sharedcore bytes are unchanged.

The integrated refusal exposed an incorrect #755 assumption: action cwd/workspace
were required to equal the managed enrollment values. Reviewed source intentionally
keeps two identities:

* Enrollment authority is the original managed workspace's identity digest,
  physical root-binding digest and enrollment UUID. The producer obtains the
  original authority facts from `protectedScopedPermissionOwner.readCaptureFacts`
  and sets its source owner snapshot cwd to `config` and workspaceRef to
  `active.workspaceRef` in
  [controlled-owned-read-producer.ts](../../../packages/cli/test/controlled-owned-read-producer.ts).
  The protected owner's `currentFacts` hashes `identity(active)` with the actual
  credential/lease epochs in
  [protected-scoped-permission-owner.ts](../../../packages/daemon/src/protected-scoped-permission-owner.ts).
* The owned file service's `build()` explicitly overrides that snapshot's cwd with
  its newly created disposable `root`, workspaceRef with
  `resourceRef + ":temporary-tree"`, and relevantStateRefs with its original
  physical target reference in
  [owned-file-read-service.ts](../../../packages/engine/src/owned-file-read-service.ts).
  The fence then copies those projected facts into the authenticated action in
  [synthetic-read-fence.ts](../../../packages/engine/src/synthetic-read-fence.ts).
  The bootstrap rule is constructed from that projected action. The protected
  capture interface separately retains `binding: active` and the action's
  `resourceWorkspaceRef`; it does not equate them.

The corrected observer still reconstructs enrollment roots/identity/witness,
compares actual intent/enrolled markers and baseline binding, checks exact actual
sidecar revision, and computes the authority epoch with the reconstructed
**enrollment binding**. Those checks were not removed or replaced by the action's
workspaceRef. The projected action cwd must separately equal the parent of the
kernel-validated original exclusive fixture creation path. That exact path must
have the controlled base's finite `orca-owned-service-XXXXXX/fixture` shape; no
prefix/path-normalization alternative is accepted. Existing replay validates the
physical parent/create/read-only-reopen/unlink/retained-descriptor lineage.

Action workspaceRef must equal the captured original `owned-file:<UUID>` plus
`:temporary-tree`, and coverageId must use the same UUID plus `:source-v1`.
Resources and relevantStateRefs must both designate the captured physical target,
whose full nine-component stamp already must match the actual retained detached
inode. Environment/credential references remain complete and empty. Baseline,
capture and authorization must still contain identical actions; the exact
bootstrap rule must still match the projected action and its revision/verdict.
The non-authoritative result preserves both `enrollmentBinding` and
`resourceProjection` explicitly with `authority: none`.

No new input field or supervisor interface is needed. `resource.creation_path`,
its original raw creation record and timestamp already come from kernel replay;
the action cannot designate a different root by supplying a path string. The
logical resource UUID is random source-owned identity, not derivable from an
inode: its correspondence relies on the reviewed exact image, authenticated
records and physical stamp checks. This does not independently measure random
UUID issuance or recover the unprojected in-memory snapshot; its original cwd and
workspace assignment are source-reviewed facts. Trusted kernel/source, stable
clocks/mounts/hostname and cooperative same-UID assumptions remain unchanged.
All lifetime, durable ordering and incomplete/non-connected gates remain intact.

Local follow-up validation: **30 dedicated semantic tests** and **135 total Python
tests pass**, using the commands above. `git diff --check` passes. New controls
re-encrypt and authenticate coherent wrong enrollment roots/workspaces, projected
cwd/workspace/resource/state/coverage, and rule/verdict revisions; separately
changed protected copies refuse. They also reject substituting the resource
workspace into the managed authority epoch or designating another kernel creation
path. Synthetic positives retain both identities and carry no acceptance authority.

#756's actual preserved-trace semantic refusal is parent-reported evidence, not a
run performed here. Those private originals/traces are unavailable in this fresh
workspace. The additive provider is present in the starting #756 code, but
read-only replay of those originals and a fresh integrated exact-image attempt
remain pending parent review/coordination. The previously documented concurrent
eventfd interval refusal is unaffected. No fresh bootstrap success, accepting
exit, connected launch/token, production change or main/PR merge is claimed.
