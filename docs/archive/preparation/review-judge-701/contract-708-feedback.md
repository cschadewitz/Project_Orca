# #701 compatibility feedback on proposed #700 contract

Inspected [draft PR #708](https://github.com/cschadewitz/Project_Orca/pull/708) at
`e08bc96ab3250718c93f77057b5560e7b6421dcd`, including its contract, README, ADR,
compile-time fixtures and acceptance cases. This is feedback for the parent and
independent reviewers, not approval, a frozen interface, a schema fork or production
adoption. No peer-branch code was copied/imported into this preparation or production.

The proposed separation of action/policy/judge/enforcement owners, current authority
checks, one-use permits, explicit unknown facts, strict native choice qualification,
automatic approved-rule responses and advisory/required failure limits is compatible
with the intended #701 direction. The following differences block a direct port mapping.

## Required #701 mapping corrections

1. **Delegated eligibility:** the proposed `JudgeRequestV1` is constructed only after
   an approved rule explicitly delegates fit assessment. Our `approved-rule` fixture
   symbol does not encode that distinction: in advisory/required mode its harness
   currently invokes a judge for any such symbol. Treat the existing vectors as
   assuming explicit delegation, not as a complete eligibility test. Add separate
   matching ordinary-rule/no-delegation and delegated-rule vectors after review.
   The ordinary rule should respond automatically without an extra judge/human step;
   unsolicited fit advice must not gain policy authority. Match C10/C11 semantics.
2. **Advice vocabulary and policy ownership:** local `allow` maps only to candidate
   `fit`, never `PolicyVerdictV1.allow`; local `deny` maps to `not-fit`, not a mandatory
   policy denial; local abstain/escalate and failures need distinct indeterminate
   reasons. The local simulator always stops on a judge denial, whereas #708 lets
   the approved rule determine whether not-fit stops or escalates. That choice must
   remain with #702's deterministic evaluator. Local `hold`/`escalate` are symbolic
   expectations, not ready-made canonical verdict serialization.
3. **Review binding and lifetime:** the local synthetic runner has no review/action/
   authority/coverage/rule/projection identities to validate. #708 requires matching
   retained request state and post-review reevaluation. Add negative fixtures for each
   changed binding and expiry/revocation during review, rather than claiming the local
   immutable enum snapshot proves these properties. Convert `deadlineAt` into a finite
   local remaining timeout bounded by the original invocation/action lifetime; never
   extend the deadline on retry or late delivery. Cancellation still holds every mode.

## Contract questions for #700/#699 review

**How does approved projection content reach the adapter?**
`JudgeRequestV1.approvedProjection` is a `RepresentationV1` with private/binding references,
while `ReviewJudgeV1.assess` has no materialization argument or capability. Please name
the trusted materialization owner and seam. A coordinator-supplied immutable approved
payload or a narrowly bound projection reader could work; the judge must not acquire
a general protected-store dereferencer. Validate the exact projection binding, schema,
byte limit and destination policy before invocation. Never serialize the entire internal
request, authority stamp or protected references into a model/provider prompt by default.
This can be clarified without expanding the canonical private action envelope.

**How are unavailable versus assessed-indeterminate results distinguished?**
`JudgeResultV1.result` has only fit/not-fit/indeterminate and a string `reasonCode`.
The README correctly distinguishes advisory unavailable from reviewed advice, but the
accepted mapping needs to retain whether review actually occurred. Our fixtures treat
transport failure/timeout/malformed as unavailable and evaluated abstention as escalation;
conflating these could change declared advisory behavior. Specify a versioned closed
classification or owner-retained execution-status record. Unknown codes must not be
interpreted as a permissive unavailable result. Expected errors should be normalized;
unexpected thrown/rejected adapters must also hold a required lane and expose no raw error.

**What does `judgeVersion` pin and how is compatibility negotiated?**
The single string can remain compact if it identifies an immutable manifest containing
method, transport, model, config/prompt, input/output schema and destination/disclosure
versions. Please confirm that interpretation or the owner of equivalent protected
metadata, and define negotiation failure before invocation. The selected instance and
retained request must bind that identity; don't accept whichever version the response
claims. Optional latency/token/cost and coverage limits can remain separate audit data.
No extra authority fields or public wire schema are needed for this clarification.

## Prepared follow-up vectors, execution pending

| Shared case | Additional #701 vector after reviewed interface confirmation |
| --- | --- |
| C10 | Approved rule lacks judgment delegation: zero judge calls; unsolicited fit ignored/rejected; no new authority |
| C10 | Wrong review/action/authority/coverage/projection/rule revision, destination or selected judge version: required lane holds |
| C11 | Ordinary matching rule automatically responds without judge; delegated fit responds after deterministic reevaluation; mandatory-human remains human |
| C12 | Distinguish transport-unavailable, malformed/timeout and evaluated indeterminate; verify declared advisory composition and separate audit attribution |
| C12 | Not-fit follows the approved rule's stop/escalate policy, with no provider/profile fallback |
| C20 | Unresolvable or insufficient safe projection and unauthorized destination: no materialization/egress and explicit unsupported state |
| C22 | Cancellation, turn expiry or revoked original authority during review: no late automatic response or restored callback |

Current local evidence remains the 79 offline tests recorded in [validation](validation.md).
These additional identity/contract vectors are prepared expectations, not newly executed
integration acceptance. Continue only after the parent confirms the reviewed #700 interface;
keep #712 draft and preparation-only in the meantime. No provider, credential, native
enforcement, #594, sandbox/privacy, release or deployment acceptance changes.
