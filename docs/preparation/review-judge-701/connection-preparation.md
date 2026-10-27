# Inactive ReviewJudge connection preparation (#701)

A partial #701 slice. It adds the seam between the merged
[injected-endpoint adapter](endpoint-transport.md) (#746) and the authorized
disclosure-grant and credential-reference services that #701 says it must reuse
(#335–#337 capability, secret and session boundaries; #363 privacy acceptance). Base: main
`4d5176c8d57c37f974517900935e6e28ea234082`. Source:
[connection.ts](../../../packages/agents/src/review-judge/connection.ts). Tests:
[review-judge-connection.test.ts](../../../packages/agents/test/review-judge-connection.test.ts).

Nothing registers, imports, exports or activates it. It is absent from the agents barrel,
profiles, defaults, engine, policy, daemon, protocol and renderer. The #746 adapter and the
offline local adapter are unchanged.

## The missing seam

#746 accepts only `credential: "none"` and returns `credential-unsupported` for anything
else, because no service existed to approve a disclosure or resolve an opaque reference.
Those services still do not exist: #336's typed references and execution-boundary resolver
are unimplemented, and disclosure-approval provenance belongs to #363. This slice
therefore does **not** add a secret store, resolver or grant registry. It defines the
smallest contracts the judge needs from them, marked **PROPOSED** in source, and the
preparation that consumes them. Only in-test fakes implement the proposed contracts.

`prepareJudgeConnection(descriptor, { grants, credentials, sender }, signal)` returns either
`{ status: "unavailable", reason }` or the `manifest`, `limits` and `transport` an owner
would pass to the unchanged `createEndpointReviewJudge`, plus their `configRef`.

### Proposed contracts

- **`JudgeDisclosureGrantService`** (#363). `find(query)` looks up an approved grant for
  one exact purpose, destination, destination policy, projection policy, method, model,
  prompt and evidence schema. `current(grantRef)` returns the grant's revision and expiry,
  or null once it is revoked. The service cannot create or widen a grant.
- **`JudgeCredentialService`** (#336/#337). `describe(ref)` returns metadata only: the
  reference id, the destination it is bound to and availability. `withCredential(ref, use,
  signal, consume)` resolves for one `use` (purpose, destination, grant) and ends the
  lease when `consume` settles. The service must refuse any use outside the binding.
- **`OpaqueCredentialRef`** is `{ kind: "credential-ref/v0", id }`. It carries no secret
  material and is not proof of authorization.
- **`JudgeEndpointSender`** is the owner-injected sender for one destination. It is the
  only code that receives the frame and the resolved credential together, as
  `{ frame, credential, signal, maxResponseBytes }`. It must declare `abort-signal`,
  `response-byte-bound`, `no-redirect` and `no-retry`. A declaration is the owner's claim
  about injected code, not proof.

## Preparation

Preparation copies the descriptor and captures every injected function before awaiting.
It contacts only the two metadata lookups. It resolves no credential and sends nothing.
Each missing or unsupported item returns `unavailable`, with no other destination,
provider, credential or profile to fall back to:

| Condition | Reason |
| --- | --- |
| Signal already aborted, or aborted during a lookup | `cancelled` |
| Any version, destination or policy field empty; a non-reference credential; any limit absent, non-integer or unbounded; per-call cost above the budget | `incomplete-config` |
| Sender bound to another destination | `destination-mismatch` |
| Sender lacks a required capability | `capability-unsupported` |
| Grant lookup fails | `disclosure-unavailable` |
| No approved grant | `disclosure-grant-missing` |
| Grant does not echo every query field exactly | `disclosure-grant-mismatch` |
| Grant withholds any field of the adapter's frame | `disclosure-insufficient` |
| Grant expired | `disclosure-grant-expired` |
| No binding for the reference | `credential-binding-missing` |
| Reference bound to another destination | `credential-destination-mismatch` |
| Reference unavailable, or lookup fails | `credential-unavailable` |

`disclosure-insufficient` is #701's explicit unsupported state. The #746 frame
(`schema, requestId, model, prompt, evidenceSchema, evidence`) is already the minimum the
adapter can send. If the grant cannot permit all of it, the judge cannot run.

### Configuration identity

The prepared `transportVersion` is a SHA-256 over the connection schema, the sender's
version and destination, the required capabilities, the opaque reference id, the grant
ref and revision, and the cost budget. The #746 `configRef` already covers
`transportVersion`, every manifest field and every limit. A changed model, prompt, config,
destination, policy, credential reference, grant revision, sender, deadline, payload,
concurrency or budget therefore gives a new ref. A request bound to the earlier ref is
refused as `request-config-mismatch` before anything is sent. The manifest keeps
`credential: "none"`: the adapter and its method still hold no credential, and the binding
exists only behind the transport.

## Each send

The prepared transport runs these checks, in order, for every frame the adapter delivers:

1. **Projection.** The frame must be the exact canonical #746 frame with the selected
   model, prompt and evidence schema, within the request byte limit and the configured
   response bound. An added field such as `credential` or `privateRef`, a reordering or an
   oversized frame is `projection-refused`.
2. **Concurrency.** The number of in-flight sends is limited to `maxPending`, even when the
   transport is called directly. A slot is held until the sender actually settles.
3. **Budget.** The owner-declared `maxCostUnitsPerCall` is reserved from
   `maxTotalCostUnits` before any await and never refunded, because a cancelled call may
   still have been billed. When the budget is exhausted the result is `budget-exhausted`.
4. **Grant recheck.** `current(grantRef)` must return the same revision, not expired.
   Otherwise the result is `disclosure-revoked`, and no credential is resolved.
5. **Scoped resolution.** `withCredential` resolves for this one use and passes the handle
   straight to the sender. This module never inspects, copies, serializes or retains it.
6. **Late reply.** A reply that arrives after cancellation or timeout is dropped as
   `cancelled`. The adapter drops it independently as well.

Every failure throws an error whose message is one fixed code, with no cause and no text
from a service, sender or credential. The adapter maps each one to `transport-failed`
(or `cancelled`/`timeout`). `refusals()` keeps the 32 most recent send-time codes, so an
owner can tell which check failed without any message, frame or credential.

## Tests

The tests use fake grant and credential services and a deterministic fake endpoint that
authenticates the handle and evaluates only the delivered synthetic evidence. They cover:

- Preparation through metadata only; frozen, deterministic outputs; end-to-end advice
  through the unchanged adapter; exactly what the sender receives.
- Every refusal in the table above, each with no resolution and no send. A refusal carries
  only `status` and `reason`.
- Cancellation before and during preparation, before review, and during completion: the
  sender's signal aborts, the lease stays held until the sender settles, and a late reply
  is dropped.
- Timeouts; malformed, contradictory, non-string and permission-bearing replies; a
  duplicate replay of an earlier reply.
- Provider and configuration changes. Each changed field gives a new ref that an earlier
  request cannot use. Pinning against caller mutation after preparation.
- Stale advice: delivery stops once the grant is revoked, rotated or expired, and identical
  requests always reach the endpoint again because there is no cache.
- Cross-destination reuse of a prepared transport, credential or grant.
- Projection, concurrency and budget at the send boundary; the bounded refusal list.
- Prompt injection: injected evidence escalates; a hostile endpoint that echoes the
  credential is `malformed-result`; adversarial text is carried as data and yields no
  recommendation.
- Secret leakage. A credential generated per run is absent from the prepared object,
  manifest, limits, config ref, results, refusals, thrown error and stack, service
  arguments, frames and the serialized handle. No `console` method is called.
- Advice is not authority. The judge exposes only `version` and `assess`, and the
  transport only `version`, `destination` and `send`. A result carries only the
  `JudgeResultV1` fields and the caller's authority snapshot. The module imports only
  `node:crypto` and the two adapter modules, and the agents barrel does not reference it.

Run them with:

```sh
pnpm exec vitest run packages/agents/test/review-judge-connection.test.ts
```

## Assumptions

- **Current contract only.** Required versus advisory composition, and whether a required
  judge from the first matching rule acts as a global ceiling, remain #702/#701 policy
  decisions. They are not resolved here. A required and an advisory review receive the
  same `unavailable` result, and policy decides the effect.
- **Proposed contracts.** The grant and credential interfaces are proposals for #363 and
  #336 to accept, replace or map. They are not shared canonical types and are not exported.
- **Grant scope.** A grant's retention, redaction, logging, region, subprocessor and
  training terms are assumed to be named by `destinationPolicyRef` and checked by the
  grant service. This module checks only identity, revision, expiry and the frame fields.
- **Cost units.** Cost units are an owner-declared ceiling, not a measured or estimated
  provider spend. ORCA cannot supply provider cost, and this module does not approximate it.
- **Grant and credential independence.** A grant is assumed to bind disclosure to a
  destination independently of the credential. The credential service is assumed to
  enforce its binding against the `use` it receives.
- **Trusted owner code.** Services and the sender are owner-injected and trusted to match
  their declarations. They are invoked detached from the objects they came from.

## Remaining operational requirements

- A reviewed #336 resolver and typed references, including principal authority over
  list, validate and use, wrong-host refusal, rotation and revocation, plus #363 disclosure
  approval provenance. These must implement or replace the proposed contracts.
- A real sender that enforces the response byte bound while reading, refuses redirects,
  never retries, and keeps the credential out of URLs, arguments, errors and logs. It also
  needs a reviewed decoder for the provider's real wire format.
- Provider terms, key provisioning, spend limits enforced at the provider, and
  isolation/process-level shutdown for hostile or CPU-bound code.
- Production registration, profile selection and activation, each of which needs separate
  reviewed authorization. None is added here. No live model, real key, network call,
  hosted or BYOK service, payment or private evidence was used.
