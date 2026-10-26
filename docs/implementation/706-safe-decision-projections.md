# Inactive coverage and decision projections — #706

This bounded slice under #699 adds [a pure protocol helper](../../packages/protocol/src/guard-decision-projection.ts)
and [synthetic tests](../../packages/protocol/test/guard-decision-projection.test.ts) for later reuse
by existing Attention, permission and audit surfaces. It consumes the accepted
[canonical types](../../packages/core/src/model/tool-execution-guards.ts),
[composition contract](../preparation/tool-execution-guards/README.md),
[synthetic fence composition](../preparation/enforcement-conformance/composition-slice.md)
and [inactive policy seam](702-inactive-policy.md). Canonical APIs and #702's
source/storage implementation files are unchanged. #706, #702 and #363 remain open.
The helper is not re-exported by the production protocol barrel; tests import its
module directly, following the existing inactive seam pattern.

## Projection boundary

`projectGuardDecision` takes an unknown snapshot, an explicit clock and an injected
`GuardProjectionDisclosure` capability. `GuardDecisionProjectionInput` documents how
canonical coverage, verdict, review and receipt records compose with lifecycle facts
and independent observations. It is an internal composition input, not a new RPC,
persisted schema, store, queue or source of policy authority. It parses only named
fields and emits closed classifications, canonical timestamps, nonnegative measured
revocation latency when supplied, and approved opaque reference IDs. It never displays
private IDs, arbitrary labels, reasons, raw errors, commands, paths, resource/scope text,
model rationale or credentials. Malformed inputs and thrown projection errors return
fixed diagnostics with unknown facts, without propagating raw exception details.

This follows the closed allowlist approach of the existing
[operator read projection](../../packages/daemon/src/operator-read-model.ts) and
[operator protocol](../../packages/protocol/src/operator-reads.ts). It preserves the
public/private split in [protected execution storage](../protected-execution-storage.md).
The existing general `OperatorIdSchema` intentionally accepts arbitrary strings and
cannot establish safe disclosure for these private references. This helper therefore
requires an explicit destination-specific approval capability and closed `{ id: UUID }`
public references. UUID syntax alone is never approval: unapproved UUID-shaped private
values are omitted, and returning a private value unchanged is refused even if it is a
UUID. Approved references must be independently assigned opaque public
IDs, never low-entropy secret hashes, encodings, raw private refs or inferred labels.
There is no general redaction regex, new reference registry or protected-record reader.

The trusted owner must bind the disclosure capability to the exact authorized snapshot,
reader, destination and current disclosure policy. `requiredDisclosure` receives an
isolated copy of the exact parsed snapshot so approval can reject changed records without
mutating the retained projection input. It attests that the
required decision-relevant material can be safely disclosed with sufficient meaning.
If this cannot be established, the entire view is unavailable and no positive decision,
authority or review is emitted. Per-reference refusal withholds the affected attribution;
missing rule/revision or human attribution also suppresses positive authority. Capability
failure cannot leak raw diagnostics. The helper cannot authenticate its input or prove
an approval capability is correctly implemented; production binding requires #363 review.

## Meaning and uncertainty

Coverage is a **reported evidence tier**, not qualification by this helper. Source-only,
missing installed/independent evidence or missing hook/config facts cannot report verified
per-execution coverage. Observation-only or unknown coverage cannot show current positive
authority. `support` is deliberately limited to unsupported/unknown; even the synthetic
installed-reference fixture cannot advertise supported operation. Provider/tool/version/host
scope resolves only through the approved coverage reference, with no raw metadata fallback.

An allow view requires approved attribution, matching coverage, explicit applicability,
current authority, active revocation state and a known lifetime. A one-shot requires a
bounded lifetime; an explicitly unbounded stored rule remains visibly unbounded. Missing,
absent and unknown facts do not become a known empty/default authority. Rule ID/revision
and rule/human authorizer are kept separate from one-shot/stored-rule authority. Non-allow
canonical verdicts do not carry matched-rule attribution; this helper does not invent it.
No profile/rule matching, delegation eligibility or policy evaluation is implemented here.
These conservative display conditions do not authorize an action or enable a positive choice.

Revoked/expired snapshots suppress positive current authority. Repeated calls recompute
the complete view and never merge a stale positive state into a later incomplete snapshot.
No timer, subscription, durable recovery, invocation deduplication or replay is implemented.
Any measured revocation latency is supplied explicitly; missing latency stays absent.

The coarse execution receipt is displayed independently of four attributed observations:
approval recording, response delivery, dispatch and independently observed effect. Each
observation requires an approved source and a valid non-future observation time. A missing
observation is unknown; `not-observed` requires an explicit observation record and never
means missing telemetry. A completed receipt does not manufacture any observation. A
recorded answer does not imply delivery, delivery does not imply dispatch, and dispatch
does not imply observed effects. Revocation/cancellation cannot erase an observed effect
or promise an undo. Execution-unknown never invites retry.

Review execution distinguishes evaluated fit/not-fit/indeterminate from unavailable.
Unavailable-fit, unknown labels, missing approved review refs and mismatched action,
coverage or authority bindings cannot become positive review. Missing required disclosure
and stale/unknown authority suppress fit. Review advice cannot create authority: a fit
without the independently supplied allowing policy verdict stays unknown. The protected
verdict's optional `judgeResultRef` also requires its matching approved review record;
missing/misbound/contradictory referenced reviews suppress positive authority. A valid
unavailable advisory record remains unavailable alongside an independently allowing rule.
The protected owner must validate exact review/config/projection provenance before composing this input;
this helper supplies no model execution or review-registration capability.

## Validation and remaining acceptance

The tests exercise all four reported coverage tiers, source-only/missing qualification,
safe rule/revision and human refs, bounded one-shot versus stored authority, explicit
unbounded/unknown lifetimes, expiry/revocation/owner-loss/repeated snapshots, independently
missing observations, recorded-but-undelivered answers, coarse execution-unknown receipts,
unavailable/contradictory/misbound review, invalid clocks, malformed/untrusted input,
unapproved references and raw error/canary exclusion. They use synthetic facts only.
Actual command results and the exact final head are reported in the draft PR.

The baseline is main `040fe081731ae636198a283ea70d421428dc328c`; its combined full CI was
still pending when assigned. This work makes no claim that main is green. Setup uses the
pinned pnpm 12.4.2 frozen install with unchanged lockfile and lifecycle/supply-chain policy.

Privacy review, production record/source adapters, approved reference provenance and
retention, exact authorization/revocation refresh, UI/audit wiring and installed/physical
effect acceptance remain later owner-reviewed work. No production registration, defaults,
rule writes, providers, credentials/access, hosted services, paid benchmarks, hooks, sandbox
changes, upstream communication, releases or deployments are included. #594 and its actual-Cal
acceptance remain unsupported by these synthetic tests.
