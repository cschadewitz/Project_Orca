# Inactive local ReviewJudge source slice (#701)

The follow-up implements the accepted three-phase contract without another policy
coordinator. Its baseline is main `24a53ccd5e4ed365222071c6f6b5748364535abe`
with #708 and #712 merged. It consumes independently reviewed #716 at
`9688aa259a37216642ca36a5be144d234306700a`, preserving that commit's ancestry and
attribution. The canonical vocabulary lives in
[core](../../../packages/core/src/model/tool-execution-guards.ts); no types are copied.
The preparation [contract](../tool-execution-guards/contract.ts) re-exports that same
module. The parent owns merging #716 and any later shared export coordination.

The smallest usable slice is
[adapter.ts](../../../packages/agents/src/review-judge/adapter.ts), directly importable
by source tests, with independent method and transport interfaces and
[offline doubles](../../../packages/agents/src/review-judge/offline.ts).
Neither module is registered, imported by production callers, exported through the
agents barrel, or wired into profiles/defaults. There are no engine, policy, protocol,
provider, secret, dependency or lockfile changes in this slice. The shared type/barrel
changes in the full branch diff belong only to the preserved #716 dependency.

## Binding and ownership

A trusted owner constructs a local adapter with an immutable registered manifest.
Its `ref` identifies the exact method, transport, model, prompt, config, input/output
schemas, destination and disclosure/projection policy revisions. The owner must never
reuse a ref for changed execution, code or limits; an opaque ref alone is not proof of
registration or authorization. This slice supplies no registry. `modelVersion` and
`promptVersion` must be `none`, and the only supported destination is `offline:fixture`.

The adapter copies configuration, functions and finite limits once, checks method and
transport compatibility before invocation, and requires the request's `judgeConfigRef`
to match the selected manifest. It also matches the destination/projection policy refs,
payload/projection binding and schema. Every request field is copied and nested objects
frozen before awaiting. A result carries only the retained review/action/authority/
coverage/projection binding, selected manifest identity and validated advice attribution.
Responses cannot choose a replacement identity or contribute extra authority fields.
Caller mutation cannot change the already selected invocation or returned binding.

The registered manifest and injected functions are trusted in-process dependencies.
Their identities are not attested by a model echo. This does not sandbox injected code
or prove that arbitrary code honors its descriptor. A future worker/provider adapter
needs a separate isolation, execution-attribution and disclosure review.

Only the copied, frozen `ApprovedJudgePayloadV1` and an abort signal reach the method.
The transport additionally receives a frozen allowlisted method descriptor. The private
request, authority stamp, delegation and store references are not sent. There is no
reader, credential resolver, tool, executor, policy writer or permit capability in either
interface. Content approval/materialization and truthful binding remain engine/privacy
owner work; matching an opaque binding string does not prove approved provenance.

The adapter does not decide eligibility, interpret grant scope, select native choices,
compose required/advisory/disabled modes, write rules, mint permits or authorize an action.
Policy's `evaluate` → `bindReview` → `completeReview` remains #702 ownership, including
exact retained-request verification and final checks of authority, coverage, policy,
rule revisions, revocation, principal, destination, state and lifetime. #703 retains
permit enforcement. Ordinary matching rules without judgment delegation require no
judge call or additional human confirmation; proving that dispatch path belongs to
those owners' integration tests. The adapter's successful fit is advice only.

## Mapping and bounded execution

| Valid local recommendation | Canonical result | Execution attribution |
| --- | --- | --- |
| allow / fixture-match / certain | fit | evaluated |
| deny / fixture-mismatch / uncertain | not-fit | evaluated |
| escalate / fixture-injection / uncertain | indeterminate | evaluated |
| abstain / fixture-incomplete / uncertain | indeterminate | evaluated |
| Failure, incompatibility, malformed response, timeout or cancellation | indeterminate | unavailable |

The schemas and enum-method behavior reuse the #712 preparation vocabulary. The source
reference method is still a synthetic enum fixture, not a command analyzer. It rejects
prompt-like extra fields, non-string enum values and noncanonical/duplicate-key input.
Both input evidence and output advice use exact `JSON.stringify` frames with documented
property order (schema, applicability/context/injection for evidence;
schema/recommendation/rationaleCode/uncertainty for advice). Whitespace, reordered keys,
unknown fields/versions/labels, duplicate keys and contradictory advice are unavailable;
this narrow local framing is not a general JSON/provider interoperability claim.

Every adapter requires explicit positive integer pending/call/frame/deadline limits.
The whole approved payload frame and raw response frame have UTF-8 byte bounds. The
response is bounded before parsing. Per-call time is the smaller of the original
absolute deadline and the configured local maximum; monotonic elapsed time and the
original wall deadline are checked again after awaited work. Timer-overflow limits are
rejected. Errors produce fixed sanitized codes, with no raw method/transport data.

Cancellation propagates to the transport. Caller completion removes its listener and
timer; late success or rejection cannot replace a settled result. An ignoring transport
retains its pending slot until it really settles, so timeouts cannot spawn unbounded
hidden work. This can exhaust local capacity indefinitely; in-process cancellation
cannot stop hostile or CPU-blocking code. There are no automatic retries, alternate
providers/destinations, profile changes, caches, ensemble voting or permissive fallback.
Required/advisory outcomes are returned identically as advice for policy to compose.

## Validation on 26 October 2026

Node `v24.19.0` and the existing workspace tools were used. The environment's installed
tools differ from the lockfile (Vitest 5.0.2, ESLint 10.11.0, Prettier 3.9.9;
TypeScript 7.0.2). No dependency restoration completed and no install/lockfile/lifecycle
policy was changed. Normal Corepack bootstrap of pinned pnpm 12.4.2 failed to reach
`https://registry.npmjs.org/@pnpm/exe.linux-x64/12.4.2` with `fetch failed`.
An explicit writable temporary Corepack cache was used after its default cache path
was absent. No registry, integrity, frozen-lockfile or lifecycle checks were bypassed.

| Check | Result |
| --- | --- |
| `node_modules/.bin/vitest run packages/agents/test --maxWorkers=2` | 316 passed across 14 files, including 80 new adapter cases; none failed/skipped |
| `node --test docs/preparation/review-judge-701/offline.test.mjs` | 79 passed; none failed/skipped/cancelled/TODO |
| `node_modules/.bin/tsc -b packages/agents/tsconfig.json` | Passed (affected core/agents source build) |
| `node_modules/.bin/eslint .` | Passed with existing repository configuration |
| CSS token guard | Passed |
| Prettier on the two source files and test | Passed |
| `git diff --check` and scoped Markdown links/encoding/fences | Passed |
| `node_modules/.bin/tsc -p tsconfig.json --noEmit` | Blocked by existing app dependency resolution: `packages/app/src/main/first-run/setup.ts:14` cannot resolve `yaml`; no adapter/test diagnostics |
| `node_modules/.bin/tsc -b tsconfig.build.json` | Blocked by existing resolution of app `yaml` and testing `@orca/store`; renderer bundle not reached |

The separate renderer typecheck also fails on existing missing `yaml` resolution and
happy-dom settings type mismatches outside this slice. The renderer build was not run
following these dependency/type failures. These are source
and synthetic checks, not clean frozen-install proof or full-suite/coverage acceptance.
No native agent, installed hook, filesystem confinement, provider/model/JEV, hosted/BYOK,
secret lifecycle, paid call, service, release or deployment was exercised. #594 and
sandbox/privacy/native acceptance remain unchanged. No changelog fragment is needed
because this unregistered slice changes no shipped runtime behavior.
