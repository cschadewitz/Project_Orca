# `@orca/protocol`

The wire contract between the ORCA daemon (`orca serve`) and its clients. Zod schemas, so
both ends validate at the boundary and the TypeScript types fall out of them. It depends on
`@orca/core` for the domain types and on nothing else — a client that depends only on this
package cannot reach the engine, the stores or the transports (ADR 0008).

Everything below is exported from the package root. Current main uses **2.0**
([version source](src/version.ts)), store epoch `operator-journals-v4`.
Protocol 2.0 requires coordinated client/daemon upgrade: old closed capability/event
schemas cannot safely ignore the operator/admission/revision additions. Methods remain
conditional on installed providers, read-only mode and current caller authority; the
[method inventory](#method-inventory) says which conditions and which grant, for every
method a daemon can answer.
See [operator integration](../../docs/runtime-operator-integration.md) for the current
composition and dated acceptance checkpoints. Root version 0.6.0 alone does not identify
a deployed build. Introduction versions below are history, not the current handshake
version. See [release history](../../CHANGELOG.md).

| Protocol | What it added |
| --- | --- |
| 1.7 | the v0.5.0 config, workflow and plan methods |
| 1.8 | maintenance admission and optional `hello.processId`; it is also the first to advertise the additive v0.6.0 fields that landed under 1.7: decision `resultIsPreview`, `runs.get.workflowPinned`, step `model`, workflow `pinned`, and `WORKFLOW_VERSION_NOT_FOUND` |
| 1.9 | authenticated clients, typed-input preflight and pinned launch guards |
| 1.10 | Request admission, configuration generations and `config.apply`, workspace/boot identity, and live callback fields |
| 2.0 | the operator, admission and revision capabilities and the `revision.recorded` event. A 1.10 client validates capabilities and events with closed schemas and cannot ignore them, so this is a major |

**The template and workflow-draft methods arrived inside 2.0.** The eight
[`templates.*`](#template-authoring--templates) methods and the eight
[`workflowDrafts.*`](#workflow-drafts--workflowdrafts) methods joined the method table after
`PROTOCOL_VERSION` became 2.0, and the minor was not bumped for them, although
`version.ts`'s own rule bumps the minor for added methods. So "2.0" does not say whether a
daemon has them: a 2.0 daemon built before them answers `PROTOCOL_METHOD`. Ask
`hello.methods`, which is the check that matters anyway.

## Transport

`POST /rpc` with one **request** envelope, answering with one **response** envelope;
`GET /health` for supervisors. `WS /socket` is the same dispatch **plus** the direction HTTP
has not got — the daemon speaking first, in `notification` envelopes.

```ts
{ kind: "request",  id, method, params? }
{ kind: "response", id, ok: true,  result }
{ kind: "response", id, ok: false, error: { code, message, details? } }
{ kind: "notification", method, params? }
```

`code` is a plain string, so a newer daemon's codes still parse. It is either an
`OrcaErrorCode` from `core` (`RUN_STATE`, `NOT_SUPPORTED`, `WORKFLOW_INPUT_INVALID`, …) or
one of the protocol-only codes in [`errors.ts`](src/errors.ts), which exist only between
processes: the three `PROTOCOL_ERROR_CODES` (`PROTOCOL_VERSION`, `PROTOCOL_METHOD`,
`PROTOCOL_MESSAGE`), the three `AUTH_ERROR_CODES` (`AUTH_REQUIRED`, `AUTH_INVALID`,
`AUTH_FORBIDDEN`, [below](#authentication-and-typed-preflight-19)), and the five the control
methods add (`CONTROL_ERROR_CODES`):

| code | means | `details` |
| --- | --- | --- |
| `INPUT_ANSWERED` | somebody answered that question already | `requestId`, `runId`, `answer` |
| `INPUT_OPTION_UNKNOWN` | not an option this question offers | `requestId`, `options` |
| `RUN_NOT_WAITING` | the run is not parked on anything, or has finished | `runId`, `status` |
| `RUN_LEASED_ELSEWHERE` | another **live** process is interpreting it | `runId`, `holder`, `pid`, `host`, `renewedAt` |
| `CONFIG_STALE` | the file moved under the edit; a refusal, never a merge | `document`, `expectedRevision`, `actualRevision` |

They exist because a screen has to tell them apart, and the engine says `RUN_STATE` to
the first four — the right shape for a CLI that prints a message, the wrong one for a client
that branches. Invalid params are `PROTOCOL_MESSAGE` with the Zod issues in `details`.

**The `PROTOCOL_VERSION` code is a client's, not the daemon's.** No daemon path sends it.
A daemon answers a `hello` it is not compatible with by `NOT_SUPPORTED`, with both versions
in `details` (see [`hello`](#hello--every-connection-opens-with-it)). `PROTOCOL_VERSION` is
the code a client raises locally when the `hello.protocol` it got back is not one it
accepts: the app's daemon client, the MCP operator backend and `orca revisions` all do so.

The `PROTOCOL_VERSION` constant is `{ major, minor }`: `major` changes when a message changes
shape or meaning, `minor` when messages or fields are added. Compatible when the majors match
and the daemon's minor is at least the client's (`isCompatible`).

**A `/rpc` body is at most 1,000,000 bytes.** The daemon stops reading at that point and
answers HTTP 413 with `{ kind: "response", id: 0, ok: false, error }`, where `error` is
`INTERNAL` "body too large". The id is `0` because the envelope was never parsed. A
credential refusal comes earlier, from the headers alone, and never reads the body (see
[security](../../docs/daemon-security.md#http-rpc)).

A client that only reads never opens a socket: `hello` and every read method work over
`/rpc` with none. `DaemonHandle.socketUrl` is present only when the daemon was given an
engine feed, and `socketUrlFor(httpUrl)` derives it (`http`→`ws`, `https`→`wss`, plus
`SOCKET_PATH`).

## Authentication and typed preflight (1.9)

The default daemon requires a bearer credential on `/rpc` and `/socket`. HTTP uses
`Authorization: Bearer <token>`; WebSocket uses subprotocols `orca.v1` and
`orca.bearer.<token>`. Tokens must never be placed in URLs. `/health` remains an
unauthenticated `{ok:true}` liveness response without resource or identity details.

Missing credentials produce `AUTH_REQUIRED` (401). Invalid, malformed, expired and revoked
credentials produce the same `AUTH_INVALID` (401), without reason-specific details. An
operation refusal is `AUTH_FORBIDDEN` in the normal response envelope; inaccessible and
absent protected resources have matching not-found responses. WebSocket authority is
rechecked for messages, notifications and idle connections; expiry/revocation closes with
4401. Reconnect/replay reauthorizes rather than retaining an old principal.

`workflows.validateInputs` takes `{workflowId, version?, vars?}` and returns
`{workflowId, version, revision, validation}` without echoing resolved values. Access
requires launch authority (`runs.start`) and workflow scope before resolution/validation.
It is implemented and advertised, not reserved: the method table installs it whenever a
workflow-input model is wired, `orca serve` always wires one, and `hello` then lists the
method and the `workflows.validateInputs` capability to a caller holding `runs.start`.
Discover it through `hello.methods`, like everything else. The result's version
and revision are forwarded as `runs.start.workflowVersion` and
`runs.start.expectedWorkflowRevision`. A stale revision is `WORKFLOW_INVALID`; input
failures are `WORKFLOW_INPUT_INVALID` with `{errors, warnings}`. Read-only mode may offer
preflight but still omits `runs.start`.

See [runtime integration](../../docs/runtime-foundation-integration.md) for token-file
migration, protected execution state and standing-permission failure semantics.

## Maintenance admission (1.8)

The standard daemon installs `maintenance` independently of `runs.control`, including
in read-only mode; discover availability through `hello.methods`. `hello.processId` is
optional supervisor identity, not caller authentication. Both maintenance methods need
`daemon.maintenance`.

```ts
params: { action: "prepare" | "resume"; token: string } // nonempty token
result: { ready: boolean; active: string[] } // active method names, not run IDs
```

`prepare` closes admission only when no wrapped calls remain active; otherwise it returns
`ready: false` and the active methods for the supervisor to drain/retry. Once held,
another token is refused with `PROTOCOL_MESSAGE` ("Another updater owns admission").
`resume` clears that in-memory token and returns `ready: false`. Invalid parameters also
use `PROTOCOL_MESSAGE`. This counts in-flight method calls, not all persisted run states.

This method does not install software or accept paths/commands. The token coordinates
updaters; general HTTP/WS authentication and `daemon.maintenance` authorization now
apply separately ([security](../../docs/daemon-security.md)). The supervisor must
also check run/update readiness and daemon ownership as described in [Updating](../../docs/UPDATING.md).
See [schema](src/maintenance.ts) and [admission implementation](../daemon/src/maintenance.ts).

### `maintenance.runtime` — exact-target idle proof, drain and defer

```ts
target: { workspaceId; instanceId; processId } // hello.identity plus hello.processId

params: { action: "prepare" | "resume"; token; target }
result: { proof: "runtime-v1"; target; outcome: "held" | "blocked" | "released";
          active: RuntimeActivityReason[] }

params: { action: "drain" | "defer"; token; target }
result: { proof: "runtime-drain-v1"; target; outcome: "draining" | "held" | "blocked" | "released";
          active: RuntimeActivityReason[]; unfinished: { status; count }[]; truncated: boolean }
```

`RuntimeActivityReason` is `rpc`, `execution`, `callback`, `renewal`, `dispatch`,
`continuation`, `recovery` or `unavailable`. The legacy method counts RPC calls; this one also
proves the runtime behind them is idle. It is installed only when the daemon's live
execution runtime is completely bound: token mode, a daemon identity, and the Request,
admission and continuation services on that one runtime, which a writable token-mode
`orca serve` provides. A `--read-only` daemon therefore has `maintenance` and not
`maintenance.runtime`. A `target` other than this process's, or a token other than the one
holding admission, is refused with `PROTOCOL_MESSAGE` ("Runtime target changed", "Another
updater owns admission"). Once a runtime proof holds admission, the legacy `maintenance`
is refused too ("Runtime admission requires its proof method").

- **`prepare`** answers `held` only when nothing is active, neither an RPC call nor any
  runtime activity; otherwise `blocked`, with the reasons in `active`. `held` closes every
  wrapped method.
- **`resume`** releases a held proof and answers `released`. A draining owner uses `defer`.
- **`drain`** closes *new* admission at once, even while work is active, and leaves
  existing work running. It answers `draining` with the live activity reasons, and once
  there is none, with an aggregate `unfinished` count per status (`created`, `running`,
  `waiting`, `paused`) of runs not yet finished. When nothing is left it seals every
  wrapped method and answers `held`. The daemon does not poll: the owner calls `drain` again
  to observe. An inventory that fails, takes longer than a second or covers more than 4,096
  runs comes back `truncated: true` with `unavailable`, and cannot become `held`.
- **`defer`** releases a still-draining fence. It cancels and settles nothing.

Only a target-matching `released` proves release. Treat every other answer, `blocked`
included, as leaving an earlier hold in place. The full contract is in
[update drain](../../docs/implementation/mac-update-drain.md).

### What closed admission refuses

A wrapped method refused by admission fails with `PROTOCOL_MESSAGE` ("Update admission is
closed; retry later"). `hello`, `subscribe`, `unsubscribe`, `maintenance` and
`maintenance.runtime` are never wrapped. The new-admission methods are `runs.start`,
`runs.admit`, `requests.submit`, `operator.admitRun` and `operator.submitRequest`; every
other method in the table is existing work.

| Admission is closed by | New admission | Existing work |
| --- | --- | --- |
| a `maintenance` `prepare` hold, `ORCA_MAINTENANCE_TOKEN`, or a `held` runtime proof | refused | refused |
| a `maintenance.runtime` `drain` still `draining` | refused | admitted |
| a file at `ORCA_ADMISSION_FILE` | refused | refused |
| the durable new-admission gate | refused | admitted |
| the durable existing-work gate | refused | refused |

A drain keeps answers, resumes, continuations, receipt reconciliation and reads available,
so that the existing work can finish. The two durable gates are callbacks `orca serve`
derives from its update-window ownership
([`update-bootstrap.ts`](../cli/src/update-bootstrap.ts)); each closes independently of any
token, and a gate that throws counts as closed.

`orca serve` reads two environment variables for an update supervisor:

| Variable | Effect |
| --- | --- |
| `ORCA_MAINTENANCE_TOKEN` | The daemon starts with admission already closed and held by this token, as if `maintenance` `prepare` had succeeded with it. Every wrapped method, and the daemon's own continuation recovery, waits until the same token sends `maintenance` `resume`. `maintenance.runtime` cannot take the hold over (its `prepare` and `drain` answer `blocked`), and any other token is refused. |
| `ORCA_ADMISSION_FILE` | A path. While anything exists at it, every wrapped method is refused, `maintenance.runtime` answers `blocked` with `unavailable`, and no token can reopen admission. Removing the file lifts this gate. The Debian release tool ([`orca-release.py`](../../tools/deploy/orca-release.py)) starts the daemon with this pointing at its pending-activation record, so a daemon restarted mid-activation stays closed ([Updating](../../docs/UPDATING.md)). |

## Conventions the read methods share

- **Display read models, not `RunState`.** A result carries what a screen renders — a name,
  a status, a duration — not the engine's record for a client to fold itself.
- **`asOf`.** Every result carries the daemon's clock. Elapsed times (`durationMs`,
  `waitingMs`) are measured against it, so a client with a skewed clock still shows the
  truth and a screen can say what it is current as of.
- **Sequence numbers are the cursor.** `lastSeq` is a run's highest event sequence number;
  it is what the status bar shows and what `runs.events` pages on.
- **Missing is not invented.** A run whose log is gone is left out of a listing, and shown
  as `stale` under its id where a parent still points at it.

## The eight statuses

`DisplayStatus` is the one status vocabulary on the wire: `running`, `waiting`, `succeeded`,
`failed`, `cancelled`, `blocked`, `held`, `stale` — the same list, in the same order, as
`runStatus` in `packages/design/semantics.json`, which is what draws them. The engine's
`RunStatus` (7) × `RunOutcome` (3) and `StepStatus` (7) fold onto it here, once, in
`status.ts`; `displayStatusForRun` and `displayStatusForStep` are exported for the daemon
and tested in `packages/protocol/test/status.test.ts`.

| engine | display | why |
| --- | --- | --- |
| `completed` + `success` | `succeeded` | |
| `completed` + `failure` / `cancelled` | `failed` / `cancelled` | a workflow may end deliberately in failure |
| `failed`, `cancelled` | `failed`, `cancelled` | |
| `paused` | `waiting` | the engine parks a whole run only for a person |
| `waiting` on `human-input` | `waiting` | a person is being asked |
| `waiting` on `dependencies` / `plan` | `blocked` | nothing is wrong and nobody is being asked |
| `waiting` on `agent-turn` / `child-run` | `running` | the run is working |
| `created` | `blocked` | it exists and nothing has started |
| `created`/`running`/`waiting` with `leaseLapsed` | `stale` | nothing is driving it |
| step `scheduled` | `blocked` | |
| step `skipped` | `cancelled` | a branch never taken is not a fault |

`leaseLapsed` is the caller's to supply. The daemon's read model sets it for a `running` or
`waiting` run whose lease is lapsed *or absent*, and never for a `created` run, so a daemon
read shows a `created` run as `blocked`; the fold itself sends any of the three to `stale`.

`held` is never produced from a run: it is the plan surface's word for an item restrained by
risk appetite, and belongs to the plan methods.

## Method inventory

Every method the daemon's [method table](../daemon/src/methods.ts) can install, all 83, with
the operation grant the [operation matrix](../daemon/src/auth/operations.ts) gives it and
what has to be wired for the method to be in the table at all. On a token daemon, a method
that is not installed answers `PROTOCOL_METHOD` to a caller holding its grant, and
`AUTH_FORBIDDEN` to one who does not (see [`hello`](#hello--every-connection-opens-with-it)).
`hello.methods` is this table cut down to what is installed and what the caller holds. The
[security matrix](../../docs/daemon-security.md#permission-matrix) adds each method's
resource check and audit class.

The conditions use these words:

- **store**: the daemon serves a store. Without one it answers `hello` alone.
- **writable**: not `orca serve --read-only`. A read-only daemon has no control model and
  omits every row that says so.
- **token**: token authentication, the default `orca serve`. An explicit
  `--unauthenticated-loopback` daemon installs none of the rows that say so.
- **identity**: the daemon has a workspace identity (`hello.identity`).
- **generations**: configuration generations are wired, which is also what `config.apply`
  needs.
- **operator**: token, identity and the operator projection sources, which `orca serve`
  supplies.

| Methods | Operation grant | Installed when |
| --- | --- | --- |
| `hello` | any authenticated principal | always |
| `runs.list`, `runs.get`, `runs.events`, `inputs.list`, `claims.list` | `runs.read` | store |
| `artifacts.list`, `artifacts.get` | `artifacts.read` | store |
| `workflows.list`, `workflows.get` | `workflows.read` | store |
| `workflows.validateInputs` | `runs.start` | a workflow-input model; `orca serve` always has one |
| `config.get` | `config.read` | a configuration model |
| `plans.list`, `plan.get`, `items.list`, `schedule.get`, `schedule.explain`, `dependencies.list`, `risks.list`, `decisions.list`, `journal.list` | `plan.read` | the read model has a plan |
| `subscribe`, `unsubscribe` | any authenticated principal | an engine feed; answered on the socket only |
| `agents.list` | `agents.read` | an agent registry |
| `agents.ping` | `agents.ping` | an agent registry |
| `maintenance` | `daemon.maintenance` | always |
| `maintenance.runtime` | `daemon.maintenance` | writable, token, identity, a completely bound execution runtime |
| `inputs.answer` | `inputs.answer`; `always` also needs `permissions.grant` | writable |
| `runs.resume`, `runs.cancel` | `runs.control` | writable |
| `runs.start` | `runs.start` | writable |
| `claims.release` | `claims.release` | writable |
| `dependencies.waive`, `decisions.decide`, `decisions.reopen`, `risks.update` | `plan.write` | writable, with a plan |
| `config.set` | `config.write` and `config.read` | writable, a configuration model |
| `config.apply` | `config.write` | writable, generations |
| `requests.submit`, `requests.reconcile`, `requests.admission`, `requests.admissions` | `plan.write` and `runs.start` | writable, token, the Request submission service |
| `runs.admit`, `admissions.get`, `admissions.reconcile` | `runs.start` | writable, token, the admission retry service |
| `continuations.get` | `runs.read` | token, the continuation service |
| `runs.continue`, `continuations.reconcile` | `runs.control`; a decision also needs `inputs.answer` | writable, token, the continuation service |
| `inputs.revisionPending` | `runs.read` | writable, token, identity, the revision services |
| `inputs.revise`, `inputs.replaceRevision` | `inputs.answer` and `runs.control` | writable, token, identity, the revision services |
| `templates.get`, `templates.history`, `templates.validate`, `templates.preview` | `config.read` | generations, identity |
| `templates.variant`, `templates.save`, `templates.assign`, `templates.publish` | `config.write` and `config.read` | writable, generations, identity |
| `workflowDrafts.get` | `config.read` | generations, identity |
| `workflowDrafts.open`, `workflowDrafts.apply`, `workflowDrafts.undo`, `workflowDrafts.redo`, `workflowDrafts.review`, `workflowDrafts.publish`, `workflowDrafts.discard` | `config.write` and `config.read` | writable, generations, identity |
| `operator.discover` | any authenticated principal | operator, or a host-resource source alone |
| `operator.page` | any authenticated principal; each collection checks its own grant | operator |
| `operator.config` | `config.read` | operator, a configuration status source |
| `operator.preflight` | `runs.start` | operator, generations |
| `operator.artifact` | `artifacts.read` and `runs.read` | operator, an artifact source |
| `operator.hostResources` | `host.telemetry.read` | token, identity, an injected host-resource source; `orca serve` injects none |
| `operator.submitRequest` | `runs.start` and `plan.write` | operator, writable, the Request submission and admission retry services |
| `operator.admitRun`, `operator.admission`, `operator.reconcileAdmission` | `runs.start` | operator, writable, the admission retry service |
| `operator.cancel` | `runs.control` | operator, writable |
| `operator.answer` | `inputs.answer` | operator, writable, store |
| `operator.continuation` | `runs.read` | operator, the continuation service |
| `operator.continueRun`, `operator.reconcileContinuation` | `runs.control` | operator, writable, the continuation service |
| `operator.revise` | `inputs.answer` and `runs.control` | operator, writable, the revision services |

`requests.*` and `inputs.revise` / `inputs.replaceRevision` list one grant in `OPERATIONS`
and the guard adds the second (`runs.start`, `runs.control`) before anything else is
checked. `operator.artifact` is listed under `artifacts.read`; discovery also requires
`runs.read`, and without it the artifact answers `ARTIFACT_MISSING`.

### Capabilities

`hello.capabilities` is coarse: a capability names a family, not every operation in it.
The enum (`DAEMON_CAPABILITIES`, [handshake](src/handshake.ts)) has 32 values. `hello`
advertises each one under the condition in the middle column, and shows it only to a
caller holding the grant in the last.

| Capability | Advertised when | Shown to a caller holding |
| --- | --- | --- |
| `runs.read` | the embedder lists it; `orca serve` always does | `runs.read` |
| `runs.subscribe` | the embedder lists it; `orca serve` always does | `runs.read` |
| `runs.control` | writable | any of `runs.control`, `runs.start`, `inputs.answer`, `claims.release` |
| `plan.read` | the read model has a plan | `plan.read` |
| `plan.write` | writable, with a plan | `plan.write` |
| `workflows.validateInputs` | its method is installed | `runs.start` |
| `inputs.live` | the control model has live input (writable token `orca serve`) | `inputs.answer` |
| `runs.admit`, `admissions.get`, `admissions.reconcile` | the three methods are installed | `runs.start` |
| `runs.continue`, `continuations.reconcile` | their methods are installed | `runs.control` |
| `continuations.get` | its method is installed | `runs.read` |
| `inputs.revisionPending` | its method is installed | `runs.read` |
| `inputs.revise`, `inputs.replaceRevision` | their methods are installed | `inputs.answer` and `runs.control` |
| `operator.discover` | its method is installed | any of `host.telemetry.read`, `runs.read`, `artifacts.read`, `workflows.read`, `runs.start`, `config.read`, `plan.read` |
| `operator.page` | its method is installed | any of `runs.read`, `artifacts.read`, `workflows.read`, `config.read`, `plan.read` |
| `operator.config`, `operator.preflight`, `operator.artifact`, `operator.hostResources` | its method is installed | the method's grants, as the inventory gives them |
| `operator.submitRequest`, `operator.admitRun`, `operator.admission`, `operator.reconcileAdmission`, `operator.cancel`, `operator.answer`, `operator.continueRun`, `operator.continuation`, `operator.reconcileContinuation`, `operator.revise` | its method is installed | the method's grants, as the inventory gives them |

There is no capability for the read methods beyond `runs.read`, for `config.*`,
`templates.*`, `workflowDrafts.*`, `requests.*`, the agent methods or `maintenance*`: ask
`hello.methods`.

## Methods

### `hello` — every connection opens with it

```ts
params: { client: string; protocol: { major, minor } }
result: { protocol, orcaVersion, storeDir?, processId?, identity?: { workspaceId; instanceId };
          capabilities: DaemonCapability[]; methods?: string[] }
```

`capabilities` is coarse; `methods` is the installed method set available to this
authenticated principal. Protocol 2.0 includes conditional operator/admission/revision
families beyond the original read/control/plan/agent groups. A schema/export alone
does not install a service. The [method inventory](#method-inventory) and
[capability table](#capabilities) list them; consult [handshake schemas](src/handshake.ts)
and current [operation authorization](../daemon/src/auth/operations.ts) for the source.
Resource scope is still checked on every call.

**A version the daemon cannot serve is `NOT_SUPPORTED`.** The daemon accepts a `hello` when
`isCompatible(client, daemon)` holds: the majors match and the daemon's minor is at least
the client's. Otherwise [it refuses](../daemon/src/methods.ts#L366-L375) with
`NOT_SUPPORTED`, a message such as `client speaks protocol 1.10, daemon speaks 2.0`, and
`details: { client, daemon }`, both `{ major, minor }`. It never answers
`PROTOCOL_VERSION`, which is a client-side code (see [Transport](#transport)).

**`methods` is the check that matters, not `capabilities`.** `orca serve --read-only` leaves
the control methods out of the dispatch table *and* out of `methods`, and drops
`runs.control` from `capabilities`. For a caller holding the relevant operation grant,
an omitted control method answers `PROTOCOL_METHOD`. A caller lacking the known
operation's grant can receive `AUTH_FORBIDDEN` first: the
[operation guard](../daemon/src/auth/guard.ts#L176-L187) runs before the
[method lookup](../daemon/src/server.ts#L202-L203) in `dispatch`. Discovery lets a client
hide an unavailable action; it does not bypass authorization.

> **A lease and caller authority are separate.** Default `orca serve` authenticates
> bearer credentials and enforces operation/resource authority. Explicit
> loopback-unauthenticated compatibility is the older local-trust mode; it is not the
> default. The per-run lease prevents competing execution writers and does not replace
> authentication. ADR 0008's original no-auth context is historical.

### `runs.list` — the run list

```ts
params: { status?: DisplayStatus[]; requestId?; workItemId?; parentRunId?; roots?: boolean;
          limit = 100; offset = 0 }
result: { runs: RunSummaryView[]; total: number; asOf }
```

Newest first. `RunSummaryView`: `id`, `name`, `workflowId`, `workflowVersion`,
`workflowPinned?` (`runs.get` only), `status`, `outcome?`, `waitingOn?` / `waitingDetail?` /
`waitingSince?`, `createdAt`, `startedAt?`, `finishedAt?`, `durationMs?`, `parentRunId?`,
`parentStepRunId?`, `requestId?`, `workItem?`, `agentId?`, `error?`.

`name` is the work item's title, else the request's title, else the workflow id — never an
id alone when something better exists, and never invented.

### `runs.get` — one run's tree

```ts
params: { runId }
result: { run: RunSummaryView; workspace; vars; steps: StepView[]; traversal?: RunTraversalView[];
          artifacts: ArtifactView[]; lastSeq; asOf;
          admissionExecution?: { state: "pending" | "started" | "uncertain";
                                 reason?: "legacy-evidence" | "evidence-unavailable" };
          continuation?: { expectedBoundary };
          provenance?: RunProvenance }
```

`run.workflowPinned` is set here and never on `runs.list`: true when a version of the
run's workflow is on disk and it is not the run's recorded `workflowVersion`, so the run
runs, and resumes, on the stored definition it started with (#179). False when the
workflow is not registered at all.

Three optional fields carry what a token-mode daemon knows beyond the log. Each is absent
when there is nothing to say, and none is authority for anything:

- **`admissionExecution`** is evidence about a durably admitted run's first execution:
  `pending` before it starts, `started` once it has, and `uncertain` with a `reason` when the
  evidence is legacy or unreadable. It never promises that something is attached now. It is
  absent for a run started any other way, and rechecks `runs.read` and the run before and
  after it reads.
- **`continuation.expectedBoundary`** is the opaque, server-issued guard
  [`runs.continue`](#runscontinue--continuationsget--continuationsreconcile--durable-continuation)
  takes. It is issued only for a durable boundary continuation supports, and only when
  continuation is wired.
- **`provenance`** is the safe launch explanation recorded when the run was created:
  `configGeneration`, the workflow's `{ id, version, revision }`, the `inputs` by name and
  source (`caller` or `workflow`) with every value `[REDACTED]`, the per-node `selections`
  (agent, host, model and template, each with the source that chose it), and the
  `templatePack` and `itemWorkflow` defaults. It holds no executable snapshot, secret value
  or artifact reference.

`steps` is every step run in scheduling order — one entry per *attempt*, so a retried node
appears more than once with ascending `attempt`; a tree groups by `nodeId` (and `iteration`,
inside a loop). Each `StepView` carries `status`, `waitingOn?`, its timestamps and
`durationMs?`, `agentId?` / `agentSessionId?`, `model?`, `inputArtifactIds` / `outputArtifactIds`,
`choice?`, `message?`, `error?`, its `children` (`ChildRunView`: `runId`, `name`, `status`,
`branch?`, `workItemId?`, `resumed?`) and its `skippedBranches` — the fan-out branches that
never became child runs, so the whole fan-out is shown and not just the part that ran.

`traversal` (protocol **1.7**, #174) is the same visits in node order, shaped for the
workflow viewer's overlay: `nodeId`, `stepRunId`, `attempt`, `status`, `startedAt?`,
`endedAt?`, `viaEdge?` and `childRunIds?`. It exists beside `steps` for `viaEdge` — which
edge of the *definition* the run arrived on, which no step run records and which a client
could recover only by holding the workflow and the run side by side. Where the pair
(previous node, this node) is not an edge there is none to name: a retry of the same node, a
run resumed mid-graph, a workflow this daemon no longer has. The field is then absent rather
than guessed. It is optional on the wire, so a 1.6 daemon simply does not send it.

`RUN_NOT_FOUND` when the store has no log for `runId`.

### `workflows.list` / `workflows.get` — the workflow files as a graph

```ts
params: {}
result: { workflows: WorkflowSummaryView[]; asOf }

params: { id; version? }
result: { workflow: WorkflowView; asOf }
```

Reads, added in **1.7** for the workflow viewer (#177). `WorkflowSummaryView` is `id`,
`name`, `version`, `description?`, `nodeCount`, `edgeCount`, `start`. There is deliberately
no "shipped or user-defined" flag: a daemon loads every workflow from one glob into one
registry and does not keep the path, so the distinction is not one it can make.

`WorkflowView` is `id`, `name`, `version`, `description?`, `start`, `inputs?`, `vars?`,
`nodes`, `edges`, `versions?`, `pinned?`. A `WorkflowNodeView` carries `id`, `type`, `name?`,
`description?`, `maxAttempts?` and **`fields`** — the per-type configuration flattened for
display (an agent's `role` / `agentId` and `template`, a decision's `source`, a gate's
`options`, a loop's bounds, a subworkflow's target), never the `NodeDef` whole. An unknown or
`custom:<name>` type passes everything but the base fields through, so a plugin's node draws
as a generic node rather than as nothing. Edges are `from`, `to`, `when?`, `label?`.

**Nested graphs are inline and addressable.** A `loop` body, a `forEach` body and each named
`parallel` branch arrives as a nested `WorkflowView` under its node, with the id the engine
runs it under — `parent::node`, or `parent::node::branch` (`INLINE_WORKFLOW_SEPARATOR`). So a
viewer may draw the graph it was given or fetch the same one again by id when a collapsed
node is expanded, and both name one thing.

**`versions` combines registered, stored and run-referenced versions.** Since v0.6.0,
`workflows.get({ id, version })` can serve a stored definition; `pinned` is true when a registered definition exists
and has a different version. A recorded version need not still be available: a missing requested version
returns `WORKFLOW_VERSION_NOT_FOUND`. Runs with `workflowStored` prefer the recorded
definition; legacy runs without it retain their current-definition fallback. New launches
reject changed content at an already recorded version, and generation restoration
verifies the exact digest. Bump the workflow version before admitting changed content.
The low-level lookup and protected-generation restoration have distinct missing-data
guards; see [configuration generations](../../docs/configuration-generations.md).

Version labels alone do not establish reproducible external executables, plugin
closures or provider environment; the generation contract states those limits.

`WORKFLOW_NOT_FOUND` for an unknown id, and for a `parent::node` whose node has no nested
graph.

### `runs.events` — the timeline, paged by sequence number

```ts
params: { runId; after?: number; before?: number; types?: string[]; stepRunId?: string;
          limit = 200 }
result: { events: OrcaEvent[]; nextCursor?; prevCursor?; hasMore; lastSeq; asOf }
```

`after` walks forward from a sequence number, `before` takes the `limit` events immediately
preceding one; giving both is an error. Either way the page reads oldest first, so live and
historical rendering are one code path. `types` filters, and an unknown type matches nothing
rather than failing. `lastSeq` is the run's, not the page's.

**`stepRunId` is how a step's output is read.** A step's output *is* the `agent.update`
events it appended, so it is a filter here rather than a method of its own (#158): one
method, one cursor semantics, one thing file mode and a read-only daemon have to support.
The two filters are an AND, and an unknown step run matches nothing rather than failing.
Run-level events (`run.*`, `vars.set`) are about no step and so match no `stepRunId`.

The filters cut the log before it is paged, so `nextCursor` / `prevCursor` are cursors into
the *filtered* sequence while remaining the run's own sequence numbers: paging back from a
page's `prevCursor` lands on the page before it with no gap and no duplicate, however many
other steps' events lie between them. `lastSeq` is the run's high-water mark either way, so
a screen filtered to one step still shows the same cursor as the run around it.

> A client buffering a step's output buffers **events, not lines**: one `agent.update` can
> render many lines, and #158's "last 50,000 lines" is a count of events on this wire. The
> trim boundary a client pages across with `before` is therefore an event boundary, which is
> what makes "load earlier output" exact — a line boundary would not be addressable here.

### `inputs.list` — the attention surface

```ts
params: { runId?; kind?: ("decision" | "permission" | "question")[]; revisionRunIds?: string[] }
result: { inputs: OpenInputView[]; waiting: number; pendingRevisions?: PendingRevisionsDiscovery;
          asOf }
```

Longest-waiting first. `runId` scopes to that run *and its descendants*. Each entry carries
the question, its `options` verbatim, the `context` the asking step attached, where it came
from (`runId`, `runName`, `stepRunId`, `nodeId?`, `workItem?`), `requestedAt` with
`waitingMs`, and the `artifacts` the step had in hand — the design does not let a person
approve something the app could not show them, so those travel with the card.

`waiting` is the one number the title bar shows.

**`options` carries the whole `GateOption` as of protocol 1.4** — `{ id, label, consequence?,
destructive? }`, the model's own shape (`@orca/core/schemas`). It used to be `string[]`
holding the ids, which let a client answer a gate it could not render: no label, no
consequence clause, and no `destructive` flag, which is a safety property and not a
decoration. `id` is still the selected answer — `inputs.answer` takes an option id, a
label may be reworded between the ask and the answer, and a log written before #220 reads
each bare string as an option that is its own id and label. `input.opened` carries the same
shape. A live permission reply additionally requires the exact current target from
`inputs.list`; a push frame alone does not establish callback availability or identity.

**`agent` says whose turn is being held, as of protocol 1.6** — `{ id, hostId, hostType? }`,
three fields of `AgentView` and not a fourth, because the rest of an agent's state is what
the Agents surface is for. A `permission` ask always has one: it reaches a person through a
live agent session, and "claude-local on build-01 is waiting" is what makes an allow-always
decision one a person can size. A workflow `decision` or `question` has none, and the absence
is the answer rather than a field that failed to load — as is a missing `hostType`, which
means the host is no longer configured. `input.opened` carries it too, for the same reason it
carries the options.

**`live` is a live permission callback's identity** — `{ target, state }`, with `state` one
of `pending`, `accepting`, `expired` or `owner-unavailable`. It is absent on a durable
workflow gate, and an expired ask cannot be answered; see
[`inputs.answer`](#inputsanswer--settle-an-open-gate-or-permission-ask).

**Revision fields (2.0).** A token-mode daemon adds three, each absent where it has nothing
to say, and a legacy read model's rows never carry the first two (the method strips them
before projecting its own):

- **`revisionActionId`** on an input is a restriction only: that declared option cannot be
  chosen with `inputs.answer`, whether or not a revision capability is offered.
- **`revision`** on a durable `decision` input is the `RevisionBoundaryView`
  (`target`, `capability`, `destinationDescription`) when exactly one waiting revision
  boundary matches this input and its `capability.actionId` is one of the options. Its
  `target` is what [`inputs.revise`](#inputsrevise--inputsrevisionpending--inputsreplacerevision--explicit-corrections)
  takes. Only a caller holding `inputs.answer` and `runs.control` as well as `runs.read`
  sees it, and only on a writable daemon with the revision services.
- **`pendingRevisions`** lists the current correction at each revision destination of an
  explicit batch of runs, apart from the open inputs and never counted in `waiting`. It is
  present only with the revision services. The batch is `revisionRunIds`, 1–20 unique
  exact run ids, defaulting to `[runId]` and never to descendants or the whole store.
  Without either, the answer is empty with `incomplete: true, reason: "run-scope-required"`.
  At most 50 items, metadata only (`target`, `expectedRevision`, `state`,
  `unavailableReason?`); correction text needs `inputs.revisionPending`. `incomplete: true`
  with `reason: "limit"` or `"boundary-unavailable"` says it is not the whole answer.

A change in the caller's authority while these are read refuses the whole response rather
than returning part of it.

### `claims.list` — who owns which work item

```ts
params: { runId?; workItemId? }
result: { claims: ClaimView[]; asOf }
```

Oldest first. A claim is `workItemId`, `workItem?`, `branch`, `stepRunId?`, `claimedAt` and
its `owner`: `runId`, `name?`, `status`, `missing` (no log for that run any more, shown as
`stale`), and `releasable` — true when the owning run cannot resume, which is exactly when
`orca claims release` does not need `--force`.

### `artifacts.list` — the artifact index, filtered

```ts
params: { runId?; name?; kind?; producedByStepRunId?; limit = 200; offset = 0 }
result: { artifacts: ArtifactView[]; total: number; asOf }
```

Metadata only — a version list must not cost the bodies it lists. Grouped by `name`, oldest
version first, because `Artifact.version` is monotonic per (run, name): asking for one
`name` in one `runId` *is* the version list the docked panel steps through with `[` and `]`,
and each entry carries `producedByStepRunId` and `createdAt`, so "which step wrote v3, and
when" needs no second call.

Which steps *consumed* an artifact is not a field here: `runs.get` already gives every
`StepView`'s `inputArtifactIds`, so a client that has the run tree has the consumers, and
listing a gate's artifacts must not ship a run's provenance graph to draw six chips.

### `artifacts.get` — one artifact, with its body

```ts
params: { artifactId? } | { runId; name; version? }, plus maxBytes = 1_000_000
result: { artifact: ArtifactView; text?: string; omitted?: { reason; detail }; asOf }
```

Address it by `artifactId`, or by the (`runId`, `name`, `version?`) triple a deep link
carries (`orca://artifact/spec.md@v3`); without a `version`, the latest of that name. Giving
both addresses, or neither, is `PROTOCOL_MESSAGE`.

`text` is present exactly when `omitted` is absent. A body is declined rather than served
when the artifact's `mediaType` is not text (`reason: "binary"`) or its `size` is past
`maxBytes` (`reason: "tooLarge"`); `detail` says so in words, because it is what a panel
shows where the body would have been, and the size is on the `ArtifactView` beside it.
Declining is not an error — the panel still shows what the artifact *is*.

`ARTIFACT_MISSING` when the index has no such artifact, and equally when it has one whose
blob is gone.

### `config.get` — the workspace's configuration, as two documents

```ts
params: {}
result: { config: ConfigDocumentView; permissions: ConfigDocumentView;
          schema: ConfigFieldDescription[]; effective: { agents: Record<id, EffectiveAgentPolicy> }; asOf }
```

A read, answered by a `--read-only` daemon (#174, #266). **Two** documents, because ADR 0009
moved written permission grants out of the YAML: `config` is `orca.config.yaml` and
`permissions` is `orca.permissions.json` beside it. A `ConfigDocumentView` is
`{ document, path, exists, revision, text, parsed? }` — `revision` is the sha256 of the bytes
(`""` when the file is not there), `text` the bytes verbatim, and `parsed` the document as
YAML/JSON read it, *before* schema defaults, which is what a form binds to.

**Editor bytes are unredacted and require `config.read`.** `text` is the file, host entries and command lines included. A form
that edits a file has to show the file, and a redacted text written back would destroy what
it hid. Loopback is the default bind address, not a caller identity. Default token mode
authenticates and authorizes HTTP/WS before projection. Grant raw config reads only to
callers trusted with these bytes, including environment values. The MCP operator's
redacted effective-config projection is a separate contract, not editable raw text.

`schema` describes `OrcaConfigSchema`, walked at runtime rather than written out by hand:
`{ path, type, enum?, required, default?, help? }` per field, with an array's element type
written once as `hosts[]` and a discriminated union flattened — every branch's fields at one
path, the discriminators merged into one `enum`, and a field only some branches have marked
not required. A node the walker cannot describe is `type: "unknown"`, never guessed at.

`effective` is each configured agent's policy **as it is actually evaluated**: the configured
rules first, then the sidecar's, then the built-in defaults (#140), first match wins, each
labelled `source: "config" | "permissions" | "default"` and carrying the sidecar's `addedAt` /
`grantedFor` where it has them. `default` — the fallthrough for a call no rule matched — comes
from configuration alone, because neither the sidecar nor the default layer carries one. It is
computed here so a renderer never re-implements evaluation order (ADR 0009, as corrected by
#140).

### `config.set` — write one of them

```ts
params: { document; expectedRevision; text? | patch?: { path; value? }[]; validateOnly? }
result: { document: ConfigDocumentView; written; validation?: { errors: { path; message }[] }; asOf }
```

A write, so it is in `CONTROL_METHODS` and absent from a `--read-only` daemon;
current operation authority requires `config.write` **and** `config.read`, because every
save or validation receipt carries the unredacted document bytes, even for an empty patch.
Discovery omits it from a caller without both. Exactly one of `text` and `patch` — they
are different promises. `text` replaces the bytes; `patch` edits the parsed YAML *document*
in place, so every comment and every piece of formatting survives. The daemon never
re-serialises the parsed config, which would materialise every schema default into the file
and delete every comment in it. A patch entry with no `value` deletes the key.

`expectedRevision` is the `revision` the edit was made against (`""` asserts the file did not
exist). Anything else is **`CONFIG_STALE`**, with `details: { document, expectedRevision,
actualRevision }` — a refusal rather than a merge, because the daemon cannot know which of two
edits to a field was meant. A schema failure is `CONFIG_INVALID` with `details.errors` keyed
by dotted path (`hosts[1].type`), so a form places each message on the field it belongs to;
`validateOnly` reports the same list instead of throwing and writes nothing.

The sidecar write goes through the writer in `@orca/agents`, under its `link()` lock and in
its fixed key order, so an operator's save and a run answering "always" both land. It is
therefore *canonicalised* rather than stored verbatim — the one place `text` does not round
trip byte for byte. A `permissions` document carrying a `default` is refused: answering one
prompt must not change the answer to every other one (ADR 0009).

**Saving and activation are separate.** `config.set` saves; guarded `config.apply`
validates/activates supported settings and assets for new admissions. Bootstrap settings
require restart; existing work restores captured generation material. Permission sidecars
are loaded on every permission ask, independently of apply. See
[generations](../../docs/configuration-generations.md) for result states, mandatory
revision/generation guards and restoration limits. Live permission continuity has its
separate owner/session/turn/lease lifetime ([live input](../../docs/live-input-continuity.md)).
`config.set` takes no run lease and appends no run event. App appearance preferences
have their own app-owned lifetime.

## The plan methods

Nine reads under `plan.read` (#169). They project `PlanService`, and every one of them takes
an explicit `planId`: a daemon serves a store rather than a person, so it has no default plan
and `plans.list` is how a client finds one.

**Nothing here carries a date estimate** (#169). `criticalPathLength` is in the plan's own
estimate units and is not a duration; `dueBy` on a decision is something a person wrote down.

### `plans.list` / `plan.get` — the plan, and what is in it

```ts
params: {} | { planId }
result: { plans: PlanView[]; asOf } | { plan: PlanView; asOf }
```

A `PlanView` is `id`, `key`, `title`, `description`, `status`, `requestIds`, `counts` (one
number per classification, and every item is in exactly one), `riskMatrix`, `policy`
(`strategy`, `concurrency`, `riskAppetite`) and the timestamps. Deliberately *not* the
snapshot: items, dependencies, risks, decisions and the journal are five calls of their own.

### `items.list` — the schedule table

```ts
params: { planId; status?; classification?; requestId?; text?; limit = 200; offset = 0 }
result: { items: PlanItemView[]; total: number; asOf }
```

In schedule order — ready first and best first, then running, waiting, held, unschedulable
and the settled ones — so a client that renders the rows as given is showing the order a
dispatcher would take. `total` counts the filter, not the page.

A `PlanItemView` is the `WorkItemView` (`id`, `slug`, `title`, `status`) plus `requestId`,
`kind`, `priorityBand`, and the four things only the scheduler knows: `classification`
(`ready | running | waiting | held | unschedulable | done | failed`), `priority`
(`score` and the `reasons` behind it), `risk` (the open risks that name this item, scored and
levelled) and `claim` (the run holding it, if one does). A *cancelled* item reports `failed`
here; its own `status` still says `cancelled`.

### `schedule.get` / `schedule.explain` — what may run, and why

```ts
params: { planId } | { planId; workItemId }
result: { schedule: ScheduleView; asOf } | { lines: string[]; asOf }
```

`ScheduleView` is `core`'s `CompactSchedule` with the work-item id added to every bucket
entry: `ready` with scores and reasons, `waiting` with one line per unmet dependency, `held`
with the level and the reason, `unschedulable`, `waves`, `criticalPath`, `cycles`, the risk
summary and the open decisions.

`schedule.explain` returns the lines `orca plan explain <slug>` prints, in the same order and
word for word — `core`'s `explainWorkItem`, then one line per dependency and one per risk that
names the item. They are strings on purpose: giving a client the parts to re-sentence would
let the popover and the terminal disagree about why an item is blocked, which is the one thing
this method exists to prevent. `workItemId` takes an id or a slug.

### `dependencies.list` / `risks.list` / `decisions.list`

```ts
params: { planId; workItemId?; status? }
result: { dependencies: DependencyView[]; asOf }
params: { planId; status?; workItemId? }
result: { risks: RiskView[]; matrix; appetite; asOf }
params: { planId; status? }
result: { decisions: DecisionView[]; asOf }
```

A `DependencyView` carries both the stored `status` and the scheduler's live `evaluation`
(`state` and a one-line `detail`), and they can differ: `status` is what was last written,
`evaluation` is what the plan says now. Its `target` is resolved for display — a work item
with its slug and any `stage`, a decision with its key, or an external key.

`risks.list` answers highest score first, with the plan's `matrix` and its `appetite` beside
the rows, because a level means nothing without the grid it was scored on. `decisions.list`
carries the criteria, the options, the matrix `result` and `blocks` — the work items the
decision gates, which are the dependencies targeting it, resolved; a `Decision` keeps no copy.

### `journal.list` — the audit trail, paged

```ts
params: { planId; after?; before?; types?; limit = 200 }
result: { entries: PlanJournalEntryView[]; nextCursor?; prevCursor?; hasMore; lastSeq; asOf }
```

Exactly `runs.events`'s cursor semantics over the plan journal's per-plan sequence: `after`
walks forward, `before` walks back to the `limit` entries immediately preceding one, both
read oldest first, and giving both is an error. An entry carries its `payload` as the journal
recorded it plus `summary`, the one-line rendering `orca plan journal` prints.

## The push channel

### `subscribe` / `unsubscribe` — socket only

```ts
params: { runId?; methods?: NotificationMethod[]; since? }
result: { subscriptionId; replayed }

params: { subscriptionId }
result: { stopped }
```

`runId` absent means every authorized run in the store. `methods` absent or empty
means all eleven notification methods, subject to current per-notification authority.
`since` is a resume cursor and **requires `runId`** — see below. `stopped: false` means the
id was not live; unsubscribing twice is not an error, and closing the socket ends every
subscription on it.

Over `/rpc` these answer `NOT_SUPPORTED` — there is nowhere to push to. When the
subscription source is installed, they join the method table; authenticated discovery
and each call still apply current authority. The coarse capability is `runs.subscribe`.

### The eleven notifications

Six are derived from a run log. Each carries `subscriptionId` (one connection may hold several),
`runId`, `seq` — the sequence number, within that run, of the event behind it, and therefore
**the cursor** — and `at`, the event's own timestamp rather than the moment the frame was
sent. The seventh run-scoped method, `input.invalidated`, is ephemeral: it carries
`runId` but no `seq`, is never replayed and never advances a run cursor. The other
four are not about a run and carry no `runId`: `agent.changed`,
`workflows.changed` and `config.changed` are about the process and about the workspace's
files and have no cursor at all, and `plan.changed` is about a plan and carries the *plan
journal's* sequence number, which is not something `subscribe({ since })` takes. Each has its
own section below.

- **`run.changed`** — `status`, the `run.*` `event`, and `outcome?` / `reason?` / `error?`.
- **`step.changed`** — `stepRunId`, `status`, `event`, plus `nodeId`/`nodeType`/`attempt` on
  the `step.scheduled` that introduces the step, `waitingOn?` on `step.waiting`, and
  `willRetry?` / `error?` on `step.failed`.
- **`agent.update`** — `stepRunId`, `sessionId`, `fromSeq`, and a non-empty `updates`. Batched.
- **`input.opened`** — `stepRunId`, `requestId`, `kind`, `question`, `options` (whole
  `GateOption`s since 1.4) and `agent?` (since 1.6). The agent comes off the event rather than
  out of a read, which is what keeps this fold a pure function of one event; `hostType` is
  therefore only on `inputs.list`, where the registry can be asked.
- **`input.answered`** — `stepRunId`, `requestId`, `answer`.
- **`input.invalidated`** — `subscriptionId`, `runId`, exact live `target` and `at`;
  owner-local live callback invalidation. Re-read `inputs.list`
  for current availability. Losing the callback/lease does not fabricate a run event.
- **`event.appended`** — the raw `OrcaEvent`, for a timeline that renders events rather than
  state. **Excludes `agent.update` events**, which arrive coalesced instead, so agent output
  is never shipped twice.
- **`agent.changed`** — `at` and the whole `AgentView`. No `runId`, no `seq`, no replay.

A folded notification is sent *before* the `event.appended` for the same event, so a client
watching only the folded stream is never behind one watching both.

`run.changed` and `step.changed` are derived from the transition alone — no store read per
event, no lease check — so **they never carry `stale`**. A lapsed lease is the *absence* of
events, which no stream can announce; a client that cares re-reads `runs.list`.

`parseNotification(message)` validates an envelope into the `DaemonNotification` union, so
`switch (n.method)` narrows `n.params`. It returns `undefined` for a method this build does
not know — a newer daemon's — because dropping it is the compatible thing to do.

### Resuming

Sequence numbers for log-derived run notifications are per-run and gap-free, which
is what makes the cursor work. Keep the highest `seq` for that run; on reconnect send
`subscribe({ runId, since: seq })`; the daemon replays
`since + 1` onwards and then the live stream takes over, with `replayed` saying how many
frames the replay sent. There is no gap and no duplicate: the daemon attaches its listener
**before** reading the log, buffers what arrives during the read, and drops anything at or
below the last replayed sequence number. The persisted run log supplies replay;
ephemeral `input.invalidated` has no replay cursor. Re-read `inputs.list` after reconnect
to obtain current callback identity/availability. See the
[subscription contract](src/subscriptions.ts).

`since` requires `runId` because a store-wide subscription interleaves numbers from
unrelated logs and has no single cursor; it reconnects fresh and the screens behind it
re-read.

### Batching

**At most one `agent.update` per step per 100ms, coalescing the lines.** An agent turn
appends as fast as the agent speaks, and one frame each would make the socket, not the
model, the slow part of watching a run. Coalescing never reorders: a held batch is flushed
before any other notification for the same run and on unsubscribe, so agent output never
lands after the `step.completed` that ended it.

One limit worth knowing: the socket fans out *this process's* event store. A run appended by
a separate CLI process is not pushed and appears on the next read. That is a property of an
in-memory listener list and not of the store — reads have always been current, and are more
so since #196 — so the fix, when it is wanted, is a watcher rather than a lock.

### `agent.changed` — a push that is not about a run

```ts
params: { subscriptionId; at; agent: AgentView }
```

In the union since **1.5**, and the first with neither `runId` nor `seq`. Agent health
lives in the daemon's memory and not in any log: there is no run it belongs to, no sequence
number to resume from, and nothing for a reconnect to replay, because the current answer is
one `agents.list` away. A client that folds a run cursor checks both the matching
`runId` and numeric `seq` on log-derived notifications. Neither `input.invalidated`
nor the plan journal's `plan.changed` sequence advances that cursor.

**1.4 kept it out of the union and 1.5 puts it in (#241).** The exclusion was meant to keep
every cursor fold simple, and it did the opposite: a fold that compared `runId`s was already
true on a store-wide subscription, so the special case existed and was merely unwritten, and
`parseNotification` dropped the method — which meant the daemon was sending a frame no client
could receive. A second parser would also have meant a second route and a second unsubscribe
for one socket. `parseAgentChanged` is gone; `parseNotification` handles it like any other
method, and a build that does not know it still drops it, which is the compatible thing to do.

A daemon sends it only to subscriptions that did **not** scope themselves to a run, and only
on a handshake succeeding or failing — never on `lastSeenAt` moving, which happens with every
batch of agent output and would be exactly the firehose the `agent.update` coalescing exists
to prevent.

### `workflows.changed` — activated asset invalidation

```ts
params: { subscriptionId; id; version; removed?; at }
```

The second push that is not about a run, added in **1.7** (#174). Like `agent.changed` it has
no `runId` and no cursor: a client re-reads `workflows.get`.

Successful configuration activation emits this invalidation for added/changed and
removed workflow IDs (`removed: true` for removal), filtered by current workflow
authority. Re-read the affected snapshot. No notification is emitted for failed apply
or validate-only. There is no filesystem watcher; an explicit activation is the asset
refresh boundary, including template-only changes. That is `config.apply`, or the
activation that `templates.publish` and `workflowDrafts.publish` perform, and all three
announce the same way.

### `config.changed` — the third push that is not about a run

```ts
params: { subscriptionId; document; revision; path; kind?: "saved" | "activated";
          generation?; at }
```

New in **1.7** (#174, #266), and it follows `agent.changed` in every respect: store-wide
subscriptions only, no `runId`, no `seq`, nothing to replay — a client reconnecting re-reads
`config.get`.

Both writers announce. A successful `config.set` sends one, and so does ORCA writing the
sidecar itself when an `inputs.answer` with `always` appends a standing grant, because a
configuration screen that only heard about its own writes would show a policy that stopped
being true the moment a run answered a prompt (ADR 0009: the sidecar is meant to be read).
An `always` that added nothing — the rule was already recorded — sends nothing.
Successful `config.apply` also announces activation with the generation; a client
must compare that state even if the saved revision is unchanged. Validation and
failed apply do not publish activation.

It carries no `text`: a document can be large and the frame goes to every store-wide
subscriber. An equal revision can suppress a duplicate document read for a `kind: "saved"`
echo already reflected in the client's state. It cannot suppress activation handling:
compare the authoritative generation/status, and refresh the held configuration state
when it changes even if the document hash is equal. See the
[activation event](../daemon/src/config-model.ts) and
[generation contract](../../docs/configuration-generations.md).

### `plan.changed` — a push about the plan, not about a run

```ts
params: { subscriptionId; planId; kinds: ("items"|"dependencies"|"risks"|"decisions"|"schedule"|"journal")[]; seq; at }
```

One frame per plan journal entry, on store-wide subscriptions only — a plan outlives every
run in it, so a run screen would be woken by work it is not showing.

`kinds` is coarse and is folded from the entry's *type alone*: the push never reads the
store. Almost everything includes `schedule`, because almost everything changes what may run
now, and everything includes `journal`, because every entry is one. A client is told which
areas to consider stale and re-reads the one list it is holding; `seq` is the plan journal's
per-plan, gap-free sequence number, so a frame already folded can be told from a new one.

There is no replay: `since` still refuses to travel without a `runId`, and the current answer
is one `schedule.get` away.

## The control methods

These mutation methods are omitted by a `--read-only` daemon. Coarse discovery
capabilities describe method families; they do not grant every operation in a family.
The [operation matrix](../daemon/src/auth/operations.ts) checks current permissions
and resource scope for each call:

| Operation | Required operation permission |
| --- | --- |
| `runs.start` | `runs.start`, scoped to the workflow |
| `runs.resume`, `runs.cancel` | `runs.control`, scoped to the run |
| `inputs.answer` | `inputs.answer`, scoped to the input; `always` additionally requires `permissions.grant` |
| `claims.release` | `claims.release`, scoped to the claim |
| `config.set` | `config.write` and `config.read` |
| `config.apply` | `config.write` |
| `dependencies.waive`, `decisions.decide`, `decisions.reopen`, `risks.update` | `plan.write` |
| `requests.submit`, `requests.reconcile`, `requests.admission`, `requests.admissions` | `plan.write` and `runs.start` |
| `runs.admit` | `runs.start`, scoped to the workflow |
| `admissions.get`, `admissions.reconcile` | `runs.start`; a Request receipt also needs `plan.write` |
| `runs.continue`, `continuations.reconcile` | `runs.control`, scoped to the run; a decision also needs `inputs.answer` |
| `inputs.revise`, `inputs.replaceRevision` | `inputs.answer` and `runs.control`, scoped to the run |

The admission, continuation and revision methods are installed only where their services
are (see the [method inventory](#method-inventory)); the template and workflow-draft writes
have [their own sections](#template-authoring--templates), and the
[operator aliases](#the-operator-methods) wrap these same services.

### `inputs.answer` — settle an open gate or permission ask

```ts
params: { requestId; runId?; optionId; note?; always?: { decision: "allow" | "deny" };
          live?: LiveDecisionTarget; resume = true }
result: { requestId; runId; answer; permission?; run?; asOf }
```

`optionId` is an option's **`id`** (the free text, for a question that offers none).
For a durable workflow gate, `resume` re-drives the run under this daemon's lease and
returns once it is parked again or finished, so `run` is a settled status rather than
a snapshot mid-flight. `resume: false` records the durable answer without resuming,
as with `orca answer --no-resume`.

For a live permission callback, copy the selected input's `input.live.target` into
the answer's `live` field. The [read wrapper](src/live-input.ts#L15-L18) is `{ target, state }`;
the answer takes the nested target alone. Its `instanceId`, `sessionId`, `turnId`,
`invocationId`, `runId`, `stepRunId` and `requestId` identify the original callback.
The [answer schema](src/control.ts#L46-L48) permits omission for durable gates;
the [live-answer handler](../daemon/src/control.ts) requires it for a live reply,
rechecks current server-bound authority and callback/lease availability, and refuses
`resume: false` with `NOT_SUPPORTED`. Delivery goes to the original valid turn.
An expired or unavailable owner cannot be recovered by reusing the identity. See
[live input continuity](../../docs/live-input-continuity.md) for these lifetime rules.

Answering a *permission* ask allow-once / allow-always / deny is: the allow option's id;
the allow option's id plus `always: { decision: "allow" }`; the reject option's id. The
standing rule an "always" answer implies is appended to the workspace permission sidecar
(ADR 0009) and `permission` carries `recordAlwaysDecision`'s own `rules` / `added` /
`alreadyPresent` / `refused` **verbatim** — a button that promises "ORCA will not ask again"
has to be able to check whether that is true, and `refused` is the case where it is not.

`always.decision` is stated by the client rather than inferred from the option id, because
those ids are the *agent's* and a standing permission grant is the last place to guess.

`note` is why this option and not which one. It does not reach the workflow, which branches on
the option id alone, and it **does** reach the run's log as of #238: `human.answered` carries
it beside the answer, so a client may show it as something the run recorded, because it is.
Until then the daemon wrote it to the *operator's* log — a person's reasoning attached to
whichever terminal the daemon was logging to, and to nothing that outlived the run.

`INPUT_ANSWERED`, `INPUT_OPTION_UNKNOWN`, `RUN_NOT_WAITING`, `RUN_LEASED_ELSEWHERE`.

### `runs.resume` / `runs.cancel`

```ts
params: { runId }                      result: { run: RunSummaryView; asOf }
params: { runId; reason? }             result: { run: RunSummaryView; asOf }
```

`runs.resume` walks up to the topmost parked ancestor and re-attaches on the way down, so a
gate answered inside a child continues the tree and not just the child. `runs.cancel` closes
the run and the children it is waiting on.

Both refuse a run another **live** process is interpreting, immediately and with that
holder's pid and host (`RUN_LEASED_ELSEWHERE`). They never wait on a lease: a client on an
open HTTP call cannot tell waiting from hanging. A *lapsed* lease is not a refusal — its
holder stopped heartbeating, so the next interpreter takes it over, which is what the ttl is
for.

### `runs.start` — direct workflow launch with optional existing associations

```ts
params: { workflowId; vars = {}; workflowVersion?; expectedWorkflowRevision?;
          expectedConfigGeneration?; idempotencyKey?; requestId?; workItemId? }
result: { runId; run: RunSummaryView; asOf }
```

Direct launch creates a run for the selected workflow; it does not implicitly create a
Request or decompose it into work items. Optional `requestId` and `workItemId` associate
existing documents. The [orchestrator](../engine/src/orchestrator.ts) reads and validates
them before creating the run: a supplied Request must exist, a supplied work item and
its Request must exist, and supplying both requires matching associations. Missing or
mismatched documents fail with `RUN_STATE`. Provisioning also reads these associations;
the launch is not document-read-free. Valid associations are recorded on `run.created`
and exposed on `run.changed`.

The [resource guard](../daemon/src/auth/guard.ts) additionally requires `plan.read`
when `requestId` is supplied, and both `plan.read` and `plan.write` for `workItemId`.
Workflow launch authority alone does not make those workspace documents accessible.

`workflowVersion` and `expectedWorkflowRevision` are the exact pair
`workflows.validateInputs` returned; a stale revision is `WORKFLOW_INVALID`.
`expectedConfigGeneration` names the active configuration generation the caller reviewed.
If another one is active the launch is refused with `CONFIG_STALE` ("active configuration
changed; refresh before launching"), and a daemon without configuration generations
refuses the guard with `NOT_SUPPORTED`.

**Under default `orca serve`, `runs.start` is a durable admission.** Where retry admission
is wired, which a writable token-mode `orca serve` does, `runs.start` goes through the
same admission as [`runs.admit`](#runsadmit--admissionsget--admissionsreconcile--durable-direct-admission),
under the same `run.admit` operation kind, and then waits as it always has:

- `idempotencyKey` identifies one launch intent and must be 1–128 UTF-8 bytes; anything
  else is `WORKFLOW_INPUT_INVALID`. Sending the same key with the same command again returns
  the original admission instead of starting a second run. The same key with a different
  command is `RETRY_CONFLICT`. Without a key there is no deduplication.
- An `accepted` admission is settled as before: the call drives the new run under this
  daemon's lease and returns `{ runId, run, asOf }`.
- **Anything short of `accepted` is a refusal, not a receipt.** It is `RUN_STATE` "Run
  admission requires reconciliation", with the receipt in `details`: `state` (`prepared` or
  `recoverable-failure`), `admissionId`, `operationId`, and `runId?` / `failure?`. Bounded
  contention is `RUN_STATE` "Run admission is in progress", with
  `details: { state: "in-progress", operationId, recovery: "inspect-or-retry" }`. Either
  way, `details.operationId` is what `admissions.get` and `admissions.reconcile` take.

Without retry admission (an `--unauthenticated-loopback` daemon, or an embedder that wires
none) `runs.start` launches through the orchestrator directly, and an `idempotencyKey` is
refused with `NOT_SUPPORTED` ("Retry admission is not configured").

### `runs.admit` / `admissions.get` / `admissions.reconcile` — durable direct admission

```ts
params: { workflowId; vars?; workflowVersion?; expectedWorkflowRevision?; expectedConfigGeneration?;
          requestId?; workItemId?; idempotencyKey?;
          expectedScope?: { principalId; workspaceId } }
result: { operationId; admissionId; state: "prepared" }
      | { operationId; admissionId; state: "accepted"; runId }
      | { operationId; admissionId; state: "recoverable-failure"; runId?;
          failure: { code; message; recovery: "reconcile" } }

params: { operationId } // "retry_" and a UUID; the same for both
result: { state: "resolved"; operationId; replayed: boolean; result }
      | { state: "in-progress"; operationId; recovery: "inspect-or-retry" }
```

`runs.admit` is `runs.start`'s durable admission without the wait. It returns the receipt
once admission is recorded, and an `accepted` run's first execution is dispatched in the
background. Only `accepted` promises admitted work, and it is neither completion nor
attachment: `runs.get`'s `admissionExecution` says what is known about that first
execution. Bounded contention is `RUN_STATE` "Run admission is in progress" with the
`in-progress` envelope in `details`, never a fabricated receipt. Params are strict, and the
params schema itself holds `idempotencyKey` to 1–128 UTF-8 bytes, so a bad key is
`PROTOCOL_MESSAGE` here; a good one deduplicates exactly as it does for `runs.start`.
`expectedScope`, when it is given, must name the caller's own verified principal and the
daemon's workspace, or the call is `AUTH_FORBIDDEN` before anything is admitted. The
resource guard applies `runs.start`'s `requestId` / `workItemId` grants.

`admissions.get` inspects and `admissions.reconcile` recovers a retained operation by
`operationId`. Only the caller's own operations in this workspace are found; anything else
is `RUN_STATE` "Retry operation is unavailable". `result` is the retained receipt of the
operation's own kind, a `requests.submit` receipt (with `requestId`, and needing
`plan.write`) or a `runs.admit` / `runs.start` one. Reconciling an `accepted` direct
admission whose run never attached dispatches it.

**Only two operation kinds can be inspected or reconciled here: `request.submit` and
`run.admit`.** The same retry facility also keeps `revision.submit`, `revision.replace` and
`run.continue` operations, but an `operationId` of those kinds is refused with
`NOT_SUPPORTED` ("This operation's receipt dispatcher is not installed"), even though the
`in-progress` envelope their own methods return says `inspect-or-retry`. A continuation
has `continuations.get` / `continuations.reconcile` by `continuationId`. A revision is
recovered only by sending the same `idempotencyKey` and command to its method again; its
current state is `inputs.revisionPending`, and `inputs.list`'s `pendingRevisions` finds the
target. See [admission retry](../../docs/admission-retry.md) for comparison rules, limits and
quotas (`RETRY_LIMIT`).

### `runs.continue` / `continuations.get` / `continuations.reconcile` — durable continuation

```ts
params: { command: { runId; expectedBoundary; decision?: { requestId; optionId; note? } };
          retry = { idempotencyKey? } }
result: { state: "resolved"; operationId; replayed: boolean; result: ContinuationReceipt }
      | { state: "in-progress"; operationId; recovery: "inspect-or-retry" }

params: { continuationId } // "ct_" and a UUID; the same for both
result: ContinuationReceipt

ContinuationReceipt: { operationId; continuationId; runId; expectedBoundary;
                       state: "prepared" | "accepted" | "blocked" | "settled";
                       blockedReason?: "authority-unavailable" | "leased" | "unsafe-boundary"
                                     | "generation-unavailable" }
```

The durable counterpart of `runs.resume`, and of `inputs.answer` plus resume when a
`decision` is included (`optionId` and `note` at most 16,384 characters). `expectedBoundary`
is copied from [`runs.get`](#runsget--one-runs-tree)'s `continuation.expectedBoundary`, an
opaque guard the daemon issues only for a boundary it supports; a client never builds one.
If the run has moved on, the call is `CONTINUATION_STALE` ("Continuation boundary has
changed"). Admission writes one protected decision-plus-dispatch marker and returns;
execution is attached in the background, and the receipt moves on to `settled`, or to
`blocked` with a `blockedReason`. The retry key follows the shared 1–128-byte rule.

`continuations.get` reads a receipt and needs `runs.read` on its run. `continuations.reconcile`
needs the original principal and `runs.control` (and `inputs.answer` when the original
included a decision), and may attach execution. An unknown, foreign or rewound continuation
is `RUN_STATE` "Continuation is unavailable"; durability that cannot be verified is
`RUN_STATE` with `details.uncertain: true`. A run past 100,000 events is refused with
`NOT_SUPPORTED`. See
[continuation composition](../../docs/runtime-operator-integration.md#current-continuation-composition)
for the boundaries supported.

### `inputs.revise` / `inputs.revisionPending` / `inputs.replaceRevision` — explicit corrections

```ts
params: { command: { target: RevisionTarget; actionId; payload; supersedesRevisionId? };
          retry: { idempotencyKey? } }                                    // inputs.revise
params: { target: PendingRevisionTarget }                                 // inputs.revisionPending
params: { command: { target: PendingRevisionTarget; expectedRevision; payload };
          retry: { idempotencyKey? } }                                    // inputs.replaceRevision

RevisionTarget: { runId; stepRunId; requestId; destinationId; expectedRevision }
PendingRevisionTarget: { runId; revisionId; destinationId; attemptId }
payload: { kind: "text"; text } | { kind: "values"; values }

result: { state: "resolved"; operationId; replayed: boolean; result: RevisionReceipt }
      | { state: "in-progress"; operationId; recovery: "inspect-or-retry" } // revise, replace
RevisionReceipt: { revisionId; target; state: "pending" | "delivered" | "rejected" | "superseded";
                   attemptId; currentRevisionId; expectedRevision }
result: { target; expectedRevision; state; payload?; boundary?; replacementAllowed;
          unavailableReason?: "delivered" | "target-changed" | "cancelled"
                            | "delivery-uncertain" }                      // revisionPending
```

A revision-enabled gate offers "Request changes" as an action of its own. `inputs.revise`
records a correction for the workflow-declared destination together with the exact branch
decision, as one commit, with no separate `inputs.answer`. Its `target` and `actionId` come
from the input's [`revision`](#inputslist--the-attention-surface) field, and that option
cannot be chosen through `inputs.answer`. `inputs.replaceRevision` swaps the payload of the
one undelivered correction at a destination and attempt, by compare-and-swap on
`expectedRevision`, and stays available after the gate has closed. A payload is at most
64 KiB, the whole params at most 256 KiB, nesting at most 32 deep, and a retry key 1–128
UTF-8 bytes. A target or version that no longer accepts the correction is `REVISION_STALE`.

`inputs.revisionPending` needs `runs.read`; its `payload` and `boundary` come back only to a
caller who also holds `inputs.answer` and `runs.control`. A lost `inputs.revise` or
`inputs.replaceRevision` response is recovered by sending the same key and command again,
not through `admissions.get`. See [revision input](../../docs/revision-input.md).

### Request admission — conditionally installed shared service

`requests.submit`, `requests.reconcile`, `requests.admission` and `requests.admissions`
are implemented. The [method table](../daemon/src/methods.ts) installs them only when
control, the Request submission model and its authority provider are present;
[production serve wiring](../cli/src/commands/index.ts) supplies those dependencies.
Inspect the caller's current `hello.methods` rather than assuming every daemon exposes them.

The [Request protocol schema](src/request-submission.ts) defines submission commands
with optional `idempotencyKey`, reconciliation/inspection by `admissionId`, and listing.
The [operation guard](../daemon/src/auth/guard.ts) requires both `runs.start` and
`plan.write` for these methods; the shared service additionally enforces workspace,
workflow scope and current admission authority. The receipt records
durable acceptance, separately from execution attachment or completion. See
[Request submission](../../docs/request-submission.md) for typed launch guards, result
states and the CLI/daemon retry boundary, and
[admission retry](../../docs/admission-retry.md) for exact retained envelopes.

### The plan writes — `dependencies.waive`, `decisions.decide`, `decisions.reopen`, `risks.update`

```ts
params: { planId; dependencyId; rationale? }      result: { dependency: DependencyView; asOf }
params: { planId; key; option; rationale? }       result: { decision: DecisionView; choice; recommended?; asOf }
params: { planId; key }                           result: { decision: DecisionView; reopenedDependencyIds; asOf }
params: { planId; key; status }                   result: { risk: RiskView; asOf }
```

Not guarded by a run lease, because a plan is not a run: what serialises them is
one `PlanService` instance's in-memory per-plan queue. Per-file locks protect document
updates, but the document and journal writes are separate persistence operations, not
a cross-process transaction. Each write journals with
`PlanOrigin { kind: "human", actor: "daemon" }` — the same shape `orca plan` writes with
`actor: "cli"`. The journal is the audit trail, and "a human, through the daemon" is the
honest entry: these only ever run because a person pressed something.

**Automatic matrix decisions preserve an already-decided choice** (#104). Explicit human
decisions can replace it without reopening. Deciding one the
same way again is idempotent and journals nothing; deciding it *differently* re-decides it,
which is what asking for it means. `recommended` comes back beside the choice when the
decision has a matrix, so a client can show that a person went against it without the daemon
deciding what that means. An option the decision does not offer is `PLAN_INVALID` — the
daemon does not fall back to the matrix on a person's behalf.

`decisions.reopen` names the dependencies it set back to `open`, because that is the
consequence: items that were dispatchable a moment ago are not any more.

`risks.update` moves a risk along `open → mitigating → mitigated | accepted | realized →
closed`. Accepting one is how an item held above the plan's appetite is released without
changing the appetite. Only `status` may be set from here.

### `claims.release` — take a work item back from a dead run

```ts
params: { workItemId; force = false }
result: { claim: ClaimView; note?: string; asOf }
```

A claim is never released on its own (#88): a finished run keeps its items so they are not
dispatched twice, and a claim outlives the process that took it. This is the operator's act,
and it is **refused with `RUN_STATE` while the owning run could still resume** — running,
paused or waiting — unless `force`. `ClaimView.owner.releasable` from `claims.list` predicts
which it will be, so a confirmation can be honest before the call rather than after it.

`note` is what releasing did *not* fix: the claim decides who may launch the item, but the
item's own status is projected from the owning run's log, and a dead run's log never moves
on — so an item left `in-progress` is still treated as running by the scheduler. It is the
same sentence `orca claims release` prints.

## The agent methods

`agents.list` requires `agents.read`; `agents.ping` requires `agents.ping`, as defined
by the [operation matrix](../daemon/src/auth/operations.ts). A `--read-only` daemon
can expose both, subject to current caller authority. Listing reads in-process health;
ping spawns an agent to perform a handshake and updates that health. Neither drives
a workflow run or acquires its lease; discovery is not permission to spawn an agent.

### `agents.list`

```ts
params: {}
result: { agents: AgentView[]; claims: ClaimView[]; asOf }
```

Every *configured* agent in config order, contacted or not. `AgentView`: `id`, `hostId`,
`hostType?` (`local` | `ssh`, since 1.5), `roles`, `state` (`unknown` | `ok` | `degraded` |
`down`), `lastHandshakeAt?`, `lastSeenAt?`, `roundTripMs?`, `consecutiveFailures`,
`lastError?`. `hostType` is absent only when the host has left the config under the agent —
the transport is not guessed. Health is in-process and does not
survive a restart, so a freshly started daemon says `unknown` for all of them rather than
claiming `ok`; `degraded` means the handshake worked but only after one failed, and there is
deliberately no latency rule.

**Two timestamps, because they answer different questions (#227).** `lastHandshakeAt` is when
ORCA last *established* a connection — what `state`, `roundTripMs` and `consecutiveFailures`
are all about. `lastSeenAt` is when the agent last said anything, and it moves with its
output. A per-run pooled session handshakes once and then talks for an hour, so one timestamp
would have to choose between "the connection is an hour old" and "it spoke a second ago".

`claims` is what is being worked right now, projected exactly as `claims.list` projects it:
the surface's second question, after "is it up", is "and what is it on".

### `agents.ping`

```ts
params: { agentId; cwd? }
result: { agent: AgentView; ok; roundTripMs?; error?; asOf }
```

Spawns the agent, completes the ACP handshake, closes, and records the result — in the
daemon's own process, so what it proves is that *the daemon* can reach the agent. It pushes
`agent.changed` afterwards rather than leaving the caller to re-list. A failed handshake is a
result and not an error envelope: "down, and here is why" is what the caller asked.

`orca ping <agentId>` calls this when a daemon answers on the configured address, and
otherwise falls back to an in-process handshake — saying, in those words, that it recorded
nothing (#225).

## The operator methods

Sixteen `operator.*` methods, six reads and ten mutation aliases, are a bounded and
allowlisted surface over the methods above for non-UI clients; the
[MCP operator](../../docs/mcp-operator.md) is built on them. They exist only on a token-mode
daemon with a workspace identity and the operator projection sources, which `orca serve`
supplies; `operator.hostResources` needs an injected host-resource source instead. Every
one but `operator.discover` takes `target: { workspaceId, instanceId }`,
which must equal `hello.identity`; any other is `RUN_STATE` "Target changed; discover the
deployment again" (the host read says "Resource target or observation changed; discover
again"). Each call checks the caller's original credential again, rather than the
authority it had when it connected. See [schemas](src/operator-reads.ts) and
[contracts](src/operator-mutations.ts).

### Reads

```ts
operator.discover    params: {}
                     result: { target; protocol; orcaVersion; principalId; authentication: "credential";
                               scope: { runs; workflows; permissions }; operations: string[];
                               collections: string[]; asOf }
operator.page        params: { target; collection; runId?; workflowId?; workflowVersion?; stepRunId?;
                               requestId?; cursor?; limit = 50 }              // limit at most 100
                     result: { target; items: OperatorRow[]; asOf; revision; nextCursor?;
                               truncated: boolean; restartRequired: boolean }
operator.config      params: { target }
                     result: { target; activeGeneration; activeRevision; savedRevision;
                               state: "active" | "pending" | "restart-required" | "invalid"; asOf }
operator.preflight   params: { target; purpose: "request" | "workflow"; workflowId?; workflowVersion?;
                               expectedWorkflowRevision?; expectedConfigGeneration?; vars = {};
                               overrides?; request?: { title; body; source; labels } }
                     result: { target; workflowId; workflowVersion; expectedWorkflowRevision;
                               expectedConfigGeneration; validation; inputSchema?; selections?;
                               itemWorkflow?; templatePack?; asOf }
operator.artifact    params: { target; runId; artifactId; maxBytes = 16384 }  // at most 16 KiB
                     result: { target; artifact: OperatorRow; text?;
                               omitted?: "binary" | "tooLarge" | "sensitive"; asOf }
operator.hostResources params: { target }
                     result: the host-resource snapshot
```

`operator.discover` says who the caller is, what it may do (`operations`, from the same
filter as `hello.methods`) and which `collections` it may page. `operator.preflight`
resolves a launch against the active generation, with no side effects, and returns the guards
(`workflowVersion`, `expectedWorkflowRevision`, `expectedConfigGeneration`) that
`operator.admitRun` and `operator.submitRequest` require. `operator.hostResources` is the
advisory host read in [host resources](../../docs/host-resources.md); `orca serve` does not
mount it.

`operator.page` reads one collection. Its grant is checked before its params are validated:

| Collection | Grant | Needs `runId` |
| --- | --- | --- |
| `runs` | `runs.read` | no |
| `steps`, `children`, `events`, `inputs`, `provenance` | `runs.read` | yes |
| `artifacts` | `artifacts.read` and `runs.read` | yes |
| `workflows`, `graph` | `workflows.read` | no, but a caller with a restricted workflow scope names `workflowId` or `runId` |
| `requests`, `items` | `plan.read` | no |
| `choices` | `config.read` | no |

A page stops at `limit` rows, or earlier when its JSON would pass
`(OPERATOR_MAX_RESULT_BYTES − 4096) / 3` bytes, `OPERATOR_MAX_RESULT_BYTES` being 256 KiB;
that leaves room for escaping and for an MCP reply that carries the page twice. Either way
it is `truncated: true` with a `nextCursor`. A row over 12 KiB
arrives as `{ id, kind, runId?, omitted: ["oversized-item"] }`.

**A stale cursor is a page, not an error.** A `nextCursor` is opaque, signed with a key this
daemon process holds, and bound to the caller, their scope and grants, the filter and the
collection's `revision`. When a cursor does not verify, was issued for a different binding
or revision, or the collection changes while the page is being read, the answer is an
ordinary result with `items: []`, `truncated: false` and `restartRequired: true`: page again
from the start, without a cursor. A daemon restart makes every old cursor stale. There is no
`OPERATOR_CURSOR_STALE` error code. See
[bounds and freshness](../../docs/mcp-operator.md#bounds-freshness-and-non-secret-projections).

### Mutations

The ten aliases adapt the authenticated services above and own no durable state of their
own. Each is installed only when the service it adapts is (see the
[method inventory](#method-inventory)), and `hello` lists each as a capability of the same
name.

| Alias | Adapts | Grant |
| --- | --- | --- |
| `operator.submitRequest` | `requests.submit` | `runs.start` and `plan.write` |
| `operator.admitRun` | `runs.admit` | `runs.start` |
| `operator.admission` | `admissions.get` | `runs.start` |
| `operator.reconcileAdmission` | `admissions.reconcile` | `runs.start` |
| `operator.cancel` | `runs.cancel` | `runs.control` |
| `operator.answer` | `inputs.answer` | `inputs.answer` |
| `operator.continueRun` | `runs.continue` | `runs.control` |
| `operator.continuation` | `continuations.get` | `runs.read` |
| `operator.reconcileContinuation` | `continuations.reconcile` | `runs.control` |
| `operator.revise` | `inputs.revise` | `inputs.answer` and `runs.control` |

Where they differ from the methods they adapt:

- **A retry key is required.** `operator.submitRequest`, `admitRun`, `continueRun` and
  `revise` take `retry: { idempotencyKey }`, 1–128 UTF-8 bytes, and the key cannot be left
  out.
- **The launch guards are required.** The `command` of `operator.admitRun` and
  `operator.submitRequest` must carry `workflowId`, `workflowVersion`,
  `expectedWorkflowRevision` and `expectedConfigGeneration`, which is what
  `operator.preflight` returns. `admitRun`'s command has no `idempotencyKey` of its own.
- **Contention is a result.** `operator.admitRun`, `submitRequest`, `admission` and
  `reconcileAdmission` return the `resolved` / `in-progress` envelope rather than throwing.
  `operator.reconcileAdmission` also settles an accepted Request admission through
  `requests.reconcile` and refuses with `RUN_STATE` if the two disagree.
- **`operator.cancel`** takes `{ target, runId, reason? }`, with `reason` at most 2,000
  characters, and returns `{ runId, asOf }`.
- **`operator.answer`** takes a `decision` that is either
  `{ lifetime: "durable"; runId; stepRunId; requestId; optionId; note?; resume: false }`,
  which records the answer without resuming the run, or
  `{ lifetime: "live"; live; optionId; note? }` for a live permission callback. It returns
  `{ runId, requestId, asOf }`.
- **`operator.admission`, `reconcileAdmission`, `continuation` and
  `reconcileContinuation`** take `{ target, operationId }` or `{ target, continuationId }`.

## Template authoring — `templates.*`

Eight methods over the workspace's configured instruction templates. They are installed
when the daemon has configuration generations and a workspace identity, and the four
writes only when it is also writable; see the [inventory](#method-inventory) for grants.
They were added within protocol 2.0, without a minor bump (see the top of this page).
Every params object but `templates.get`'s names `target: { workspaceId, instanceId }`,
which must be `hello.identity`; another is `CONFIG_STALE` ("Template target changed.").

```ts
templates.get       {}                                    → TemplateCatalog
templates.history   { target; key }                       → { entries: { revision; at; generation? }[];
                                                              scope: "acknowledged-local-revisions" }
templates.validate  TemplateCandidate                     → { candidateRevision; errors; changes;
                                                              compatibility: "compatible" | "incompatible" | "unavailable" }
templates.preview   { target; expectedCatalogRevision; expectedConfigGeneration; id; pack?;
                      fixtures: { values; artifacts }; candidate? }
                                                          → { requestedId; resolvedId; fallback; partialIds; text }
templates.variant   { target; key; expectedSourceRevision; expectedCatalogRevision;
                      expectedConfigGeneration; pack }    → { key; text }
templates.save      { candidate: TemplateCandidate; candidateRevision }
                                                          → { status: "saved"; candidateRevision; snapshot: TemplateCatalog }
templates.assign    { target; expectedCatalogRevision; expectedConfigGeneration; key;
                      expectedSourceRevision; templateId; version; validateOnly?; candidateRevision? }
                                                          → { written; candidateRevision; snapshot: TemplateCatalog }
templates.publish   { target; expectedCatalogRevision; expectedConfigRevision;
                      expectedConfigGeneration; validateOnly? }
                                                          → ConfigApplyResult

TemplateCandidate: { target; key; expectedSourceRevision; expectedCatalogRevision;
                     expectedConfigGeneration; draftSequence; text }  // text at most 256 KiB
TemplateCatalog: { target; catalogRevision; contextRevision; configRevision; generation;
                   assets: { key; id; revision; version; requires; partials; usedBy; source }[];
                   assignments: { key; workflowId; nodeId; revision; templateId? }[];
                   workflows: { id; version }[]; errors: TemplateDiagnostic[] }
```

Saving and activating stay apart, as `config.set` and `config.apply` do. `templates.save`
writes one exact reviewed source and activates nothing. `templates.publish` validates the
saved catalog and applies it as a new configuration generation, returning `config.apply`'s
result; generations already admitted keep their instructions. `templates.assign` points a
workflow node at a template, which changes that workflow's version. Every write is fenced by
the config, catalog, source and generation revisions it names, and a moved one is
`CONFIG_STALE`. An asset's `source` is `{ state: "available", text }` or
`{ state: "withheld" }`. Preview renders only the fixture values and artifact bodies it is
given. `templates.history` lists digests of acknowledged saves and activations, never old
bodies. See [template integration](../../docs/implementation/m21-config-template-integration.md#production-contracts).

## Workflow drafts — `workflowDrafts.*`

Eight methods, the daemon half of the visual workflow editor (#180). They are installed
under the same conditions as the template methods, all but `workflowDrafts.get` only on a
writable daemon, and were likewise added within protocol 2.0. See
[schemas](src/workflow-drafts.ts).

```ts
workflowDrafts.get      { workflowId }                              → { draft: WorkflowDraftView | null;
                                                                        layout; editable; reason? }
workflowDrafts.open     { workflowId }                              → WorkflowDraftView
workflowDrafts.apply    { workflowId; expectedRevision; ops }       → WorkflowDraftView  // 1–200 ops
workflowDrafts.undo     { workflowId; expectedRevision }            → WorkflowDraftView
workflowDrafts.redo     { workflowId; expectedRevision }            → WorkflowDraftView
workflowDrafts.review   { workflowId; expectedRevision }            → { revision; baseVersion; nextVersion;
                                                                        baseText; text; reviewToken }
workflowDrafts.publish  { workflowId; expectedRevision; reviewToken } → { workflowId; version;
                                                                          apply: ConfigApplyResult }
workflowDrafts.discard  { workflowId; expectedRevision }            → { discarded: true }
```

**Editing never touches the live file.** A draft is the workflow's YAML, comments and all,
plus an undo history, kept beside the workflow in `.drafts/`. There is one draft per
workflow, owned by the principal who opened it: anyone else's `workflowDrafts.get` shows it
read-only (`owner.you: false`), and their writes are `CONFIG_INVALID`. Every method after
`open` names the draft `revision` it was made against, and a stale one, or a workflow file
that changed since the draft was taken, is `CONFIG_STALE`.

`apply` takes a batch of semantic operations (`addNode`, `insertNode`, `updateNode`,
`renameNode`, `changeType`, `removeNode`, `moveNode`, `addEdge`, `updateEdge`, `removeEdge`,
`setStart`, `setWorkflow`, and the layout-only `place`, `unpin` and `tidy`) that lands
whole, as one revision and one undo step, or not at all. A dragged position is layout
metadata, kept in `.layout/` once published and never in the workflow file. `review`
returns exactly the bytes `publish` would write, with a `reviewToken`; `publish` requires
that token, writes the file under the configuration writer lock, bumps its version and
applies a configuration generation, restoring the previous file if activation is refused.
Runs already started keep the version they began on. See
[workflow editing](../../docs/design/70-workflow-editing.md#drafts).

## Remaining capability and acceptance work

Request admission and direct launch are implemented with the boundaries above.
Structured configuration/launch authoring, actual-client acceptance and native beta
delivery retain their distinct gaps and owners in the
[capability ledger](../../docs/ROADMAP.md). Protocol implementation alone does not
establish deployed or native acceptance.
