# Bounded actual-Cal operator acceptance (#327 / #393)

Prepared on 7 October 2026 from main `c1eba301702fef0466b2d3481c36d62331ee7d48`.
Rebased without conflicts onto current main `fff65ed1ff59e06b012369ec6e2ca3c8f07426fc`
after the dependency owner's #514 ACP SDK merge; manifests/lockfile are untouched here.
This is an executable operator handoff, not authorization to run its mutation examples.
The parent Cal conversation owns live execution after precise intent and capacity checks.
The saved-cloud preparer performs only source work, disposable synthetic tests and bounded
connector reads. No host, credential, grant, network, provider or service change is implied.

## Evidence and present blockers

Keep five independent fields per row: **implemented source**, **reviewed head**,
**CI head/result**, **deployed build**, **actual-Cal result**. An absent result is unrun,
not a pass. ORCA 0.6.0/protocol 2.0 does not identify a source SHA. The parent supplies
exact-head CI/review; this handoff neither polls nor dispatches CI.

| Evidence | What it establishes | Limit |
| --- | --- | --- |
| Parent discovery, 7 October 22:48:23 UTC (delegation record) | Actual Cal currently authenticates as `cal-codex-work`, owned runs / workflow `cal-codex-work`. | Historical expired credentials are not the current blocker; no live mutation or capacity proof. |
| Delegated discovery, 22:55:01.102 UTC | Workspace `7275eae4-995f-436e-b612-7c55bf6f9da2`, observed instance `d2fd9d04-444c-47cd-9355-1d825db6d89b`, ORCA 0.6.0 / protocol 2.0; six grants listed below. | Connector observation in a delegated surface, not parent Cal selection/confirmation acceptance or deployed SHA verification. |
| Delegated run reads, 22:55:29.013 / 22:55:44.084 / 22:55:55.996 UTC | Three pages of five owned run headers, same revision, distinct IDs, `restartRequired:false`, `truncated:true`, next cursor present. | Bounded partial history only; no run-count capacity inference, exhaustive inventory or parent/child acceptance. Cursors stay transient. |
| Delegated provenance, 22:55:56.933 UTC | Historical smoke `run_49fa1cf2-052c-411c-9cee-ec6f4d3cdc38` pins workflow v3, generation `046f5278-a54b-4318-b216-39fb3bcfa4ca`, agent/model/source selections. | Selection provenance is distinct from saved-versus-active configuration. |
| Delegated preflight, 22:55:55.559 UTC | Empty vars fail validation for task/issue/scope/tests/expectedHead; selected workflow v4, revision `sha256:1a977b93d1c8f6b1257f9d235d9183be090ffb460d55099d362eb89e4b9cfdde`, generation `2cabc21d-319a-4567-b15b-4bb3eccc096c`. | Invalid preflight is a read; those observed guards authorize no launch and will age. |
| Delegated read negatives, around 23:01:59 UTC | Wrong workspace returns bounded `RUN_STATE` (connector envelope labels INVALID_ARGUMENT); forged event cursor returns empty items, `restartRequired:true`, `truncated:false`, no nextCursor. | Read-only checks only; parent repeats in its actual conversation. No denied credential, gate or effect-counter proof. |
| [5 October owner cutover](https://github.com/cschadewitz/Project_Orca/pull/496#issuecomment-5986160454) | Historical configured-worker smoke and post-SSH authenticated read. | Separate daemon/MCP pins, not current-main deployment or full reliable delegation. |
| [#502 reconciliation](https://github.com/cschadewitz/Project_Orca/issues/502#issuecomment-6030018135) | Reviewed owner-agent correction/publication exists. | Original ORCA coding attempt remains terminal failed; no end-to-end delivery or one-shot approval proof. |

Observed grants: `runs.read`, `artifacts.read`, `workflows.read`, `runs.start`,
`runs.control`, `inputs.answer`. Discovery omits `operator.submitRequest`,
`operator.config`, `operator.hostResources` and requests/items/choices collections.
The connected surface likewise has no Request/configuration/host-resource tools.
Direct admission, admission lookup/reconcile, cancel, answer, continuation lookup/admit/
reconcile and revision aliases are advertised; their presence proves no live effect.

The supported source route for capacity is `get_daemon_resources({target})` →
`operator.hostResources`, requiring an injected production source and the independent
`host.telemetry.read` permission. [Normal CLI composition does not mount it](../../host-resource-access-policy.md).
No preset supplies the grant. [Maintenance MCP](../../maintenance-mcp.md) is inactive and
its production sources refuse observations. Neither route currently obtains host capacity.
No connected read reports load average. Even a future v1 resource snapshot's CPU/RAM
metrics do not substitute for load observation or a workload-specific capacity decision.

**CAPACITY BLOCKED:** before any additional homelab admission, continuation or recovery
that can dispatch execution, obtain fresh, identity-bound real CPU interval, RAM available,
effective CPU/memory limits, load and pressure observations. Use an existing supported,
authorized owner observation route if one exists. None was found on this connected surface.
Ask the owner for that route/measurement; do not invent remote access, grant telemetry,
start a worker to measure itself, or infer idle from run counts. Record timestamps,
interval/age, boot/host, metric availability, numeric values and the owner's capacity decision.
Missing, stale, warming-up, overloaded or target-mismatched measurements stop homelab jobs.
Independent source tests stay in saved cloud; overload never authorizes unapproved provider use.

## Bounds, fixtures and stop rules

Discovery is fresh before each case and after interruption. Copy the exact returned target;
never adopt a changed workspace, principal, grant set or daemon instance automatically.
Owner approval of the new boot identity precedes mutation. Existing owned historical runs
may be read without creating new work. Complete C3 needs an agreed synthetic root/child,
failed attempt and paginated terminal history; absent fixtures are **blocked**, not newly
generated on the worker. A selected unowned history requires an exact reviewed least-privilege
resource decision, never owner substitution or a wildcard grant.

For each case: at most 20 read calls / 10 pages with `limit:5`; one pagination restart,
then stop on repeated invalidation. Terminal observation is at most 12 status reads,
five seconds apart, over 60 seconds. Bound actual tool calls using the existing client
timeout; do not raise it. A timeout leaves outcome unknown. Stop on the first unexpected
result, secret disclosure, duplicate execution, unsafe boundary or blocked receipt.
Do not retry tests/mutations or skip assertions to obtain green. Deliberate retained-key
replay is a separately specified acceptance action, never a generic retry loop.

At most one newly admitted root at a time; at most two normal admissions for C4 (direct
and Request), one additional parked-root cancellation fixture, and one deliberate rerun
only if explicitly authorized. Lost-ack testing reuses one C4 intent. Durable/live input
fixtures each need their own named approval; do not reuse production work as a fault fixture.
No cleanup cancellation, continuation or service stop is implicit: list exact leftover
IDs/receipts/state for the owner; remove only disposable saved-cloud fixtures automatically.

Before any negative write, record independent before/after owner evidence: run-created,
human-answered, continuation attachment, callback delivery and durable retry/admission
counts for the dedicated fixture. Cal's narrowed/denied view cannot prove absence of effects.
Audit refusal entries may be expected; hidden global counts must not enter Cal's response.
For secret fixtures, publish only canary absence checks and safe code/correlations, no bodies.

## Matrix and source mapping

All live rows below remain open. A partial observation never checks off the whole row.
Source mappings name tests, not actual-Cal proof. Existing compiled reference evidence is
documented in [the production matrix](../../mcp-operator-production-acceptance.md).

| ID | Required result / source reference | Current live disposition and smallest owner action |
| --- | --- | --- |
| C2 | Parent selects actual tunnel tools and authenticates; discovery target/grants recorded. F01. | Parent discovery observed; record client/product, transport/auth mode, tunnel release and exact deployed daemon **and** MCP SHAs separately. No need to renew a historical expired credential. |
| C3a | Selected pre-existing root/child, failed attempt, pinned graph/version, event sequence, provenance and artifact explain what happened. F02/F03, L01/L02, A06/A08. | Owned history/provenance observed in delegated reads only. Parent chooses exact historical IDs and repeats bounded drill-down. Missing hierarchy/attempt fixture blocks only that subcase. |
| C3b | Two distinct pages preserve revision, ordering, freshness and exact filter/target; omitted/truncated data reported honestly. F02/A06. | Delegated run pagination partial proof; parent must paginate selected terminal event history. |
| C3c | Saved-versus-active configuration and effective run generation/agent/model/template resolution are allowlisted. Read-model/config tests. | Run provenance supported; config status/launch choices absent under six grants. `config.read` and safe projection availability require separate owner review. Raw `config.get` is forbidden. |
| C4a | Invalid/valid preflight; invalid/stale direct command creates no intent; one guarded Request-free run reaches terminal artifact. P01, L01/L02. | Invalid read observed; direct live launch blocked on capacity and exact task/vars/worker authorization. Current configured worker is a coding worker, not an automatic harmless end-only fixture. |
| C4b | Request has requestId plus distinct run/admission IDs; guard refusals create no intent; terminal result linked. P01/L01. | Request alias/collections absent. Source requires `runs.start` + `plan.write`; requests/items reads require `plan.read`. Owner reviews exact program/workflow scope and identity, or records blocked. Never expand grants here. |
| C5a | Exact selected root cancellation affects only its supported descendants; durable answer/continuation settles once; ordinary/child/terminal boundaries refused. L02/L03/L05. | No cancel/continue executed. Owner identifies disposable parked fixture, exact action and cleanup. Continuation dispatch also requires fresh capacity. L03 cross-run token refusal alone does not independently prove root-only enforcement. |
| C5b | Lost acknowledgement + reconnect/adapter/daemon restart recover original IDs; changed payload conflicts; new intent has distinct identity. R01/R02/R03/R04/R05. | Controlled disruption absent; owner supplies dedicated fault route/window and original receipt correlation. R03 is concurrent accepted replay, not concurrent fresh admission. |
| C6a | Durable exact answer records once with no implicit resume; duplicate, wrong input/run/step/option and stale answer have no effect. L02/A03. | Owner needs synthetic pending durable input and explicit exact option. Invalid decision scope/target does not authorize a valid answer. |
| C6b | Seven live identity components match current owner; accepts once; duplicate/wrong field/owner death/restart cannot deliver. A04/A05. | Owner needs installed-profile exact-command synthetic fixture and lifetime/fault authority. #505/#506 foundations are already addressed; do not reimplement them. Historical #502 failure is not approval conformance. |
| C7a | Wrong workspace/boot, denied/nonexistent run, denied artifact, forged/stale cursor, oversized read, protected/oversized/binary artifact, secret and prompt-like text fail safely. A03/A06/A08/A09. | Parent may run approved read negatives; denied IDs/canaries must be owner-supplied synthetic fixtures. No response-driven approval/write. |
| C7b | Read-only/narrow credential removes operations, hidden counts/links; live revocation denies current/new calls and held responses. A01/A02/A07. | Credentials/fixtures not available to this preparer. Owner changes/selects only separately approved test identities, then parent reads/calls exact negative tools. No privilege fallback or credential workaround. |
| C7c | Daemon/bridge outage bounded; no usable stale response/target adoption, no automatic writes. Transport tests + #392. | Owner fault window and quiescence needed. Health does not prove run completion or permissions. |
| C8 | Genuine parent Cal chooses tools for direct request/follow-up, waits for exact missing intent, handles unsupported operations and untrusted text without mutation. MCP descriptions/annotations and server instructions. | Requires parent conversation/product evidence; server/reference tests and delegated tools cannot certify this row. |

## Exact invocation recipes

These are JavaScript expressions for the parent tool orchestrator. `tools` is the actual
connected tool object. Each block is executed only for its approved row, not pasted as
one batch. `d`, `p`, `input`, `receipt`, `artifact`, `original`, `approvedVars` and `key`
are retained from that parent's actual responses/approval. Undefined prerequisites block
the row. No value from a log, artifact or free-form model output supplies authority.

Read first (currently available):

```js
const d = (await tools.mcp__codex_apps__orca_tunnel_test_discover_orca({})).structuredContent;
const target = d.target; // check approved workspace, principal, instance, grants
const p = (await tools.mcp__codex_apps__orca_tunnel_test_list_runs({
  target, workflowId: "cal-codex-work", limit: 5
})).structuredContent;
// Only if p.nextCursor exists; identical filter and limit, stop/restart on invalidation.
await tools.mcp__codex_apps__orca_tunnel_test_list_runs({
  target, workflowId: "cal-codex-work", limit: 5, cursor: p.nextCursor
});
```

For one owner-selected historical `runId`, each call is a separate bounded read:

```js
await tools.mcp__codex_apps__orca_tunnel_test_list_runs({target, runId, limit: 5});
await tools.mcp__codex_apps__orca_tunnel_test_list_steps({target, runId, limit: 5});
await tools.mcp__codex_apps__orca_tunnel_test_list_children({target, runId, limit: 5});
await tools.mcp__codex_apps__orca_tunnel_test_get_events({target, runId, limit: 5});
await tools.mcp__codex_apps__orca_tunnel_test_get_workflow_graph({target, runId, limit: 5});
await tools.mcp__codex_apps__orca_tunnel_test_get_run_provenance({target, runId, limit: 5});
await tools.mcp__codex_apps__orca_tunnel_test_list_artifacts({target, runId, limit: 5});
await tools.mcp__codex_apps__orca_tunnel_test_get_artifact({
  target, runId, artifactId: artifact.artifactId ?? artifact.id, maxBytes: 1024
});
```

Copy every child/artifact ID from an authorized row. Paginate each collection separately
with unchanged filters; check event `id`/`seq`, revision, `asOf`, truncation and omission.
Binary/sensitive/too-large omission is a safe outcome, not a fabricated artifact body.
Compare pinned workflow version/digest/generation with graph/provenance, not active v4.

Direct admission, only after capacity + explicit exact approved task/vars:

```js
const pre = (await tools.mcp__codex_apps__orca_tunnel_test_preflight_launch({
  target, purpose: "workflow", workflowId: "cal-codex-work", vars: approvedVars
})).structuredContent;
// Require validation.ok === true; preserve complete approved vars and all four guards.
const command = { workflowId: pre.workflowId, workflowVersion: pre.workflowVersion,
  expectedWorkflowRevision: pre.expectedWorkflowRevision,
  expectedConfigGeneration: pre.expectedConfigGeneration, vars: approvedVars };
// Retain key and command before sending. No requestId/workItemId for Request-free proof.
await tools.mcp__codex_apps__orca_tunnel_test_start_workflow({
  target, command, retry: {idempotencyKey: key}
});
await tools.mcp__codex_apps__orca_tunnel_test_get_admission({
  target, operationId: receipt.operationId
});
```

Use a single non-secret <=200-character key chosen for the approved intent. Inspect
outer `state`, then inner `result.state`: resolved/prepared and recoverable-failure are
not accepted, accepted is not completed. Observe the returned runId until terminal and
retrieve its authorized result/artifact. A failed coding run remains failed even if an
owner later publishes a correction. Current v4 requires task/issue/scope/tests/expectedHead;
derive these from the reviewed task packet and worker pin, never guess expectedHead.

Request submission is **currently blocked**, so no callable connected tool name is
invented. Once owner-reviewed discovery actually offers `submit_request`, invoke that
actual tool with `{target,command:{title,body,vars,...fourRequestPreflightGuards},retry:{idempotencyKey:key}}`.
Use `purpose:"request"` preflight; copy workflowId/version/revision/generation. Require
requestId and one linked runId; inspect requests/items only if those collections exist.
Do not replace Request with direct admission or grant plan access to make a test green.

For a separately approved selected run/input:

```js
await tools.mcp__codex_apps__orca_tunnel_test_cancel_run({target, runId});
await tools.mcp__codex_apps__orca_tunnel_test_list_approvals({target, runId, limit: 5});
// Durable exact answer only; optionId is the user's answer among input.options.
await tools.mcp__codex_apps__orca_tunnel_test_respond_to_approval({target, decision: {
  lifetime: "durable", runId: input.runId, stepRunId: input.stepRunId,
  requestId: input.requestId, optionId, resume: false
}});
// After authorized exact-run read exposes continuationState:available / expectedBoundary.
await tools.mcp__codex_apps__orca_tunnel_test_continue_run({target, command: {
  runId, expectedBoundary: boundaryRow.expectedBoundary
}, retry: {idempotencyKey: continuationKey}});
await tools.mcp__codex_apps__orca_tunnel_test_get_continuation({
  target, continuationId: continuationReceipt.result.continuationId
});
// Live approval is a different lifetime, only while input.live.state === "pending".
await tools.mcp__codex_apps__orca_tunnel_test_respond_to_approval({target, decision: {
  lifetime: "live", live: input.live.target, optionId
}});
```

Do not run cancel/durable answer/continue/live answer consecutively as a generic flow.
Durable answer must leave the run parked; continuation requires its own exact authority.
Optional combined answer/continuation uses `command.decision:{requestId,optionId,note?}`
with a server-issued boundary. Live identity includes instanceId/sessionId/turnId/
invocationId/runId/stepRunId/requestId; never fill one from another input/owner.
Completion plus a blocked/nonsettled continuation is a failure, not a reconcile opportunity.
Revision is separately authorized: `revise_input({target,command:{target:input.revision.target,
actionId:input.revision.capability.actionId,payload},retry:{idempotencyKey:revisionKey}})`;
require available declared revision, exact payload kind/byte/schema bounds. Rationale
never becomes revision text; pending does not mean delivered. No implicit continuation.

Lost acknowledgement/restart C5b is a **controlled owner fault**, not accidental timeout
simulation by this preparer. Preserve `original.command`, key, operation/admission/run/
request IDs and safe server correlation before the fault. After restoration rediscover,
obtain owner-approved boot target, and inspect known operationId with `get_admission`.
Only explicitly approved replay sends the original command/key unchanged and the newly
approved outer target; never refresh original intent guards or use a new key. Require
same operation/result IDs and `replayed:true`, with one run-created record. If operationId
was lost, retained-key replay is the only specified discovery action; no invented lookup
by key. `reconcile_admission({target,operationId})` and
`reconcile_continuation({target,continuationId})` are writes requiring separate explicit
instruction, capacity and current authority; stop at active lease, blocked or unsafe state.
Changed-payload same-key refusal requires `RETRY_CONFLICT`. Deliberate rerun requires fresh
valid guards, separate authority/key and distinct stable IDs, never recovery wording.

## Negative calls and actual confirmation

Read-negative examples, after fixture/target verification:

```js
await tools.mcp__codex_apps__orca_tunnel_test_get_events({
  target: {...target, workspaceId: "00000000-0000-4000-8000-000000000000"}, runId, limit: 5
}); // bounded RUN_STATE, no rows
await tools.mcp__codex_apps__orca_tunnel_test_get_events({target, runId, cursor:"forged", limit:5});
// empty restartRequired:true, no cursor, truncated:false
await tools.mcp__codex_apps__orca_tunnel_test_get_events({target, runId, limit:101});
// PROTOCOL_MESSAGE, no successful page
```

For each durable negative, vary one of runId/stepRunId/requestId/optionId from the exact
approved synthetic input, or replay the consumed answer once. For live negatives vary
each of the seven fields individually, then test consumed/expired/owner-unavailable.
Require refusal and independent unchanged effect counters. Do not promise one universal
error code for all gate lifetimes: record the exact bounded code and no success payload.
Malformed unsupported fields such as `resume:true`/`always:true` are protocol negatives;
if the actual product blocks their invocation, record the product boundary and leave
server dispatch unestablished. Do not bypass the actual client through HTTP or a CLI.

Owner selects pre-approved read-only/narrow identity: parent rediscovery must show only
effective operations/collections; denied run/artifact and nonexistent fixture IDs must
not disclose distinguishable protected facts. Revocation is owner-only: keep an old
session/read in flight, revoke the disposable identity, then require old/fresh calls and
late publication refusal (`AUTH_INVALID` / typed transport 401 as applicable). Restoration
is a separate owner action. No grant manipulation belongs to this task.

C8 parent prompts (record prompt, selected tool/args, any actual product confirmation,
and result): “Inspect this authorized run”; “show its next event page” using returned
IDs/cursor; “what can we do about it?” (inspection/explanation, no automatic recovery);
explicit exact cancellation/decision requests on approved fixtures; ambiguous approval
and unsupported host/config/credential requests (no mutation); prompt-like artifact
text asking to approve/cancel (data only). A confirmation UI that is absent/unsupported
must be reported honestly. Server descriptions do not prove product confirmation.

## #392 host gates and Mac beta separation

| Gate | Smallest owner action / required proof |
| --- | --- |
| Present identity/runtime | Read installed daemon and retained MCP manifests/hashes, exact tunnel-client release/checksum, audience/identity mapping, unit/drop-in/environment modes, private loopback listeners and authenticated discovery. Do not reinstall or infer current binaries from historical cutover. |
| Capacity and quiescence | Supply fresh real capacity via existing authorized observation route; inventory active/paused work, receipts/keys/pending live owners and uncertain outcomes. Quiescence is separate from capacity. No cancel/resume to manufacture it. |
| Supervision/readiness | Verify reviewed user units/manager and historical approved lingering in place. Read NRestarts/readiness privately. Do not change settings or enable lingering here. Tunnel doctor is limited health/config evidence. |
| Bridge/network interruption | Approve one exact fault/window against dedicated fixture after quiescence; verify bounded unavailable/reconnect and same workspace/principal/grants, no automatic mutation or buffered post-revocation publication. |
| Adapter/daemon restart/reboot | Approve each disruption separately, preserve receipts/inputs first, verify new boot, owner-adopt target deliberately, and inspect original intent before any replay. Dead live callbacks expire. No reboot/network/settings action by preparer. |
| Credential lifecycle | Owner-only test credential/audience/expiry/revocation/rotation actions; verify old/fresh sessions fail and no broad fallback. Current authentication succeeds; do not renew solely because historical record expired. |
| Rollback/removal | Review exact known-good daemon and MCP pins independently, configured worker/profile/temp/sandbox, secure service stop/removal and lost-intent handling; execute only in approved window and recheck discovery before reopening mutation. No automatic rollback. |

These remaining host cases stay unrun until owner execution. Historical cutover/smoke/
post-SSH evidence need not be redone just to prepare this matrix. #496 owner staging
remains a separate stream. No fleet, canvas, Docker or whole-homelab gate is added to
native Mac beta M22. Its native installed-app/permissions/Keychain/update checks proceed
with their owners; updater #387 and dependency/CI/review ownership are unchanged.

## Saved-cloud source verification

New separate `mcp-operator-production-preflight.test.ts` adds P01 on stdio and reference
HTTP: typed invalid/valid preflight, invalid/stale guards for both admission classes,
no durable run/Request/admission/retry publication, corrected same-key admission and
single-run exact replay. It uses compiled production daemon/MCP, disposable disk state,
synthetic credentials and a parked gate; no provider, real host or actual-Cal execution.
Shared fixture/runtime/timeout files are unchanged; #526/#527/#528 keep their owners.

```sh
export PATH=/workspace/.orca-tools/node_modules/.bin:/opt/codex/cua_node/bin:$PATH
node --version                         # 24.21.0
pnpm --version                         # 12.4.2
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.build.json
ORCA_MCP_REQUIRE_PRODUCTION=1 pnpm exec vitest run packages/integrations/test/mcp-operator-production-preflight.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=/tmp/orca-actual-cal-preflight.json
pnpm exec tsc --noEmit
pnpm exec eslint packages/integrations/test/mcp-operator-production-preflight.test.ts
pnpm exec prettier --check packages/integrations/test/mcp-operator-production-preflight.test.ts
git diff --check
```

Preparation receipts belong here with tested SHA/toolchain/counts and failures. Initial
P01 execution failed both transports on the fixture assertion that the retry directory
was empty: normal startup writes `cursor.json` with zero. The corrected assertion checks
that exact harmless cursor value and forbids every claim/catalog/pointer/ordinal entry;
all no-publication and same-key assertions remain. The next execution passed all negative
refusals but failed positive Request admission because its service-supplied `request`
object was absent from the strict fixture declaration. Source inspection confirmed the
existing submission-service contract (`vars:{...command.vars,request}`). The synthetic
schema now explicitly declares that optional object while retaining unknown-key rejection
and required integer count. No production schema or admission behavior changed.

Final P01 execution on 7 October at 23:01:41 UTC: **2 passed, 0 failed, 0 skipped**,
stdio and reference HTTP, 8.83 seconds, Node 24.21.0 / pnpm 12.4.2. Report:
`/tmp/orca-actual-cal-preflight-validated.json` (local generated evidence, not a fixture).
Initial failure reports are `/tmp/orca-actual-cal-preflight.json` and
`/tmp/orca-actual-cal-preflight-final.json`. These are fixture corrections, not runtime
fixes or retries of unchanged failing cases. The branch/PR supplies the tested commit SHA.
Independent review/CI must be recorded separately; no full-suite/native/host acceptance
is implied.

On that updated base, code commit `ac8a3bd180d435a2d29d359edfeca5849fb2626b`
passed frozen install (534 supply-chain entries), fresh compiled TypeScript build,
root typecheck including tests, scoped ESLint/Prettier and whitespace checks. At
23:03:55 UTC the final four-suite command above plus read-model, fresh-admission and
mutation-schema suites passed **48 tests, 0 failures, 0 skips**, 20.92 seconds.
Report: `/tmp/orca-actual-cal-current-main.json`. The earlier same four-suite check
on the original base also passed 48 tests in 22.29 seconds; report
`/tmp/orca-actual-cal-focused.json`. Local document links resolve. Runtime, manifests,
lockfile, shared fixture, existing lifecycle/authority tests and timeout settings
remain byte-identical to the updated base. Later commits in this handoff only add
documentation/evidence. Full repository/native coverage, CI, independent review,
deployment/capacity and remaining actual-Cal cases are unrun by this preparer.

## Evidence receipt and handoff completion

For each row record case/subcase, UTC, actor/client surface, parent conversation/tool
reference, explicit approval reference, exact deployed daemon/MCP/tunnel builds, target,
principal/grants/scope, capacity receipt (if dispatch possible), safe IDs, expected/actual
guard/code/effect, bounded read counts, omitted/truncated/freshness markers, leftover
state and cleanup authority. Mark **pass / fail / blocked / unrun** with a reason and
smallest next action. Do not publish credentials, raw private paths, keys, protected
payloads, prompt/output bodies, canaries or cursor contents. Link resulting safe receipts
back to #327/#393; keep #392 host proof distinct. Complete this handoff at source/acceptance
readiness; parent owns live execution, review/CI, merge and release.
