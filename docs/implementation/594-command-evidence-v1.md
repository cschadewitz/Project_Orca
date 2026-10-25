# #594 command evidence v1: offline reference and upstream handoff

Developed on main `b5b00d1d8ba10bffde23f5523d1d4961bf7c41b5`, 25 October 2026,
following the owner's approval to develop a versioned evidence-preserving bridge.
This advances the [merged #641 audit](594-provider-evidence-contract.md) and
preserves [#607's disposition](m10-live-command-evidence-disposition.md).
Cal owns implementation/coordination. The maintained upstream implementer,
released bridge/native pair and authorized private reviewer principals are still
unresolved. Development approval does not authorize private command disclosure.

**Contract identifier: `orca.command-evidence/1`, draft, offline only. There is
no supported installed pair or runtime capability in this change.** The
[test-only reference](../../packages/agents/test/fixtures/command-evidence-v1.ts)
specifies capture, eligibility, private review budgeting and answer binding. It is
not exported from `@orca/agents` or imported by production. Fixture hooks record
and deliver memory counters; they cannot start a provider or command. No installed
bridge, native provider, authorization policy, public schema or activation changes.

## Refreshed trusted-source boundary

Cal's GitHub connection re-read release metadata and these exact source revisions;
no binaries were fetched or run. Latest releases remain codex-acp 2.2.2 (10 October)
and Codex 0.164.0 (23 October). ACP schema latest is v1.26.0 (16 October).

| Source | Exact revision and relevant contract |
| --- | --- |
| codex-acp 2.2.2 | `202e66e63343ec4f5a5e35ab590251d813d129ca`; [manifest](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/package.json) still declares Codex `^0.160.1`, not 0.164.0 |
| Native dependency floor 0.160.1 | `d27764b82f7118f674371e6d6e76271d9d606edb`; [params/stripping](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1549), [emission](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server/src/bespoke_event_handling.rs#L668) |
| Native 0.164.0 candidate | `6aaac694803004a63c6f393d153c96d22521a6b9`; [params/stripping](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1560), [emission](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server/src/bespoke_event_handling.rs#L676), [turn/session profile responses](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs#L773) |
| ACP schema v1.26.0 | Annotated tag `3fdcc2cb717e1dfa50f2efcaeae88cb69a6504cd` resolves to commit `e2d83349bc9e28a4059ea3acefa1c91c966f74e2`; [schema/v1/schema.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/e2d83349bc9e28a4059ea3acefa1c91c966f74e2/schema/v1/schema.json), definitions `RequestPermissionRequest`, `PermissionOption`, `PermissionOptionKind` and `RequestPermissionResponse` |

ACP supplies session, tool-call update and offered options. Its kind is a
presentation hint; `_meta` permits arbitrary values. Neither authenticates native
scope, request/callback correspondence or a maintained extension. This is why
[#662](https://github.com/cschadewitz/Project_Orca/issues/662)'s correct in-process
option-kind preservation is necessary for its own forwarding scope but cannot
restore #594's missing evidence. Its orchestrator/human-input/facade files and
existing tests are outside this patch; coordination comments record the boundary.

The bridge's [native dispatch](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/CodexAppServerClient.ts#L231)
calls `handleCommandExecution(params)` with parsed params only. Its handler API
does not carry the native JSON-RPC request ID. The
[approval handler](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/permissions/CodexApprovalHandler.ts#L44)
owns the returned decision, but the
[reporter](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/tool-calls/reporters/CommandReporter.ts#L96)
strips command wrappers and does not export native callback/turn/environment
correspondence. [Decision defaults](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/permissions/command-decision-contract.ts#L14)
remain insufficient for an authoritative native offer.

Both reviewed native versions can strip `additionalPermissions`. A missing field
cannot establish authoritative absence. Null environment IDs also have no accepted
local-environment interpretation here. A bridge-only label or reconstructed
command cannot fix those native gaps. Strict auto-review on a profile grant still
applies to a turn, including subsequent commands, not one command.

## Normative draft v1 contract

The reference's `Capture`, `Offered`, `Target`, `Owner` and `Review` types specify
the draft structural contract. They are trusted-boundary inputs, **not an
untrusted-wire parser**. A future production parser must be closed and fail on
unknown versions/fields; a model or client supplying the same shape establishes
no provenance. The reference accepts only explicitly synthetic source descriptors;
real existing bridge builds are unsupported. This is deliberately not a runtime
support registry or evidence-signing facility.

1. **Capture before presentation.** On the verified native connection, capture
   original JSON-RPC method and typed request ID (number and string differ),
   thread/turn/item, distinct approval ID with missing versus null preserved,
   start time, explicit action kind, environment identity, command representation,
   cwd, complete decision-relevant scope and original native offered decisions.
   Preserve the native shell-quoted string byte-for-byte; do not parse it into an
   invented argv or strip/recreate wrappers. Preserve the complete raw params in
   owner-local memory for comparison, without exporting them. Missing evidence
   stays missing. Bind the actual pending native callback and connection by
   opaque object identity, not just item ID, a digest or a model-supplied token.
2. **Bind ACP separately.** Capture the actual ACP request ID, session, tool-call
   ID and ordered option ID/name/kind/native-decision/scope mapping from that same
   invocation. Preserve native offered ordering independently of ACP option
   ordering. Require a bijection with the authoritative native offer. No defaults,
   guessed kinds, injected choices, duplicate IDs or mismapped rejection options.
3. **Use a small eligible subset.** V1 permits only explicit ordinary command
   requests with identified environment, complete command/cwd/identity and
   source-attested complete absent network/additional/policy scope. In the draft
   fixture those four scope fields must be explicitly null, with independent
   `scopeEvidence: complete`; the latter is an upstream proof obligation, never
   something inferred from nulls or accepted from arbitrary metadata. The only
   positive mapping is native `accept` + ACP `allow_once` + scope `command`.
   Negative mappings are native `decline`/`cancel` + ACP `reject_once` + no grant.
   Unknown or additional scope, absent/stripped fields, network, stdin,
   subcommand, profile, turn/session and policy amendments remain explicitly
   incomplete or unsupported. No silent filtering or rewriting makes a broader
   offer eligible; preserve it privately and refuse this exact-command route.
4. **Authorize and budget review.** Authorize the specific private reviewer under
   the original ownership mutex and current credential/run scope. Return a fresh
   owner-local review reference for a snapshot. It is not bearer authority or a
   private-payload digest. Export only command representation, cwd, native IDs,
   method, environment identity, start time, absent scope, source descriptor,
   exact mapping, seven ORCA lifetime fields and original expiry. Exclude reason,
   parsed display actions, full context, environment values, credentials, raw
   params and private digests. Command text itself may be sensitive; production
   disclosure still needs approved principals and a safe complete-field policy.
   Regex redaction is no substitute for approval. If that policy cannot permit
   the complete necessary evidence, return unavailable with no positive choice.
5. **Bound the whole transport.** UTF-8 JSON row size must be at most 12 KiB; the
   complete enclosing JSON-RPC result, with framing and other rows/metadata, at
   most 256 KiB. `fitsReview` witnesses these exact boundaries with the trusted
   full-frame serializer supplied by the caller. It cannot certify a serializer
   that omits transport overhead. Never truncate or redact then call it exact.
   Oversize or incomplete results return only a bounded status and empty options.
6. **Bind and consume once.** Recheck current authority, run scope, unchanged full
   native params and mapping, all seven ORCA fields, original connection,
   callback, pending ACP request, source contract, original lease, original expiry
   and cancellation under ownership. Reject standing requests on this route.
   Claim synchronously before awaits, record before delivery, recheck after the
   record await, consume before dispatch. Changed evidence after recording gives
   recorded=true/delivered=false. Abort, expiry, revocation, turn/owner death,
   restart, lease loss and uncertain append or delivery never authorize replay.
   An accepted callback is not independent command-effect evidence.

The fixture is conservative: even pre-record authority failure retires its review
identity. Production must reuse `LiveHumanInput`'s current refused-responder,
authority, original-lease and durable-record semantics rather than replace its
registry with this model. Seven-field identities and lease/lifecycle machinery
remain the existing production foundation. Generic supported ACP callbacks and
separately authorized standing-rule writes keep their existing contract.

## Precise implementation dependency handoff

| Owning boundary | Required implementation and proof before support |
| --- | --- |
| Native maintained version | Emit a negotiated versioned completeness descriptor **before** experimental-field stripping. Preserve all decision-relevant scope and authoritative offers; explicitly distinguish authoritative absence from omitted/unknown. Supply an environment identity or source-backed null interpretation. Keep the original command representation and method/action/callback semantics. Pin an exact supported native build; 0.164.0 is not selected merely because it is latest. Native schema/emission and omission tests must prove this descriptor, not bridge assumptions. |
| Bridge transport owner | Extend native dispatch to capture the actual request envelope and its pending response closure at JSON-RPC dispatch. The current parsed-params-only handler needs a new owned context argument. Do not correlate a later handler with an observed message by equal params or item ID: concurrent identical requests need distinct closures. Carry native request ID/type, connection incarnation and cancellation into that context. If the JSON-RPC library cannot expose them, implement/review that transport seam upstream before proceeding. |
| Bridge approval handler | Capture the original params and authoritative mapping before `CommandReporter.permission` or other presentation. Produce an immutable v1 envelope tied to that exact native closure and the exact outbound ACP pending invocation. Return the selected native decision through the original captured callback once. Cancellation or changed transport/turn invalidates the binding. Retain the complete offer; refuse v1 eligibility if any decision has unsupported semantics. Add same-item/distinct-callback, identical-concurrent-request, turn/profile, default-offer, omission and loss-of-ack tests. |
| Maintained bridge/native release | Assign maintainer and explicit version pair; review source and artifacts together. Standard ACP has no native evidence guarantee. Negotiate a namespaced extension only with the verified adapter/transport identity and supported-pair allowlist. `_meta` may carry bytes only after that provenance seam exists; it is never independently trusted. Unknown/missing negotiation disables exact-command eligibility without breaking generic ACP. No concrete new upstream version number is invented here. |
| ORCA adapter/integration | After upstream capture is real, attach its private evidence handle to the same `PermissionInvocation`; never recover it from display/history or durable replay. Add a closed source-validated adapter and private projection only after reviewer policy is approved. Bind the review to existing `LiveHumanInput` ownership/lifetime/recording and its seven-field target. Keep live positive support disabled until this is tested on that actual route. |
| Installed and actual-Cal acceptance | Separately prove launcher/executable/dependency/artifact/source correspondence and managed routing. Then separately authorize exact shell/wrapper, cwd, effect/target/profile/lifetime/budget and safe evidence reviewers for actual-Cal command and C6b lifetime proof. Record native request, ACP request, authorized selection, original callback delivery and independently observed effect separately. Synthetic counters cannot satisfy either gate. |

The production registration proposal must name the contract version, exact bridge
and native package versions, source revisions and public artifact SHA-256 values,
ACP schema revision, completeness-contract revision and command-representation
semantics. Public build hashes identify artifacts, not private request contents.
Registration must be controlled by the verified adapter; the peer's self-reported
version is not sufficient. No real supported registration is supplied by this PR.

No changes have been submitted to upstream repositories, and no upstream maintainer
has accepted this draft. These dependencies remain real blockers. Downstream
projection alone cannot repair them. Keep [the live handoff](../preparation/acp-command-conformance/live-test-handoff.md)
disabled and #594 open until installed and actual-Cal evidence separately satisfy
its acceptance. #327/#393, #385/#390 and #602 consume that eventual evidence;
offline success cannot clear the beta gate.

## Regressions and verification

Before implementation, a temporary regression imported the existing digest-pinned
300-byte upstream `CommandUtils` fixture and required original wrapper retention.
It failed: expected `/bin/bash -lc 'printf orca-594'`, received `printf orca-594`.
The temporary test was removed after recording the result; the original immutable
source-loss witness remains, and the new v1 tests assert preservation on the
reference route. The upstream helper is unchanged and still loses the wrapper.

The new tests exercise original wrappers, multiline/quoted strings, null/missing
semantics, all seven lifetime fields, native method/ID/connection/callback,
environment, offered order and authoritative decisions, unsupported scopes,
changed snapshots, current review/answer authority, expiry, owner death/restart,
lease replacement/loss, duplicate/concurrent answers, record-before-delivery,
uncertain append/lost acknowledgement and exact multibyte row/result limits.
Protected-data sentinels prove narrow projection excludes raw reason/actions.
All command strings are synthetic data and are never executed.

```sh
node node_modules/vitest/vitest.mjs run \
  packages/agents/test/command-evidence-v1-594.test.ts \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/acp-command-conformance-506.test.ts \
  packages/engine/test/live-input.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/app/renderer/tsconfig.json --noEmit
node node_modules/eslint/bin/eslint.js \
  packages/agents/test/fixtures/command-evidence-v1.ts \
  packages/agents/test/command-evidence-v1-594.test.ts
```

Final focused result: **135 passed, zero skipped, four files** (69 new v1
reference tests, five source-loss witnesses, 31 existing #506 conformance tests
and 30 existing live-input tests). Both root and renderer typechecks, scoped
ESLint, changed-TypeScript Prettier, Markdown text/local-link checks and diff
whitespace checks passed. Node 24.19.0 / Vitest 5.0.2 use pre-existing cached
dependencies, not a newly reproduced frozen-lockfile install. Local worktree
links and the already-cached yaml 2.9.1 link were repaired only for verification;
no dependency, manifest or lockfile change is included.

No full suite, coverage, build, installed/native provider, platform smoke, live
approval, effect proof, deployment or release is claimed. Existing cached
dependencies are reused without install/lifecycle execution; source/synthetic
results and later PR CI are separate evidence.
