# Closed owned read service (#703 / #706)

Inactive implementation: `packages/engine/src/owned-file-read-service.ts`.
No package barrel export, daemon registration, agent/client executor, production
build acceptance, provider hook, shell tool or activation is added.

## Trusted integration facade

The daemon owner constructs `createOwnedFileReadServiceForTest` only in a
controlled disposable Linux scope. It supplies its authenticated original owner,
content for a newly created private regular file and a lifetime invocation limit
(1–128). There is no pathname/descriptor intake. Setup closes its write descriptor,
opens a read-only descriptor, checks inode/ownership metadata and unlinks the file.
No resource content is read during setup, capture or policy evaluation.

`service.capture(owner, parameters, policy, evidence)` is **trusted intake**, not an
RPC. `owner` is a fresh original invocation binding. `policy` is the canonical
`PolicyPortV1`; `evidence` is the existing `SyntheticFenceEvidence` protected record
adapter. Parameters have exactly three own data properties: `resourceRef`,
`offset`, `length`. They are copied synchronously before any await.

The returned frozen `TrustedOwnedReadInvocation` has:

- `action`: canonical, recursively frozen `ActionEvidenceV1`.
- `evaluate(signal)`, `bindReview`, `completeReview`: canonical policy/review handles.
- `authorize(action, verdict, signal)` and `dispatch(permit, signal)`:
  canonical `EnforcementPortV1`. No unchecked execute method is exposed.
- `inspect(receipt, readAuthority, signal)`: existing separately authorized
  observation lookup. Missing observations remain unknown.

`service.refreshPolicyRevision(invocation)` is a separate trusted transition for
one evaluated `require-human` ask after a stored-policy revision change. It accepts
no new parameters, owner, policy, evidence adapter or lifetime. Every original
snapshot field must be identical except `currentPolicyRevision`. It retires the
old fence synchronously before fresh evidence is captured, retains the first
caller's cancellation and original expiry, and reuses the exact captured policy
source (including its captured ceiling). It refuses pending review, any started
permit authorization, dispatched/terminal work, repeated refresh and every other
snapshot change. Old `ActionEvidenceV1` remains frozen. The transition gives no
permission: current authority/policy still run before authorization/dispatch.

The descriptor, executor and fence stay in closures. Resource, profile, coverage,
workspace and effective cwd remain stable for the service lifetime. Every distinct
original invocation gets a separate capture, action, permit and one-use read guard.
Identical captures using the same trusted capabilities coalesce; replacement owner,
policy or evidence objects and changed parameters refuse. The bounded invocation
table retains tombstones; capacity exhaustion refuses instead of evicting replay
protection. A closed service cannot be recreated on the same owner signal. A new
boot/resource gets new identities and cannot use the old resource reference/rule.

Anchor identity includes original boot/session/run/root/step/attempt,
principal/agent/host/runner and captured-generation/lease epoch. Policy revision
may differ across fresh invocations, but captured-generation is preserved. Each
invocation's original snapshot, authority, expiry and cancellation remain retained.
Synchronous last checks and permit consumption precede the actual positional read;
metadata or authority changes afterward make completion uncertain. Cancellation
cannot retract a read or response already started. Recording/delivery/effect are
separate observations, not inferred from a completed receipt.

## Coverage and qualification gate

Coverage truthfully stays `policy-per-ask`, `installedRefs: []`,
`independentlyObservedEffects: false`. The source fixture is not relabeled.
`scopedPermissions.choose(save)` still requires `verified-per-execution`; its gate
is untouched. Accepted managed production builds remain empty and activation off.

`packages/engine/test/owned-read-built-conformance.mjs` is the smallest current
emitted-code evidence producer. Build the actual dependencies and service, then run:

```sh
pnpm exec tsc -b packages/engine/tsconfig.json
node packages/engine/test/owned-read-built-conformance.mjs > /tmp/owned-read-built-conformance.json
```

It imports emitted modules, uses actual strict source/policy, lease and execution
stores, and independently wraps the real OS read API with call-through observation.
The report contains an ordered SHA-256 manifest of emitted JS in core/store/agents/
engine, an aggregate digest, exact runtime/host/tool/profile coverage and observed
counts for missing rule, repeated dispatch, two fresh reads, revocation and close.
It is explicitly **unqualified**, not a new protected proof schema or a bearer
qualification token. The source suite additionally composes the actual typed
sidecar publication/read source, strict policy, offline required judge and fence.

Exact remaining gate: there is no independently accepted installed build/host/tool/
profile qualification record or protected evidence lookup binding this local
conformance report to an accepted runtime. Self-generated hashes and source tests
cannot establish that acceptance. The daemon proof owner must verify actual
accepted build evidence and protected conformance records before any future
qualification producer may issue canonical `verified-per-execution` coverage.
Arbitrary evidence strings, injected booleans and weakened Save checks are excluded.

## Stored-rule and fresh-answer limits

The integration test persists one exact rule using the real typed store, then
uses it for two fresh original invocations against the same inode/profile. It
checks distinct action/permit lifetimes and independent OS reads. The initial
pre-save action remains frozen at its old policy revision and refuses as stale.
The original captured-generation and a captured false ceiling survive later
policy allowance. This is not an end-to-end #733 Save/fresh-answer demonstration.

The daemon owner still owns authenticated boot/managed-store binding, protected
capture/approval/qualification records, and the separate fresh answer composition.
The service now supports the policy-revision part through the explicit pre-permit
refresh described above. Integration tests evaluate an actual ask, persist a rule
through the actual typed store, update only its current revision, refresh, complete
actual policy/required offline judge, read once, then match a second fresh invocation.
They check original request/authority/expiry/cancellation and immutable old evidence.
They also prove captured-deny ceilings, cancellation and terminal uncertainty cannot
use refresh to reopen authorization. This still does not bypass the missing
installed qualification gate or constitute the daemon #733 Save workflow.

Tests assume synthetic authenticated boot/principal/ceiling and protected approval/
compatibility proofs, an offline judge transport and disposable synthetic data.
The resource and OS reads, source/policy/judge/fence/store algorithms are actual.
The report is a local build observation, not installed production qualification.
No immutable content guarantee is made: metadata checks are conservative and do
not protect against hostile same-UID/root writers, hostile kernels/filesystems,
arbitrary paths, native shells, alternate MCP, remote hosts, macOS or Windows.

## Development dependencies

Development starts at green main `a4ae53d1d5a8d7945f5c6782da46c833accdb29d`,
with the exact published, unmerged dependencies #732
`ba39c77aa98d2776a3d63a807f245539f0fddd9c` and #733
`c94826f0c81e180db384ece1d0347f6a05397e65` merged non-force locally.
Parent integration/review owns accepting or replacing those dependencies.
