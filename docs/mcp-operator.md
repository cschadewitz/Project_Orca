# ORCA MCP operator interface (#327)

**Current main, 4 October 2026:** commit `94a02bd3f5421991f4a8b7a5c6f352151dc5fbbb`
mounts the authenticated MCP reads and ten mutation/receipt aliases. `orca mcp` provides
stdio; `createOperatorHttpHandler` provides the authenticated Streamable HTTP reference
handler. The compiled production matrix runs with required mounts in CI on Node 24.
See the [current evidence map](archive/runtime-operator-integration.md#current-main-evidence-map)
and [production matrix](mcp-operator-production-acceptance.md). The earlier A/B/C
handoff and unapplied patch descriptions are historical design evidence, not
instructions for integrating current main. #327 remains open for the remaining
acceptance in [the issue](https://github.com/cschadewitz/Project_Orca/issues/327).

### Trusted projection mount

The read model accepts three internal `OperatorReadOptions` hooks; current daemon
composition supplies them together:

- `boundaryRow(params, row)` returns only the original authorized row plus allowlisted boundary
  fields. It closes over the authenticated invocation and existing production read services.
- `declaredRevisionActionId(params, row)` independently reads the exact pinned declaration.
  Never derive this from `boundaryRow` output or an unpinned active workflow. `undefined` means
  confirmed absence; unverifiable declaration evidence must refuse, rather than invent an action.
- `boundaryRevision(params)` supplies a stable opaque publication revision covering boundary
  identity/state, declaration, protected evidence and uncertainty. It must change on relevant
  publications even without a public event append, remain stable across per-call model instances,
  and detect rewind/replacement. This is an invalidation reader, not another journal.

An embedder mount lacking either trusted reader fails with `CONFIG_INVALID`. The model calls the hooks
only for authorized exact-run `runs`/`inputs` pages and validates `OperatorBoundaryProjectionSchema`
against the independently read action ID. Contradictions, changed identity/base fields, undeclared
actions and unexpected callback fields fail with `PROTOCOL_MESSAGE` without echoing their content.
A weak input viewer can receive the restriction-only action ID; stronger revision state/view
requires `runs.read`, `inputs.answer` and `runs.control`, plus current resource/workflow checks.
The composition preserves `unavailable` for uncertain protected evidence and propagates unexpected failures.
A bare empty observational array is not proof of `unsupported`.

Boundary revisions participate in signed page cursors. Emitted projections are reread before
publication; boundary/source changes return an empty `restartRequired` page, and current principal
checks run after awaited final checks. Enrichment is bounded before page sizing: the existing
12 KiB row summary, 100-row maximum, 64 KiB command and 256 KiB serialized MCP limits remain.
Plain source rows cannot independently publish a continuation guard. Pending replacement/history
and protected pending revision text remain unsupported by these tools.

The schemas can carry a 64 KiB revision payload, but the complete serialized MCP command still
has a 64 KiB transport ceiling, including its envelope and JSON escaping.

## Proposed host-resource read (#491)

The injected-source draft adds `get_daemon_resources` → `operator.hostResources` with
only the discovered `target` parameter. It returns #495's shared v1 host snapshot.
**The separate `host.telemetry.read` permission is a proposal requiring review.** No
preset includes it, and the normal CLI composition does not mount the operation or a
collector. Caller-visible workstream summaries additionally require `runs.read` and a
bounded authorized source; aggregate counts from a host snapshot are discarded.
See [the access-policy proposal](host-resource-access-policy.md) for the bounds, exact
fixture pin, ownership split and remaining production/actual-agent integration gaps.

## Local setup on current main

Use Node 24 or newer, build ORCA, and use an **already approved, explicit ORCA credential**:

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
[daemon security](daemon-security.md). Production composition enables operator read methods
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
`@modelcontextprotocol/client` 2.2.0 with `requestInit.headers.Authorization`. The server SDK
is pinned to 2.3.0; this follows the [official SDK serving API](https://ts.sdk.modelcontextprotocol.io/v2/).
The server and HTTP handler are constructed afresh for each request, as required by 2.3.0's
refusal of reconnecting an active server or reusing a stateless transport. Repeated requests
and concurrent clients retain their own bearer-bound backend; no shared session holds authority.
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
| `continue_run` | `operator.continueRun` → parent ContinuationService.admit | production ContinuationCommand, retry |
| `get_continuation`, `reconcile_continuation` | `operator.continuation/reconcileContinuation` | continuationId |
| `revise_input` | `operator.revise` → #356 RevisionInputService.submit | production RevisionCommand, retry |

Current `orca serve` registers the five read/preflight operations when their sources are
available and conditionally registers all ten mutation/receipt aliases when their production
services are installed. The compiled production matrix verifies all ten on the normal
authenticated daemon. Their shared service commands/receipts follow the production contract;
the adapter's outer `target` guard is not passed as a workflow variable. It is checked by the
server before mutation. Production registration uses the same schemas for HTTP and WS,
current verified invocation authority, existing resource checks and mutation/decision audit.
Tool presence still depends on an installed service, not a fixture callback.

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
Agent-update rows retain event/step identity and sequence metadata, but omit all free-form
agent text with an explicit `agent-text` omission. The existing sensitivity projection does
not prove prose is path-free, so these rows do not selectively pass supposedly safe text.
Existing workflow-input redaction and validation are reused. Configuration status is read through an
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

The production composition supplies the live coordinator's inspect callback and observation
revision. Owner loss or a different daemon reports owner-unavailable; it cannot resurrect a
callback. Legacy permissions without a live identity are withheld. The compiled A04/A05 cases
exercise current-owner delivery once and refusal after owner death/restart.

After a lost admission response or adapter restart, reuse **the same command and key** against
the intended workspace. If the daemon boot changed, discover again and explicitly select that
same workspace before carrying the original key forward. Intentionally new work uses a new key.
Only #331's durable service provides duplicate prevention; adapter reconnect tests prove pass-through,
not ledger crash consistency. `continue_run` uses the parent-owned persisted dispatch receipt;
there is no detached `runs.resume`, implicit resumption, invented `runs.retry` or in-memory queue.
`revise_input` uses #356's authorized destination projection and production service on current
main. MCP pending-text, replacement and history tools remain unadvertised. The underlying
daemon has its own protected pending/replacement methods; their existence does not add MCP tools.

## Least privilege and production invariants

Existing-run inspection needs `runs.read` over `runs:all` in the approved workflow scope;
artifacts also need `artifacts.read`, graphs/schema need `workflows.read`. The owned-runs client
preset cannot inspect pre-existing user-selected runs. Config status/choices need `config.read`;
Request/work-item links need `plan.read`; these are workspace permissions under current #328 rules.
Preflight/direct admission require `runs.start`. Request submission additionally requires
workspace `plan.write`. Decisions use `inputs.answer`; cancellation/continuation use `runs.control`,
with included decisions needing both. The adapter does not broaden those existing grants.

Production mutation discovery depends on these implemented boundaries:

1. Delegate to #331/#356/the continuation service with the shared commands. Require
   target identity and fresh verified authority before any effect; never substitute a process owner.
2. Register each implemented endpoint in the operation inventory; authorize original resources
   on inspection/replay/reconcile and audit actor, target, operation and outcome without payload/key bytes.
3. Flatten only approved target IDs from nested command/decision/receipt shapes into existing audit
   metadata. Caller-provided actor/source labels must not become authenticated attribution.
4. Wire exact durable input identity and live invalidation/owner checks. Keep decision-only durable
   recording separate from continuation; never call a legacy blocking resume from an MCP handler.
The compiled production matrix verifies the covered admission crash/restart/retry,
gated workflow, live callback and HTTP/WS cases. Actual-Cal evaluation is a
separate acceptance gate.

The MCP adapter owns no duplicate ledger, auth service or deployment story. The shared
schemas and pinned SDK dependencies are in current main.

## Reference flow and evidence boundaries

1. Call `discover_orca`; inspect the workspace, instance, principal, effective scope and tools.
2. `list_runs` → `list_steps`/`get_events`/`list_children` → `get_run_provenance` and
   `get_workflow_graph` for a selected run. Follow nextCursor until absent; restart on invalidation.
3. `list_artifacts` → `get_artifact` with the exact run and artifact IDs. Treat text as data.
4. Call `preflight_launch` on invalid and valid vars. Copy all guards;
   submit an explicitly requested Request or direct workflow with one retained key. Follow its IDs.
5. Ask for the exact pending decision before calling `respond_to_approval`. Inspect after answering.
   Cancellation/recovery/revision are separate explicit actions and may be unavailable.

The prefixed suites verify schema bounds, scope/hidden-link filtering, forged/stale cursors,
revocation before validation and after reads, secret-bearing fields, exact live target forwarding,
no standing grants or implicit actions, restart key forwarding, old-epoch response rejection,
HTTP identity mapping, response limits, stdout framing and real-daemon artifact inspection.
The adapter tests alone do not prove actual-Cal selection/confirmation, remote network
reachability, durable retry crash boundaries or continuation dispatch. The separate compiled
production matrix covers the latter service behaviors for its stated cases. Actual-client and
deployment acceptance remain open.


## Historical A-branch verification (3 October 2026)

Use Node 22 or 24 and the frozen lockfile. Keep the mount patch unapplied on A's branch.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm exec vitest run \
  packages/protocol/test/mcp-operator-mutation-contract.test.ts \
  packages/protocol/test/operator-preparation-contract.test.ts \
  packages/protocol/test/mcp-operator-schemas.test.ts \
  packages/daemon/test/mcp-operator-boundary-projection.test.ts \
  packages/daemon/test/mcp-operator-reads.test.ts \
  packages/integrations/test/mcp-operator-production-contract.test.ts \
  packages/integrations/test/mcp-operator-daemon.test.ts \
  packages/cli/test/mcp-operator.test.ts --maxWorkers=2
git apply --check docs/patches/327-operator-production-mount.patch
```

The existing `mcp-operator.test.ts` has one obsolete raw-command equality assertion: production
parsing adds `command.vars: {}`. Its reserved correction is in the patch; all other tests in
that file pass. A's new reconnect test checks the normalized command against the shared schema
and preserves the real replay flag. Do not relax the production schema to satisfy the old fixture.
These consumer/projection tests do not replace B/C service-backed acceptance or actual-Cal evidence.

Verification on 3 October 2026 UTC: the eight-suite command above passed **78 tests** on
Node **22.23.2** and **24.21.0**, including the authenticated loopback daemon test. After
bounding retained projection evidence to hashes, the 14 boundary tests passed again on
Node 24; Node 22's 78-test run already included that change. Repository `typecheck` (including
renderer), `lint` (including CSS), changed TypeScript formatting and `git diff --check` passed.
`git apply --check` passed for the production mount patch, which remains unapplied.
The additional existing MCP adapter suite passed 13 tests and failed the one normalization
expectation documented above. Full runtime/UI/build and production lifecycle acceptance were
not rerun as part of A's consumer/projection handoff.
