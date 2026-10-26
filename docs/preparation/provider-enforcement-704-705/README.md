# #704/#705 provider enforcement qualification — offline preparation

26 October 2026; ORCA baseline `32f92cc16b9faf1748059e930c3f77b3934151ae`.
**GO for source qualification and non-executing fixture preparation only. No
provider/tool tuple is certified for strict execution or beta acceptance.**

This consumes the completed [#594 provider findings](https://github.com/cschadewitz/Project_Orca/issues/594#issuecomment-6405532959)
and [hook/client comparison](https://github.com/cschadewitz/Project_Orca/issues/594#issuecomment-6406001402),
the [merged bridge evidence work](../../implementation/594-command-evidence-v1.md),
and the [current-state path map](../../research/tool-call-safety/current-state.md).
It does not repeat the client survey or supersede the Codex proposal packet.
[#700](https://github.com/cschadewitz/Project_Orca/issues/700) owns the canonical
contract. These independent docs/data propose bindings; they define no runtime
port, support flag, production default or peer-branch dependency.

## Pins and evidence levels

[source-pins.json](source-pins.json) records full commit and Git blob identities,
original line ranges and SHA256 of exact excerpts under
[tools/test/fixtures](../../../tools/test/fixtures/provider-enforcement-704-705).
Excerpts are unmodified lines, not complete runnable modules; upstream licenses
are retained there. Public GitHub source was reread through Cal's connection.
No private provider context was collected. Version labels below are research
pins, not claims about what is installed or latest.

| Provider | Native / adapter pin | Evidence and compatibility limit |
| --- | --- | --- |
| Claude | Claude Code candidate **2.1.309**; SDK **0.3.309**; claude-agent-acp **0.95.0**, `ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350` | [Manifest](https://github.com/agentclientprotocol/claude-agent-acp/blob/ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350/package.json) fixes SDK 0.3.309. [Publication metadata](claude-publication-metadata.json) pins npm integrity, including platform dependency versions, without downloading artifacts. Native implementation is closed; CLI/SDK platform artifact correspondence and shared hook semantics remain unknown. Matching version suffixes do not prove linkage. |
| Codex | Bridge **2.2.2**, `202e66e63343ec4f5a5e35ab590251d813d129ca`; native dependency floor **0.160.1**, `d27764b82f7118f674371e6d6e76271d9d606edb`; separate hook candidate **0.164.0**, `6aaac694803004a63c6f393d153c96d22521a6b9` | Reuse [#641/#676/#678 findings](../../implementation/594-command-evidence-v1.md): bridge `^0.160.1` excludes 0.164.0. The hook source below is a separate native candidate, never a supported bridge tuple. |
| Pi | Native **1.4.0**, `4a080252f06caf63a525d7873c5d94d3c23887e0`; community svkozak/pi-acp **0.0.34**, `b0581c9c1d675e634234674484247008b03d69b4` | [Native manifest](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/package.json), [adapter manifest](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/package.json). External native launcher selection is unverified; other forks' safeguards cannot be attributed to this adapter. |
| Gemini | **0.65.0**, `6006c14a4decfe4b891c6263ad6ad5992e404b5b`; ACP is native in the same revision | [Manifest](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/package.json). This source lane is distinct from default consumer availability. [Google's official transition notice](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) directs free/Pro/Ultra users to Antigravity after 18 June 2026, while enterprise/paid API access remains. Antigravity and future providers are outside this qualification. |

`documented` means dated public documentation; `source-reviewed` means a pinned
control-flow read; `source-function-tested` means only the small vendored pure
function exercised with synthetic dependencies. **Installed-tested: none.
Live observed effect/cached approval/revocation: none.** Unknowns stay unsupported.

## Actual boundaries and failure behavior

| Path | Evidence, native behavior and limitation | Strict feasibility / smallest change |
| --- | --- | --- |
| Claude pre-tool vs permission ask | [Hook documentation](https://code.claude.com/docs/en/hooks#pretooluse) places PreToolUse before permission handling; `canUseTool`/PermissionRequest is narrower. Adapter [callback](https://github.com/agentclientprotocol/claude-agent-acp/blob/ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350/src/acp-agent.ts#L10294-L10512) forwards only asks. Its existing preview/subagent hooks are not an ORCA every-dispatch guard. Cached-native approvals reaching a new hook are documented intent, not observed here. | **UNKNOWN** for bounded Claude experiment. Follow [fixture PLAN](claude-fixture-plan.md); final input/cwd, later hook mutations, matcher inheritance, config protection and failure handling must be established on the selected artifact. |
| Claude failures and answers | Current [failure reference](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) documents command/HTTP `onFailure: block` only since **2.1.295**; unset failures/timeouts may continue. SDK callback timeout semantics differ. A plain-text/empty success is not proof of an affirmative policy decision. Adapter [decoder](https://github.com/agentclientprotocol/claude-agent-acp/blob/ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350/src/permissions/response.ts) checks actual offered IDs; callback checks abort after awaiting. | **UNKNOWN** installed fail-closed. One offered option is bound to the original toolUseID/input, but persistent permission-update effects and effective context still need structured source-backed qualification. Do not diagnose a Codex-like erased command/callback defect. |
| Codex pre-tool candidate | [Pinned parser](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/hooks/src/events/pre_tool_use.rs#L203-L323) marks malformed/error/unsupported output failed while leaving `should_block` false; exit 2 needs a nonempty blocking reason and control-capable handler. [Upstream test](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/hooks/src/events/pre_tool_use.rs#L556-L587) explicitly shows `ask` fails open. Competing rewrites select by completion order. | **NO-GO** as current strict mandatory checker. A wrapper emitting deny on its own errors cannot cover failure to start the wrapper. Need supported native fail-closed negotiation plus final rewritten action binding; do not copy Claude `ask`. |
| Codex native approval + bridge | [#594 source audit](../../implementation/594-provider-evidence-contract.md) records stripped shell prefixes, missing native callback/environment/scope and profile `allow_once` that grants a turn. Hook metadata cannot repair that evidence loss. | **NO-GO** current exact-command route. Continue existing evidence-preserving native/bridge direction; no second direct adapter or invented stable envelope. |
| Pi native tool_call | [Runner](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/runner.ts#L1249-L1267) passes one mutable event through handlers; block stops the sequence. [Dispatch](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/agent-session.ts#L658-L685) rethrows errors to block. No handlers returns no decision. [Bash](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/tools/bash.ts#L186-L275) later adds commandPrefix, takes effective context cwd and calls spawnHook that may change command/cwd/env; custom operations own execution. | **NO-GO** for treating early input as final action. Native block/error seam is useful. Smallest change: a protected final check after all transformations, immediately before the chosen operations dispatch, plus typed cancellation-bound authorization. |
| Pi ACP | [UI bridge](https://github.com/svkozak/pi-acp/blob/b0581c9c1d675e634234674484247008b03d69b4/src/acp/session.ts#L957-L1029) maps generic select choices to `allow_once`, synthetic `pi-ui-*` identity and kind `other`; exceptions cancel UI. Confirm checks `yes`. | **NO-GO** UI elicitation as exact command authority. Preserve cancellation/error handling; add a typed native invocation/option binding instead of interpreting arbitrary UI text. Other forks remain separate unknown tuples. |
| Gemini native ACP | [Invocation closure](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/cli/src/acp/acpSession.ts#L694-L840) retains native args/callback, but projects title/content/locations/kind without exact command/resolved cwd/additional scope. It parses option ID as a native enum, without comparing this request's options, then calls onConfirm/updatePolicy. Late-response policy effects need qualification. [Shell](https://github.com/google-gemini/gemini-cli/blob/6006c14a4decfe4b891c6263ad6ad5992e404b5b/packages/core/src/tools/shell.ts#L540-L551) checks abort before starting. | **NO-GO** strict projected approval today; **UNKNOWN** broader effects. Smallest change: projection from owned invocation plus actual offered-ID membership and cancellation/pending check before confirmation/policy mutation. Source omission is not proof of an exploit or of canceled shell execution. |

The dated [Codex hook reference](https://learn.chatgpt.com/docs/hooks#tool-coverage)
documents shell/exec, apply_patch, MCP and most local function hooks, with
hosted/specialized exclusions; later `write_stdin` sends input without another
pre-hook. These are documentation observations, not a source-tested exhaustive
tool inventory. Ask/error continuation above has separate pinned-source evidence.

## Coverage exclusions that cannot inherit a positive row

| Boundary | Claude | Codex | Pi | Gemini |
| --- | --- | --- | --- | --- |
| Repeated native cached permission | PreToolUse candidate; installed unknown | Native hook candidate; failure gaps | Native hook candidate; post-check mutation gap | ACP confirmation only; no every-dispatch proof |
| Native shell input/cwd | Hook input/session cwd need final-action proof | Hook command/session cwd need effective-action proof; existing bridge lossy | Later prefix/spawn/cwd/custom ops transformation proven | Native closure retains invocation; projection incomplete |
| Interactive stdin / continuation | Unknown; exclude | Later write_stdin documented uncovered | Unknown; exclude | Unknown; exclude |
| Subagents / subprocesses | Hook inheritance/identity unknown; a Bash hook does not check every child syscall | Subagent hooks documented, exhaustive paths unknown; child shell effects unmediated | Extension/custom tool paths and nested calls need pin-specific proof | Native callbacks do not prove every subagent/child action asks |
| Client filesystem | Separate ORCA handler, current callback path is not universal enforcement | Same | Same | Native/client fallback routing needs separate proof |
| MCP / alternate server | Named hooks documented; service-side effects/alternate routes unknown | Local MCP documented; hosted/specialized bypass remains | Extension/custom operations unknown | Native tool confirmation is not every server dispatch |
| Cancellation / owner loss | Abort checked on callback; reconnect exactly-once unknown | Native/bridge #594 obligations remain | UI error cancellation; native abort/final operations coverage unknown | Shell pre-start abort exists; late policy mutation unknown |

Every row also excludes policy/checker files writable by the agent, launcher or
binary drift, credential/ambient environment leakage, descendants and remote
effects beyond the named executor. A hook is not OS confinement. Native sandbox,
network, filesystem and credential ceilings remain necessary. Never force an ask
by bypassing permissions, relaxing sandbox policy or introducing broad grants.

## Proposed bindings for #700 review

1. Bind a provider-specific final immutable command/input/cwd/resources snapshot
   to its native pending closure, toolUseID or typed RPC identity, caller/run/host
   and connection generation. Re-evaluate after every rewrite; a session cwd is
   not automatically the command's effective cwd. Never derive authority from
   titles, arbitrary metadata, a generic UI option kind or model instructions.
2. Record coverage at the named boundary and exact native/adapter/runner tuple,
   distinguishing complete, authoritative absence and unknown scope. Excluded
   paths must fail admission for strict profiles; no permissive fallback checker
   or remembered native grant may fill a missing hook.
3. Map only actual offered IDs to source-backed effects/lifetime. A one-use permit
   binds one unchanged invocation; native session/turn/policy changes need
   separately authorized scope. Preserve current policy/revocation generation,
   #594 seven-field ownership/original lease and claim-before-await semantics.
4. Normalize missing evidence/checker outage/timeout/invalid response as
   indeterminate with no dispatch authorization; native continuation must be
   stopped by a proven execution boundary. Cancellation/death/restart/expiry,
   duplicate/replay, uncertain persistence and lost acknowledgement cannot mint
   or redeliver a permit. Require bounded pending work and protected configuration.

These are binding proposals pending the parent's canonical #700 review. No
production wire types or capability registry are introduced here.

## Offline verification and decision order

[Validation results](validation.md) record the actual focused checks.
[vectors.json](vectors.json) supplies non-executing inputs, native observations,
strict dispositions and the next proof required. They are rehearsal data, not
certification or a replacement policy engine. The focused test loads digest-checked
Pi/Claude pure source functions with synthetic dependencies; command strings are
never sent to a shell, provider, MCP server or host executor. Codex/Gemini excerpts
are source-reviewed only; their upstream tests are not claimed as run here.

```sh
node node_modules/vitest/vitest.mjs run \
  tools/test/provider-enforcement-source-704-705.test.js \
  tools/test/acp-command-evidence-source.test.js --maxWorkers=1
```

Priority: (1) reconcile these bindings with #700, (2) resolve the exact Claude
native/SDK/artifact tuple and protected failure contract, (3) seek separately
scoped authorization for [the bounded Claude experiment](claude-fixture-plan.md),
(4) review native/adapter changes for remaining no-go rows before any live trial.
No upstream contact, native process, configuration/hook installation, private
evidence disclosure, credential/access change, JEV/hosted activation, release,
deployment or Mac acceptance occurs. #704's actual cached/revocation proof and
#705's installed qualification remain open. #594 unsupported mode, disabled live
handoff, installed/actual-Cal/C6b and beta/privacy gates are preserved.
