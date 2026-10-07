# Source, provenance and capability map

Checked 2026-10-07. These are source observations and synthetic contracts, not
installed/deployed proof. Baseline ORCA is
`794e64344e3d6edb64e80c5920f722ff381fa4a5`.

## Profile and exact pins

| Component | Evidence | Status |
| --- | --- | --- |
| Installed profile labels | [#502 owner observation](https://github.com/cschadewitz/Project_Orca/issues/502#issuecomment-6022267371), refreshed [here](https://github.com/cschadewitz/Project_Orca/issues/502#issuecomment-6028681755): Codex CLI 0.159.1, adapter 2.1.1 | Recorded labels; no installed binary/hash/config inspection in #506 |
| Codex 0.159.1 release | [`rust-v0.159.1`](https://github.com/openai/codex/releases/tag/rust-v0.159.1) resolves to [`8e68a98ef03cdde76d2e6800791ebdf1b3b95b24`](https://github.com/openai/codex/commit/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24) | Release provenance and the native parameter/emission/response sources below retrieved at this SHA; installed-artifact correspondence unverified |
| ACP adapter 2.1.1 release | [`v2.1.1`](https://github.com/agentclientprotocol/codex-acp/commit/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd), SHA `68d7d2d5ddfc0ed5746f9f6130892dda685e65dd`; pinned [package](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/package.json) | Exact release source retrieved. Package depends on `@openai/codex: ^0.159.1`; range alone does not pin the launched CLI |
| Executable selection | Pinned [launcher](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CodexJsonRpcConnection.ts) and [entry point](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/index.ts) | Explicit Codex path or dependency launcher starts `app-server`; installed selection remains unknown |

The archived `zed-industries/codex-acp` repository did not resolve `v2.1.1`
or `2.1.1` (422); its release URL returned 404. Search located the newer
`agentclientprotocol/codex-acp` repository. No upstream-main behavior is used
as a substitute. The initial native `protocol/v2.rs` lookup was the wrong path:
`v2` is a directory at the pinned CLI SHA. Cal's review identified the exact
files below; these were retrieved and reviewed at that SHA. This corrects the
initial retrieval gap. Native source describes these code paths, not every
installed execution path; **installed emission and managed routing remain
unverified**. Generated bridge types still establish only the bridge's contract.

## Pinned native approval source

Every native link below uses `8e68a98ef03cdde76d2e6800791ebdf1b3b95b24`.
This is a source review; no native binary, model or app-server was launched.

| Boundary | Source observation | Available / lost evidence |
| --- | --- | --- |
| Native command parameters | [CommandExecutionRequestApprovalParams](https://github.com/openai/codex/blob/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1549-L1630) | Thread/turn/item/start time, action kind, environment and optional distinct callback approval ID. Regular shell/unified-exec approval ID is null; subcommand/stdin callbacks can have distinct IDs under one item. Optional command string, cwd, reason, parsed actions, network context, additional permissions, amendments and available decisions. No structured argv/environment or effect proof. Additional permissions/available decisions are marked experimental; the stripping helper clears additional permissions |
| Native permission-profile scope | [Permission params and response](https://github.com/openai/codex/blob/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs#L773-L806) | Request includes thread/turn/item/environment/start time/cwd/reason/profile. Response carries granted profile plus scope `Turn` (default) or `Session`; optional `strictAutoReview` requests review of every subsequent command in the turn. This is broader than one command |
| Native command approval emission | [ExecApprovalRequest event handling](https://github.com/openai/codex/blob/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/app-server/src/bespoke_event_handling.rs#L667-L815) | Converts effective decisions and native event identity to `CommandExecutionRequestApproval`, then sends a pending server request. Invalid cwd is denied. The command branch emits `shlex_join` of the original command vector, cwd and best-effort parsed actions; its comment distinguishes exact approval command from redacted history. The managed-network branch instead emits network context with command/cwd/actions absent. These branches do not prove all native actions request approval or identify which branch Cal's installed policy uses |
| Native command response → core callback | [Response mapping and submission](https://github.com/openai/codex/blob/8e68a98ef03cdde76d2e6800791ebdf1b3b95b24/codex-rs/app-server/src/bespoke_event_handling.rs#L1965-L2090) | `Accept` → `Approved`; session/execpolicy/network amendments retain broader semantics. `Decline` → denied; `Cancel` → abort. Parse, client and channel errors deny; turn-transition errors return without resubmission. Submits `Op::ExecApproval` with the distinct approval ID or item ID and event turn ID. Submission may fail; response mapping is not effect proof |

The reviewed native command branch preserves a shell-quoted representation of
the input vector in its approval string. The later bridge shell-prefix transform
can still remove that context. Source availability therefore does not resolve
the command fidelity or operator-projection stop gate.

## Native request to ACP

All bridge links below use `68d7d2d5ddfc0ed5746f9f6130892dda685e65dd`.

| Boundary | Source observation | Available / lost evidence |
| --- | --- | --- |
| Native typed requests → thread handler | [CodexAppServerClient](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CodexAppServerClient.ts#L233) routes `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` to registered thread handlers | Unknown/no matching handler returns cancel for command/file; permissions returns an empty turn grant. No claim that routine auto-allowed actions emit a request |
| Native command shape expected by bridge | [Generated command params](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/app-server/v2/CommandExecutionRequestApprovalParams.ts) | Thread, turn, item, optional callback approval ID, approval kind, start time, environment ID; optional command **string**, cwd, reason, parsed actions, network context and amendments. No structured argv/env or filesystem/execution proof |
| Command option eligibility | [Decision parser](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/permissions/command-decision-contract.ts), [options](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/permissions/options.ts) | Present `availableDecisions` is validated; missing/null uses legacy defaults. Invalid/empty/unknown decisions cancel. `accept` maps to `allow_once`; `decline` and `cancel` to `reject_once`; session/policy amendments to remembered options. These defaults are bridge logic, not installed-native evidence |
| Command → ACP permission request | [Approval handler](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/permissions/CodexApprovalHandler.ts), [command reporter](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/tool-calls/reporters/CommandReporter.ts#L96), [renderer](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/tool-calls/AcpToolCallRenderer.ts#L57) | ACP `sessionId = threadId`, `toolCallId = itemId`; `rawInput` can carry transformed command, cwd, HTTP(S) URL, additional permissions. Non-AIR client gets execute/pending plus generic title and action-derived locations. Native turn/approval/environment IDs, kind and full network context are not retained by this command reporter |
| Command fidelity | [Shell-prefix transform](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CommandUtils.ts) | Shell executable, flags and surrounding single quotes can be removed from `rawInput.command`. It is a display transformation, not lossless command/argv binding |
| Permission profile → ACP | [Permission params](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/app-server/v2/PermissionsRequestApprovalParams.ts), handler/options above | `allow_once` can grant a permission profile for the **turn**, including strict-auto-review variant; `allow_always` grants session scope. Reject/cancel returns empty permissions. An ACP one-shot option is not universally one-command authority; this path is unsupported for exact-command acceptance |
| Tool lifecycle observations | [Prompt lifecycle](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/permissions/lifecycle.ts) | Start/completion observations track command presentation and MCP correlations. They are not approval requests or evidence of confinement |

Bridge response mapping selects the offered option by ID, with cancelled/invalid
responses or request errors returning native cancel (empty grants for profiles).
This supports mapping a native **command** `accept` to the originating callback,
conditional on the adapter honoring it. No synthetic test imports or runs this
provider source. Other native requests, AIR/MCP-specific prompts, stdin/subcommand
approvals and native automatic review remain outside certified coverage.

## ACP to ORCA to the operator and back

ORCA links refer to the preparation baseline; local fixture runs test the new
preparation head over that baseline.

| Boundary | Existing seam | Result and limit |
| --- | --- | --- |
| ACP callback → policy | [acp-session](../../../packages/agents/src/acp-session.ts), [permissions](../../../packages/agents/src/permissions.ts) | Only active matching ACP session/turn asks proceed. ORCA mints session/turn/invocation identity. Policy matches kind/title/locations, not `rawInput`; workspace reads can auto-allow without live input. Automatic allow can fall back to `allow_always`; the ordinary fixture deliberately offers a one-shot option |
| Eligible ask → live input | [orchestrator](../../../packages/engine/src/orchestrator.ts), [askHumanInput](../../../packages/engine/src/human-input.ts) | Uses original run/step and lease with boot/session/turn/invocation. Offers only ACP `allow_once`/`reject_once`; remembered-only asks cancel without an impossible card. Protected context retains the ACP tool call; it cannot reconstruct lost native data |
| Input → protected storage/public projection | [ProtectedEventStore](../../../packages/store/src/protected-event-store.ts), [OperatorReadModel](../../../packages/daemon/src/operator-read-model.ts) | Protected payload holds context. `operator.page(inputs)` exposes exact live target/state, question and options but deliberately omits context and artifact links. **Raw command/cwd/scope are unavailable in this operator approval projection**, even when present in the original ACP ask |
| Explicit operator answer → same callback | [MCP tool](../../../packages/integrations/src/mcp/server.ts), [operator alias](../../../packages/daemon/src/operator-mutations.ts), [control](../../../packages/daemon/src/control.ts), [LiveHumanInput](../../../packages/engine/src/live-input.ts) | `respond_to_approval` → `operator.answer` → `inputs.answer`, with live `resume:true`, exact seven-field identity and separately verified authority. No standing grant field. Authority is rechecked under original lease; actor/answer recorded before single delivery. Expiry, mismatch and duplicates refuse |
| ACP response → effects | `openAcpSession` returns selected original option or cancelled; bridge maps it to native decision | Delivered response is not execution proof. Synthetic peer increments a memory counter for allow; real native sandbox/managed limits still apply |

## Readiness findings

- **Supported synthetically:** exact ORCA live identity, one delivery, negative
  lifetime/race cases and bounded operator projection. See [matrix](test-matrix.md).
- **Blocked for exact-command actual-Cal review:** operator context omission;
  transformed command string lacks lossless shell/argv binding; native invocation
  and scope/effect provenance are incomplete. Never approve from “Run command”,
  task text, update events or a matching tool-call ID alone.
- **Unknown:** installed CLI/bridge artifact-to-release match, installed native emission,
  managed/automatic reviewer routing and actual Cal tool selection. Release tags
  and source compatibility do not establish these.
- **Unsupported:** turn/session permission-profile grants in a one-command test,
  remembered-only choices, native execution that does not reach ACP, and any
  generalized claim that ACP intercepts or confines every action.
- **Existing managed denial:** #502's refreshed owner evidence reports a loopback
  listener denied under the unchanged workspace policy. This preparation does
  not rerun it or classify it as an ORCA defect. No network grant, alternate mode
  or standing policy is proposed to obtain a pass.

These are owning-seam findings for #327/#237, with native forwarding/fidelity
belonging to the bridge. No production fix is included. Keep them separate from
the earlier [capability research](../../research/tool-call-safety/current-state.md)
and [live lifetime contract](../../live-input-continuity.md).
