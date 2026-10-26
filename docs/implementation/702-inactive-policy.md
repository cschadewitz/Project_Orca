# #702 bounded strict policy evaluation — inactive

This successor to [#716](https://github.com/cschadewitz/Project_Orca/pull/716)
implements policy/core seams from the reviewed [#708 contract](../preparation/tool-execution-guards/README.md).
Its canonical vocabulary is [core's tool-execution-guards model](../../packages/core/src/model/tool-execution-guards.ts).
It changes no shared declarations, persisted legacy schemas, session handlers,
configuration defaults, daemon methods or UI flows. Nothing registers or activates
the strict path. #702 remains open; this is not provider, execution or migration acceptance.

## Implemented seam

[Core's evaluator](../../packages/core/src/strict-permission.ts) is pure. It takes
a captured `ActionEvidenceV1`, a fresh trusted `StrictPermissionState`, a clock value
and a review identity. It evaluates current original authority, captured ceilings
and protected access before coverage/profile/required facts, scoped rules, mandatory
human requirements and explicit delegated review eligibility. Missing required
material is indeterminate. Revoked matching rules deny; expired, future or stale
rules cannot authorize. An approved matching allow returns rule ID/revision and
the exact current authority binding without an additional human confirmation.

[StrictPermissionRule and state](../../packages/core/src/model/strict-permission.ts)
are internal typed projections from existing protected rule/config/authority sources,
not a new file format or policy database. Predicates name exact principal, agent,
host, runner, operation, profile, coverage, cwd and workspace; every captured resource
and environment/credential reference must fit the approved scope. No title, kind or
path-prefix heuristic is treated as physical execution evidence. All profile facts
must be complete or explicitly permitted to be inapplicable. Known-empty and unknown
facts remain distinct. A trusted capture owner must separately validate exact coverage
qualification and relevant execution state through `coverageAndState`; synthetic
reference strings in tests do not establish installed qualification.

`selectStrictPermissionOption` is a pure eligibility helper. It returns only an
offered `allow_once` with proven invocation-only effect, a complete qualification,
`scopeRef` equal to the original invocation ID, one maximum use and a finite expiry
within the action lifetime. Other scope-reference representations are unsupported
by this bounded selector. Remembered, unknown, duplicated-ID and unbounded choices
cannot widen approval. It does not send a response, record an answer or mint an
execution permit. An ORCA-owned I/O path does not need to manufacture native options.

[The agents factory](../../packages/agents/src/strict-permission.ts) implements
`PolicyPortV1` without a transport or scheduler. It requires three internal capabilities:

- `source.readCurrent`: reread existing current policy and original-principal/run
  authority on every evaluation, registration and completion. Required missing or
  corrupt sources stay unavailable; legacy empty-sidecar fallback is not strict authority.
  Policy/profile/config references and revisions must identify immutable content.
- `authorizeProjection`: authorize the exact projection, provenance and destination
  under existing disclosure authority before registration. Materialization, payload
  bounds and actual judge scheduling remain engine/#701 ownership.
- `recordReview`: retain the normalized request/result and candidate verdict through
  existing protected execution records and return their real reference. Failure or
  an empty reference blocks allow. This callback adds no new store or rule writer.

The factory copies action input before its first await, retains exact rule/eligibility
and request snapshots privately, and issues owner-local pending/bound handles. It
claims registration/completion before awaiting, checks current state around projection
authorization and after review recording, and refuses forged, repeated, cross-owner,
changed or expired handles. Original cancellation invalidates pending handles.
Capacity includes in-flight registration; subsequent evaluation reclaims expired
entries. Handles are ephemeral and have no restart or durable recovery semantics.

Required judge unavailability blocks. Advisory unavailability can allow only when
the same approved allowing rule explicitly permits that fallback. The stored result
retains `execution: unavailable`; its reference never implies a successful review.
Evaluated indeterminate remains separate and follows configured escalation. Not-fit
can deny or require a human. Unknown/contradictory labels, malformed bindings, wrong
model/config/projection identities and oversized reason codes cannot become advisory
fallback. The trusted adapter must attest `judgeVersion`; a matching model echo alone
does not provide that attestation.

There is no dispatch fence in this policy port. A verdict is not an execution permit;
#703 must independently verify provenance and current state under the existing owner
fence before consuming its retained original action. Recording a candidate verdict is
not proof of final authorization, reply delivery, dispatch or effects. Source/record
capabilities must honor cancellation; no live provider or remote store adapter is
introduced here.

## Regression scope

The synthetic tests cover approved automatic option eligibility, deny/human ceilings,
required-policy outage, required/absent/unknown facts, exact scope, rule expiry/revoke,
stale authority, qualified one-use choices, explicit delegation, required/advisory
composition, exact retained requests/results, projection refusal, recording failure,
concurrent registration/completion, mutation across awaits, cancellation and capacity.
Existing legacy/session/sidecar/LiveHumanInput/config tests verify first-match/default
and recorded-answer/persistence-failure behavior is preserved. Test qualification refs
are explicitly synthetic; no installed provider or actual effects are certified.

Final command results are recorded in the successor PR. The supported pinned frozen
install repaired the stale supplied graph under unchanged lifecycle/supply-chain policy;
the worker makes no lockfile/dependency changes.

## Later acceptance

Actual strict rule projection and persistence must reuse the existing configured policy,
sidecar lock/revision checks and `permissions.grant` authority. This slice provides no
store adapter or migration and does not reinterpret existing legacy rules as certified
typed rules. Explicit scoped-rule creation, expiry/revoke editing, shared use budgets,
Allow once/Deny/Create scoped rule UI, safe protocol projection and concurrent writes
remain later #702 acceptance. They cannot silently create native remembered grants.

Automatic native response delivery and the #703 synthetic executor integration remain
separate owner-reviewed work. Real capture codecs, state/physical-resource guarantees,
native cached-grant rechecks, protected record adapters, installed provider qualification,
privacy/effect observation and native/platform acceptance remain open. #594 is still
unsupported; existing sandbox/privacy gates are unchanged. No production rule writes,
activation, providers, credentials, hooks, paid services, JEV, release or deployment
are authorized by this inactive module.
