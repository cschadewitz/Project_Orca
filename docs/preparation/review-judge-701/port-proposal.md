# Local ReviewJudge proposal v0

This is a design candidate for [#701](https://github.com/cschadewitz/Project_Orca/issues/701).
The names and synthetic schemas below are scoped to this preparation directory;
they are not a canonical action envelope or an agreed #700 port. Integration must
wait for [#700](https://github.com/cschadewitz/Project_Orca/issues/700).

## Three responsibilities

| Owner | Responsibility | Cannot be delegated to advice |
| --- | --- | --- |
| Deterministic coordinator (#700) | Resolve verified authority, current state, coverage, ceilings, mandatory human classes, existing rule applicability and native response scope | Current credentials/run scope, policy/revocation checks, grant effects, permit issue/consumption |
| Review methodology (#701) | Assess only the approved projection and return recommendation, concise rationale code and uncertainty | Write policy, create a rule/grant, select a broader profile or manufacture missing facts |
| Transport adapter (#701) | Deliver the approved evidence to exactly the selected compatible execution destination within its approved budgets and deadline | Select another destination/provider/key, disclose more context or retry using broader authority |

The reference method is pure. A transport receives that method, an immutable synthetic
snapshot and a cancellation signal. Tests replace method and transport independently.
The in-process transport is trusted test machinery, not isolation or a security boundary.
A production worker must have independently enforced isolation and no general tools,
executor, policy mutation or secret lookup capability.

## Local experiment and proposed production obligations

The local port version is `orca-701-preparation/v0`. Its input version is
`orca-701-synthetic-evidence/v0`; output is `orca-701-synthetic-advice/v0`.
The experiment fails negotiation before invoking a transport with incompatible schemas.
Its only evidence is three closed synthetic enums: applicability, context sufficiency
and injection presence. No action identity, principal envelope, command representation,
resource or native option schema is invented here. Those require #700 agreement.

The output contains `allow`, `deny`, `escalate` or `abstain`, an enumerated rationale
and uncertainty. Extra authority fields, unknown labels/schema, contradictory rationale
or uncertain allowance are malformed. Free-form prompts, errors and provider responses
are not copied into the audit. Local unavailable reasons distinguish invalid evidence,
incompatibility, payload/budget limits, timeout, cancellation and malformed/failed output.

Production negotiation must pin port, evidence and response versions, supported operation
coverage, method/config/prompt/model/transport identities and explicit coverage limits.
No compatible model must mean unavailable; never choose a permissive replacement.
The offline runner records fixture method/transport/config versions and marks model/prompt
as `none`. Latency, tokens and cost are not fabricated; production adapters may report
validated available metadata separately from recommendation and effective outcome.

## Automatic response and declared modes

All automatic response vectors assume the deterministic coordinator has already verified
an existing approved rule/delegation, current authority, sufficient coverage, mandatory
constraints, exact scoped native choice and live callback. They do not verify those facts.
No judge output can establish them. Revalidate current state after any awaited review and
before delivery/permit consumption using #700's agreed owner, not fixture booleans.
For advisory/required vectors, the symbolic approved-rule prerequisite must additionally
mean that the rule explicitly delegates fit assessment. The current fixture harness
does not represent or test this distinction. An ordinary approved rule without such
delegation must not invoke a judge. See the [#708 cross-check](contract-708-feedback.md);
the local recommendation labels and composition outcomes must not be mapped directly
to the proposed canonical vocabulary before the parent confirms the reviewed interface.

| Mode | Eligible existing approved rule | Failure behavior |
| --- | --- | --- |
| disabled | No judge invoked; respond with the scoped native choice | Missing authority, evidence, coverage or scoped choice holds/escalates as required |
| advisory | A valid allowance may proceed; a deny stops and abstain/escalate requires review in this candidate methodology | Report judge unavailability separately; proceed only on independently verified approved authority under this predeclared mode |
| required | Valid allowance plus all deterministic prerequisites permits the scoped response | Unavailable, timeout, malformed or incompatible judge holds the lane |

Cancellation/expired lifetime never permits a response, including advisory mode.
Mandatory denials and human classes win in every mode. A judge allowance with no approved
rule escalates, and incomplete/unknown/stale prerequisites hold. Missing a bounded native
choice cannot select an `always` response instead. `respond-scoped-choice` is a symbolic
expected result only: no native callback is invoked by this experiment. Unknown profile
modes hold rather than defaulting to disabled. No retry, provider shopping or ensemble
is implemented. A later ensemble must pin member versions, order, quorum, disagreement
and abstention/failure composition; no implicit majority or availability substitution.

## Evidence minimization and disclosure

`projectSyntheticEvidence` constructs a fresh immutable allowlist projection rather than
passing through commands, context strings or caller objects. Tests include deliberately
untrusted synthetic instruction/secret fields and confirm their exclusion. Missing required
facts returns unsupported; omission never becomes evidence of safety. This enum exercise
does not establish real prompt-injection resistance, secret detection or safe redaction.

The only allowed destination is `offline:fixture`. Unknown destinations, including hosted,
BYOK and JEV names, return unsupported without fallback. The input bytes are bounded,
and the response has closed keys/enums; errors expose a reason code, not raw content.
In-memory test data has no persistence, external logging or provider retention path.

A production projector must be approved for the exact destination and method. Record
minimum necessary fields/snippets, sensitivity, purpose, retention/deletion policy,
redaction and logging guarantees, and restrictions on region/subprocessors/training.
If permitted disclosure cannot preserve facts needed by the method, report unsupported
and hold the required lane. Tool network permission does not authorize judge egress.
Do not send private evidence to another service when the chosen destination fails.
The schema remains a projection of #700's envelope, never a second action authority.

## Hosted/BYOK connection design boundary

Future model/JEV/hosted/BYOK adapters implement compatible methodology and transport seams.
They are not package dependencies or enabled destinations here. Reuse capability/session
boundaries [#335](https://github.com/cschadewitz/Project_Orca/issues/335),
secret resolution [#336](https://github.com/cschadewitz/Project_Orca/issues/336),
and session constraints [#337](https://github.com/cschadewitz/Project_Orca/issues/337).
Coordinate privacy acceptance with [#363](https://github.com/cschadewitz/Project_Orca/issues/363).

A reviewed connection design should bind an opaque authorized connection/credential
reference to an exact destination, method/model versions, disclosure policy and finite
request/token/spend limits. Credential resolution belongs to an authorized service;
the method receives no secret, general secret resolver or renderer-supplied credentials.
An opaque reference is not proof of authorization. Recheck resource/capability access
and availability at use. No credentials in prompts, renderer/config exports, errors,
logs, issue evidence or public digests. Provider terms, key provisioning and activation
are explicit owner work beyond this preparation. No new vault or model orchestration
system is proposed.

## Budgets, lifetime and cache

The fixture requires explicit positive pending/call/payload caps and per-call timeout.
It snapshots input before awaiting, propagates cancellation, drops late results, and
does not retry. A timed-out transport that ignores cancellation retains its pending slot
until it actually settles; returning a timeout must not allow unlimited hidden work.
Production workers require bounded shutdown and process-level enforcement because an
in-process timeout cannot stop CPU work or a malicious extension. No default cap here is
a production policy value, and no cache is implemented.

A future advice cache requires #700's exact action, principal/source, policy/revocation,
relevant state and coverage identities plus projection/destination and judge/config/
prompt/model versions. Any changed or omitted required field invalidates positive advice.
Advice never replaces fresh authority validation or a fresh one-use permit. Human answers
and consumed permits must not become cached decisions for later invocations.

## Offline evaluation and remaining acceptance

Versioned synthetic vectors cover required/advisory/disabled composition, unknown facts,
injection indication, refusal, abstention, cancellation, timeout, schema mismatch and
repeatability. A positive result never returns an authority object or grants a capability.
The suite compares expected versus actual fixture outcomes; its counts are not measured
false-allow/false-denial rates of any real model or provider.

After the #700 interface is agreed, add reviewed labeled action cases with coverage and
privacy provenance. Report confusion counts, abstention and uncertainty, injection cases,
repeatability, latency and only available token/cost metadata per pinned method/config.
Include authority/policy/principal/source/state changes during review and at consumption,
lease loss, cross-destination disclosure denial, worker shutdown and ownership races.
Those integration/security properties cannot be proved by symbolic fixture prerequisites.
Any later paid/live evaluation or production activation needs separate authorization;
this proposal changes no production profile, #594 acceptance or beta/privacy gates.
