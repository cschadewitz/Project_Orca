# Parallel contract: Request admission, configuration generations, connections and live gates

This documentation-only preparation freezes boundaries for #329, #332, #318 and
#237. It does not implement or advertise any of them. Existing issue acceptance
criteria remain required.

Integration baseline: `66e247832bf8f5f7dfa49533d941ecfe0e18326a`, the merge of
#371. Its tree equals the independently reviewed, CI-green integration head
`a092cd0996f4396ebafbb76e6b61d8e093d234ae`. Post-merge/main and this preparation's
CI status must be reported separately; a branch check is not a main check.

All four agents start from the same full, reviewed preparation merge SHA supplied
after this PR is approved and merged. Do not start from moving main, the baseline
above without this preparation, or another feature branch. Creating this draft
does not authorize merging it or starting implementation.

Read AGENTS.md, CONTRIBUTING.md and docs/DEVELOPMENT.md. UI work also reads
docs/design/RULES.md. The earlier runtime-foundation-parallel-contract.md is
historical; do not reapply docs/patches/328-control-integration.patch.

## Existing guarantees

Preserve [the integrated foundation](runtime-foundation-integration.md) and
[protected storage](protected-execution-storage.md): protocol 1.9, authenticated
clients, typed preflight/version/digest admission, exact ownership/actor
attribution, protected-execution-v2 storage, and artifact-reference filtering.

Authentication/operation checks precede parameter validation; resource authority
precedes resource-specific diagnostics; launch validation precedes admission
side effects. Reuse OrcaError/ProtocolFault envelopes and ValidationResult.
No permissive principal, dummy production generation, duplicate gate engine or
second workflow-version store is acceptable.

Authoritative inputs, event payloads and workflow snapshots retain their existing
protected storage and safe public projections. No plaintext provenance snapshot,
replacement key lifecycle, silent legacy migration or deletion of resume data.
Authorization/revocation and permission-sidecar rereads remain live, not frozen
in a launch snapshot.

New method implementations may be tested through injected fixtures. They are
advertised only when implemented, authorized and wired in integration; this is
not a requirement for another follow-up issue.

## Shared structural seams

These are internal structural contracts, not new public exports in this
documentation-only PR. Independent implementations can declare matching local
interfaces and test injected callbacks without importing a peer branch. Cal
consolidates exports and wires the production provider at integration.

### Generation-bound launch capture (#332 implements; #329 consumes)

```ts
interface LaunchSelection {
  purpose: "workflow" | "request";
  workflowId?: string;
  workflowVersion?: string;
  expectedWorkflowRevision?: string;
  expectedConfigGeneration?: string;
}

type BoundLaunchOptions = Omit<
  StartRunOptions,
  "workflowId" | "workflowVersion" | "expectedWorkflowRevision" | "inline"
>;

interface CapturedLaunch {
  readonly generationId: string;
  readonly workflow: Readonly<{ id: string; version: string; revision: string }>;
  validateStartRun(options: BoundLaunchOptions): Promise<void>;
  startRun(options: BoundLaunchOptions): Promise<string>;
}

type CaptureLaunch = (selection: LaunchSelection) => Promise<CapturedLaunch>;
```

StartRunOptions is the existing engine type, not a wire request. Capture is
side-effect-free and selects one immutable active configuration plus the exact
workflow. An omitted workflow for purpose=request uses that generation's program
default; purpose=workflow requires an explicit target. Guards are checked during
capture, before writes. Both callbacks remain bound to the same generation and
workflow; caller options cannot substitute another definition or generation.
validateStartRun is side-effect-free; startRun rechecks authoritative admission
and uses the captured version/digest. An apply between capture and start does not
mix choices or silently substitute the new generation.

The captured object/functions and resolved sensitive values are server-internal,
never RPC data. #329 can test a faithful injected implementation while #332 builds
the real provider; production integration must not substitute a made-up generation.

### Submission identities and result (#329 owns; #331 later wraps)

```ts
type SubmissionResult =
  | { state: "prepared"; admissionId: string; requestId: string }
  | { state: "accepted"; admissionId: string; requestId: string; runId: string }
  | {
      state: "recoverable-failure";
      admissionId: string;
      requestId: string;
      runId?: string;
      failure: { code: OrcaErrorCode; message: string; recovery: "reconcile" };
    };

interface SubmissionAuthority {
  readonly workspaceId: string;
  readonly actor: MutationActor;
  authorize(command: SubmissionCommand): Promise<void>;
  onRunAdmitted(runId: string): Promise<void>;
}

interface SubmissionService {
  submit(command: SubmissionCommand, authority: SubmissionAuthority): Promise<SubmissionResult>;
  reconcile(admissionId: string, authority: SubmissionAuthority): Promise<SubmissionResult>;
}
```

SubmissionCommand is owned by #329: title/body, optional source/labels, workflow
selection/guards, vars and existing RunOverrides. The wire cannot set principal,
actor, admissionId, Request ID, programRunId or the service-injected Request var.
Reject unsupported associations rather than expanding the API implicitly.
Verified authority and CaptureLaunch are injected server-side.

prepared is a durable inspect/recovery state, not successful work acceptance.
accepted requires a durable run ID/link and durable ownership before execution
or the accepted response. After a persistence failure, return/inspect a safe
recoverable state rather than invisible orphan work. failure.code uses the
existing application/protocol error contract, never a raw exception or secret.

admissionId is a server-allocated recovery correlation, not a client retry key.
#329 owns one durable admission lifecycle and reconciliation of its partial writes.
#331 owns the future principal/workspace/operation-scoped idempotency-key index,
fingerprints, conflict/retention rules and replay authorization, referencing that
same admission lifecycle. No second deduplication ledger or exactly-once external
execution claim is introduced here. Admission/recovery tests do not imply
client-retry deduplication before #331 lands.

### Authenticated target identity (#318 owns)

hello gains an optional additive identity object when the implementation is wired:

```ts
interface DaemonIdentity {
  workspaceId: string; // persistent opaque UUID for one logical store
  instanceId: string;  // fresh opaque UUID once per daemon boot
}
```

Create/persist the workspace identity atomically in owner-controlled store
metadata, not per request, and never derive it from URL, PID or filesystem path.
One daemon boot reuses its instanceId across transports. Identity is not an
authorization credential and exposes no private path.

A complete backup restored as a replacement for the same logical workspace keeps
workspaceId and gets a fresh instanceId. An independently operated clone/fork gets
a new workspaceId before it is served; do not run two independently writable
copies claiming the same identity. The supported clone path changes identity
metadata without rewriting run IDs, protected payloads or keys. Missing or corrupt
identity for an already identified store is an explicit repair condition, not an
excuse to silently mint another ID. A first upgrade of a never-identified store
may initialize it once under the store lock.

Clients use a local connection epoch as well. An older daemon without identity is
a distinct connection scope: do not infer equivalence or reuse drafts/cursors
from URL/PID alone. A restored store can be behind a cursor; refresh safely rather
than assuming a persistent workspace ID proves identical history.

## #329: shared Request submission

Own the service and typed command/result above, exposed as requests.submit
alongside runs.start. Direct workflow launch remains legitimately Request-free.
Do not redesign Request/work-item/plan models or add MCP transport.

Build on ProgramService.submit: #371 already validates through validateStartRun
before Request persistence and pins/rechecks the selected version/digest. Reuse
this sequence. Protect the injected Request var from caller override. Source and
caller-session labels are provenance, never verified principal identity.

Authorize and validate first, then persist the admission/Request, admit the run,
persist exact ownership and linkage, and acknowledge accepted IDs without waiting
for workflow completion. Execution failures use the existing authorized reads and
events. Define restart recovery for Request-written/run-missing and
run-written/link-missing boundaries, retaining a durable admission correlation so
reconciliation finds the original root rather than spawning another.

CLI and ACP submission paths use the same service and preserve their documented
compatibility. Trusted in-process callers carry explicit local authority; there
is no default fabricated principal.

## #332: saved versus active configuration

A saved document revision is not an active generation. config.set continues to
save only; config.get/status and apply results make pending/restart-required state
visible. config.apply validates the expected saved revision and expected active
generation, then atomically activates an immutable candidate for future captures
or leaves the old generation untouched.

Publish a finite reloadability table; unclassified settings are restart-only.
Store/auth/network/security changes must not be silently hot-swapped. Saving a
file notification never implies active-state activation. Read-only mode exposes
no apply mutation.

Implement CaptureLaunch. Record redacted provenance explaining config generation,
workflow identity and resolved role/agent/model/template/host/input sources.
Reuse the protected workflow snapshots and execution records from #371, not a
parallel pin store or plaintext generation dump. Restore admitted execution
choices on restart; missing recorded generation/material fails closed instead of
using current settings. Existing runs keep captured execution choices, except
current authorization/revocation and live permission-sidecar evaluation.

External edit/manual refresh and same-version workflow collision handling must
agree with the existing immutable workflow rules. Apply cannot rewrite a pinned
workflow body.

## #318: authenticated daemon switching

Preserve ORCA_DAEMON_URL > saved endpoint > bundled daemon precedence, including
the existing development fallback. Show the source. Reuse current credential
selection/refresh, TLS/redirect and main-process token boundaries. Save only the
endpoint and approved nonsecret locators/preferences; never tokens in URLs,
renderer state/logs or ordinary preferences.

Probe the candidate through the existing authenticated hello path. Protocol,
identity and current authority must be acceptable before atomically switching.
Failure/cancel leaves both the working connection and saved choice intact.
Do not send an automatically discovered local-owner credential to another remote
target.

Bind drafts, selections, inflight results and subscription cursors to workspace
identity plus connection epoch. Ignore late old-epoch responses and detach old
subscriptions. Pending launch/config/editor drafts cannot be submitted to the new
workspace. A boot change requires reconnect authority/cursor revalidation, not
blind reuse. UI switching itself never cancels, approves or answers work.

Return-to-bundled clears the saved override but cannot override an explicit
environment choice silently. Test cancellation, failed/revoked authentication,
protocol mismatch, disconnected old daemon, restart, same-URL/new-workspace,
backup rewind, and pending edits.

## #237: durable gates and live permission callbacks

Current PausingHumanInput cancels permission callbacks; durable decisions and
questions park in the log. Preserve that distinction, event-log gate recovery and
concurrent-answer protections rather than describing an orphaned callback as
durable permission to replay.

Bind a live decision to exact run/step/input, owning daemon instance, agent
session/turn and invocation generation. Each retry gets a new approval identity.
Its owning interpreter settles the callback once while retaining/renewing its
execution lease. Do not reacquire an owner-held answer lease independently or
allow a second interpreter. Route verified cross-process intent to the owner or
report typed owner-unavailable/expired state; the session cannot move hosts.

Owner/agent death, lease loss, cancellation, timeout and revoked authority
invalidate live callbacks. Durable gates remain recoverable; old tool answers
never authorize a fresh invocation. UI disconnect only disconnects the client.
Session resumption requires capability checks and an honest fresh-session fallback.

Reuse #371's exact authority, accepted-answer ordering, actor audit and standing
write under the accepted-decision lease. Preserve the answerRecorded/parked
sidecar-failure boundary and #271's live rereads.

## Exclusive ownership

Existing paths below were checked against the integrated baseline. New paths are
explicitly new; they do not imply an existing implementation.

- #329: engine/src/program/service.ts and new adjacent submission modules;
  core/src/model/request.ts plus new request-submission types; new
  protocol/src/request-submission.ts and daemon/src/request-submission.ts;
  integrations/src/acp-facade/orca-acp-agent.ts; dedicated submission tests/docs.
- #332: daemon/src/config-model.ts; protocol/src/config.ts; new engine/core
  configuration-generation/provenance modules; dedicated generation tests/docs.
- #318: app/src/client/auth.ts, daemon-client.ts and subscription.ts;
  app/src/main/connection-state.ts, daemon-process.ts and workspace.ts;
  app/src/preferences/schema.ts and preferences-file.ts; new connection-target
  manager and renderer connection dialog/model; new store workspace-identity and
  daemon identity modules; dedicated connection tests/docs.
- #237: engine/src/human-input.ts; agents/src/acp-session.ts and permissions.ts;
  integrations/src/acp-facade/upstream-human-input.ts; new live-decision/session
  modules and dedicated tests/docs. Preserve existing permission-policy semantics.

Every path above is under packages/. Dedicated new test names must be
request-submission*, config-generation*, daemon-connection* or live-input* for
the owning story, not edits to another story's suite. Required existing-test
updates are named in the handoff for Cal rather than overlapping silently.

Cal reserves orchestrator.ts/run-context.ts; core run/event/error contracts and
existing protected stores; daemon methods/control/read-model/auth inventory,
server/socket/subscriptions; protocol control/handshake/version/errors and all
barrels; CLI bootstrap/main/existing command modules; app main/index.ts, preload,
shared IPC and renderer root/providers; manifests/lockfile/CI, design-system
changes and shared living docs. Feature agents supply exact separate patches for
these, including constructor dependencies and exports. #318's new identity
module is owned, while its shared hello registration is Cal's.

Each story owns the semantics of any needed new error code and supplies the
exact core/protocol enum and mapping patch; Cal owns applying those reserved
changes together. Reuse existing codes where correct. This documentation adds
no enum members, alternate error hierarchy or runtime promise. No casts that
pretend an unreserved code is already part of the shipped contract.

## Dependencies, handoff and acceptance

Dependency graph: verified #371 -> this reviewed preparation ->
{#329, #332, #318, #237} -> combined wiring. The four have no peer-branch compile
dependency. #331 consumes #329's admission lifecycle later; #329 does not depend
on #331. #318 remains in configuration-studio; the others retain their existing
runtime-foundation ship group and metadata.

Each agent returns full SHA, owned diff, focused/full check evidence, exact shared
integration patch, API/error/capability additions and limitations. No feature-only
CI result claims cross-story acceptance.

Combined tests cover Request versus direct-run semantics; side-effect-free denial;
crash recovery at every submission write; one generation under concurrent
apply/admission; protected pinned restart; target switching with drafts/inflight
responses; live versus durable duplicate/stale/cross-process decisions; lease
loss/revocation/restart; HTTP/WS parity and supported CLI/ACP/app clients.

Run repository gates and real app smoke at the final combined head. Report
unexecuted platform smoke as blocked, not passed; baseline uploads are not test
execution. Preparation merge and feature merge/publication authorization remain
separate from this document's implementation boundaries.
