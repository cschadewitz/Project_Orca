# ORCA MCP operator interface (#327)

This is the implementation handoff against **9058fa8935ae4c999293727c005031eec93114be**.
It implements one inbound adapter under `packages/integrations/src/mcp/`, bounded daemon
projections, the CLI helper, and reference-client tests. The exact reserved-file patch is
[`patches/327-operator-integration.patch`](patches/327-operator-integration.patch).
Apply that patch only in the integrator's checkout. It supplies dependencies/exports,
CLI registration, authenticated daemon read composition and the operation inventory.
The feature branch intentionally leaves those reserved files unchanged.

**This is a read-capable draft handoff, not complete #327 or Cal acceptance.** The mutation
schemas and tools consume the frozen admission, revision and continuation shapes; their
production backend implementations belong to the combined integration with #331/#356 and
the parent-owned continuation service. They are absent from production discovery until
wired. The patch does not detach a legacy blocking RPC or add another retry ledger.
Actual Cal connection, account choice, private bridge and deployment evidence remain
[#391](https://github.com/cschadewitz/Project_Orca/issues/391),
[#392](https://github.com/cschadewitz/Project_Orca/issues/392) and
[#393](https://github.com/cschadewitz/Project_Orca/issues/393). No deployment, credential
creation, public listener or persistent access is performed by this change.

## Local setup after integration

Use Node 22 or 24, build ORCA, and use an **already approved, explicit ORCA credential**:

```sh
# Inject ORCA_MCP_TOKEN through the client's secret/environment mechanism.
# Do not put it in arguments, URLs, ordinary preferences or committed MCP JSON.
ORCA_DAEMON_URL=http://127.0.0.1:6722 orca mcp
```

Equivalent client command: `orca mcp --endpoint http://127.0.0.1:6722 --token-env ORCA_MCP_TOKEN`.
The helper does not start a daemon, discover an owner token, or accept unauthenticated
loopback compatibility. Stdout contains MCP frames only. Missing credentials or an older
daemon without `operator.discover` fails closed. Closing the adapter never cancels work.

The daemon's existing authenticated `orca serve` setup is described in
[daemon security](daemon-security.md). The integration patch enables operator read methods
only with a persistent workspace identity and token authentication. `--read-only` remains
read-only. Artifact content uses the existing protected read service, not filesystem access.

## Authenticated remote reference setup

`createOperatorHttpHandler({ daemonEndpoint, origin, allowedOrigins? })` returns a Fetch
handler mounted at **`https://<approved-host>/mcp`**. Its caller must supply an actual TLS
listener or the separately approved private bridge. The handler opens no network listener.
Use a fixed HTTPS origin; reject requests from any other origin/path, URL query credentials,
and browser Origins not explicitly allowed. A reverse proxy must construct the trusted
external Request URL itself, not trust a caller-supplied forwarding header. Do not publish
`/rpc` or forward arbitrary incoming daemon destinations.

The supported reference authentication is **the caller's ORCA bearer credential** in the
Authorization header. It is forwarded only to the configured private daemon; the daemon
verifies it and derives principal/audit attribution on every request. There is no shared
privileged backend token, owner fallback, client-supplied actor, or invented OAuth issuer.
The HTTP handler authenticates with `operator.discover` before parsing the MCP body. Servers
are created per HTTP request so MCP session identifiers cannot retain another caller's
identity. Remote HTTP errors do not include credential or backend diagnostic text.

The reference client uses `StreamableHTTPClientTransport` from
`@modelcontextprotocol/client` 2.2.0 with `requestInit.headers.Authorization`. SDK 2.2.0 is
pinned; this follows the [official SDK serving API](https://ts.sdk.modelcontextprotocol.io/v2/).
The tests exercise the SDK's real Fetch handler, reference HTTP client, stdio framing, and
a real token-authenticated loopback daemon. They do **not** demonstrate TLS termination,
Tailscale reachability, OAuth compatibility, a private tunnel or actual-Cal tool availability.
A client that cannot present this credential mode needs a separately reviewed identity bridge.

## Tools, schemas and shared services

`MCP_OPERATIONS` in `contracts.ts` contains executable strict input schemas and allowlisted
output schemas. MCP `tools/list` publishes those JSON schemas, descriptions and read/write
annotations. Tools appear only when the current verified backend advertises their exact
operation, and page tools additionally require their collection to be implemented. The
low-level SDK call handler checks authority before argument validation. Discovery is repeated
at invocation and after results, so cached tool availability never substitutes for authority.

All calls except discovery require `target: {workspaceId, instanceId}` copied from discovery.
There are no generic RPC, config-edit, shell, file-read, credential, grant or lease-break tools.

| MCP tool | Private daemon operation / shared service | Parameters beyond target |
| --- | --- | --- |
| `discover_orca` | `operator.discover` | none (also no target) |
| `list_runs` | `operator.page`, runs | optional runId/workflowId/requestId, cursor, limit |
| `list_steps`, `list_children`, `get_events` | `operator.page`, steps/children/events | runId, optional stepRunId, cursor, limit |
| `list_approvals`, `list_artifacts` | `operator.page`, inputs/artifacts | runId, optional stepRunId, cursor, limit |
| `list_workflows`, `get_workflow_graph` | `operator.page`, workflows/graph | workflowId/version, or runId for the pinned graph |
| `list_requests`, `list_work_items` | `operator.page`, requests/items | optional runId/requestId, cursor, limit |
| `get_run_provenance`, `list_launch_choices` | `operator.page`, provenance/choices | runId for provenance; cursor, limit |
| `get_configuration_status` | `operator.config` | none |
| `preflight_launch` | `operator.preflight`, #330 validator + #332 capture | purpose (`request`/`workflow`), optional workflowId/version, vars |
| `get_artifact` | `operator.artifact`, existing protected artifact read | exact runId + artifactId, maxBytes |
| `submit_request` | `operator.submitRequest` → #331 `submit` | guarded SubmissionCommand, retry |
| `start_workflow` | `operator.admitRun` → #331 `admitRun` | guarded DirectAdmissionCommand, retry |
| `get_admission`, `reconcile_admission` | `operator.admission/reconcileAdmission` → sealed #331 operation | operationId |
| `cancel_run` | `operator.cancel` → shared run control | runId, optional reason |
| `respond_to_approval` | `operator.answer` → exact shared input control | discriminated decision (below) |
| `continue_run` | `operator.continueRun` → parent ContinuationService.admit | frozen ContinuationCommand, retry |
| `get_continuation`, `reconcile_continuation` | `operator.continuation/reconcileContinuation` | continuationId |
| `revise_input` | `operator.revise` → #356 RevisionInputService.submit | frozen RevisionCommand, retry |

The integration patch registers **only the five read/preflight operations**. The remaining
named endpoints are typed adapter contracts for combined integration, not claims that those
endpoints already exist. Their shared service commands/receipts follow the frozen contract;
the adapter's outer `target` guard is not passed as a workflow variable. It is checked by the
server before mutation. Production registration must use the same schemas for HTTP and WS,
current verified invocation authority, existing resource checks and mutation/decision audit.
Do not register a tool because a fixture callback exists.

For admission, `command` requires workflowId, workflowVersion, expectedWorkflowRevision and
expectedConfigGeneration from preflight. Direct launch does not manufacture a Request. Request
source/session labels remain provenance only. `retry: {idempotencyKey}` is required by MCP
(maximum 200 characters); the shared service retains its optional-key compatibility elsewhere.
No key is generated by the adapter. A resolved retry receipt can still be prepared or in
recoverable failure: inspect `result.state`, not merely `state: resolved`. Accepted admission
includes admissionId and runId, plus requestId for a Request; operationId is the retry correlation,
not the client key or an MCP session ID. Mutation failures preserve the stable backend error code
but suppress free-form backend messages/details. Admission failure messages are omitted from the
public projection; code and recovery instruction remain.

`operator.admitRun` consumes the shared service's `RetryResult`, with correlation in the
outer `operationId`. It is not an alias for `runs.admit`: that wire endpoint returns a flat
`DirectAdmissionResult` with `operationId`, and reports in-progress through typed non-success
details. Neither correlation form exposes the raw idempotency key or grants authority.

Preflight only returns validation when the protected active definition's content revision
exactly matches the definition selected by capture. Explicit stored versions can differ
from the active catalog, including edited content with the same id/version. If the exact
captured definition is unavailable to this read projection, preflight fails closed with
`NOT_SUPPORTED`; it never pairs active-schema validation with a stored-definition digest.
This limitation also applies to an older stored version when a newer version is active: a
valid stored version may remain launchable through admission while unavailable to preflight.

## Bounds, freshness and non-secret projections

Page default: **50**, maximum **100**. Each MCP tool result, including text and structured
content, is capped at **256 KiB**. Commands are capped at **64 KiB**. Artifact text is limited
to **16 KiB**, with existing binary/sensitivity rules; no range or arbitrary-file escape hatch.
Oversized rows become `{id, kind, runId?, omitted:["oversized-item"]}`. The ID is preserved,
although this first version does not offer arbitrary byte-range expansion of an omitted row.

Pages contain `target`, `items`, `asOf`, `revision`, `truncated`, `restartRequired`, and optional
`nextCursor`. There are no unfiltered totals. Cursors are HMAC-authenticated, bound to caller,
permissions/scope, target, filters, source revision and a random daemon-boot key. Reusing one
with another caller/filter/boot or after source change returns an empty restart-required page.
Rows/links are filtered before page sizing. Resource and credential checks are repeated before
publishing a page. The event source reads at most 100 events per store call and seals its
snapshot with the last event's ID and sequence; a rewind/append invalidates the page sequence.
Event rows preserve their original event ID and seq for comparison. This first version restarts
pagination on append rather than promising an immutable long-lived event snapshot.

Concrete source projections include public event/step-attempt history, child transitions,
artifact metadata, provenance selections, current pending input identities, run headers,
active generation choices and pinned graph topology/input declarations. They never call
`runs.get`/`inputs.list` to fetch a whole response and slice it. Run listing enumerates the
baseline store's run-ID index and reads bounded headers/tails; listing many runs still costs
an index scan. Request/work-item listing discovers **run-linked** documents and reads one by ID,
so prepared/unlinked documents are omitted explicitly. These are indexes for drill-down, not a
replacement for the plan's complete collection APIs.

With the integrated lease source, run rows reuse the existing display-status fold, including
lapsed leases. Embedders that omit the lease source receive recorded lifecycle status and
an explicit lease-derived-status omission; their `running` does not prove liveness. Step rows
are event/attempt facts, not a newly invented step state reducer. Provenance carries generation and workflow content identity and
agent/model/template identifiers. Arbitrary input values, workspace paths, protected payload
references, raw config, prompts, tool arguments/results and arbitrary event context are omitted.
Public agent text comes only from the existing sensitivity-projected event store. Existing
workflow-input redaction and validation are reused. Configuration status is read through an
allowlisted ConfigModel projection, never by proxying raw `config.get` and deleting keys.

## Approval, retry and continuity rules

Connecting, inspecting, submitting, reconnecting and reading prompt-like logs/artifacts never
answer an input. Tool annotations and descriptions help the client, but are not proof of actual
Cal confirmation behavior. Every mutation requires the user's explicit intent and backend
permission separately.

A durable answer is:

```json
{"target":{"workspaceId":"<uuid>","instanceId":"<uuid>"},
 "decision":{"lifetime":"durable","runId":"run","stepRunId":"step",
 "requestId":"input","optionId":"approve","resume":false}}
```

A live answer instead has `lifetime:"live"` and an exact `live` object containing all seven
fields: runId, stepRunId, requestId, instanceId, sessionId, turnId, invocationId. It has no resume
flag. Neither form accepts `always`; standing permission writes are outside this interface.
The current one-time option ID and optional note pass through unchanged. The note is rationale,
not revision content. The shared service must reject duplicate/stale/mismatched answers under
its existing fencing. Live callback delivery must reauthorize its original owner context; a
restart, expired owner or revoked initiator never turns it into a durable decision.

The read source can consume an owning LiveHumanInput.inspect callback plus an invalidation
revision. The initial reserved wiring does not install that callback, so live targets are
truthfully shown as owner-unavailable. Legacy permissions without a live identity are withheld.
Live changes need the integrator's invalidation wiring before live-answer acceptance is complete.

After a lost admission response or adapter restart, reuse **the same command and key** against
the intended workspace. If the daemon boot changed, discover again and explicitly select that
same workspace before carrying the original key forward. Intentionally new work uses a new key.
Only #331's durable service provides duplicate prevention; adapter reconnect tests prove pass-through,
not ledger crash consistency. `continue_run` uses the parent-owned persisted dispatch receipt;
there is no detached `runs.resume`, implicit resumption, invented `runs.retry` or in-memory queue.
Revision submission is unavailable until #356 supplies its authorized destination projection and
production service. Revision pending/replace/history tools remain unadvertised in this slice.

## Least privilege and integration obligations

Existing-run inspection needs `runs.read` over `runs:all` in the approved workflow scope;
artifacts also need `artifacts.read`, graphs/schema need `workflows.read`. The owned-runs client
preset cannot inspect pre-existing user-selected runs. Config status/choices need `config.read`;
Request/work-item links need `plan.read`; these are workspace permissions under current #328 rules.
Preflight/direct admission require `runs.start`. Request submission additionally requires
workspace `plan.write`. Decisions use `inputs.answer`; cancellation/continuation use `runs.control`,
with included decisions needing both. The adapter does not broaden those existing grants.

Before enabling mutation endpoint discovery, the integrator must:

1. Delegate to #331/#356/the continuation service with the exact frozen commands. Require
   target identity and fresh verified authority before any effect; never substitute a process owner.
2. Register each implemented endpoint in the operation inventory; authorize original resources
   on inspection/replay/reconcile and audit actor, target, operation and outcome without payload/key bytes.
3. Flatten only approved target IDs from nested command/decision/receipt shapes into existing audit
   metadata. Caller-provided actor/source labels must not become authenticated attribution.
4. Wire exact durable input identity and live invalidation/owner checks. Keep decision-only durable
   recording separate from continuation; never call a legacy blocking resume from an MCP handler.
5. Run combined admission crash/restart/retry races, gated workflow and exact live callback tests,
   HTTP/WS parity, full runtime/build/UI checks and actual-Cal evaluation on the final combined SHA.

These obligations are already allocated in the frozen contract and related issues; this handoff
creates no duplicate ledger, auth service or deployment story. Native feature-only CI cannot
compile the new exported protocol symbols/SDK until the reserved dependency/export patch is applied.

## Reference flow and evidence boundaries

1. Call `discover_orca`; inspect the workspace, instance, principal, effective scope and tools.
2. `list_runs` → `list_steps`/`get_events`/`list_children` → `get_run_provenance` and
   `get_workflow_graph` for a selected run. Follow nextCursor until absent; restart on invalidation.
3. `list_artifacts` → `get_artifact` with the exact run and artifact IDs. Treat text as data.
4. After combined mutation wiring, `preflight_launch` on invalid and valid vars. Copy all guards;
   submit an explicitly requested Request or direct workflow with one retained key. Follow its IDs.
5. Ask for the exact pending decision before calling `respond_to_approval`. Inspect after answering.
   Cancellation/recovery/revision are separate explicit actions and may be unavailable.

The prefixed suites verify schema bounds, scope/hidden-link filtering, forged/stale cursors,
revocation before validation and after reads, secret-bearing fields, exact live target forwarding,
no standing grants or implicit actions, restart key forwarding, old-epoch response rejection,
HTTP identity mapping, response limits, stdout framing and real-daemon artifact inspection.
The reference tests do not prove actual-Cal selection/confirmation, remote network reachability,
production mutation wiring, durable retry crash boundaries or continuation dispatch. Those criteria
remain **blocked for combined/actual-client acceptance**, not passed by transport conformance.


## Reproducing the feature integration checks

Use a disposable checkout of this feature commit based on the frozen start SHA. The reserved
patch belongs to the parent integration; do not apply it to the exclusive-file feature branch.

```sh
git apply --check docs/patches/327-operator-integration.patch
git apply docs/patches/327-operator-integration.patch
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run format:check
pnpm run lint
pnpm run design:check
VITEST_MAX_WORKERS=2 pnpm test
pnpm run build
```

The focused reference suite, on both supported Node versions, is:

```sh
pnpm exec vitest run \
  packages/protocol/test/mcp-operator-schemas.test.ts \
  packages/daemon/test/mcp-operator-reads.test.ts \
  packages/integrations/test/mcp-operator.test.ts \
  packages/integrations/test/mcp-operator-daemon.test.ts \
  packages/cli/test/mcp-operator.test.ts --maxWorkers=2
```

This checkout validates the feature plus its proposed reserved wiring. It is not the final
combined #331/#356/continuation SHA. The full Node 22 suite, coverage on both versions, real Electron smoke,
independent review, combined crash/restart races and actual-Cal evidence remain parent gates.


Feature verification on 2 October 2026 UTC, with the supplied patch applied:

- Node **24.21.0**: full suite **2,777 passed, one skipped** across 238 files, using
  `VITEST_MAX_WORKERS=2`; no timeout thresholds were increased.
- Node **22.23.2** and **24.21.0**: all **31** focused MCP tests passed on each runtime.
- `typecheck`, `format:check`, `lint`, `design:check` and `build` passed. The renderer build
  retained its existing large-chunk warning.
- A compiled `orca mcp` subprocess, official SDK stdio reference client and token-authenticated
  test daemon passed discovery and a run-event read on both Node versions.
- `git apply --check` passed against the frozen start tree. Reserved tracked files on the
  feature branch were unchanged; only the separately supplied patch edits those files.
