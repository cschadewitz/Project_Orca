# Authenticated connected delivery correlations — incomplete

Refs #699 / #706. This separate preparation branch,
`cal/706-connected-semantic-correlations`, starts from independently reviewed
#762 head `d5005fcb05e9a5c5b9e8bd5a50fd1008275d3e57`. The preparation-only
[kernel grammar](controlled-connected-kernel-grammar.md), exact bootstrap
[decision](controlled-bootstrap-gate-decision.md) and
[attestation](controlled-exact-attempt-attestation.md) remain unchanged in scope.
The producer source pin remains `557f62fbe86fc8371d48f11ec37bf9db71cac436`.

## Bounded subset and source contract

`controlled_delivery_semantics.py:authenticate_connected_delivery` supplies
necessary authenticated delivery/dispatch correlations after complete
`ConnectedKernelReplay`. It is deliberately **not** a full Save/persistence
authority verifier or a qualification capability. It is not wired into the
executable supervisor; no command is released. The executable supervisor still
runs only bootstrap, reports `connectedCommandsReleased: false` and retains exit
2 for partial evidence. No fresh bootstrap, connected process or trace was run.

The finite source-owned records come from:

* `controlled-owned-read-producer.ts`: baseline, original/refreshed/fresh capture,
  two persistence-review envelopes, final-delivery diagnostic acknowledgement,
  two canonical authorizations and two producer observation correlations.
* `protected-event-store.ts` and `execution-store.ts`: filename/AAD-bound encrypted
  envelopes and public journal projection of the actual private event payload.
* `human-input.ts`, `live-input.ts`, `owned-read-scoped-capture.ts` and
  `synthetic-read-fence.ts`: original request/once-answer identity, final original
  ownership settlement and canonical human versus fresh rule attribution.
* `owned-file-read-service.ts`, `protected-scoped-permission-owner.ts`,
  `strict-permission-source.ts`, `typed-sidecar.ts` and `credentials.ts`: original
  resource projection, managed root binding, current authority epochs, exact
  sidecar byte revision, rule revision and 12-character credential identities.

The subset reconstructs original enrollment roots/identity/witness with the
existing semantic helper and the kernel-retained initial sidecar object. The
actual initial sidecar must be empty and its exact bytes must hash to the
baseline/initial action revision. Exactly two distinct physical sidecar
publications must survive in replay history: initial and saved. The current
sidecar's exact bytes supply the refreshed/fresh action revision, approved rule,
rule revision, original Save-marker locator, actor and authority attribution.
Mutable sidecar publication is checked as close-before-rename lineage; it is not
relabeled as an fsync/durability proof that the source does not provide.

The helper reuses closed action/service schemas, original physical resource stamps
and projections, credential/lease/authority digest construction order, native ELF
platform binding and the unchanged integer owner-expiry predicate. Original,
refreshed human and fresh rule actions must have distinct action identities.
Original/refreshed invocation identity stays fixed; fresh rule invocation and turn
are exactly the source-designated separate values. Operation, resource, interval,
scope and owner expiry cannot widen during either transition. Current actual
credential bytes must contain both designated unrevoked principals; permissions,
scope, credential creation/currency, guarded lease identity/currency and authority
epochs are reconstructed rather than accepted from an authorization equality alone.

## Observed records and causal predicates

The helper decrypts every actual final `.payload.json` object using the original
kernel-reconstructed key, exact filename AAD and existing strict JSON decoder.
Physical publication, directory synchronization, durable-publication raw indices
and original raw-line clock samples are required; missing evidence refuses.
The finite inventory is 15 encrypted records, with no additional semantic kind:

| Record family | Count |
| --- | ---: |
| Baseline | 1 |
| Original, refreshed human, fresh rule captures | 3 |
| Persistence review envelopes | 2 |
| Original final-delivery diagnostic acknowledgement | 1 |
| Canonical human and rule authorizations | 2 |
| Corresponding producer observation correlations | 2 |
| Actual requested, waiting, Save, answered journal payloads | 4 |

The journal replay now retains the actual append entry indices as well as closes.
Each authenticated private event must durably publish before its public append;
its type and projection must match the actual journal reference/sequence exactly.
For Save, the private `entry` bytes are authenticated and kept opaque in this
subset; their authority semantics are explicitly unvalidated. A dedicated control
uses an invalid opaque entry and still returns **no Save authority**, documenting
that boundary rather than silently treating decryption as approval validation.

The actual answer append must close before creation of the diagnostic final-ack
record. That record must durably settle in `human-read`, with the original request
and operator, before creation of the refreshed human capture. The capture must
settle before canonical human authorization, which must settle before the one
original service pread, followed by its correlated producer observation. Only
after that observation settles may the fresh rule capture be created. Its separate
canonical rule authorization must precede exactly one further service pread and
its observation. Captures, authorizations, observations and effects must lie in
their exact phase windows. Extra/missing effects or authorizations refuse;
producer observations are correlations, never independent effect counters.

The human verdict's acceptedAnswerRef must exactly encode the original answered
event ID/run. The fresh rule verdict has only rule identity/revision attribution;
it cannot acquire human attribution or a judge result. The source has no configured
execution judge. These predicates establish no mandatory-judge or new-grant
precedence theorem. Duplicate dispatch with an additional observed read refuses;
the identity of the in-memory reused receipt remains a source-level property.

## Source trust versus independent observations

| Independently checkable from original replay inputs | Exact-source / trusted-supervisor assumptions |
| --- | --- |
| Physical resource, roots, original files, image association and protected bytes | Parent's bootstrap designation and permanent original instance closure |
| AEAD filename-bound plaintext, finite schemas and public/private journal correlations | Trusted reviewed source/runtime and original key provenance; no hostile same-UID memory/key protection |
| Current sidecar byte revision, rule/status/revision, original actor, current credential/lease epochs | Original credential issuance and random UUID issuance are source-owned identity, not independently measured entropy |
| Raw durable publication/phase/effect ordering and two actual bounded preads | The diagnostic acknowledgement was emitted by the exact original callback/ownership path after genuine final settlement |
| Separate original/fresh invocation values and canonical human/rule verdict bytes | Registry, original callback, automatic capture index, permit and dispatch object identity remain unprojected memory |

The diagnostic record and acceptedAnswerRef cannot recreate live delivery
authority. The verifier returns record
`authenticated-connected-delivery-correlations-only`, `authority: none`,
`liveDeliveryAuthority: unmeasured-exact-source-memory`,
`saveAuthority: unvalidated-persistence-approval-and-review`, and qualification
`unavailable-save-authority-and-full-connected-effect-audit-pending`. No child
success flag, report digest or produced coverage boolean grants authority. The
source's connected coverage shape is checked as a shape; actual observed reads
come independently from the kernel replay.

## Two source-grammar corrections

The earlier journal grammar incorrectly required a UUID for actor credential ID.
`CredentialStore.create` emits exactly nine random bytes encoded as 12 base64url
characters; its record/token schemas enforce that format. This slice changes only
that credential field to the exact source grammar and tests actual-shaped IDs
versus UUID rejection. Payload/approval/action UUID predicates remain unchanged.

The typed sidecar publisher uses the same `<sidecar>.<leaderPid>.tmp` basename for
both initial enrollment and Save. The default bootstrap replay still refuses
reuse of every writer path. A connected-only override permits the second exclusive
creation only during Save, at that exact basename, after the initial physically
bound writer close/rename completion, with the original final sidecar still named.
It requires an actual new O_EXCL inode lineage and rejects a third publication,
pending/overlapping predecessor, wrong phase, missing physical binding, or any
other private temporary reuse. All original open flags, alias checks, byte bounds,
notification proof, namespace checks and interval history stay in the base replay.

## Validation and remaining obligations

All fixtures are explicitly synthetic. Same-key semantic tampering is reencrypted
and independently AEAD-roundtripped before rejection. Controls cover lost/pending/
late/wrong-target acknowledgement despite an existing answer; revoked actor,
reviewer or rule; coherent stale policy/epoch changes; wrong attribution, phase,
invocation, root, resource stamp and interval; extra reads/authorizations;
public/private mismatch; missing publication/clock observations; and schema/AAD
tampering. No fixture or local pass constitutes a connected run.

The complete Python suite passes **222 tests** (5.853 s): 20 new delivery semantic
controls and 36 connected grammar controls are included. Optimized Python also
passes all 20 delivery controls (0.395 s) and all 36 grammar controls (0.077 s).
The prior exact `d5005fcb` journal method was separately loaded read-only and
confirmed to refuse the new actual-shaped 12-character credential fixture at its
UUID predicate. `git diff --check` passes. No TypeScript producer rebuild or
new provider acceptance is claimed; those source files are unchanged.

```
python3 -B -m unittest discover -s tools/owned-read-proof -p 'test_*.py'
python3 -O -B -m unittest discover -s tools/owned-read-proof -p 'test_controlled_delivery_semantics.py'
python3 -O -B -m unittest discover -s tools/owned-read-proof -p 'test_controlled_connected.py'
git diff --check
```

Remaining before any accepting connected decision:

* Fully validate both persistence attestations, distinct reviewer/grant authority,
  the complete protected approval entry, bridge review/explicit Save semantics,
  scope evidence/disclosure projection and one-time facade refresh. Closed
  persistence envelope fields alone are not validated persistence authority.
* Correlate all additional mutable histories and exact required-policy outcomes,
  not just the initial/current observations consumed here. Current bytes do not
  by themselves prove the entire credential/rule history or every revocation race.
* Preserve genuine original callback and settled ownership capability semantics
  under pending/lost ack, cancellation and duplicate completion/dispatch. This
  subset checks necessary authenticated correlations; it does not replace the
  existing source-owned in-memory proof or establish durable restart recovery.
* Complete kernel/private-I/O effect auditing and original same-invocation physical
  checks, then collect a fresh complete trace under the unchanged 256 MiB trace,
  60-second process and 55-second owner limits. Missing/unknown effects must refuse.

No other provider, production guard, security setting, credential/access, shared
lockfile, Mac path or accepting gate is changed. Parent owns independent review,
integration and any later acceptance decision. Raw traces and secrets are never
publication artifacts.
