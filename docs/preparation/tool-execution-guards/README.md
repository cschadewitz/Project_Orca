# Tool execution guard contract v1 — inactive preparation

Owner: #700 under [#699](https://github.com/cschadewitz/Project_Orca/issues/699).
Baseline: main `32f92cc16b9faf1748059e930c3f77b3934151ae`, freshly fetched on
26 October 2026. No runtime imports, package exports, runtime configuration, hook installation,
policy defaults, capability advertisement or activation are added. The interfaces in
[contract.ts](contract.ts) are the single proposed v1 vocabulary for #701–#706;
they are not a public wire protocol. The narrow ESLint project override retains all
repository type-aware rules for these no-emit preparation files. [ADR 0010](../../adr/0010-versioned-tool-execution-guard-ports.md)
records the decision for review. Parent #699 coordinates adoption; this draft is not
reviewed acceptance or proof of support.

## Baseline findings

| Boundary / source inspected at the pinned baseline | Actual behavior | Coverage limit |
| --- | --- | --- |
| [ACP session](../../../packages/agents/src/acp-session.ts), `requestPermission` | Generates `PermissionInvocation` for a live turn; rereads policy per received ask | Policy per ask only. A cached native approval can avoid the callback entirely |
| [Permission evaluator](../../../packages/agents/src/permissions.ts), `decidePermission`, `resolvePermission` | Protected locations before first matching configured/sidecar/default rule; automatic `allow` prefers `allow_once`, then `allow_always` | Kind/title/location heuristics are not final argv or guaranteed effects. Automatic rules do not pass through the human callback |
| Same loader, `loadEffectivePermissionPolicy` | Missing/empty legacy sidecar is empty. Unreadable sidecar caps later allows to ask; earlier configured rules retain precedence | Strict required material must be validated independently; do not change this compatibility contract |
| Same ACP session, `fs.readTextFile` / `fs.writeTextFile` | Owned host I/O, lexical session roots and separate physical protected-path checks, without policy-per-ask evaluation | No tool guard permit or general physical root confinement. Read slicing happens after host read |
| [LiveHumanInput](../../../packages/engine/src/live-input.ts) and [orchestrator](../../../packages/engine/src/orchestrator.ts) | Owner-local original invocation and one-time offered choices; current authority under lease; answer recorded before standing write/delivery | A live callback is not a reusable gate or execution permit; human-only filtering does not constrain automatic `resolvePermission` |
| [ControlModel](../../../packages/daemon/src/control.ts), [config model](../../../packages/daemon/src/config-model.ts), [execution authorities](../../../packages/daemon/src/live-input-authority.ts) | Existing standing writer, revision-guarded config edits, current verified answer/grant/run authority | Reuse these foundations. Rule TTL, action use budgets and dispatch permits are not implemented |

For Claude/Codex/Pi/Gemini, baseline ORCA ACP policy applies only **if an ask arrives**.
This is a statement about the client handler, not installed provider/version qualification.
Native shell, built-ins, descendants, subagents, independent MCP routes, custom sessions
and remote execution have unknown coverage unless individually qualified. No installed
provider path is newly classified `verified-per-execution` here. [#594](https://github.com/cschadewitz/Project_Orca/issues/594)
remains unsupported pending its exact-command/actual-Cal callback/artifact acceptance;
source inspection and synthetic tests cannot close it. Existing live/sandbox/privacy gates remain.

## Port and ownership map

| Proposed port | Owner and eventual package seam | Consumer obligations |
| --- | --- | --- |
| `ActionEvidenceV1`, `FactV1`, `CoverageV1`, `PolicyVerdictV1` | #700 shared vocabulary; pure types eventually in core | Peer workers reference these names and semantics; incompatible changes return to #700/#699 |
| `PolicyPortV1` | #702 deterministic evaluation in agents/core; engine coordinates; daemon binds verified authority | Reread required current policy/revocation, enforce captured ceiling, explain matched rule/revision, issue review eligibility and retain/revalidate exact review requests |
| `ReviewJudgeV1` | #701 method/transport adapters; engine owns scheduling/projection | Consume only approved projection and delegated rule; no policy-write, tools, permit or credentials in the request |
| `EnforcementPortV1` | #703 engine coordinator and existing agents/host I/O boundary | Trust capture, validate authorization, record/consume once under ownership, dispatch only retained bytes; no caller IDs mint authority |
| Coverage qualification | #704 Claude; #705 other providers; #706 independent lifecycle/effects/privacy acceptance | Pin provider/bridge/tool/schema/host/platform, separate source and installed evidence, list bypasses; never infer enforcement from a prompt or hook name |
| Safe public projection | #702 protocol/app using existing permission surfaces; #363 privacy coordination | Internal types/private refs are not RPC schemas. App still imports only protocol/design |

## Action and coverage semantics

`ActionEvidenceV1` is a deep immutable snapshot made by the trusted boundary **before any
await**. TypeScript `readonly` is illustrative; implementations must copy/freeze and
retain the original dispatch object privately. Run/root/step/attempt, daemon boot,
agent/session/turn/invocation, principal, host/runner and action identities come from
verified owner state. Public toolCallId, RPC metadata and caller-claimed coverage are
correlation only. Human escalation additionally binds the existing `LiveDecisionTarget`
including requestId; do not replace `PermissionInvocation` or `LiveHumanInput`.

Preserve original representation and final dispatch representation separately. An adapter
registers an exact versioned codec and bounded parser; `codecVersion` is mandatory and
unknown codecs refuse strict use. No universal argv/shell/JSON equivalence is implied.
The protected binding covers every field affecting the decision, including exact bytes,
transformations, cwd, workspace, resources, executable/interpreter, stdin, environment
and credential **references**, relevant state, expiry, coverage and authority stamp.
A byte/string command stays byte/string exact; do not trim, normalize shell syntax or
substitute a display title. Parsed JSON binds the exact parsed structure; discarded raw
duplicate keys remain unknown. A raw-key-validation requirement cannot be satisfied by
an SDK that already discarded those bytes. Final preparation/transformation must finish
before authorization; any later transformation invalidates the action.

`complete` means the trusted boundary authoritatively captured the named attribute.
`absent` means the attribute does not apply and explains why; it is never shorthand for
an omitted list. `unknown` means evidence is unavailable/ambiguous. Known empty resource
or environment sets use `complete: []`. The immutable protected `profileRef` names the versioned requirements and limits. A
profile says which facts must be complete,
which may be absent and which effects must actually be constrained. A model cannot
promote unknown facts. Physical-path labels alone cannot defeat symlink/rename races;
use stable I/O handles/preconditions or an independently enforced resource boundary.
Relevant state includes file preimages/handles, script/config versions and remote expected
state as appropriate. Same command text with changed state is a new decision.

The additive inactive #706 composition repair declares `ActionResourceV1` once in core.
Existing physical targets retain `physicalTargetRef`; an explicit `disposable-memory`
alternative binds one original owner lifetime, resource identity and never-reused resource
revision. The same canonical type is used by approved rule predicates. Mixed/malformed
kinds and missing identities refuse; no cross-kind or undefined-field match is permitted.
The actual private-cell capability supplies synthetic memory evidence only. Resource-kind
support does not qualify a provider, lower a profile or turn a path into a physical handle.
See [the bounded composed slice](../enforcement-conformance/composition-slice.md).

`CoverageV1.level` has four distinct meanings: unknown; observation/UI only; current
policy per received ask; verified check at every execution on the **named path**.
Even verified interception does not imply every effect is constrained: list the exact
`guaranteedEffects` and `unsupportedPaths`. Its tuple is exact and versioned, with source
refs distinct from installed refs and independently observed effects. Installed evidence
must include allow/deny/revoke/outage and lifecycle/bypass results before qualification.
An empty tuple/evidence, missing protected configuration or unsupported hook negotiation
cannot support strict admission. Changing provider/tool/adapter/host/mode invalidates
qualification until rechecked. There is no best-effort downgrade after an enforcing
profile was selected.

## Deterministic evaluation and optional judges

Legacy mode retains ADR 0009 first-match ordering, unreadable-sidecar behavior and native
option mapping. Do not turn a later deny into legacy deny-overrides. Opt-in strict mode
puts current authority/captured ceilings, protected paths, required coverage/material,
profile prohibitions and mandatory-human requirements **outside** that evaluator. These
ceilings cannot be weakened by an earlier legacy allow, human choice, saved rule or judge.
A required missing/unreadable policy is indeterminate even if legacy fallback could allow;
explicitly optional legacy absence remains separate from required strict material.

Evaluate in this order: verified owner/current original authority and captured ceiling;
coverage and required evidence; deterministic scoped rules/limits; mandatory-human classes;
explicit delegated judgment eligibility; validated optional judgment; final verdict.
Explicit denial yields deny; unavailable required facts/material/checker yield indeterminate;
authority-eligible mandatory review yields require-human. None dispatches. A person may
resolve a policy-permitted ambiguity through a new evaluation, but cannot override a
missing execution boundary, revoked principal or forbidden capability.

An existing approved matching rule yields allow with rule ID/revision and current authority;
the coordinator automatically answers the live request or issues a new internal permit.
**No redundant human confirmation.** Each subsequent invocation is evaluated again, including
native cached approvals on certified paths. Native callback delivery must select an offered
allow_once with independently proven `effect: this-invocation`; remembered-only or unknown
options are unsupported in strict mode. `grantScopeAndLifetime` must independently establish the original invocation, one use
and its lifetime; null expiry/use values mean explicitly unbounded, never unknown.
No allow_always fallback. Deny can cancel rather
than persist a native remembered denial. An ORCA-owned I/O path need not manufacture ACP
options when it performs the dispatch itself.

A judge is invoked only for a scope in which an approved rule explicitly delegates fit
assessment. `PolicyPortV1.evaluate(action, signal)` returns either `phase: final` with
a verdict, or `phase: needs-review` with policy-created `ReviewEligibilityV1` and an opaque
`PendingReviewV1`. Only policy determines whether verified ceilings and delegated rules
permit this phase; the engine must not duplicate rule eligibility. Policy retains the
original action, decision binding, matched rule/revision, requirement, review ID, approved
projection/destination policies, immutable judge method/model/config `judgeConfigRef` and
deadline. A needs-review result is neither a final verdict nor an execution permit. Pending/bound
review handles are ephemeral owner-local state invalidated by the original lifetime; they
are not a new durable answer or recovery ledger.

The engine adds only the privacy-approved projection to form `JudgeRequestV1` and calls
`PolicyPortV1.bindReview(pending, request, signal)` **before** scheduling a judge. Policy
revalidates current eligibility, verifies every eligibility/config field against its retained
record, validates projection policy/provenance, copies the exact request including projection
binding, and returns opaque `BoundReviewV1`. Stale, forged, duplicate-registration or changed
requests refuse registration; errors cannot release a judge call or execution. The engine
schedules `ReviewJudgeV1.assess(request, payload, signal)` only for this registered immutable
request. It neither substitutes a different model/config nor rewrites a policy requirement.
The trusted engine projection/materialization seam resolves only the approved projection,
validates schema, codec, byte bound, exact binding and destination/disclosure policy, and
supplies an immutable `ApprovedJudgePayloadV1` string. The adapter receives no general
protected-store reader. Never serialize the entire internal request/authority/private refs
into a provider prompt; send only explicitly approved payload fields. Insufficient or
unresolvable safe content blocks the review without egress.

Never send arbitrary agent instructions or the complete private envelope. #701 may vary
small-model/JEV/other methods and hosted/BYOK transports without changing policy authority.
No provider setup or egress is authorized here. Destination/retention/projection policy,
finite deadline, frame bytes, response schema, pending count/concurrency and cancellation
must be validated before any future call. `judgeVersion` pins an immutable manifest covering
method, transport, model, config/prompt, input/output schemas and destination/disclosure
versions; policy-owned `judgeConfigRef` binds the selected manifest before scheduling.
The engine/adapter negotiates compatibility against that exact identity before invocation;
failure blocks the call. A response cannot select its own version. Convert deadlineAt to a
finite remaining local timeout bounded by the original invocation/action lifetime; retry
and late delivery cannot extend it. Unknown versions/labels, timeout, contradictory,
oversized or stale results are indeterminate, never a reason to shop for a permissive judge.

`PolicyPortV1.completeReview(bound, result, signal)` resolves the exact request/action
from policy-owned registration, never from caller-supplied replacement action fields. It
checks the review ID, action/authority/coverage/projection binding, retained rule revision,
judge version and immutable judge config, destination, lifetime and original principal.
It then reruns current ceilings, policy/delegation, revocation, relevant state and limits
before producing a final `PolicyVerdictV1`. A fit result does not itself authorize. Config,
model or request changes require a new eligible request and registration; a late/repeated
completion cannot overwrite a settled evaluation. The engine must attribute actual model/
config execution to that retained config; an untrusted model echo is not proof of it.

`JudgeResultV1.execution` is a closed classification: `evaluated` means validated assessment
(fit/not-fit/indeterminate); `unavailable` permits only indeterminate. The trusted adapter
normalizes transport failure/timeout/malformed output and unexpected rejection into an
unavailable result with a sanitized reason and retained execution attribution, without raw
provider errors. Evaluated abstention remains evaluated-indeterminate. Unknown labels or
status do not become permissive unavailable; policy treats invalid results as indeterminate.
#702 composes these distinct cases only as the approved rule declares.

Required judge failure blocks. Advisory absence may proceed only when the approved
deterministic rule already permits that path; audit it as unavailable rather than reviewed.
Transport/projection failures complete the retained review with an accurately attributed
indeterminate result or cancel it; they cannot bypass registration/completion. Not-fit
stops/escalates according to that rule. Mandatory-human classes remain human. Judgment
cannot create a rule, broaden resources, persist a grant or mint a permit. #712's separate
symbolic recommendations require an explicit validated mapping by the judge adapter to
this registered request's `JudgeResultV1`; they are not a policy verdict or bound result by
themselves. Local allow advice maps only to candidate fit, deny advice to not-fit, and
valid abstain/escalate advice to evaluated-indeterminate; transport failures map to
unavailable-indeterminate. None maps directly to policy allow/deny. Policy still owns
final composition/revalidation and never delegates eligibility to #712.

## One-use enforcement lifecycle

The ports are internal capabilities, never deserialized from public fields. `authorize`
accepts only a retained, trusted captured action and allow verdict; structural shape or
an action ID alone is insufficient. The owner checks verdict provenance/binding and
current authority/lease/policy/revocation/state/deadline/budgets. `OneUsePermitV1` is an
opaque owner-local handle to those retained records, with maximum uses fixed at one,
issuer/authorizer and issue/expiry times. Remote serialized permits are out of v1 scope.

Lifecycle: requested → evaluated → awaiting-human? → authorized → consumed →
completed / failed / execution-unknown. Denied, cancelled and expired terminate before
consumption. Keep model calls and human waits outside the mutation mutex while lease
renewal continues. Do not hold the mutex throughout arbitrary external execution.

`dispatch` accepts only the permit, not replacement arguments. Under the existing ownership
fence it rechecks the exact action, current authority, revocation/policy/lease epochs,
state preconditions and limits, records required protected authorization evidence and
atomically claims consumption. Changes require reevaluation; a still-matching rule can
automatically authorize again. No old human answer can authorize changed input. The
registered executor alone receives retained final bytes/handles after consumption.
Cancellation/revocation must synchronize with this dispatch fence; after release/dispatch,
stop is best effort and observed termination/unknown effects must be reported separately.

Register the existing callback before presenting it. Duplicate same identity/binding
requests observe the existing state; same ID with changed bytes refuses. A new attempt
gets a fresh invocation. Concurrent dispatches cannot both claim the permit. Lease loss,
turn end, expiry, principal revocation, agent/owner death and restart invalidate unused
permits/callbacks. UI disconnect is not revocation. Reconnect must not resurrect dispatch.

Record acceptance before delivery, preserving `LiveHumanInput`'s answer-recorded but
standing-write-failed boundary: the tool remains unapproved/parked, without policy writes
after an uncertain append. This is distinct from execution completion. An external effect
is not in the store transaction: crash/uncertain delivery after consumption returns
execution-unknown, never blind replay. Reuse #338/#357 recovery and #474 durable receipt
coordination; do not implement a new answer/cancel/effect ledger in this contract slice.

`ExecutionReceiptV1.state` is a coarse execution result, not a combined proof that an answer
was recorded, a native reply delivered, dispatch started and effects observed. #703 owns an
internal receipt-inspection seam backed by the existing protected execution/recovery records:
resolve `protectedEvidenceRef` under current exact-run read authority and expose separate
recording, delivery, dispatch and independent effect observations, each with observed / not
observed / unknown state and retained source/time attribution. A missing observation stays
unknown. Inspection is read-only and cannot replay, authorize or infer completion from reply
delivery. #338/#357/#474 own durable receipt/storage reconciliation; #706 supplies independent
effect evidence; #363 and protocol owners define safe public projection. This draft requires
that inspection behavior before advertising supported operation; it adds no RPC or ledger.

## Work that can start next

**#702 owns** opt-in typed predicates and compatibility/migration rules in the existing
core permission model, the agents evaluator/sidecar writer, daemon config/control authority
and revision checks, and existing Attention/Config projection. Define expiry/revoke/shared
use limits in the existing store rather than a second policy database. Preserve existing
legacy schemas unless an explicit versioned migration is implemented. Separate Allow once,
Deny and Create scoped rule; show operation, principal, resources, environment, duration,
limits and coverage before saving. Reuse permissions.grant and revision-guarded writes;
add reviewed rule identity/revision attribution. A UI save is not native standing approval.
Tests: automatic matching with no ask dialog; stale/concurrent edits; expired/revoked/scope
changed rules; persistence failure; repeated asks; remembered-only native choices.

**#703 owns** a proposed first fixture at the existing ACP `fs.readTextFile` → `AgentHost.fs`
seam using an injected disposable synthetic host, not native Bash or a new MCP service.
Bind the actual final path/read parameters and original owner, evaluate via #702's port,
then consume/dispatch at host I/O. The current host string-path interface has no stable
handle guarantee: design conditional/stable-handle I/O before claiming physical resource
confinement on a real filesystem. Prove observed synthetic read counts for allow, deny,
revoke, outage, cancellation, duplicate races, argument/state mutation and uncertain effects;
add real physical-path/symlink races only inside a disposable offline fixture before any
filesystem guarantee. Ordinary ACP file callbacks currently do not use permission policy.
Do not claim this fixture mediates an agent's native shell, descendants or independent MCP.
#703 can prepare capture/fence tests now; integrated rule behavior waits on #702 and reviewed
v1 adoption. Production activation remains separate.

**#706 consumes** [acceptance cases](acceptance.md), extends independent observed-effect and
privacy evidence, and keeps source/synthetic/installed claims separate. #701/#704/#705 can
prepare against these ports now; no peer-branch runtime import or conflicting contract.
Full provider support, hosted service/key setup, JEV activation, releases and deployment
are outside this draft. Exact byte codec, persisted permit/evidence schema and protected
configuration/hook protocol for the first real path still need #702/#703/#706 review.

## Offline checks

See the [verification record](verification.md) for exact results and environment limits.

```sh
node_modules/.bin/tsc -p docs/preparation/tool-execution-guards/tsconfig.json
node_modules/.bin/eslint .
node tools/eslint-config/bin/check-css-tokens.js packages/app/renderer packages/design/css/components.css
node_modules/.bin/vitest run packages/agents/test/permissions.test.ts packages/agents/test/live-input-session.test.ts packages/engine/test/live-input.test.ts packages/daemon/test/live-input-authority.test.ts --maxWorkers=2
git diff --check
```

[contract-fixtures.ts](contract-fixtures.ts) contains one explicitly unqualified synthetic
action, one positive review-phase consumer and thirteen compile-time negative consumers. These verify representability and type
separation only. [acceptance.md](acceptance.md) is an adjudicated expected-outcome corpus,
not an executable policy simulator. No test here qualifies an installed provider or
proves actual dispatch, one-use atomicity, confinement, privacy approval or model quality.
