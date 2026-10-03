# Source-grounded capability map

All relative source links below refer to the exact main SHA in [README](README.md),
not an assertion about whatever `main` becomes later. Inspection date: 2026-10-03 UTC.

The classifications mean:

- **Implemented-on-exact-main:** inspected source and its production entry point exist.
  This is source evidence, not a new test execution or actual-Cal proof.
- **Active-integration-only:** implementation is present on a named unmerged head.
  Its availability remains bounded by that head's wiring and verification.
- **Documented contract:** approved interface/preparation, without a claim that its
  production implementation is installed.
- **Future proposal:** experience or product behavior still requiring an owner decision
  or implementation; disabled/unavailable until supported.

An open issue is not evidence of missing code. For example, #328 remains open while
its authentication foundation is implemented. Conversely, #327's interface fixtures
are not evidence of a live Cal connection.

## Main capability inventory

| ID | Capability and classification | Source and implication for the experience |
| --- | --- | --- |
| C01 | Authenticated daemon and resource grants — **implemented-on-exact-main** | [Auth operations](../../../packages/daemon/src/auth/operations.ts), [resources](../../../packages/daemon/src/auth/resources.ts), [security](../../daemon-security.md); #328. Current authority is checked separately from tool availability and user intent. Preflight requires `runs.start`; Request submission also needs workspace `plan.write`. Never substitute an owner credential. |
| C02 | Workspace/boot identity and app switching — **implemented-on-exact-main** | [Handshake](../../../packages/protocol/src/handshake.ts), [daemon identity](../../../packages/daemon/src/daemon-identity.ts), [connection contract](../../daemon-connection.md); #318. Pin workspaceId, instanceId and local connection epoch. URL alone is not identity; old results cannot populate a new target. |
| C03 | Typed launch validation and workflow digest — **implemented-on-exact-main** | [Input wire schema](../../../packages/protocol/src/workflow-inputs.ts), [validator model](../../../packages/daemon/src/workflow-inputs.ts), [registration](../../../packages/daemon/src/methods.ts); #330. Returns workflowId/version/revision/validation, not effective vars or config generation. Admission rechecks version/digest. The model's old “not registered yet” comment is superseded by actual registration. |
| C04 | Separate Request submission — **implemented-on-exact-main** | [Command/result](../../../packages/core/src/model/request.ts), [daemon model](../../../packages/daemon/src/request-submission.ts), [service](../../../packages/engine/src/program/request-submission.ts), [documentation](../../request-submission.md); #329. Prepared/accepted/recoverable-failure retain admissionId/requestId and runId when available. Admission correlation is not a client retry key. |
| C05 | Direct workflow launch — **implemented-on-exact-main** | [RunsStartParams](../../../packages/protocol/src/control.ts), [ControlModel.startRun](../../../packages/daemon/src/control.ts). No Request is created. Legacy `runs.start` waits until parked/finished; it is not prompt durable admission. Optional existing associations must be valid and authorized. |
| C06 | Captured config and safe run provenance — **implemented-on-exact-main** | [Generation capture](../../../packages/engine/src/configuration-generation.ts), [provenance](../../../packages/engine/src/configuration-provenance.ts), [public shape](../../../packages/core/src/model/run-provenance.ts), [reloadability](../../configuration-generations.md); #332. Saved revision differs from active generation. Recorded input values are withheld. Existing runs retain captured choices; authority stays current. Raw `config.get` is not an operator preview. |
| C07 | Role/model/template selection — **implemented-on-exact-main**, with entry-point limits | [CLI selection](../../../packages/cli/src/commands/selection.ts), [Request overrides](../../../packages/core/src/model/request.ts), [session model](../../../packages/engine/src/session-model.ts), [template registry](../../../packages/core/src/template/registry.ts). CLI/ACP and Request overrides exist. Direct daemon params expose neither `overrides` nor top-level agent/model/template selectors. Do not encode them in arbitrary vars and claim override behavior. |
| C08 | Model and template resolution — **implemented-on-exact-main** | [Session model](../../../packages/engine/src/session-model.ts), [registry](../../../packages/core/src/template/registry.ts), [rendering](../../../packages/core/src/template/render.ts). Session-offered model selection differs from configured declarations; session application can fail. Pack lookup falls back to base, partials use exact IDs. Role selection does not select a persona. Template version metadata is not independently immutable lookup. |
| C09 | Workspace providers — **implemented-on-exact-main**, without a launch-time picker | [Local provider](../../../packages/engine/src/workspace/provider.ts), [Git worktree provider](../../../packages/engine/src/workspace/git-worktree.ts), [provisioning](../../../packages/engine/src/orchestrator.ts). Local uses configured cwd; Git worktree creates per-work-item checkouts, but a direct run without a work item uses the main checkout. Direct wire input has no repo/cwd/worktree selector. No promise of an automatically isolated direct run. |
| C10 | Inspection, output and artifacts — **implemented-on-exact-main**, with read limits | [Read model](../../../packages/daemon/src/read-model.ts), [run wire views](../../../packages/protocol/src/runs.ts), [artifact views](../../../packages/protocol/src/artifacts.ts). Source IDs and event cursors exist. Some collections are unpaged; artifact omission does not authorize filesystem fallback. A run's success is not independent verification of the patch or checks. |
| C11 | Exact durable/live answers, cancellation and resume — **implemented-on-exact-main**, with lifetime limits | [Control](../../../packages/daemon/src/control.ts), [live target](../../../packages/protocol/src/live-input.ts), [continuity](../../live-input-continuity.md); #237. Durable gates park; live answers require the original valid owner/callback. Legacy resume and durable answer-and-resume wait. No `runs.retry`, transfer of a dead callback or blanket safe replay. |
| C12 | ACP session behavior — **implemented-on-exact-main** | [ACP facade](../../../packages/integrations/src/acp-facade/orca-acp-agent.ts) advertises `loadSession: false`. Reopening Cal's conversation or observing an existing run is not durable same-agent chat continuity. |

## Active work and remaining proposals

| ID | Capability and classification | Evidence and experience boundary |
| --- | --- | --- |
| C13 | Retry ledger, direct admission, continuation and revision runtime — **active-integration-only** | [PR #415](https://github.com/cschadewitz/Project_Orca/pull/415), observed head `b4bc23c97fba542a1cb3dcff6b0b0d241f430436`; feature inputs #412/#413/#414. Its checkpoint reports protocol 2.0/operator-journals-v4, real receipts and bounded continuation recovery. Automatic Request/direct startup recovery remains deferred; do not promise automatic progress after crash. Native evidence is reported for its runtime-identical parent, not executed here. New observational reads still need review. |
| C14 | Bounded MCP reads and coherent operator preflight — **active-integration-only** | [#414](https://github.com/cschadewitz/Project_Orca/pull/414) at `b5a2c8f926135e14005cd57ddcf55020e6316322`, integrated into #415. Read/preflight wiring does not establish mutation mounting. Recheck actual discovered operations and current grants on the accepted combined build. |
| C15 | Ten production operator mutation envelopes and boundary projections — **documented contract** | [#419](https://github.com/cschadewitz/Project_Orca/pull/419), frozen `4937f4c083c572d07b840258724ef600368a7a5d`, [production contract](https://github.com/cschadewitz/Project_Orca/blob/4937f4c083c572d07b840258724ef600368a7a5d/docs/mcp-operator-production-contract.md). Strict target/command/retry envelopes; four launch guards required. This preparation installs no handlers. It preserves actual RetryResult envelopes and tri-state boundary availability. Pending correction replacement/history is unsupported in that mount. |
| C16 | Cal's private connection — **documented contract**, execution blocked/unverified | [#391](https://github.com/cschadewitz/Project_Orca/issues/391), [connection decision](../private-mcp-access/decision.md), #392/#393. No positive actual-Cal harmless read was found in the inspected issue/evidence. This packet makes no new account/tunnel availability claim; reference-client or source review is not proof. |
| C17 | Guided launch surface — **future proposal** | [#334](https://github.com/cschadewitz/Project_Orca/issues/334). This packet specifies its one-agent experience. Active admission-controller work does not establish the complete selection/preview/review surface. |
| C18 | Reusable template editor/publication — **future proposal** | [#355](https://github.com/cschadewitz/Project_Orca/issues/355). Select only supported loaded instructions today; editing, immutable catalog publication and pack compatibility are separate work. |
| C19 | Exact repo/worktree evidence before direct launch — **future proposal** for a safe operator projection | C09 has provider behavior, but neither the direct command nor frozen safe target discovery supplies an arbitrary picker or verified checkout snapshot. #334/#327 must agree the minimum safe observation; see D1 in [handoff](implementation-handoff.md). Missing evidence blocks this experience's launch. No raw config or arbitrary path-read fallback. |
| C20 | Minimal implementation workflow and verified result bundle — **future proposal** | #334/#420 own the workflow/sample handoff; no ready named workflow is asserted. Authorized artifacts may carry a diff and command evidence. A built-in repository-diff/check-verification API is not established by C10. |
| C21 | Usage, enforced monetary budget, completion percentage and ETA — **future proposal / unavailable** | [Design rule 12](../../design/RULES.md); #345/#346 own usage/budget work. Do not display estimates or imply a monetary cap is enforced. Existing workflow limits, if known, are different. |
| C22 | Job PR publication — **future proposal**, outside initial operator surface | #327 excludes arbitrary shell/admin tools; [#350](https://github.com/cschadewitz/Project_Orca/issues/350) tracks GitHub publication infrastructure. A later separately authorized supported publisher can return a verified PR URL. Never invent an ORCA publish-PR method. |

## Contract reconciliation

The original [operator parallel contract](../../runtime-operator-parallel-contract.md)
remains the foundation. The inspected #419 preparation refines the integration's
operator envelopes and boundary observations; this packet adopts those details only
as **documented contract**, without changing them. In particular:

- Keep `operationId`, `admissionId`, `runId` and optional Request identity distinct.
  Preserve real `resolved`/`in-progress`, `replayed` and nested admission state.
- Continuation/revision views distinguish `available`, `unsupported` and
  `unavailable`; absent fields are not usable guards. Exact run/input/step/node
  evidence must agree. A busy or unverifiable read cannot become “no approval.”
- Use existing `operator.page` for exact-run boundary enrichment. Do not add an
  RPC or infer a boundary from the newest input. Live owner hooks must be wired.
- Main is still the source baseline here. No #415/#419 branch was imported;
  their protocol/store epochs and test counts are not main acceptance evidence.
