# #594 native dispatch seam: private offline prototype

This is a source-correspondent proposal against codex-acp **2.2.2**, commit
`202e66e63343ec4f5a5e35ab590251d813d129ca`. It extends the
[v1 contract/reference](../../../implementation/594-command-evidence-v1.md)
from PR676 head `4771d2bc1ff096a5c610d37e3e2aff6c551ae0e2`.
PR676 merged into main at `30113b4e2c055cad8570bcf1e080364cbf342ce5`.
A fresh GitHub comparison confirmed its reviewed head is main's merge base,
with main seven commits ahead and zero behind. The new draft therefore targets
main; PR676 is a satisfied dependency. The local test base is the exact reviewed
PR676 tree. Existing main changes, including #662, are outside this preparation.

All new files stay in this existing private preparation area. Nothing imports
them from ORCA production. The patch is data: it has been applied only to temporary
copies of pinned source for correspondence checks. No bridge/provider process,
installed replacement, real command, credential, private command data, public
submission, upstream contact, production wiring or activation was used.

## Actual source correspondence

[source-pins.json](source-pins.json) records every vendored Git blob identity,
the reviewed native source floor and the actual JSON-RPC package artifact. The
unmodified snapshots retain the upstream Apache 2.0 [license](upstream/LICENSE).
The executable type bundle removes imports and changes formatting only.

| Owning source | Prototype/patch correspondence |
| --- | --- |
| [CodexJsonRpcConnection.ts:61](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/CodexJsonRpcConnection.ts#L61) | Replace the connection factory before `listen()` with `createCommandDispatch(reader, writer)`. Mint one opaque connection incarnation there. No process startup is run by the prototype. |
| [JSON-RPC MessageStrategy:737](https://github.com/microsoft/vscode-languageserver-node/blob/20969f3e75cb3cd35c2bb794b1d15cc2dfbe4abb/jsonrpc/src/common/connection.ts#L737) | `handleMessage(message, next)` owns the actual decoded request object. `AsyncLocalStorage.run(entry, () => next(message))` binds that dispatch frame to the typed handler. There is no params/item equality correlation or traffic observer. |
| [ServerRequest command branch](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/app-server/ServerRequest.ts) and [generated params](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/app-server/v2/CommandExecutionRequestApprovalParams.ts) | The proposed upstream module uses `Extract<ServerRequest, {method: ...}>`. The offline type bundle preserves those exact generated command params/response types. The reader adds `jsonrpc: "2.0"` as it already does upstream; native wire framing omits it. Method, ID type, all params, omissions/nulls and unknown experimental fields remain captured before any reporter. |
| [CodexAppServerClient.ts:231](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/CodexAppServerClient.ts#L231) | Replace the params-only registration with `onCommand(pending)`. Pass a clone of the captured params and the pending context to the existing approval handler, and recheck stale turn/cancellation after it returns. No reconstructed display is consulted. |
| [JSON-RPC original reply closure:818–896](https://github.com/microsoft/vscode-languageserver-node/blob/20969f3e75cb3cd35c2bb794b1d15cc2dfbe4abb/jsonrpc/src/common/connection.ts#L818) | Each typed `onRequest` invocation creates its own response-promise resolver. `pending.respond` settles only that promise, which the library awaits before its original `reply` closure writes the original typed request ID. The library's private closure is retained through this direct return chain, not copied or recovered by ID. A separate opaque callback identity is captured per invocation. |
| [StdUtils native writer:10](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/StdUtils.ts#L10) | The original writer catches errors and reports success. The proposal uses that file's existing `createLineWriter`, preserving native NDJSON framing, propagating synchronous write errors and honoring backpressure. This change is necessary before the outer seam can observe rejected writes. |
| [JSON-RPC fallback reply:887](https://github.com/microsoft/vscode-languageserver-node/blob/20969f3e75cb3cd35c2bb794b1d15cc2dfbe4abb/jsonrpc/src/common/connection.ts#L887) | A rejected result write causes an error-response attempt. The writer guard consumes the response before awaiting its first write and suppresses the fallback attempt too. Success means only that the write returned, never native acknowledgement or execution. |

[dispatch.ts](dispatch.ts) is the executable seam. [native-stdio.ts](native-stdio.ts)
copies the pinned reader/line splitter/line writer with the proposed writer fix;
it omits malformed-input logging and expands one parameter property for Node's
type stripping. It never logs traffic. [codex-acp.patch](codex-acp.patch) proposes
changes to the actual three upstream source files and adds the two seam modules.
[prepare-patch.mjs](prepare-patch.mjs) regenerates it from exact snapshots and
requires every replacement anchor to occur exactly once. Tests apply it with
`git apply --check`, verify the applied dispatch module is byte-identical to the
tested prototype except its type import path, and verify the same native writer.

The native-reader wrapper reserves IDs before JSON-RPC queues them. Duplicate IDs,
cross-method reuse and numeric/string aliases end the incarnation before the
library's string-keyed queue can overwrite a request. Tombstones are never evicted
and reused as authority. This deliberately bounded prototype permits at most 256
server-initiated requests per incarnation and 256 KiB per decoded request, then
retires it. These are offline harness limits, not proposed production capacity
policy or a bounded untrusted-wire parser. The upstream line splitter can accumulate
a line before parsing; no general transport/parser hardening is claimed.

## Native descriptor change required before exact-command support

Both reviewed native releases lack the required descriptor. At native **0.160.1**
`d27764b82f7118f674371e6d6e76271d9d606edb`,
[item.rs:1549](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1549)
defines optional/experimental scope and its stripping method erases
`additional_permissions`. [bespoke_event_handling.rs:668](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server/src/bespoke_event_handling.rs#L668)
has the native event, original command vector, action/callback routing, environment,
all scope and effective available decisions before `send_request`. That is where
the native producer must construct a negotiated, versioned stable descriptor.

The required source change is a non-experimental `evidenceDescriptor` field on
`CommandExecutionRequestApprovalParams`, with a new closed descriptor type in the
native protocol and construction at that emission boundary. Proposed descriptor
revision `codex.commandApprovalEvidence/1` must carry:

- Explicit action classification: ordinary command, subcommand, stdin, network or
  unsupported. Existing `kind: command` alone does not distinguish all of these.
- Original native-shell-quoted command and cwd representation semantics; native
  thread/turn/item and callback identity, including explicit regular-callback null.
- Identified environment, or a source-defined local-environment interpretation;
  unknown/null without that interpretation remains incomplete.
- A closed snapshot of **all** decision-relevant network, additional-permission,
  exec-policy and network-policy scope, with authoritative absence explicitly null;
  otherwise an explicit unknown/stripped status. A completeness bit cannot replace
  scope values or be inferred from legacy optional fields.
- The authoritative ordered native offered decisions and their command/turn/session/
  policy semantics. Legacy defaults, display option kinds and arbitrary metadata do
  not establish an offer.

Construct it before experimental stripping. The stripping path must either retain
the complete stable snapshot or downgrade/refuse the descriptor; it must never
retain a "complete" assertion while dropping decision-relevant values. Future
decision-relevant fields require a descriptor revision or explicit unsupported
status. Regenerate native TS/schema from that source and prove emission/omission,
experimental-off, unknown-version, environment and action/scope cases upstream.
No native descriptor is implemented by this prototype, and no supplied descriptor
bytes are trusted here: `pending.exactCommand()` always returns unsupported with
empty options, including for forged completeness metadata.

The exact **tested source tuple** is bridge 2.2.2 at `202e66e...`, JSON-RPC **9.0.1**
at `20969f3...`, and native **0.160.1 at `d27764b...` for source inspection only**.
The isolated npm lock pins JSON-RPC 9.0.1 and its SHA-512 integrity; tests also pin
its actual `lib/common/connection.js` SHA-256. No native executable is tested.
Bridge 2.2.2 declares `@openai/codex: ^0.160.1`, which excludes **0.164.0** at
`6aaac694803004a63c6f393d153c96d22521a6b9`; that later source also has the audited
stripping gap and is not selected as a compatible pair.

There is **no maintained supported v1 bridge/native version pair**. The remaining
maintenance decision is who owns the bridge factory/handler/writer changes and the
native descriptor, and which exact resulting native/bridge release and artifact
pair they support. Version numbers for those future builds are unassigned; this
private patch is not a released bridge version. A bridge-only fork without the
native change must keep exact-command support unavailable. No upstream maintainer
has been contacted or has accepted this proposal.

## Tests, self-review and limits

29 new Node tests pass with zero skips, running the actual JSON-RPC 9.0.1 dispatcher
over the source-derived native NDJSON reader/writer and memory streams. They cover
identical concurrent requests returned in reverse order, same-item/distinct approval
callbacks, typed IDs, synchronous duplicate claims, native pre/in-flight cancellation,
cancellation between claim and write, disposal/reconnect, queued/pending/settled
duplicates, cross-method collision, numeric/string aliases, immutable complete params,
multibyte/newline framing, writer failure/backpressure, request/history bounds,
unsupported/forged descriptors and exact patch/source correspondence.

The unmodified-library control observes two response attempts after a result reaches
the peer and its write rejects. Both pre-write and post-write fault cases on the
prototype observe one underlying attempt, no second completion and no retry. Tests
use only synthetic command strings and negative native decisions; none executes a
command or asserts an observed effect. A resolved response promise is not a durable
answer record or acknowledgement.

The unchanged four-file regression selection passes **135 tests, zero skipped**:
69 PR676 v1 reference, five source-loss, 31 #506 ACP conformance and 30 existing
live-input cases. Those models remain separate from this transport seam. Production
ORCA ownership, seven-field identity, original lease, current authority and durable
record-before-delivery must still be attached through the existing live-input route;
this patch does not replace it with another gate registry. Actual outbound ACP
request-ID/option mapping, private projection/reviewer policy, native descriptor
validation and installed artifact/routing proof remain unimplemented.

Standalone and root/renderer TypeScript, scoped existing ESLint rules, changed-code
Prettier, source blob/artifact hashes, patch applicability, Markdown text/local links
and diff whitespace checks pass. Self-review checked the actual dispatch/response
chain, native writer semantics, cancellation/write races, replay/collision handling,
privacy and the unimplemented native/ACP/ORCA boundaries. This is self-review, not
independent upstream or installed-provider acceptance. Full upstream typecheck/build,
ORCA full suite/coverage/build, platform proof, live/native execution and actual-Cal
acceptance were not run. CI is not awaited.

Node 24.19.0 was used. The standalone package installs only JSON-RPC 9.0.1 with
`--ignore-scripts` and its own lock; the ORCA root manifest/lock remain unchanged.
Existing cached ORCA package links and the cached yaml 2.9.1 link were restored for
the worktree. Initial missing-link failures were environment-only and passed after
repair; no fresh ORCA frozen-lockfile reproduction is claimed.

From this directory, after the isolated dependency is available:

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/orca-594-npm-cache
node --test dispatch.test.ts
node ../../../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ../../../../node_modules/eslint/bin/eslint.js *.ts *.mjs
node ../../../../node_modules/prettier/bin/prettier.cjs --check *.ts *.mjs *.json
node prepare-patch.mjs
```

The installation step fetches the pinned JSON-RPC library only; test execution is
offline. It is a private nested preparation package, outside ORCA workspace/package
build selection. CI's normal Vitest selection does not automatically execute this
Node test command; the explicit local result above is the test evidence.
Keep [the live handoff](../live-test-handoff.md) disabled and #594 open. Source and
synthetic results cannot clear installed-provider, actual-Cal or beta acceptance.
