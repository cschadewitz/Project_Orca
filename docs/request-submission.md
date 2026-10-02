# Request submission and recovery (#329)

This feature slice implements the frozen [parallel contract](runtime-next-parallel-contract.md).
The combined runtime wires daemon methods and CLI/ACP entry points to the real
configuration-generation provider, historical `RestoreLaunch`, persistent workspace
identity and durable admission store. The patch is a historical handoff; do not
reapply it. No MCP transport is implemented here (#327).

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
`principalId`, `vars.request` and `vars.__orcaAdmissionId` are rejected. This contract submits **new** Requests;
it does not attach a new program root to arbitrary existing documents. The integrated
orchestrator separately validates associations on explicit `runs.start`: missing
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

The dispatcher rechecks operation grants before parameter diagnostics over the
shared HTTP/WebSocket dispatcher. It registers admission methods only with the provider,
control enabled and durable token-mode ownership. Explicit legacy loopback mode retains
its old methods. No new permissive principal or production generation is synthesized.

### Explicit local authority

`orca submit`, `orca acp` and the demo explicitly select local-process admission.
An embedder calling `bootstrap()` gets the service but cannot submit through
`ProgramService` without explicit authority. RPC never uses the local factory.
Where token authentication is configured, local entry points verify the existing
local-client token, pin its credential ID, and recheck grants/revocation before
admission and worker execution. They neither issue nor rotate tokens. Missing,
invalid or revoked configured credentials cannot fall back to OS authority.

In a standalone workspace that has never configured token authentication, those
entry points bind the actual OS user, check current workspace access and (on Unix)
config/store directory ownership, and record an opaque OS-user actor plus durable
run ownership. Each authorization rechecks the boundary. Configuring token auth
invalidates previously captured standalone authority; restart the command. This
preserves the local disk-owner CLI boundary without a network-usable permissive
principal. Ownership writes merge under a cross-process mutex and retain the first
durable owner rather than clobbering a concurrent daemon's mapping.

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
metadata and the program root link are published together before execution. Recovery
writes this projection only while the root link is missing, with first-link writers
serialized by the admission mutex. Settlement requires the root link; once it exists,
reconciliation leaves the Request document untouched. This preserves concurrent completion,
failure or cancellation and its timestamp, without a stale read-and-replace write racing
`ProgramService.settle`.

`requests.admissions {}` lists the caller's recovery states, including work whose client
lost the initial response. `requests.admission {admissionId}` inspects one.
`requests.reconcile {admissionId}` reconciles that **original** admission and queues an
accepted root for execution. No command values can be replaced during recovery.
Daemon reconciliation validates current execution-renewal authority before returning an
accepted recovery receipt and rechecks it when the worker attaches. After bootstrap
credential rotation, this permits the original principal to recover with its current
credential, subject to unchanged workflow scope, durable ownership, `runs.start`,
`runs.control` and `plan.write` checks. A failed preflight is returned to the caller;
the original admission remains durable and can be inspected or retried. An accepted
receipt acknowledges admission and queued execution, not successful completion.

Daemon recovery RPCs require token-mode ownership and a wired submission provider.
Standalone admissions keep their original OS-user principal; a later daemon cannot
impersonate it. Use the local recovery surface from the original workspace:

- `orca admissions list` discovers prepared, accepted and recoverable admissions.
- `orca admissions inspect <id>` reads the original safe receipt.
- `orca admissions reconcile <id>` repairs its original admission without starting
  execution; an accepted receipt prints the explicit `orca resume <runId>` next step.
- Configured ACP clients expose `/admissions list`, `/admissions inspect <id>` and
  `/admissions reconcile <id>` with the same receipt-only recovery semantics.

No app recovery form is supplied. Do not submit anew as a recovery substitute: that
creates another admission. Listings omit workflows outside the caller's current scope;
revocation and unavailable authority still fail the entire operation.

| Failure boundary | What survives | Reconciliation |
| --- | --- | --- |
| Before durable index publication | No Request or run; an unreferenced encrypted record may remain | No work was accepted; submitting anew is safe only after inspecting for an uncertain index write |
| Index written, Request absent | `prepared` index and protected original input | Restore the Request, then admit |
| Request written, root absent | Index and provisional Request | Restore the same generation/version/digest; create its root |
| Root written, ID/link absent | `run.created` retains the service-injected admission correlation | Find that root, restore ownership/link; never create another |
| Ownership/link/acceptance write fails | Existing root and admission correlation | Repeat durable ownership/link writes; preserve original IDs |
| Accepted, worker never starts/client disconnects | Durable accepted IDs and ownership | Inspect/read, then reconcile or use authorized run resumption |

A per-admission file mutex serializes the **entire** recovery sequence across processes.
A recorded admission run ID (or the Request's program root link) is verified directly.
Other top-level runs may legitimately associate with the same Request, even with the
same workflow, without becoming candidates for that admission. When neither link survived,
recovery reads `requestAdmissionId` from the authenticated original `run.created` payload.
The service passes it as server-owned launch metadata, outside `vars`; workflow authors do
not declare it in `inputSchema`, and strict unknown-input rejection remains unchanged.
Even workflows without sensitive fields seal their creation payload using the existing
protected execution store. Public metadata is never proof of correlation, including when
it was redacted or altered. That marker is correlation, not authority. Previously prepared
v1 admissions retain read compatibility with the old `vars.__orcaAdmissionId` marker;
new v2 admissions never inject it.
An unreadable/ambiguous scan or multiple roots carrying that exact correlation fails closed.
Older incomplete admissions without the correlation version require explicit repair when
both root links are missing; recovery never guesses or silently creates a replacement.
Only uncertain missing-link recovery scans linearly over the run store; a newly prepared,
mutex-held admission with its original capture does not scan unrelated runs. Its created
root is still verified directly before acceptance. An unreadable or ambiguous recovery
scan remains fail-closed. Missing/corrupt protected material is a `RUN_STATE` refusal;
reconciliation never silently substitutes the latest generation.
Restoring generation material is the #332 provider's responsibility.

Public failure text is fixed and never contains a raw exception, secret or path. If the
failure-marker write itself fails, the prior prepared state remains the recovery handle.
Acceptance requires the callback to have flushed the exact run ownership change durably.
A later queued attribution cannot become a false failure of an earlier successful write. The integrated ownership store
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
| Missing/mismatched explicit-run association | `RUN_STATE` |
| Missing/foreign admission or missing protected recovery material | `RUN_STATE`, generic unavailable message |
| Failure after prepared admission | `recoverable-failure` with stable IDs and safe `RUN_STATE` recovery information |

All configured submission workers (ACP, ProgramService/CLI and daemon) pass through
`executeAcceptedSubmission`: it inspects the admission with current authority, verifies
the accepted run ID, and only then invokes execution. Revocation after durable acceptance
leaves the accepted work inspectable by authorized callers without starting a workflow.

The configured `ProgramService.submit` delegates to this service and preserves its
`{request, runId}` result, adding optional `admissionId`. `submitAndRun` and settlement
retain their existing completion behavior. The CLI prints admitted Request/run/
admission IDs before following execution, preserving existing exit status and work-item
output. ACP emits Request/admission IDs before its usual run updates and completion;
its long-lived `session/prompt` contract still streams until the turn ends. A new prompt
or explicit recovery command may reload the existing configured local token, but only
for the same principal/workspace. The resulting authority is captured for that intent
and retained through admission/execution; rotation does not revive an older admission
or silently change an in-flight actor. `/run` and a
selected direct workflow remain direct runs. ACP session labels never supply authority.

The old three-argument embedded `ProgramService` constructor remains a legacy
compatibility path until its composition root supplies admission dependencies. It gains
reserved-variable validation, but **does not promise durable admission recovery** and
rejects generation guards it cannot honor. Production bootstrap configures the
fourth constructor argument for CLI/ACP/daemon; a configured service without explicit
local authority refuses the legacy wrapper. This is an integration requirement, not an
alternate supported new submission contract.

Existing clients using `runs.start` keep its response shape. New clients discover the
additive methods through `hello.methods`; no admission method is advertised merely
because its schemas exist. The combined runtime uses protocol 1.10. Admission methods have no separate
capability class; discovery and current operation grants still govern access.

## Integrated wiring and historical handoff

[329-request-submission-integration.patch](patches/329-request-submission-integration.patch)
is retained as a historical handoff against preparation baseline
`7abc2342aa672ee9d2f10d565ca4f8eb546184df`. Its wiring is reconciled in this tree;
do not apply it to the integrated runtime. Bootstrap supplies the real generation
provider, separate `restoreLaunch`, durable admission store and explicit local authority.
Daemon registration uses persistent workspace identity and token-mode ownership.

`CapturedLaunch.requestAdmissionCorrelation: true` requires `startRun` to forward
`BoundLaunchOptions.requestAdmissionId` unchanged. The integrated orchestrator seals
that metadata after typed validation and before publishing `run.created`, including
for nonsensitive workflows. Missing provider support refuses submission before
admission side effects, and a returned root is verified before acceptance.

Final combined checks remain necessary; see the unresolved findings and reconciliation
checklist in [runtime-next integration](runtime-next-integration.md#review-status-and-final-reconciliation).

Dedicated tests cover admission/refusal, each durable write boundary, concurrent recovery,
file-store restart, protected Request projections, configuration capture and fail-closed
recovery, live authority, prompt daemon acknowledgment, configured ProgramService/ACP
parity and direct Request-free runs.
