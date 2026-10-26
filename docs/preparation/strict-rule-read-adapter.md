# Inactive strict-rule read adapter (#702)

This bounded slice consumes main `040fe081731ae636198a283ea70d421428dc328c`, including
#722. It adds an internal, unregistered source adapter in
[`strict-permission-source.ts`](../../packages/agents/src/strict-permission-source.ts).
Canonical contracts, evaluator, provider qualification and decision projection are unchanged.
No production caller constructs the source. All positive typed material in the tests is synthetic.

## Read contract and provenance

The original owner captures the ceiling at source construction. Each read snapshots the
original action before awaiting, reads current principal/config/revocation/lease/coverage
boundaries, reads rule material, then rechecks the entire boundary snapshot. Current facts
cannot widen the captured ceiling. A changed boundary, aborted invocation or unavailable
material produces unknown rules. Boundary-read failure propagates to the existing policy
port's `current-policy-unavailable` path: the adapter cannot fabricate authority epochs.

Rule reads explicitly distinguish unavailable, malformed, unsupported and qualified material.
Only a protected owner port can supply qualified material. Its receipt must identify source,
scope evidence and grant-authorized approval records, match current policy/authority revisions,
and bind the ordered rules by digest. These are private owner references, never credentials,
public proof, model output or fields copied from an ACP request. Nonempty strings and hashes
validate the shape/binding; they do not authenticate an untrusted caller. Construction and
provenance verification remain the trusted owner's responsibility. There is no public parser
or endpoint that accepts a self-asserted receipt.

Typed projections require complete explicit predicates, valid physical or disposable-memory
resource identities, unique rule ids, and content-bound immutable rule revisions. The digest
helpers bind the exact JSON projection encoding including all match/lifecycle/delegation
fields; these helpers specify no on-disk schema. A mutation under the same rule revision is
refused, and reordering changes the projection digest. Returned rules share no references
with caller material. No state, revision history, queue or policy cache is retained.

Revoked/expired/future rules remain present and ordered for the existing evaluator to decide.
The adapter neither filters revocations nor introduces deny-overrides. Mandatory-human,
captured/current ceilings, per-phase rereads, retained-review terminality and final fence
generation assertions remain owned by the accepted evaluator/policy/fence from #722.

## Concrete persistence compatibility decision for parent

The current configured `PermissionPolicySchema` supports kind/title/path/prefix/workspace
heuristics. Existing `RecordedPermissionRuleSchema` adds only `addedAt` and `grantedFor`.
Neither supplies principal/host/runner, exact qualified resources and environment, coverage,
duration, rule identity/revision or grant-authorized approval evidence. A file content hash,
path, title or timestamp cannot invent those fields. `readLegacyStrictRuleMaterial` therefore
refuses promotion even for valid or empty legacy documents. Missing required sidecars are
unavailable; invalid JSON/schema is malformed; unknown versions are unsupported. The current
legacy evaluator's missing-file/default/floor behavior is unchanged.

**Before a production scoped writer can exist, parent must choose a versioned representation
in the existing sidecar and its supported-reader/writer compatibility policy.** Adding unknown
typed fields to version 1 is unsafe: existing Zod readers strip them and the fixed-key serializer
in `permissions.ts` discards them when either an operator replaces the file or an existing
`recordAlwaysDecision` appends a legacy grant. That could silently lose typed restrictions.
A version bump alone also needs explicit refusal/preservation behavior in every old/new
writer and migration/recovery tests. Do not silently auto-migrate heuristics into typed rules.
The proposal is explicit opt-in typed records in the same sidecar, with old-writer refusal
and explicit reapproval of typed scope; parent owns whether that compatibility tradeoff is
acceptable. This PR makes no schema or migration decision and implements no typed writer.

The subsequent [persistence compatibility gate](strict-rule-persistence-compatibility.md)
reproduces a supported replacement writer overwriting version 2 despite a matching file
revision. It adds bounded refusal in upgraded v1 replacements, but cannot retrofit old
binaries. Typed creation remains blocked pending the parent's minimum-writer/downgrade
and recovery decision; a version bump by itself does not meet the same-sidecar requirement.

`StrictScopedRuleWritePort` is only a proposed internal type seam: its sole method creates an
explicit scoped rule with a reviewed approval reference and required expected file revision
(`""` denotes an absent file). Allow once and Deny have no standing-write method. A future
implementation must snapshot the command, use `replacePermissionPolicyFile`'s existing
sidecar lock, compare revision inside it, and recheck the original principal's
`permissions.grant` authority under the lock and immediately before replacement. It must
retain actor attribution through existing records. The authority capability must be bound to
that original principal/run; a client-supplied rule/receipt is never authority to write.

The existing live-input boundary durably records an answer before attempting the standing
write, and a write failure parks the prompt without delivering approval. That ordering is
preserved, including its uncertain-result and lease handling. This source adapter cannot
record, answer, persist or dispatch anything. No production registration/default/UI/protocol
wiring, second store, native/provider calls, live user policy edits or activation is included.

## Validation

The new source tests use synthetic owner receipts and disposable legacy files. They cover
source failures, refusal of legacy promotion, missing/stale provenance, malformed typed
scope, immutable revisions and ordering, current-source races, captured ceilings,
cancellation, revocation/expiry and scope mismatches. Legacy writer seam tests exercise
concurrent/stale revisions and revocation at both authorization checks. Allow once is repeated
without changing a sidecar. Existing live-input persistence-failure, strict retained-review,
memory composition/generation and daemon authority regressions provide the relevant accepted
boundary coverage; the final validation results are recorded in the PR.

Independent review found that `Array.every` skipped holes in four qualified-material
admission checks. The adapter now requires an own element at every index before validating
source references, rules, resources and environment references. Legacy source lists and
configured rule arrays receive the same explicit density check. This is an inactive,
trusted-owner contract-validation defect, not a demonstrated production privilege escalation.
No core evaluator or scope semantics changed.

The [failing-before evidence](strict-rule-read-adapter-evidence/sparse-before.txt) runs the
final regression tests against adapter source from `2c35a83`: all eight all-hole/valid-plus-hole
qualified-array cases and the sparse source-list case fail (9 failures, 55 passes). Tests
recompute rule revisions and projection digests and assert unknown rules directly, isolating
density rather than a later evaluator failure. The fixed adapter passes all 388 tests across
the same 12 regression files, including 64 adapter tests. Dense empty rules remain complete
and require human approval; dense empty resource/environment scopes still allow a genuinely
empty-resource action. Full typecheck, lint, build and formatting are rerun for the fix.

This does not complete #702's production scoped rules, migration, UI choices or live automatic
response acceptance. Main's combined CI was pending when this task was delegated; local
checks do not establish main green. Parent owns independent review, integration and activation.
