# Inactive injected-endpoint ReviewJudge slice (#701)

A partial #701 slice. It adds one explicitly constructed transport path behind the
existing `ReviewJudgeV1` contract, separate from the offline local adapter. Base: main
`46ce182308e8d5b59c4fdbabd49232b4cf4cdbdc`. Source:
[endpoint.ts](../../../packages/agents/src/review-judge/endpoint.ts). Tests:
[review-judge-endpoint.test.ts](../../../packages/agents/test/review-judge-endpoint.test.ts).

It is **not** a hosted or BYOK implementation. Nothing registers, imports, exports or
activates it: it is absent from the agents barrel, profiles, defaults, engine, policy and
daemon. The [local adapter](source-implementation.md) is unchanged and still accepts only
`offline:fixture` with model and prompt `none`.

## Seam

`createEndpointReviewJudge({ manifest, transport, limits })`:

- **Manifest**: method, model, prompt, config and transport versions; the synthetic
  evidence/advice schemas from #712; one exact `destination`; the destination
  disclosure policy and projection policy refs; `credential: "none"`.
- **Transport**: `{ version, destination, send(frame, signal, maxResponseBytes) }`.
  The adapter captures `send` once and calls it detached. It gets one string and nothing
  else: no request, authority, reader, credential, tool, executor or policy writer.
- **Config identity**: `endpointJudgeConfigRef(manifest, limits)` is a SHA-256 over the
  wire schemas, every manifest field and every limit. The adapter derives it itself and
  requires `request.judgeConfigRef` to equal it, and uses it as `judgeVersion`. A changed
  destination, disclosure or projection policy, model, prompt, schema, transport or limit
  gives a different ref, so it cannot reuse a ref that policy selected earlier. It is
  refused as `request-config-mismatch` before anything is sent. The transport's own
  `destination`/`version` must also match the manifest.

## What leaves the process

The request frame is the canonical JSON
`{schema, requestId, model, prompt, evidenceSchema, evidence}`. `requestId` is a fresh
random UUID for each call, and `evidence` is the approved payload content. The frame never
includes review, action, authority, coverage, delegation, binding or private store
references, or the config ref. A reply must be the exact canonical frame
`{schema, requestId, model, adviceSchema, recommendation, rationaleCode, uncertainty}`.
It must echo this call's `requestId` and the selected model and advice schema
(`response-mismatch` otherwise). It must also carry one consistent mapping from the
#712 advice vocabulary. Any extra field, duplicate key, reordering, whitespace,
contradictory rationale or uncertain allowance gives `malformed-result`. The result is
built only from the retained request snapshot and the derived ref. A provider cannot add
authority or replace a binding.

## Bounds and failure

The limits are explicit positive safe integers: pending, lifetime calls, request bytes,
response bytes and a timeout that fits the timer range. The request frame is measured in
UTF-8 before it is sent, and the reply before it is parsed. The deadline is the shorter of
the request's absolute deadline and the local monotonic maximum. Both are rechecked after
the reply. Cancellation and timeout abort the transport signal. Late success or
rejection is dropped. A transport that ignores the abort keeps its pending slot until it
really settles. Errors return fixed codes (`transport-failed`, `timeout`, `cancelled`,
…) with no raw text. There are no retries, alternate destinations, providers, caches or
fallbacks.

A required and an advisory review get the same `unavailable`/`indeterminate` advice;
policy (#702) composes the mode. Any credential other than `none` is
`credential-unsupported`: no vault, resolver or opaque-reference lookup exists here.

## Remaining limits

- Only a deterministic in-test fake provider runs. No network, real provider, model, JEV,
  hosted or BYOK path, secret, paid call or private evidence is used.
- The wire schemas are local v0 synthetic frames, not a provider API. Canonical-frame
  exactness would need a reviewed decoder for a real provider.
- `maxResponseBytes` is passed to the transport, but the adapter can only measure a string
  that has already been returned. A real transport must stop reading at the bound.
- In-process cancellation cannot stop hostile or CPU-bound code. Isolation, disclosure
  approval provenance (#363), credential resolution (#336) and production registration need
  separate reviewed work.
- The derived ref binds configuration, not the transport's code. Whoever constructs the
  adapter is trusted to inject the transport the manifest describes.
