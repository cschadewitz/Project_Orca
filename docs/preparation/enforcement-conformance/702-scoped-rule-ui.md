# Inactive scoped rule choices (#702 / #706)

This slice adds an optional injected form to the existing `PermissionCard` and
`AnswerCard`. No production caller supplies the port. Existing Attention, inline
asks, configuration, defaults, first-run queued-state handling and sidecar writes
retain their existing paths. There is no new queue, policy store, protocol command,
bridge endpoint, provider hook or write adapter.

## Minimal owner interface

`packages/app/renderer/src/attention/scoped-rule-review.ts` defines renderer-local
callbacks, not a competing persisted or wire schema. The persistence owner and
parent must review the real adapter before it is supplied anywhere in production.

The adapter supplies:

- A scope key bound to workspace identity, connection generation, input identity
  and reviewed revision. An authoritative refresh must replace it after a result
  is reconciled; rerendering an old key does not release its submission latch.
- An asynchronous review read which validates the pending explicit input and
  returns unavailable on failure. Permission titles, option labels, path-prefix
  heuristics and model rationale cannot establish reviewed scope.
- Disclosure-approved exact principal, operation, resources, effective environment,
  proposed lifetime, limits, authorizer and enforcement coverage/exclusions.
  These strings must be approved for this UI destination, not copied from private
  action records. The form does not redact arbitrary private data.
- The existing #726 `GuardDecisionView` produced by its safe projection owner.
  It remains descriptive: neither the view nor a reported evidence tier creates
  a capability or certifies installed support. Rule, revision, authorizer, review
  and coverage references use that view's approved opaque references.
- A review deadline, current-binding check and owner result for required review
  of the proposed scope. This is distinct from the historical decision view,
  which can correctly have no existing grant or authorizer yet.
- Separate optional Allow once, Deny and Create scoped rule capabilities. These
  callbacks capture the owner's reviewed command; the UI constructs no payload.
  Their result distinguishes confirmed, refused, stale and uncertain outcomes.

The real owner adapter must enforce current authority, `permissions.grant`, the
existing explicit-input/revision boundary, exact scope/revision checks, idempotency
and acknowledgement reconciliation at the command boundary. The synchronous
current-binding check is only an early UI veto, never a substitute for those
checks. The Allow once capability must select a proven per-invocation native
option or reviewed ORCA-owned equivalent; it must never fall back to a standing
native option. Deny must target only this current pending invocation.

Create scoped rule saves exactly the reviewed scope and must not answer, resume
or dispatch the current invocation. It is deliberately a separate action from
Allow once. Ordinary answers cannot reach the rule capability or legacy `always`
transport path through this form. A successful save requires a fresh authoritative
read before a separate answer can be offered.

## Persistence checkpoint: still blocked

The parent's persistence checkpoint identifies an existing replacement-writer
path on baseline `df2e623` that can replace a version-2 sidecar with valid
version-1 input despite a matching revision. The persistence owner owns the
upgraded-v1 refusal hardening. Typed writing remains blocked on an enforced
minimum-writer/no-downgrade policy and whole-root recovery policy. This UI slice
does not work around that boundary or register a writer.

The owner's candidate persistence-only seam is
`createScopedRule({ rule, expectedRevision, approvalRecordRef }, authority)`
returning `{ revision }`, with reads through owner-qualified
`StrictRuleRead`/`createStrictPermissionSource`. This is a conditional contract,
not an approved endpoint or a renderer-defined schema. Source checkpoint:
[#702 comment 6409457524](https://github.com/cschadewitz/Project_Orca/issues/702#issuecomment-6409457524).

For eventual integration, the owner adapter must capture exactly that command in
the save-only callback, bind its reviewed disclosure to rule/revision/approval
record, workspace/input/connection generation and authorizer, and qualify the
returned revision against authoritative state for the exact saved rule before
mapping to the UI's `confirmed` outcome. Missing or mismatched acknowledgement
remains uncertain. Refresh should supply the safe rule/revision references through
#726, not disclose the protected approval record or raw storage material. Neither
Allow once nor Deny receives any writer capability. No additional persisted or
wire fields are proposed by this UI seam.

## Behavior and recovery

Review opens in the existing card shell using its primitives and scroll region.
Scope/limits and decision/coverage/lifecycle observations appear before positive
choices. Rule creation opens a second in-place step with Back first and focused;
only Save scoped rule invokes its owner capability. No default or Enter shortcut
selects rule creation. The shared AnswerCard ordinary answer keys are inactive
while this injected form is present.

Missing disclosure, incomplete scope, failed/unavailable required review, stale
binding, expired review, expired/revoked grant, unsupported path and unknown or
weaker coverage disable positive choices. A current owner-provided denial remains
separate. A reported verified tier alone cannot supply missing capabilities.
The UI does not claim approval recording proves callback delivery, actual dispatch
or observed effect; those remain separate #726 observations.

Every mutation takes a synchronous submission latch before invoking transport.
All results, including save refusal and uncertain/lost acknowledgement, require
an authoritative refresh before another mutation. There is no automatic retry.
The reviewed details remain visible with the outcome. Closing a settled review
hides it but does not release that latch. While a command is pending, Back/Cancel
and stack Escape remain blocked: leaving the application or switching workspace
cannot cancel an already submitted command or prove its outcome. The future owner
must reconcile uncertain results rather than automatically replaying them.

Cancel/stack close before submission discard only the local review and invalidate
late read results. Workspace/connection/review key, input identity, live target or
callback state changes unmount the old form and invalidate late acknowledgements.
Focus returns to the trigger, the surviving card region or the settled review
region only when the disappearing controls held focus. Focus moved outside the
review is preserved. Escape uses the existing layer stack, not another listener.

## Evidence and remaining acceptance

The synthetic renderer tests inject only read/command ports and execute the real
safe projection helper and existing card primitives. They cover choices, missing
capabilities, failed/stale review, unknown coverage, disclosure canaries, callback
expiry, revocation, repeated clicks, save failure/uncertainty, cancel/back/close,
workspace/input changes and focus. Existing Attention/revision/readiness and
first-run regressions remain required. These tests prove UI behavior only; they
prove neither real storage persistence nor actual execution/enforcement.

Pending: parent-supplied reviewed command contract, adapter implementation against
that exact contract, real revision/authority/idempotency integration tests,
privacy review of exact scope disclosure, bounded ORCA-owned tool qualification,
and parent integration acceptance. The feature stays default-off/unregistered
until then. No live grants, user policy writes/migration, providers, credentials,
production activation or release are part of this slice. #702/#706 remain open.
