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
  enrollment UUID and baseline/action binding. Markers corroborate original
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
 'test_controlled_semantics.py' -v` passes **21 tests**. The complete Python control
suite passes **108 tests**; `git diff --check` passes. These results are local
controls, not an integrated bootstrap. No services, native/Mac providers,
credentials, security/network settings or user workspaces are changed.

The final integrated bootstrap is deliberately pending the kernel field provider
and the parent-reviewed exact image. #748 remains draft/incomplete with no
accepting exit or connected token. Source-reviewed facts above are separate from
fresh evidence, which this delta does not claim.
