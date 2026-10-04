# Parallel contract: retry-safe admission, revision input and Cal MCP

**Engineering contract approved for preparation; implementation kickoff requires
its published preparation SHA. No agents are launched by this document.**

This contract allocates [#331](https://github.com/cschadewitz/Project_Orca/issues/331),
[#356](https://github.com/cschadewitz/Project_Orca/issues/356) and
[#327](https://github.com/cschadewitz/Project_Orca/issues/327). It specifies future
interfaces; their presence here does not claim implemented or advertised methods.
Issue acceptance criteria remain required. Credential creation, remote setup,
deployment, release publication and main merges require separate authority.

## Exact baseline and kickoff

- Final merged baseline: `7ce06c16dc49fcf81aa8f2783ca48edb2de458ad`
- Verified Git tree: `cc3107c74fbfec957462730b0e28ece119f0f3a0`
- Runtime source parent: `74a068ec943f3877dca47e82e8eb2877ebabad08`
- Main/documentation parent: `d68a35da9eb99799c0ea6553255ccafb7919d0fe`
- Preparation/start SHA: the full immutable commit that publishes this contract,
  supplied in the coordinator's kickoff and issue handoffs. Never infer it from
  moving `main` or use the merged baseline as a substitute.

PR #397 is merged with preserved history. The coordinator verified CI #351 and
App smoke #74, final independent clearance and the owner's performance acceptance
(tracked in #408). The merged tree is identical to the CI-tested synthetic merge
tree. The post-push CI run is a separate observation, not an unrecorded substitute
for this evidence. Documentation #405/#406 is retained; pending #407 is not in this
base and is not imported into these branches.

All three branches start at the same full preparation SHA. No peer-branch imports.
The preparation commit cannot contain its own hash; the external kickoff records
it after publication. Later shared-seam changes require coordinator review and a
single updated contract before downstream branches adopt them.

Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/DEVELOPMENT.md`,
`docs/runtime-next-integration.md`, `docs/runtime-next-parallel-contract.md` and
relevant security/storage docs. UI work also reads `docs/design/RULES.md`.
Older `docs/patches/` files describe historical handoffs; do not reapply them.

## Verified baseline seams and limits

| Existing seam | Location / implementation fact |
| --- | --- |
| Request command/result/authority | `packages/core/src/model/request.ts`: `SubmissionCommand`, `SubmissionResult`, `SubmissionAuthority`, `SubmissionService` |
| Durable Request admission | `packages/engine/src/program/request-submission.ts`, `program/submission-store.ts`: one Request lifecycle and file admission journal |
| Request RPC | `packages/daemon/src/request-submission.ts`, `packages/protocol/src/request-submission.ts`: submit/reconcile/inspect/list; execution is scheduled after receipt |
| Exact generation capture | `packages/engine/src/configuration-generation.ts`: `CaptureLaunch`, `CapturedLaunch`, `RestoreLaunch`; historical restoration is distinct from fresh capture |
| Legacy control | `packages/daemon/src/control.ts`, `packages/protocol/src/control.ts`: start/resume and durable answer-with-resume settle after execution parks/finishes |
| Target identity | `packages/daemon/src/daemon-identity.ts`, `packages/store/src/workspace-identity.ts`, `packages/protocol/src/handshake.ts` |
| Current authority | `packages/daemon/src/auth/{principal,operations,guard,resources,ownership}.ts`; captured generation is not captured permission |
| Preflight | `packages/daemon/src/workflow-inputs.ts`, `packages/protocol/src/workflow-inputs.ts`, `packages/core/src/workflow/inputs.ts` |
| Provenance | `packages/core/src/model/run-provenance.ts`, `packages/engine/src/configuration-provenance.ts`; authorized safe run provenance exists |
| Durable/live input | `packages/engine/src/{human-input,live-input}.ts`, `packages/daemon/src/live-input-authority.ts`, `packages/protocol/src/{inputs,live-input}.ts` |
| Adapters | `packages/integrations/src/acp-facade/orca-acp-agent.ts`, CLI bootstrap/main/local authority, `packages/app/src/bridge.ts` |

- Existing admission IDs are recovery correlations, not client idempotency keys.
  No client-key ledger, `runs.admit`, revision service or inbound MCP ships here.
- Request admission needs `runs.start` and workspace `plan.write`; the owned-runs
  `client` preset cannot inspect arbitrary pre-existing runs or bypass plan scope.
- Current preflight returns workflow version/revision and validation, not a
  configuration generation. `config.get` is a raw editor API, not a safe operator
  view. #327 must add the specified allowlisted consistent projections.
- `runs.get` includes whole collections; `inputs.list` and admission lists are
  unpaged. Artifact bodies have bounded omission behavior, not arbitrary ranges.
  New operator paging must bound reads at the service, not trim a fetched dump.
- Protocol 1.10, `config-generations-v3` and protected-execution-v2 are baseline
  facts. Epoch equality alone does not prove rollback compatibility: retain the
  current complete-store-backup/matching-binary warning. Integrator owns additive
  protocol/store compatibility changes; this contract assigns no release version.

## Non-negotiable shared invariants

- Authenticate and check operation grants before parameter diagnostics; check
  resource authority before resource-specific errors. Recheck current grants
  and revocation on replay, recovery, reads, delivery and execution attachment.
- Caller actor/session/source labels are provenance only. Server-verified
  principal, workspace and credential attribution come from trusted context.
  Never fall back from a denied caller to an adapter's owner credential.
- Validate before admission side effects. Capture exact workflow version/digest
  and one immutable configuration generation. Restoring an admitted operation
  uses its protected historical material, never a newly active default.
- Keep authorization, execution leases and permission-sidecar evaluation live.
  Admission deduplication is not an execution lease or an external-side-effect
  exactly-once guarantee. Preserve child lineage and exact durable ownership.
- Reuse protected execution records and keys. Payloads, sensitive defaults and
  fingerprints must not become plaintext indexes, logs, diagnostics or public
  provenance. No second workflow store, key lifecycle or legacy migration.
- Use existing `OrcaError`/`ProtocolFault` envelopes and `ValidationResult`.
  New codes require the owning story's exact reserved integration patch; do not
  cast an invented string into a shipped enum or add a competing error system.
- Advertise methods only when implemented, authorized and production-wired.
  A fixture callback or optional TypeScript field is not a shipped capability.

## Shared seam A: durable retries and prompt run admission

### Coordinated review clarification

The new wire `RunsAdmitResult` is `DirectAdmissionResult & { operationId: string }`.
Prepared, accepted and recoverable-failure receipts carry that stable authorized
reference; in-progress remains a typed `RUN_STATE` failure with operation ID and
recovery metadata. No raw client key is exposed and legacy `runs.start` stays unchanged.

Optional `runs.admit.expectedScope` contains `{ principalId, workspaceId }`, checked
against current authenticated authority before effects and stripped before intent
comparison. It is not authority. Neither credentials nor transient instance IDs
participate in this fence or durable intent scope. The app consumes the existing
`operator.discover` authenticated projection; no second discovery RPC is introduced.

#331 additionally owns `packages/app/src/main/admission-intents.ts` and
`packages/app/test/admission-retry*.test.ts`. Existing app wiring remains integrator
owned through the reserved patch. The journal uses main-process OS-backed encryption,
refuses unavailable or plaintext backends and requires an explicit confirmed
abandon/new-intent action; renderer and process loss retain the original key.


### Ownership and compatibility

**#331 owns the common durable retry mechanism and a deliberate nonblocking
direct-run admission service. #327 consumes it; it does not implement it.**

Keep existing Request admission as the one Request lifecycle. Extend its internal
reservation/reconciliation boundary so a durable retry claim is linked before a
Request/root can be created. A wrapper that calls today's `submit`, then records
its returned ID, leaves a crash window and is insufficient.

For direct launch, split durable admission from execution. The baseline's
`CapturedLaunch.startRun` already creates a run without driving it; build on that
seam and add protected direct-admission correlation, durable ownership, crash
reconciliation and dispatch. Do not fabricate a Request for a direct run.

Approved v1 wire choice: add `runs.admit` for prompt admission and
optional `idempotencyKey` to `requests.submit` and direct admission. Preserve
legacy `runs.start`'s settled-result shape by routing it through the same admission
service and then waiting separately. If `runs.start` accepts a key, it shares
the **logical run-admission operation scope** with `runs.admit`; changing
transport must not make the same logical retry create a second run. The additive
method and result/inspect/reconcile contracts below are frozen; #327 consumes them.

### Frozen internal structural contract

The following names are frozen new interfaces, not existing baseline exports.
They are the common fixture contract. The integrator
consolidates exports. Engine/core code must not import daemon or protocol code.

```ts
interface RetryOptions {
  idempotencyKey?: string;
}

interface DirectAdmissionCommand {
  workflowId: string;
  vars?: Record<string, unknown>;
  workflowVersion?: string;
  expectedWorkflowRevision?: string;
  expectedConfigGeneration?: string;
  requestId?: string;
  workItemId?: string;
}

type DirectAdmissionResult =
  | { state: "prepared"; admissionId: string }
  | { state: "accepted"; admissionId: string; runId: string }
  | {
      state: "recoverable-failure";
      admissionId: string;
      runId?: string;
      failure: { code: OrcaErrorCode; message: string; recovery: "reconcile" };
    };

type RetryResult<T> =
  | { state: "resolved"; operationId: string; replayed: boolean; result: T }
  | {
      state: "in-progress";
      operationId: string;
      recovery: "inspect-or-retry";
    };

interface DirectAdmissionAuthority {
  readonly workspaceId: string;
  readonly actor: MutationActor;
  authorize(command: DirectAdmissionCommand): Promise<void>;
  onRunAdmitted(runId: string): Promise<void>;
}

interface RetrySafeAdmissions {
  submit(
    command: SubmissionCommand,
    retry: RetryOptions,
    authority: SubmissionAuthority,
  ): Promise<RetryResult<SubmissionResult>>;
  admitRun(
    command: DirectAdmissionCommand,
    retry: RetryOptions,
    authority: DirectAdmissionAuthority,
  ): Promise<RetryResult<DirectAdmissionResult>>;
}
```

`SubmissionCommand`, `SubmissionResult`, `SubmissionAuthority`, `MutationActor`
and `OrcaErrorCode` above are existing core types. Direct command fields match
today's launch intent, not engine-only options. No inline workflow, actor,
principal, admission ID, run ID or arbitrary execution callback is wire input.
Existing authorized Request/work-item associations remain validated.

`operationId` identifies the durable retry claim; `admissionId` identifies the
underlying admission. Neither is the client key. A resolved result may still
contain `prepared`/`recoverable-failure`; it is not successful work acceptance.
Conflict, unavailable authority and malformed input use typed errors,
not a successful result with a hidden error string. Production inspect/reconcile
methods follow section A below, including authority requirements.

### Retry and persistence rules

1. Scope a key to verified principal ID, persistent workspace ID and logical
   operation. Do not scope to a transient credential ID, daemon boot, MCP session
   or socket; rotation/reconnect must not allocate different work. Current
   credential validity remains mandatory. Different logical operations cannot
   replay each other's result.
2. Normalize the validated caller command deterministically. Specify defaults,
   absent versus empty fields, ordering of maps/arrays and guarded selection.
   Do not accidentally fingerprint secrets into a public hash. Preserve an
   internal comparison representation using the existing protected boundary.
   Key bytes are untrusted, bounded input, not filesystem path components.
3. Equivalent retry finds the original claim **before recapturing moving
   defaults**. Reauthorize its original resources. A changed active generation
   cannot turn the same timed-out request into different work. Changed command
   bytes/guards under one key produce an explicit conflict with no new work.
4. Atomically claim across processes using existing locking foundations. Under
   the claim, preallocate and durably bind the underlying admission correlation
   before effects. Lock acquisition, claim durability, protected payload write,
   Request/run creation, ownership, root link, accepted write and response loss
   each need a crash/restart test. A multi-file store is not an assumed transaction.
5. Another caller seeing an in-progress claim gets the same safe claim identity
   or a bounded typed recoverable state. It must not wait for workflow completion,
   start another root, steal an execution lease or return another principal's IDs.
6. `accepted` requires the original run/correlation and exact ownership to be
   durable before execution or acknowledgement. Queueing a memory callback is
   not durable admission. After process death, inspect/reconcile must find the
   original run and disclose whether execution has not yet attached.
7. Replay/reconcile never blindly re-drives a completed, cancelled or actively
   leased run. Dispatch checks current authority and state. Explicit supported
   recovery operates on the original run; a new intentional launch has a new key.
8. A missing key preserves documented non-deduplicated compatibility. It must
   not be generated anew by the adapter on each retry. CLI/ACP/app/MCP retain one
   key per user submission intent, including response loss, and create a new key
   only for explicit new work. Request and direct-run identity stay distinct.
9. Approved v1 retains retry claims for the workspace lifetime, with no automatic
   key recycling. Document storage impact and enforce bounded command/key sizes,
   work per operation and an explicit quota/refusal policy before production. Never
   discard an ambiguous in-progress claim or an only recovery reference. Later
   retention/compaction and refusal tombstones belong to [#399](https://github.com/cschadewitz/Project_Orca/issues/399),
   which does not block this conservative first policy.

#331 supplies one reusable, server-internal retry-claim facility for #356's
`inputs.revise` operation. It stores an authorized result reference, not revision
delivery semantics. The operation set is closed by trusted registration; clients
cannot choose arbitrary operation names or callbacks. #356 can use a faithful
fixture of this facility but cannot ship against an in-memory replacement.

## Shared seam B: explicit revision at a durable waiting boundary

**#356 depends on #331 for production retry safety.** Its UI, schemas and delivery
fixtures may be developed in parallel after the interface is frozen. This is
not independent production readiness or a reverse dependency from #331 to #356.

`inputs.answer.note` remains rationale only. Submitting an ordinary note never
changes prompt text, workflow values, branch choice or permission policy. Revision
is a separate explicit action with its own schema, preview and audit record.

Frozen internal/wire vocabulary, owned by #356:

```ts
interface RevisionTarget {
  runId: string;
  stepRunId: string;
  requestId: string;
  destinationId: string;
  expectedRevision: string;
}

type RevisionPayload =
  | { kind: "text"; text: string }
  | { kind: "values"; values: Record<string, unknown> };

interface RevisionCommand {
  target: RevisionTarget;
  payload: RevisionPayload;
  actionId: string;
  supersedesRevisionId?: string;
}

interface RevisionReceipt {
  revisionId: string;
  target: RevisionTarget;
  state: "pending" | "delivered" | "rejected" | "superseded";
  attemptId: string;
  currentRevisionId: string;
  expectedRevision: string;
}
```

These are frozen new shapes, absent from the baseline. A revision-capable waiting-boundary projection
must issue `destinationId` and `expectedRevision`; clients cannot invent a node,
path, next agent, generation token or destination. The projection includes the
allowed payload schema, workflow-declared revision branch action and safe
destination description. The action ID is server-projected, not an arbitrary
option or node supplied by the client.
The token binds the exact recorded boundary, workflow/generation and current
revision state; the server validates its current meaning under the run's fencing.
It is not a bearer grant. Exact token encoding is private.

Approved v1 semantics (2 October 2026 UTC), to enforce with fixtures before adapter forms:

- Only explicitly revision-enabled **durable** pauses qualify. Live tool
  permissions and arbitrary mid-turn text injection are refused. Legacy pauses
  lacking a destination contract expose revision as unsupported.
- The permitted destination is the designated next step or an explicitly created
  new attempt, never whichever step happens to run next. Branching and child-run
  boundaries must be unambiguous; otherwise refuse rather than guess.
- Keep one active undelivered correction per destination/attempt. A replacement
  explicitly names the eligible pending revision and uses compare-and-swap against
  `expectedRevision`; show its pending text before replacement. Retain all versions
  and supersession history. Delivery wins the race by making replacement stale;
  neither a delivered prompt nor a completed artifact can be rewritten. Payload
  limits and application semantics are declared by the workflow. General append,
  draft composition and history reuse belong to [#398](https://github.com/cschadewitz/Project_Orca/issues/398).
- Validate current actor/resource authority, expected revision and schema before
  committing. Record author, payload provenance, target, supersession and delivery
  status durably; original payload stays in protected execution storage. Public
  views use allowlisted metadata and the existing sensitivity rules.
- One explicit **Request changes** action previews the destination, records the
  revision and takes its workflow-declared revision branch as an atomic logical
  operation. Partial failure cannot advance the gate without its recorded revision
  or claim delivery without the corresponding gate decision. Any subsequent
  execution attachment uses its own authorized continuation boundary; revision text
  never supplies tool approval, revived callbacks or additional execution grants.
  Preserve ordinary answer/note behavior; no silent new attempt or in-flight rewrite.
- Consumption is fenced to the recorded destination/attempt. Persist binding and
  prompt-input assembly so retries/resume do not append it twice or deliver it to
  another step. A crash around an external agent turn is not proof of exactly-once
  external execution; disclose ambiguous delivery instead of replaying blindly.
- Repeated submission with the same #331 key returns the original receipt.
  Changed content under that key conflicts. Cancellation rejects still-pending
  delivery deterministically; target movement, stale revision, wrong run/principal
  and restart cannot silently retarget it. State changes remain inspectable.
- The app previews the destination and explicit action, shows all four receipt
  states, keeps unsent text on recoverable failure and invalidates stale-target
  submission. Target switching never submits a draft. Unsupported CLI/ACP/MCP
  paths return a clear unsupported result instead of implying delivery.

Do not introduce a ninth run status: revision delivery states belong to revision
records, not `RunStatus`. Reuse app primitives, tokens, focus, announcements and
connection-scoped state. Engine/gate/prompt changes are reserved integration
patches, not a second gate engine hidden inside an adapter.

## Shared seam C: authenticated Cal-first MCP backend

#327 owns one thin inbound adapter and allowlisted operator read projections.
Place the new implementation under `packages/integrations/src/mcp/`; keep daemon
authentication and runtime services behind an injected typed backend. Dependency
additions, the CLI entry point and exports belong to the integrator. This location
does not imply MCP SDK or protocol dependencies already exist in the manifest.

The backend must be an authenticated path to the shared services, not an
unrestricted in-process orchestrator/store handle. It derives actor from verified
credentials and rechecks the original caller's current grants. Local stdio is a
transport, not authority. Remote encrypted transport or a private tunnel likewise
does not authorize ORCA operations by itself.

### Operator tools and gaps to wire

Use an explicit typed tool inventory, not a generic arbitrary-RPC proxy:

- Target discovery: safe workspace/instance identity, server/protocol versions,
  effective implemented operations and non-secret grant/scope summary. Omit raw
  `hello.storeDir`, PID and private endpoint/config paths from convenience views.
- Bounded run/Request/work-item links, parent/child hierarchy, pinned workflow
  graph, step attempts, events/safe output, errors, pending inputs and artifacts.
  Preserve source IDs for drill-down and cross-run comparison. Authority filters
  precede counts, links, provenance and continuation tokens.
- Saved-versus-active configuration status and existing run provenance, using
  an allowlisted daemon projection. No raw `config.get`, secret-bearing config
  dump, generic redaction proxy or new credential exposure. Preflight and launch
  bind a consistent workflow version/digest and configuration generation.
- Separate Request submission and direct Request-free admission through seam A.
  IDs return after durable acceptance and before a held test workflow completes.
  Caller reconnect/adapter restart must not determine execution lifetime.
- Exact authorized cancellation, supported recovery and input answering. No
  invented `runs.retry`, arbitrary shell, raw file access, grant/credential admin,
  lease-breaking convenience, config mutation or general maintenance tools.
- Revision tools only after seam B is wired and advertised. An earlier usable
  read/admission MCP preview does not imply #356 is complete.

The long-call problem applies beyond initial launch. For durable gates, existing
`inputs.answer` can record with `resume: false`; live callback answers require
their current owner and do not support that flag. Existing `runs.resume` waits.
Before advertising prompt asynchronous recovery or answer-and-continue, the
integrator must supply a reviewed shared continuation/dispatch receipt and exact
authorization/state semantics. #327 must not detach an RPC promise, hold a tool
call open indefinitely, imply an unpersisted queue is durable, or silently change
legacy control result contracts. Until that gap is implemented, expose only
truthfully supported operations and mark full recovery acceptance blocked.

### Bounded reads and epochs

Every large read needs finite item and byte limits, stable resource IDs,
continuation information, `asOf`/freshness and honest omission/truncation markers.
Reuse event sequence cursors where applicable. Offset-based lists need an explicit
concurrent-insert/rewind policy; wrapping an offset in an opaque string does not
make it snapshot-stable. No cursor leaks hidden counts, paths or resource IDs.

Add the missing bounded shared projections for whole run/graph collections,
pending decisions and safe configuration state through the reserved dispatcher.
Do not first request an unbounded body merely to cut it down after transport.
Respect artifact text/binary/size omission; do not bypass it through filesystem
reads. Any new content paging must be authorized by artifact identity and content
revision rather than arbitrary paths, with limits frozen in the tool schema.

Bind adapter sessions, drafts, caches, selections and cursors to authenticated
workspace identity plus a local connection epoch. Ignore late old-epoch responses.
A changed workspace invalidates target-bound intentions. A daemon instance change
requires fresh authority and live-input reads; a restored store may be behind its
old cursor even with the same workspace ID. Older identity-less targets do not
inherit an identity from URL/PID or satisfy guarded mutation discovery.

### Durable gates versus live callbacks

Preserve the exact existing live target:
`{ runId, stepRunId, requestId, instanceId, sessionId, turnId, invocationId }`.
No omitted field may be reconstructed from the latest pending input. The owning
interpreter retains its execution lease and settles once. Owner/session death,
lease loss, cancellation, timeout or revoked initiating authority expire the
callback. Another daemon reports owner-unavailable/expired; cross-process live
forwarding is not currently implemented. Never transfer or resurrect a callback.

Durable gates remain recoverable under current authority. Reconnect, inspection,
submission and revision text imply no decision. One-time answers and standing
permission writes are separate intents; initial MCP tools omit standing-grant
administration. Preserve `input.invalidated` as an ephemeral exact-target signal
without a durable event sequence, followed by authorized snapshot reconciliation.
Untrusted logs/artifacts are data, never instructions to launch or approve work.

### Least privilege and actual Cal connection

Tool availability, backend permission and the user's authorization for a specific
action are separate. Existing-run inspection requires an explicitly approved
scope capable of reading those runs; the current owned-runs `client` preset does
not suffice. Request submission's workspace `plan.write` requirement is a real
scope tradeoff. Either use a separately approved minimal supported grant set,
or explicitly design/review a new scoped service; never silently substitute owner.

[#391](https://github.com/cschadewitz/Project_Orca/issues/391) owns the actual
account/workspace/client feasibility and identity-chain decision.
[#392](https://github.com/cschadewitz/Project_Orca/issues/392) owns the approved
supervised outbound private bridge.
[#393](https://github.com/cschadewitz/Project_Orca/issues/393) owns deployment
evidence from Cal's actual conversation and feeds #327's acceptance. No second
MCP implementation belongs in those stories. A positive #391 decision is required
for bridge deployment acceptance; documentation or a reference-client test alone
cannot establish it. A blocked private route does not authorize public ingress.

These stories may prepare fixtures alongside the adapter. They are not reverse
hard dependencies requiring #327's issue closure before acceptance can run.
Credential creation/configuration, persistent access, workspace association,
service deployment and network/security changes need separate approval. This
draft performs none of them and claims no working Cal connection.

## Exclusive ownership and reserved integration files

All new names below were checked absent at the exact merged baseline. Directory
ownership covers only the listed new directory; it does not grant package-wide
ownership. Tests use the named prefix so two feature branches do not edit one
another's fixtures. A new filename outside this list needs an ownership update.

### #331

Existing exclusive edits:

- `packages/engine/src/program/request-submission.ts`
- `packages/engine/src/program/submission-store.ts`
- `packages/daemon/src/request-submission.ts`

New files/directories:

- `packages/core/src/model/admission-retry.ts`
- `packages/engine/src/admission-retry.ts`
- `packages/engine/src/direct-admission.ts`
- `packages/store/src/admission-retry-store.ts`
- `packages/protocol/src/admission-retry.ts`
- `packages/daemon/src/admission-retry.ts`
- `packages/cli/src/commands/admission-retry.ts`
- `packages/{core,store,engine,daemon,protocol,cli,integrations}/test/admission-retry*.test.ts`
- `packages/app/renderer/test/admission-retry*.test.tsx`
- `docs/admission-retry.md`
- `changelog.d/331-admission-retry.added.md`

### #356

New files/directories only; existing workflow/gate/prompt wiring is reserved:

- `packages/core/src/model/revision-input.ts`
- `packages/engine/src/revision-input.ts`
- `packages/engine/src/revision-delivery.ts`
- `packages/protocol/src/revision-input.ts`
- `packages/daemon/src/revision-input.ts`
- `packages/cli/src/commands/revision-input.ts`
- `packages/app/renderer/src/attention/revision-input-card.tsx`
- `packages/app/renderer/src/attention/revision-input-model.ts`
- `packages/{core,engine,daemon,protocol,cli,integrations}/test/revision-input*.test.ts`
- `packages/app/renderer/test/revision-input*.test.tsx`
- `docs/revision-input.md`
- `changelog.d/356-revision-input.added.md`

### #327

New files/directories only:

- `packages/integrations/src/mcp/` for adapter, typed backend, tools and transport
- `packages/integrations/test/mcp-operator*.test.ts`
- `packages/protocol/src/operator-reads.ts`
- `packages/daemon/src/operator-read-model.ts`
- `packages/daemon/test/mcp-operator*.test.ts`
- `packages/protocol/test/mcp-operator*.test.ts`
- `packages/cli/src/commands/mcp.ts`
- `packages/cli/test/mcp-operator*.test.ts`
- `docs/mcp-operator.md`
- `changelog.d/327-mcp-operator.added.md`

### Integrator only

- Engine `orchestrator.ts`, `run-context.ts`, `human-input.ts`, `live-input.ts`,
  `configuration-generation.ts`, `program/service.ts`, existing executor and
  prompt/template assembly modules
- Core existing workflow/run/Request/input/event/error contracts and schemas;
  existing protected execution/event/workflow/document/lease/claim stores
- Daemon `methods.ts`, `control.ts`, `read-model.ts`, `config-model.ts`,
  `execution-runtime.ts`, all existing `auth/`, `server.ts`, `socket.ts`,
  subscriptions/notifications and identity composition
- Existing protocol control, Request submission, inputs, runs, configuration,
  handshake, version, errors and notification schemas
- Existing CLI bootstrap/main/command modules and local authority; existing ACP
  facade and upstream input modules
- Existing app bridge/client/main/preload/IPC, connection providers and Attention
  cards/hooks; design tokens/primitives and generated assets
- All package barrels/exports, manifests, lockfile, TS/Vitest configuration,
  release compatibility, CI and existing shared tests/living documentation

Each feature supplies a separate, exact reserved-file patch against the pinned
start SHA, listing constructor dependencies, schemas, auth inventory changes,
errors, capability discovery, exports and legacy fixture updates. Do not apply
that patch to the feature branch or smuggle reserved edits into new helper files.
The integrator combines shared patches once and owns conflicts. Dedicated new
handoffs are `docs/patches/331-operator-integration.patch`,
`docs/patches/356-operator-integration.patch` and
`docs/patches/327-operator-integration.patch`, each written only by its owner.

The integrator also owns the continuation files explicitly listed in section C,
including their store adapter and tests. Feature workers must not edit them.

## Dependency order and honest preview boundaries

1. Validated/reviewed current runtime-next integration -> authorized merge ->
   exact merge SHA pinned -> reviewed preparation/start SHA pinned
2. #331 runtime/ledger and #327 transport/read/tool fixtures can develop in
   parallel; #356 boundary/UI/delivery fixtures can develop against the frozen
   #331 interface. No peer-branch compile import is permitted.
3. Production #331 -> production retry-safe #327 admission and #356 revision
   retries. #356's production acceptance remains dependent on #331.
4. Integrated authorized MCP implementation + approved #391/#392 route -> #393
   actual-Cal operator evidence, which can satisfy #327's existing acceptance
5. Usable MCP preview -> separately frozen
   [#394](https://github.com/cschadewitz/Project_Orca/issues/394) plugin restoration
   contract/runtime -> [#395](https://github.com/cschadewitz/Project_Orca/issues/395)
   JEV opt-in -> [#396](https://github.com/cschadewitz/Project_Orca/issues/396)
   fresh-process/actual-Cal restoration verification before release readiness

The existing #329/#330/#332/#237/#328 foundations remain prerequisites where their
issues specify them. #356 is not a hard blocker for a truthful limited MCP
preview. #394–#396 are **not the immediate parallel implementation batch** and
do not block the first harmless MCP reads. Outbound MCP/skills, generic recovery
UX, new storage backends and public plugin distribution are outside this batch.

Current custom-plugin limitations remain visible: behavior-bearing custom
executors, signal extractors, custom workspace providers and changed host/nested
callbacks can bind an entire generation to its original bootstrap. The shipped
JEV example is affected. Cross-bootstrap restoration fails before provisioning;
same-bootstrap operation, supported built-ins and eligible unchanged no-op or
declarative-only plugins are different cases. Matching entry bytes are not proof
of transitive dependency/closure equivalence. UI reconnect to a surviving daemon
is not engine restoration. No adapter may bypass this refusal, recreate historical
callbacks from current settings or claim #394's capabilities already exist.

## Source alignment and later work

Issue #331 retains claims for the workspace lifetime with no automatic key reuse.
Issue #356 specifies atomic Request changes, explicit undelivered CAS replacement,
immutable history and durable boundaries. #398 (composer) and #399 (compaction)
are later independent follow-ups and do not block v1. #391–393 own separately
approved private access and actual-Cal proof; #394–396 follow the usable MCP
preview with restoration implementation and acceptance. These links introduce no
reverse dependency on issue closure. The dependency graph is acyclic.

## Frozen engineering details

The coordinator approved the following engineering choices. Use these contracts
in all feature fixtures and the named ownership reservations. They do not claim
that the new operations already exist in the merged runtime.

#### A. Admission receipts and bounded retry claims

- Keep the `RetryResult<T>` and `DirectAdmissionResult` discriminated unions above.
  Add shared service `inspect(operationId, authority)` and
  `reconcile(operationId, authority)` methods. Inspect is read-only. Reconcile is
  an explicit authorized mutation that finishes the original journal only; it
  cannot allocate a second admission or restart a completed run. Wire inventory:
  `admissions.get` and `admissions.reconcile`, with fixed registered operation
  kinds rather than a caller-supplied callback or arbitrary RPC name.
- Preserve existing `requests.submit` responses by keeping the wrapper internal;
  keyed retries return the same existing admission identifiers. `runs.admit`
  returns the shared direct receipt. Legacy `runs.start` delegates admission to
  that service, then waits using its existing result shape. An operation ID is
  never an authority token, and inspect/reconcile recheck both original resources
  and the operation-specific grants. Return no existence detail on denied IDs.
- Normalize only validated schema intent: missing `vars` becomes `{}`, object
  keys sort recursively, array order remains significant, and explicit selection
  guards remain significant. Preserve text/Unicode exactly. Reject non-JSON and
  unknown fields. Never fill moving workflow/config defaults into the retry
  comparison. The first successful claim captures them once afterward.
- Store the canonical comparison and protected command under the existing
  protected execution boundary. Use a bounded server-generated index ID, never
  a raw key in a pathname. Do not publish an unsalted hash of secret-bearing
  command material. A fingerprint optimization must be keyed/protected and still
  preserve exact canonical comparison, rather than introduce another key store.
- Limits for new keyed operations: opaque key 1–128 UTF-8 bytes;
  canonical command at most 256 KiB, nesting depth 32; revision text/values at
  most 64 KiB within that envelope. Reject excess before allocating claims.
  Workflow-declared limits may be tighter. Preserve unkeyed legacy limits unless
  separately reviewed; adapters cannot silently truncate or split commands.
- Initial quotas: 100,000 retained claims per workspace and 10,000
  per principal, configured through new `admissionRetry.maxClaimsPerWorkspace` and
  `admissionRetry.maxClaimsPerPrincipal` keys via the existing authorized operator
  config boundary. Integrator owns their schema/wiring; #331 receives resolved
  limits as constructor options. Both are positive integers, never expiry knobs.
  At quota, refuse new claims with a typed resource-limit error; allow existing
  replay, inspection and reconciliation. Count/update under the durable claim
  lock. No auto-expiry, reuse or deletion. Reconciliation visits at most 100
  records per batch, with a durable cursor; do not scan the whole ledger on every
  call. Document the storage tradeoff and test full-quota replay before shipping.
- Use one persistent journal ordered `claimed -> bound -> accepted` with a
  recoverable interruption outcome. Bind IDs and protected intent before effects;
  acknowledgement waits for ownership and accepted state. Original authorization
  is recorded as provenance, never reusable authority. A restarted dispatch
  checks current authority and fences; unavailable authority means inspectable
  blocked work, not elevation to a daemon owner credential.

#### B. Service-owned pending revision read and CAS replacement

#356 owns `RevisionInputService`, including an authenticated `readPending` and
`replacePending` in its already allocated engine/daemon/protocol files. New
wire methods are `inputs.revisionPending` and `inputs.replaceRevision`; initial
`inputs.revise` remains the atomic revision-plus-declared-branch command.

```ts
interface PendingRevisionTarget {
  runId: string;
  revisionId: string;
  destinationId: string;
  attemptId: string; // server-reserved intended attempt, never a client-chosen step
}
interface PendingRevisionView {
  target: PendingRevisionTarget;
  expectedRevision: string; // opaque current CAS version, not a bearer grant
  state: "pending" | "delivered" | "rejected" | "superseded";
  payload?: RevisionPayload; // only when current protected-content access permits
  replacementAllowed: boolean;
  unavailableReason?: "delivered" | "target-changed" | "cancelled" | "delivery-uncertain";
}
interface ReplacePendingRevisionCommand {
  target: PendingRevisionTarget;
  expectedRevision: string;
  payload: RevisionPayload;
}
// RetryOptions is separate from both commands, and actionId is never a retry key.
```

The initial commit reserves the destination/attempt binding before advancing the
gate. Read remains available for that revision after the originating input is
answered, subject to current run and revision-content authority. Replace requires
current mutation authority, the same destination/attempt, the expected active
revision and an unclaimed delivery state. It atomically writes the new revision,
supersedes the old one and advances the revision CAS version under the same run
fence. It performs **no second gate answer or branch transition**. No new workflow
attempt is created by replacement. History is immutable; ordinary notes are inert.

Read projection and delivery claim share the same authoritative record. Delivery
claim wins against replacement by advancing CAS before handing the protected
payload to prompt assembly. Keep internal `unclaimed/claimed/confirmed/uncertain`
delivery metadata separate from the four public revision states. A claimed or
uncertain handoff remains visibly pending with replacement disallowed and a
specific explanation; only confirmed delivery becomes `delivered`. Never mark an
ambiguous handoff confirmed or automatically send it again. The original branch
journal and delivery claim must survive a crash; cancellation rejects unclaimed
pending revisions and fences further dispatch, without rewriting confirmed history.

Tradeoff: this retains a small inspectable pending-target record after a gate
closes. That is necessary for replacement safety and avoids a second gate engine.
App/CLI/API are the minimum supported v1 submission paths; ACP/MCP negotiate
revision capability and reject clearly until wired. The app keeps its draft on
stale/recoverable refusal and always shows destination and pending text first.

#### C. Durable continuation belongs to the integrator

Allocate a separate **integrator-owned** shared continuation slice; do not assign
it implicitly to #327 or let #331 absorb another story's execution semantics.
#331 supplies the durable registered-operation claim facility only. Reserve:

- New `packages/core/src/model/continuation-admission.ts`
- New `packages/engine/src/continuation-admission.ts`
- New `packages/protocol/src/continuation-admission.ts`
- New `packages/daemon/src/continuation-admission.ts`
- New `packages/store/src/continuation-admission-store.ts`
- New `packages/{core,engine,daemon,protocol,store}/test/continuation-admission*.test.ts`
- Existing `packages/daemon/src/control.ts`, `execution-runtime.ts`, `methods.ts`,
  existing auth operation/resource inventory and `packages/engine/src/orchestrator.ts`
- Existing protocol control/inputs/error/capability exports and all package barrels

The named owner is the parent integration task, which owns the combined patch and
production wiring. The three external feature workers must not edit these files.
This is prerequisite integration work for full MCP recovery acceptance, not a
fourth agent launch or additional authority to change code now.

Add `runs.continue` plus `continuations.get/reconcile`, with command
`{runId, expectedBoundary, decision?}` and separate `RetryOptions`. `decision`,
when present, names the exact durable input and answer; live callbacks are excluded.
A receipt contains `{operationId, continuationId, runId, state}` where state is
`prepared`, `accepted`, `blocked` or `settled`, plus safe typed blocking reason and
current boundary reference. These are receipt states, not additional run statuses.
`accepted` means the durable continuation was committed, not that execution finished.

The service journals answer-and-continue as one recoverable logical operation;
reconcile cannot record a second answer. For plain resume it CAS-checks the safe
recorded boundary. It reuses current `runs.resume`/exact input-answer authority
rather than grant broader rights. Inspect requires authorized run access;
reconcile requires the original control authority. Legacy blocking methods may
wait on this service but keep their existing wire behavior.

Persist a dispatch-needed record before acknowledgement. The daemon runtime owns
bounded discovery and attachment; startup/reconnect can find it without relying
on an orphaned Promise. A worker attaches only with a valid current execution
context and run lease. If the original context cannot be reauthorized after
restart, report `blocked` and require explicit authorized reconcile/renewal of the
same intent. Never substitute process-owner credentials or repeat terminal work.
A decision-only durable answer with `resume:false` remains available separately.

Tradeoff: one more shared receipt service makes continuation explicit and durable.
It can land after a read/admission preview, but full #327 recovery acceptance waits
for it. Freeze the interface now so the MCP worker has one fixture to target.

#### D. Read backend limits and SDK baseline

- Default page 50 items, hard maximum 100, and hard serialized response
  cap 256 KiB per tool result, including identifiers and omission metadata. A
  single oversized item is summarized with an authorized drill-down ID rather
  than breaking the envelope. Artifact body reads keep existing stricter limits;
  no new arbitrary-file or binary download path is included.
- Use service-issued cursors bound to principal, target, filters and snapshot/data
  revision. Event sequence cursors retain their existing semantics. If the store
  cannot provide a stable snapshot for mutable collections, invalidate on revision
  change and return an explicit restart-required result. This trades restart on
  writes for correctness; do not promise snapshot stability from numeric offsets.
- Safe config/preflight projections use one captured generation and allowlisted
  IDs/version/digest/status/resolution-source fields. Broad raw config access is
  never an implementation shortcut. #327 owns new projections and the typed MCP
  backend; integrator owns their auth/dispatch wiring.
- Use official TypeScript SDK v2, pinned `@modelcontextprotocol/server`
  `2.2.0`, and `@modelcontextprotocol/client` `2.2.0` for reference-client tests.
  The [official 2.2.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.2.0)
  lists both packages; [official v2 docs](https://ts.sdk.modelcontextprotocol.io/v2/)
  identify v2 as the stable line. Sources checked 2 October 2026 UTC. Use local
  stdio first and standard Streamable HTTP for remote fixtures, not legacy SSE.
  Compatibility passed in isolated scratch on Node 22.23.3 and 24.19.0 using
  TypeScript 7.0.2, Zod 4.6.5 and the exact baseline strict NodeNext options.
  Stdio subprocess discovery/calls, Zod defaults/rejection and in-process
  Streamable HTTP discovery/calls passed. Integrator owns repository dependency
  wiring and full checks; do not upgrade unrelated workspace packages. These
  fixture tests establish no ORCA authentication or actual-Cal connection.
- Actual Cal deployment/auth mapping remains #391/#392/#393 with separate setup
  authority. Use typed authenticated-backend fixtures meanwhile. Do not choose
  an OAuth issuer/account/host for the user or infer that SDK conformance proves
  the actual conversation can connect.

These decisions are the common fixture baseline. Actual launch waits only for
coordinator publication and the exact reviewed preparation SHA; production and
remote acceptance remain subject to their respective tests and authorization.

## Cross-worker fixture interfaces

The preparation is documentation-only. An owner defines its new module on its own
branch; a consumer uses a structurally faithful test fixture with the signatures
below until the integrator wires the module. Do not import a peer branch or ship
a fixture as production. Extra private implementation methods are allowed; changing
these shared signatures requires a coordinated contract revision.

### #331 facility consumed by #356 and the integrator

```ts
type RetryOperationKind =
  | "request.submit" | "run.admit"
  | "revision.submit" | "revision.replace" | "run.continue";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface RetryAuthority<C> {
  readonly principalId: string; // verified server context, never wire input
  readonly workspaceId: string;
  authorize(command: C): Promise<void>; // live credential, grants, original targets
}
interface RetryContext {
  readonly operationId: string;
  readBinding(): Promise<Record<string, JsonValue> | undefined>;
  bind(binding: Record<string, JsonValue>): Promise<void>;
  reauthorize(): Promise<void>;
}
interface RetryOperation<C, R> {
  readonly kind: RetryOperationKind;
  canonicalize(command: C): JsonValue;
  prepare(command: C, context: RetryContext): Promise<R>;
  recover(command: C, context: RetryContext): Promise<R>;
}
interface RetryClaims {
  execute<C, R>(operation: RetryOperation<C, R>, command: C,
    retry: RetryOptions, authority: RetryAuthority<C>): Promise<RetryResult<R>>;
}
```

#331 owns these exports in `packages/core/src/model/admission-retry.ts` and their
engine implementation. Trusted bootstrap registers one immutable implementation
per kind; a caller can pass only a registered service instance, never deserialize
an operation/callback from wire input. The two admission wrappers above use this
same facility. #356 implements the two revision registrations, and the integrator
implements continuation registration. No circular import of revision/continuation
types into #331 is necessary.

`bind` is a write-once durable CAS for preallocated target/result correlations:
identical repeat succeeds, changed binding conflicts. The facility persists
canonical command/binding/result in protected storage, invokes `prepare` only
for a fresh claim, and invokes `recover` for an interrupted bound claim. Each
owner must bind its IDs before admission/gate effects. A fenced owner cannot
commit after another recovery owns the claim. A resolved result is replayed only
after authorization; result inspection dispatches to the registered kind without
letting the client choose the interpretation. Omitted keys preserve compatibility
but still create a server operation journal; generated IDs are not future client
retry keys. This interface does not make multi-file side effects transactional.

### #356 service and workflow declaration

```ts
interface RevisionInputService {
  submit(command: RevisionCommand, retry: RetryOptions,
    authority: RetryAuthority<RevisionCommand>): Promise<RetryResult<RevisionReceipt>>;
  readPending(target: PendingRevisionTarget): Promise<PendingRevisionView>;
  replacePending(command: ReplacePendingRevisionCommand, retry: RetryOptions,
    authority: RetryAuthority<ReplacePendingRevisionCommand>): Promise<RetryResult<RevisionReceipt>>;
}
interface RevisionCapability {
  actionId: string; // existing human option ID
  destinationNodeId: string;
  payload: { kind: "text"; maxBytes: number } |
    { kind: "values"; inputSchema: WorkflowInputSchema; maxBytes: number };
  composition: "replace-revision-slot";
}
```

`readPending` is on a server-created authenticated service instance and rechecks
current authority; it is not a free store handle. Initial submission/replacement
return the same receipt family. Its inline `RevisionReceipt` interface includes
server-issued `attemptId`, `currentRevisionId` and `expectedRevision`, allowing exact pending
reads after the gate is answered. Existing initial `RevisionTarget.requestId`
continues to identify the source input, not the new revision.

Add optional `revision: RevisionCapability` to a durable gate or human-sourced
decision node, through #356's reserved core/workflow patch. Reuse the existing
`WorkflowInputSchema` validator for values. The action must be an existing option
whose declared branch uniquely identifies the destination agent in the same graph;
a direct branch back to a prior agent creates only the explicitly chosen normal
new attempt. Ambiguous routes, cross-child destinations and unsupported node types
are rejected as unsupported in v1. Never guess an eventual agent from graph order.

The destination receives one protected `revision` input slot containing this
payload and provenance; text becomes a separately identified corrective-instruction
block in prompt assembly, and values are available only under that slot. They do
not merge into global workflow vars or replace unrelated prompt/template content.
Supersession replaces that undelivered slot only. The branch/gate journal records
its exact action once. #356 owns declaration/assembly fixtures; integrator owns
existing schema/interpreter wiring.

### Continuation consumer interface

```ts
interface ContinuationCommand {
  runId: string;
  expectedBoundary: string;
  decision?: { requestId: string; optionId: string; note?: string };
}
interface ContinuationReceipt {
  operationId: string;
  continuationId: string;
  runId: string;
  expectedBoundary: string;
  state: "prepared" | "accepted" | "blocked" | "settled";
  blockedReason?: "authority-unavailable" | "leased" | "unsafe-boundary" | "generation-unavailable";
}
interface ContinuationService {
  admit(command: ContinuationCommand, retry: RetryOptions,
    authority: RetryAuthority<ContinuationCommand>): Promise<RetryResult<ContinuationReceipt>>;
  inspect(continuationId: string): Promise<ContinuationReceipt>;
  reconcile(continuationId: string,
    authority: RetryAuthority<ContinuationCommand>): Promise<ContinuationReceipt>;
}
```

The server-created service binds authenticated read context for inspection and
checks current run access. The read backend projects `expectedBoundary` only for
supported safe boundaries, binding run, attempt/input identity, generation and
current durable revision; callers cannot mint it. A stale token refuses before
any answer or dispatch. MCP uses `admit` and later inspection; it never waits for
settlement inside the tool call. The integrator supplies the production service;
#327 uses this fixture shape until wiring is available. The optional `decision`
never carries an `always` grant or a live callback target.

### Grant and refusal mapping

- `runs.admit`: existing `runs.start` grant and workflow/association checks.
  Request submission keeps its `runs.start` plus workspace `plan.write` checks.
- `admissions.get/reconcile`: dispatch by sealed operation kind. Reads recheck
  original admission grants and original targets; reconcile additionally rechecks
  current execution/resume authority if it will attach execution. Never infer a
  grant from possession of a receipt ID.
- Revision initial/replace: `inputs.answer` plus `runs.control` on the exact run
  and declared durable target. Pending/history/payload reads require `runs.read`
  on that run; returning protected revision payload/history additionally requires
  `inputs.answer` and `runs.control` for that run, independent of whether delivery
  currently allows replacement. Otherwise omit payload explicitly. No `permissions.grant`
  request is accepted through revision.
- `runs.continue`: `runs.control`; an included durable decision additionally needs
  `inputs.answer` for that exact input. `continuations.get` needs `runs.read` on
  its sealed run; reconcile needs the original control/decision grants again.
- Operator run/step/event/decision views: `runs.read`; artifact views additionally
  use `artifacts.read`; workflow graph/schema use `workflows.read`; preflight uses
  `runs.start`; Request/work-item details use existing `plan.read`; safe deployment
  configuration uses existing `config.read`. Run provenance remains available
  through authorized run reads. Hidden linked resources are omitted before counts.
- Add core `RETRY_CONFLICT`, `RETRY_LIMIT`, `REVISION_STALE`, `CONTINUATION_STALE`
  and `OPERATOR_CURSOR_STALE` through the integrator's reserved errors patch;
  propagate normal `OrcaError` envelopes. Use existing `NOT_SUPPORTED` for absent
  workflow/adapter capability and existing auth faults for denied targets. Error
  details contain IDs/reasons only after authorization, never payload/key material.

The same input validation/limits and method schemas apply to HTTP and WebSocket.
New method capability names equal their exact RPC names and appear only when the
production implementation is wired and the current principal has its grants.

## Publication and handoff

### Integration clarifications approved 2 October 2026

- The new wire `runs.admit` receipt is `DirectAdmissionResult & {operationId: string}`.
  Every resolved prepared/accepted/recoverable-failure receipt retains that safe
  retry correlation; an in-progress response uses a typed non-success envelope.
  The internal result and settled legacy `runs.start` shape are unchanged. The
  client idempotency key is never returned as a receipt or used as authority.
- The combined implementation crosses an explicit protocol **2.0** and
  **operator-journals-v4** store boundary. Old clients have closed capability and
  event schemas; this is not a backward-compatible minor. Client and server upgrade
  together. Managed activation/recovery checks epochs, while direct startup does
  not enforce the release marker. Rollback requires the complete pre-upgrade store
  backup and its matching binary; epoch equality is not a downgrade guarantee.
- The supported continuation boundary is exposed as optional authorized
  `runs.get.continuation.expectedBoundary`; the token is an opaque CAS guard, not
  permission. `runs.continue` accepts `{command, retry}`, and dedicated continuation
  inspection/reconciliation names the returned continuation ID. Initial production
  composition is restricted to sealed root durable gates/human decisions, with
  unsupported or ambiguous lineage omitted/refused explicitly. Wider acceptance
  remains subject to the original gates below.
- One protected authoritative event commits decision plus dispatch intent.
  Existing-file synchronization must complete before accepted acknowledgement or
  inspection. Private locator/index records are never authority: missing markers
  cannot be rebuilt from a cached receipt or index. Recovery may repair only the
  locator after verifying the original marker, preserving correlation and current
  authority. No second execution store, encryption key lifecycle or owner fallback
  is introduced.

The coordinator publishes only this preparation document against the exact merged
base after final review, then records its full commit SHA in #331/#356/#327 and
all three kickoff messages. A kickoff names issue, exact start SHA, exclusive
files, reserved patch name, fixture interfaces, acceptance checks and limitations.
No agent launch, main merge, deployment, credential setup or release is implied
by preparation publication. Preserve pending work; never reset another checkout.

## Acceptance and handoff gates

Feature handoff includes full SHA, owned diff, reserved integration patch, exact
check commands/results, schema/error/auth/capability changes, fixture limitations
and any implementation findings requiring coordinated contract changes. Feature CI does not imply combined acceptance.

Required combined tests include:

- Separate processes racing one key, same-key/different-payload conflicts,
  cross-principal/workspace/operation refusal, rotation/revocation, every durable
  write/crash boundary, retained keys with no automatic expiry/reuse, revoked
  authority and intentional-new-work identity
- Both Request and direct launch returning admitted IDs while a test executor
  remains blocked; lost response and adapter/daemon restart preserve original IDs;
  accepted ownership precedes agent/child events; no duplicate completed execution
- Generation change between preflight/capture/admit/retry/reconcile; historical
  generation restoration and current authority remain separate; invalid/stale
  launch creates no Request/run/provisioning effects
- Revision rationale separation, exactly intended destination/prompt assembly,
  duplicate/stale/replace/cancel/restart behavior, unsupported adapters, protected
  payload/provenance and app draft preservation across errors/target changes
- MCP bounded pages and large histories, wrong target/old epochs/backup rewind,
  pre-existing/child/failed-run drill-down, hidden links/counts, denied artifacts,
  current revocation, secret fixtures, unavailable daemon and untrusted log text
- Durable decisions versus exact live targets, concurrent/duplicate/stale answers,
  owner/lease/session death, invalidation races and standing-write exclusion;
  explicit supported cancellation and recovery without an indefinite tool call
- Existing CLI/ACP/app compatibility plus HTTP/WebSocket parity and tool discovery
  only for implemented authorized operations

Run final combined `typecheck`, `format:check`, `lint`, `design:check`, Node 22/24
tests and coverage, build and compiled CLI/runtime smoke. Run real Electron App
smoke on that exact combined head; platform prerequisites or runtime-library
failures are blocked checks, never passes. Record independent review and exact CI
run/commit evidence. Revalidate after integration edits or environment resets.

Reference MCP clients establish transport/server behavior only. Full #327/#393
Cal acceptance needs actual-conversation tool discovery and harmless authenticated
read, existing-run investigation and pagination, invalid/valid guarded preflight,
explicit Request/direct launches, final results, authorized cancellation/recovery,
exact decisions and confirmation behavior. Record build, client surface,
transport/authentication mode, non-secret target/scope and pass/fail/blocked per
criterion. Missing actual-client evidence is an explicit blocker, not a substitute
client success. Do not close release acceptance merely because a preview is usable.

## Preparation verification

On 2 October 2026 UTC, the exact baseline recursive Git tree (1,181 entries,
not truncated) and 24 pinned source/manifest files were inspected. Forty-seven
expanded feature ownership paths/prefixes have no cross-story or new-path
collisions; the three existing #331 edits exist. All three handoff patch names
and integrator continuation modules/test prefixes are absent. Native-Mac docs
#405/#406 are present; pending #407's private-access directory is absent.
The 12-node dependency graph, whitespace, fenced blocks and local references were
checked. Markdown is excluded by `.prettierignore`; ordinary Prettier success is
not claimed as document validation.

SDK compatibility used exact published server/client/core 2.2.0 in an isolated
scratch package, without modifying repository dependencies or source. Package
engines require Node >=20 and their exported ESM entry points resolve under the
baseline NodeNext compiler. Node 22.23.3 and Node 24.19.0 passed the same compiled
fixture. Streamable HTTP was exercised in-process through the SDK fetch handler;
no listener, remote authentication, deployment or actual Cal access was tested.
The factory returns an object with `.fetch`, not a bare function; production must
supply verified authentication rather than assuming that factory checks tokens.

Repository runtime checks remain required for implementation. This preparation
adds one documentation file only. Baseline implementation acceptance belongs to
#397's recorded evidence; this document is not a repeat security review. Full
operator acceptance cannot be closed from SDK fixtures or preparation alone.
