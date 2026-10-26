# Connected Save/persistence authority correlations — incomplete

Refs #699 / #706. This separate preparation branch,
`cal/706-connected-save-authority`, starts at independently reviewed #765 head
`ba0002668c59c645b1cdc72df9aba94a8ca64ff5`. The source-owned producer remains
`557f62fbe86fc8371d48f11ec37bf9db71cac436`. Prior
[delivery correlations](controlled-delivery-semantic-correlations.md),
[kernel grammar](controlled-connected-kernel-grammar.md) and exact bootstrap
[decision](controlled-bootstrap-gate-decision.md) retain their stated scope.

## Source-defined plan and bounded implementation

`controlled_save_semantics.py:authenticate_connected_save` checks the actual
protected Save entry, both distinct persistence attestations, and finite physical
credential/lease/sidecar publication histories. It first requires all preceding
authenticated delivery correlation predicates. It adds no command release,
accepting capability, runtime mount or production provider. The executable
supervisor remains bootstrap-only, with `connectedCommandsReleased: false` and
exit 2 for partial evidence. No fresh bootstrap, connected trace or image build
was run for this slice.

The relevant source emitters at the producer pin are:

* `controlled-owned-read-producer.ts:attest`: immutable original and refreshed
  action attestations, managed binding, exact operator, distinct reviewer/public
  credential, real logical lease, revision, original interval and expiry.
* `protected-scoped-permission-owner.ts:prepare/recordApproval/readApproval`:
  original capture/target/current authority, explicit Save entry, approval locator,
  rule/scope evidence and authority digests. `policySaved` retires prior reviews
  and requests the one-time current-revision refresh.
* `typed-sidecar.ts:initializeFresh/change/publish`: initial empty policy and one
  Save publication under a strict policy mutex, private exclusive PID temporary,
  close and same-parent rename; no stale-owner takeover.
* `permission-file.ts:withStrictPolicyLock`: unique owner filename and the distinct
  token shape `{version:1,pid,nonce}`, actual physical lock identity, token unlink
  followed by empty-directory removal. This is not the journal mutex token shape.
* `credentials.ts` and `lease-store.ts`: original operator/reviewer issuance,
  guarded lease, actual on-disk sentinel versus logical host/TTL representation,
  immutable credential identity and current revocation/currency checks.

## Authenticated authority and finite shapes

The existing observer decrypts all 15 filename/AAD-bound protected records and
correlates the public journal with their actual bytes. The Save entry now has a
closed field set. It must contain exactly version 1, choice `save`, the initial
action, managed binding and actor/credential facts, real logical lease, original
live target, exact rule/expected revision/approval locator, resource workspace,
scope evidence, authority revision, disclosed scope and projection, and the
source's review provenance. Unknown or omitted fields and scalar-type aliases
refuse.

Both persistence attestations must match their respective original and refreshed
actions exactly, including scope/binding, revision, original interval, owner
expiry and lease. The reviewer must be the distinct predesignated current grant
principal with its actual public credential. The Save entry references exactly
the first attestation; the second attestation binds the changed policy revision
and refreshed action. Neither can be reused for another action or interval.

This exact source has **no configured execution judge**. Both attestations must
retain `executionReview: {result: unavailable, sourceRefs: []}`. The Save entry
must retain `requiredReview: unavailable`, empty execution review refs and the
separate `persistenceReview: {result: passed, sourceRefs: [originalAttestation]}`.
A persistence result cannot fabricate an execution judgment or add an execution
verdict to the disclosure projection. This bounded source check decides no
global mandatory-judge or new-grant-precedence contract.

The expected disclosure is the source's fixed eight-field scope, with no private
reference disclosures. Its projection has the exact capture coverage, unknown
current execution authority (`no-execution-decision`), original expiry and active
revocation. Scope text is corroborating disclosure, never grant authority.

The observer reconstructs credential facts in source construction order, sorted
permission names and schema-ordered scope. It verifies the actual revocation
digest, guarded lease epoch and managed-binding authority revision rather than
trusting agreement among copied records. The command's expected revision must
be the actual initial empty sidecar hash; the refreshed action must use the exact
changed sidecar byte hash. Save acceptance must remain within the original
rule/credential/lease/owner currency interval.

## Physical mutable publication histories

The kernel replay now retains additive creation path/entry and successful
unlink/rmdir entry/completion positions on the same reconstructed objects. Existing
guards, syscall vocabulary, aliases, flags, byte bounds and namespace behavior
are unchanged. A dedicated control drives actual base namespace/event methods,
including unfinished close, and verifies these fields come from raw records.
No producer JSON physical tuple or success flag supplies them.

The Save verifier requires:

* Exactly two credential publications: operator-only, then that same operator plus
  the distinct reviewer. Actual current bytes must descend from those physical
  histories before original resource creation and capture. This source issues no
  optional credential label/expiry/bootstrap fields or lease note; its issuance
  shapes are closed without changing the general stores' optional-field contract.
  Extra/replacement/rollback histories refuse.
* Exactly one original guarded lease publication, with physical exclusive-link
  lineage and temporary cleanup before credential/capture provenance. This source
  does not renew or replace the lease during the bounded run.
* Exactly two sidecar writers and two physically distinct strict lock/token
  cycles, all within Save. Each writer is the source's exclusive 0600 PID
  temporary and same-parent rename. Mode/uid/gid, physical identity, actual byte
  writes, close/publication order and original parent identity must agree.
* Lock directory creation precedes exclusive token creation/write/settled close;
  token close must complete before policy writing begins. Policy close/rename
  must complete before token unlink and empty-directory removal. A boolean
  `writer_closed` cannot substitute for the actual completion index.
  Token bytes must also equal the strict owner's exact compact JSON construction.
* The original capture settles before the first attestation, which settles before
  the protected approval. The actual Save journal append closes before saved
  policy writing; the saved strict lock cycle settles before the refreshed
  attestation, and that attestation settles before the Save phase acknowledgement.

Initial sidecar bytes must be the exact source serialization of empty version-2
policy. Saved bytes must be the exact source serialization of one typed record
bound to the authenticated approval. The observer reconstructs rule/match and
record construction order instead of hashing arbitrary parsed final snapshots.
A Node `JSON.stringify`/SHA-256 golden control checks the finite pretty bytes and
rule revision independently of the Python encoder.

The typed sidecar source performs write/close/rename without directory fsync.
This slice checks physical publication causality; it does not invent a durable
publication observation or claim crash/restart durability. Protected encrypted
records retain their separately required data sync, exclusive link, directory
sync and temporary-cleanup proof. The core saved rule still does not itself pin
offset/length; the original supervisor/service interval assertion and each
authenticated capture retain that separate bound.

## Source assumptions and remaining gate

The helper returns `authenticated-connected-save-correlations-only`,
`authority: none`, distinct source-designated persistence reviewer, unavailable
execution review, two policy publications and zero Save resource reads/answers.
Qualification remains
`unavailable-full-connected-effect-audit-and-fresh-evidence-pending`.

Original empty-policy require-human evaluation, explicit bridge Save transition,
owner-local review handles, retained attestation capabilities and one-time facade
refresh remain exact reviewed-source/in-memory associations. They are not
independently measured machine capabilities reconstructed from the approval JSON.
Original callback, final settled ownership, permit, automatic capture index and
dispatch object identity retain the preceding source assumptions. Random UUID
issuance, source/runtime/kernel trust, stable mounts/clocks/hostname and cooperative
same-UID owned process-group scope remain explicit. No general provider or hostile
same-UID/root containment claim is introduced.

Remaining before any connected accepting decision: independent review of this
composition; complete aggregate kernel/private-I/O effect auditing and all original
same-invocation physical checks; actual deferred/lost acknowledgement, cancellation
and duplicate completion/dispatch evidence for the full composed path; and a fresh
complete connected trace under the unchanged 256 MiB, 60-second process and
55-second owner limits. Missing/unknown effects must refuse at their first exact
cause. No report/hash/helper output releases a command. Restart/crash recovery
and general execution-judge policy remain outside this normal-lifecycle slice.

## Local controls

All positives are explicitly synthetic, not observed connected runs. Semantic
negative payloads are reencrypted with valid filename AAD and independently
roundtripped before semantic rejection. Coherent controls include stale approval
and attestation revisions; operator-as-reviewer substitution; widened rule/approval
scope with recomputed rule and current policy revisions; equivalent parsed policy
with wrong source bytes; reordered self-consistent rule hashes; revoked current
credentials or replaced lease; extra mutable histories; wrong-phase writes;
physical alias/mode/owner substitution; pending token close; early token/directory
removal; missing raw observations; and scalar/unknown-field aliases.

The complete Python observer suite passes **244 tests** (6.858 s), including **22
Save controls**. All 22 Save controls also pass under `python3 -O` (1.779 s).
`git diff --check` passes. The Node golden control uses only synthetic input and
the native JSON serializer/hash functions; no actual credential, service or user
workspace is provisioned. No TypeScript rebuild or provider acceptance is claimed.

```
python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py'
python3 -O -B -m unittest discover -s tools/owned-read-proof -p 'test_controlled_save_semantics.py'
git diff --check
```

No producer/provider runtime, accepting gate, credential/access setting, shared
lockfile, main branch or Mac path is changed. Parent owns independent review and
integration. Raw traces, protected evidence and secrets remain unpublished.
