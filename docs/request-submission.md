# Request submission and recovery (#329)

This feature slice implements the frozen [parallel contract](runtime-next-parallel-contract.md).
The production method table, CLI bootstrap and generation-provider wiring are reserved
for integration. Apply [the shared wiring patch](patches/329-request-submission-integration.patch)
and bind the real #332 `CaptureLaunch` and #318 workspace identity before advertising
these methods. Feature tests use an injected generation provider; they do not establish
cross-story acceptance. No MCP transport is implemented here (#327).

## Two operations

`requests.submit` creates a Request and admits its program/decomposition workflow.
`runs.start` explicitly launches a workflow. It does not create a Request or decompose
anything implicitly. A direct run can legitimately have no Request. Existing authorized
run reads, events, cancellation and resumption remain the execution interface.

The command is a strict object: `title`, `body`, optional `source`, `labels`,
`workflowId`, `workflowVersion`, `expectedWorkflowRevision`, `expectedConfigGeneration`,
`vars` and `overrides` (roles, model, item workflow and template pack). The configured
program default is selected by the captured generation when `workflowId` is omitted.
Program item-workflow defaults must also be seeded by that generation's bound callbacks,
not by a mutable configuration read after capture.

Caller-selected `requestId`, `workItemId`, `programRunId`, `admissionId`, `actor`,
`principalId` and `vars.request` are rejected. This contract submits **new** Requests;
it does not attach a new program root to arbitrary existing documents. The shared
orchestrator patch separately validates associations on explicit `runs.start`: missing
Requests, missing work items, missing work-item Requests and mismatched pairs fail before
workflow snapshot, workspace or run creation. The daemon's resource guard runs first.

## Identities and authority

| Identity | Owner and lifetime | Links |
| --- | --- | --- |
| Admission ID | Server-generated recovery correlation, durable for the admission's lifetime | One Request; at most one program root |
| Request ID | Server-generated planning identity; survives client disconnect/restart | `Request.programRunId` and `run.requestId` |
| Work-item ID | Created by the decomposition workflow, with its own planning lifecycle | `workItem.requestId`, item execution runs |
| Run ID | Engine-generated execution identity, backed by the event log | Optional Request/work item; children link to parents |
| Caller session/source | Untrusted provenance, such as an ACP session label | No ownership or authorization rights |
| Principal/workspace | Verified server authority, injected separately from command data | Exact durable root ownership and admission scope |

`SubmissionAuthority` is mandatory on the shared service. It supplies the verified
workspace, mutation actor, a **live** `authorize` callback, and a durable
`onRunAdmitted` ownership callback. Authorization is repeated before writes and ownership;
it is not frozen with configuration. The daemon adapter uses the existing `holds`,
workflow scope and `Authorizer`/`OwnershipStore` seams. It requires both `runs.start`
and workspace-scoped `plan.write`, because decomposition can modify the workspace plan.
Restricted clients do not acquire workspace rights by supplying a source label.
Recovery/list/inspect are scoped to the same principal and workspace, with current grants
rechecked. A different principal and a missing admission produce the same refusal.

The integration patch rechecks operation grants before parameter diagnostics over the
shared HTTP/WebSocket dispatcher. It registers admission methods only with the provider,
control enabled and durable token-mode ownership. Explicit legacy loopback mode retains
its old methods. No new permissive principal or production generation is synthesized.

## Durable boundary and recovery

The result is one of:

```ts
{ state: "prepared", admissionId, requestId }
{ state: "accepted", admissionId, requestId, runId }
{ state: "recoverable-failure", admissionId, requestId, runId?,
  failure: { code: "RUN_STATE", message: "Request admission is incomplete; reconcile the original admission",
             recovery: "reconcile" } }
```

Admission proceeds as follows:

1. Authorize; validate the strict command; capture one generation/workflow; authorize
   its resolved target; validate launch inputs and overrides without side effects.
2. Seal command, original Request, admission binding and actor in the **existing**
   protected execution store under the admission ID. No plaintext command/provenance
   snapshot or new encryption key lifecycle is introduced.
3. Persist the discoverable `prepared` index in `request-admissions.json`.
4. Persist the provisional Request; create the root without executing it; persist
   its ID; persist exact ownership; persist the Request's root link and public projection.
5. Persist `accepted`, then return IDs. Only after this may an adapter execute.

The provisional Request has redacted title/body and no source/labels: before the engine
records its input sensitivity, those fields might repeat a sensitive value. The original
Request is passed to the workflow in the service-owned `vars.request`. After admission,
public Request fields are projected using the engine's recorded sensitivity, preserving
structural source tags. A workspace provider inspecting the provisional Request during
provisioning sees redacted text; it must use the Request ID for identity. Normal public
metadata is restored before execution. Request settlement preserves completion/failure
status when an accepted admission is reconciled again.

`requests.admissions {}` lists the caller's recovery states, including work whose client
lost the initial response. `requests.admission {admissionId}` inspects one.
`requests.reconcile {admissionId}` reconciles that **original** admission and queues an
accepted root for execution. No command values can be replaced during recovery.

| Failure boundary | What survives | Reconciliation |
| --- | --- | --- |
| Before durable index publication | No Request or run; an unreferenced encrypted record may remain | No work was accepted; submitting anew is safe only after inspecting for an uncertain index write |
| Index written, Request absent | `prepared` index and protected original input | Restore the Request, then admit |
| Request written, root absent | Index and provisional Request | Restore the same generation/version/digest; create its root |
| Root written, ID/link absent | `run.created` names the unique server-owned Request | Find that root, restore ownership/link; never create another |
| Ownership/link/acceptance write fails | Existing root and admission correlation | Repeat durable ownership/link writes; preserve original IDs |
| Accepted, worker never starts/client disconnects | Durable accepted IDs and ownership | Inspect/read, then reconcile or use authorized run resumption |

A per-admission file mutex serializes the **entire** recovery sequence across processes.
The engine run log is scanned before any new root is created. An unreadable/ambiguous
scan or multiple associated roots fails closed. Scanning is linear in the number of
runs; there is no second client retry index. Missing/corrupt protected material is a
`RUN_STATE` refusal. If the original generation cannot be captured after restart,
reconciliation remains recoverable; it never silently chooses the latest configuration.
Restoring generation material is the #332 provider's responsibility.

Public failure text is fixed and never contains a raw exception, secret or path. If the
failure-marker write itself fails, the prior prepared state remains the recovery handle.
Acceptance requires the callback to have flushed ownership durably. The shared patch
adds ownership write retries and fsync of the owner file and directory to the existing
store; it does not create a second ownership map. The file admission index likewise
flushes its directory entry before acknowledgment.

`admissionId` is **not a client idempotency key**. Two `submit` calls create two admissions.
#331 owns principal/workspace/operation-scoped keys, fingerprints, conflicts, retention
and replay checks over this lifecycle. Reconciliation does not claim exactly-once
external effects or replay safety for arbitrary workflow steps.

## Errors and compatibility

| Condition | Error/result |
| --- | --- |
| Missing/invalid/forbidden verified authority | Existing `AUTH_REQUIRED`, `AUTH_INVALID`, `AUTH_FORBIDDEN` protocol faults |
| Malformed command, unknown association fields, reserved Request variable | `WORKFLOW_INPUT_INVALID` from service; strict wire schema rejects invalid envelopes with `PROTOCOL_MESSAGE` |
| Missing/disallowed workflow, version/revision mismatch, invalid inputs/overrides | Existing workflow/agent validation errors, before persistence |
| Missing/mismatched explicit-run association | `RUN_STATE` (shared orchestrator patch) |
| Missing/foreign admission or missing protected recovery material | `RUN_STATE`, generic unavailable message |
| Failure after prepared admission | `recoverable-failure` with stable IDs and safe `RUN_STATE` recovery information |

The configured `ProgramService.submit` delegates to this service and preserves its
`{request, runId}` result, adding optional `admissionId`. `submitAndRun` and settlement
retain their existing completion behavior. The CLI patch prints admitted Request/run/
admission IDs before following execution, preserving existing exit status and work-item
output. ACP emits Request/admission IDs before its usual run updates and completion;
its long-lived `session/prompt` contract still streams until the turn ends. `/run` and a
selected direct workflow remain direct runs. ACP session labels never supply authority.

The old three-argument embedded `ProgramService` constructor remains a legacy
compatibility path until its composition root supplies admission dependencies. It gains
reserved-variable validation, but **does not promise durable admission recovery** and
rejects generation guards it cannot honor. Production integration must configure the
fourth constructor argument for CLI/ACP/daemon; a configured service without explicit
local authority refuses the legacy wrapper. This is an integration requirement, not an
alternate supported new submission contract.

Existing clients using `runs.start` keep its response shape. New clients discover the
additive methods through `hello.methods`; no admission method is advertised merely
because its schemas exist. No protocol version bump or new capability is claimed by
this independently developed slice.

## Integration handoff

The patch applies to preparation baseline `7abc2342aa672ee9d2f10d565ca4f8eb546184df`.
It contains exact exports, association admission checks, method/auth/server registration,
CLI compatibility changes, ownership durability and shared documentation links. Bootstrap
accepts a `requestSubmission` composition callback returning `{admissions, captureLaunch,
authority}`. Integration must bind that callback to the actual #332 provider and verified
local authority using #318's persistent workspace identity. The feature branch cannot
name a peer implementation's constructor before it exists; no placeholder provider is
included. Consolidate identical capture types with #332 when its exports are available.

Required existing-suite updates at integration: method inventories/security matrix tests
for four additive methods; explicit-run association fixtures must create their Request/
work-item documents; production bootstrap/CLI tests must inject the genuine provider.
Run HTTP/WebSocket parity, concurrent apply/admission, persisted generation restart and
the real App smoke at the combined head. Independent feature checks are not that evidence.

Dedicated tests cover admission/refusal, each durable write boundary, concurrent recovery,
file-store restart, protected Request projections, configuration capture and fail-closed
recovery, live authority, prompt daemon acknowledgment, configured ProgramService/ACP
parity and direct Request-free runs.
