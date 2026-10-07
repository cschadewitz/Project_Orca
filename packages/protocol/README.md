# `@orca/protocol`

The wire contract between the ORCA daemon (`orca serve`) and its clients. Zod schemas, so
both ends validate at the boundary and the TypeScript types fall out of them. It depends on
`@orca/core` for the domain types and on nothing else — a client that depends only on this
package cannot reach the engine, the stores or the transports (ADR 0008).

Everything below is exported from the package root. Current main uses **2.0**
([version source](src/version.ts)), store epoch `operator-journals-v4`.
Protocol 2.0 requires coordinated client/daemon upgrade: old closed capability/event
schemas cannot safely ignore the operator/admission/revision additions. Methods remain
conditional on installed providers, read-only mode and current caller authority.
See [operator integration](../../docs/runtime-operator-integration.md) for the current
composition and dated acceptance checkpoints. Root version 0.6.0 alone does not identify
a deployed build. Protocol 1.9 added authenticated clients, typed-input
preflight and pinned launch guards; 1.10 added Request admission, generations/apply,
workspace/boot identity and live callback fields. Protocol 1.7 introduced the
v0.5.0 config/workflow/plan methods; 1.8 adds maintenance admission and optional
`hello.processId`. It also advertises the additive v0.6.0 fields initially landed
under 1.7: decision `resultIsPreview`, `runs.get.workflowPinned`, step `model`,
workflow `pinned`, and `WORKFLOW_VERSION_NOT_FOUND`. Introduction versions below
are history, not the current handshake version. See [release history](../../CHANGELOG.md).

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

`code` is an `OrcaErrorCode` from `core`, one of `PROTOCOL_VERSION`, `PROTOCOL_METHOD`,
`PROTOCOL_MESSAGE`, or one of the five the control methods add (`CONTROL_ERROR_CODES`):

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

`PROTOCOL_VERSION` is `{ major, minor }`: `major` changes when a message changes shape or
meaning, `minor` when messages or fields are added. Compatible when the majors match and the
daemon's minor is at least the client's.

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
requires launch authority and workflow scope before resolution/validation. Discover it
through `hello.methods` and `workflows.validateInputs` capability. The result's version
and revision are forwarded as `runs.start.workflowVersion` and
`runs.start.expectedWorkflowRevision`. A stale revision is `WORKFLOW_INVALID`; input
failures are `WORKFLOW_INPUT_INVALID` with `{errors, warnings}`. Read-only mode may offer
preflight but still omits `runs.start`.

See [runtime integration](../../docs/runtime-foundation-integration.md) for token-file
migration, protected execution state and standing-permission failure semantics.

## Maintenance admission (1.8)

The standard daemon installs `maintenance` independently of `runs.control`, including
in read-only mode; discover availability through `hello.methods`. `hello.processId` is
optional supervisor identity, not caller authentication.

```ts
params: { action: "prepare" | "resume"; token: string } // nonempty token
result: { ready: boolean; active: string[] } // active method names, not run IDs
```

`prepare` closes admission only when no wrapped calls remain active; otherwise it returns
`ready: false` and the active methods for the supervisor to drain/retry. Once held,
another token is refused with `PROTOCOL_MESSAGE` ("Another updater owns admission").
`resume` clears that in-memory token and returns `ready: false`. An external admission
file can independently keep admission closed. While closed, wrapped reads and writes
fail with `PROTOCOL_MESSAGE` ("Update admission is closed; retry later"); `hello`,
`subscribe`, `unsubscribe` and `maintenance` remain available. Invalid parameters also
use `PROTOCOL_MESSAGE`. This counts in-flight method calls, not all persisted run states.

This method does not install software or accept paths/commands. The token coordinates
updaters; general HTTP/WS authentication and `daemon.maintenance` authorization now
apply separately ([security](../../docs/daemon-security.md)). The supervisor must
also check run/update readiness and daemon ownership as described in [Updating](../../docs/UPDATING.md).
See [schema](src/maintenance.ts) and [admission implementation](../daemon/src/maintenance.ts).

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
| `running`/`waiting` with a lapsed or absent run lease | `stale` | nothing is driving it |
| step `scheduled` | `blocked` | |
| step `skipped` | `cancelled` | a branch never taken is not a fault |

`held` is never produced from a run: it is the plan surface's word for an item restrained by
risk appetite, and belongs to the plan methods.

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
does not install a service. Consult [handshake schemas](src/handshake.ts) and current
[operation authorization](../daemon/src/auth/operations.ts); resource scope is still
checked on every call. Major versions must match before normal client operation.

**`methods` is the check that matters, not `capabilities`.** `orca serve --read-only` leaves
the control methods out of the dispatch table *and* out of `methods`, and drops
`runs.control` from `capabilities`: a control call against it answers `PROTOCOL_METHOD`, not
a refusal. That is deliberate — a client should be able to hide a button rather than find out
at the moment of pressing it that there is nothing behind it.

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

Newest first. `RunSummaryView`: `id`, `name`, `workflowId`, `workflowVersion`, `status`,
`outcome?`, `waitingOn?` / `waitingDetail?` / `waitingSince?`, `createdAt`, `startedAt?`,
`finishedAt?`, `durationMs?`, `parentRunId?`, `parentStepRunId?`, `requestId?`, `workItem?`,
`agentId?`, `error?`.

`name` is the work item's title, else the request's title, else the workflow id — never an
id alone when something better exists, and never invented.

### `runs.get` — one run's tree

```ts
params: { runId }
result: { run: RunSummaryView; workspace; vars; steps: StepView[]; traversal?: RunTraversalView[];
          artifacts: ArtifactView[]; lastSeq; asOf }
```

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
params: { runId?; kind?: ("decision" | "permission" | "question")[] }
result: { inputs: OpenInputView[]; waiting: number; asOf }
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
decoration. `id` is still the whole of the answer — `inputs.answer` takes an option id, a
label may be reworded between the ask and the answer, and a log written before #220 reads
each bare string as an option that is its own id and label. `input.opened` carries the same
shape, so a card drawn from the push frame alone is complete.

**`agent` says whose turn is being held, as of protocol 1.6** — `{ id, hostId, hostType? }`,
three fields of `AgentView` and not a fourth, because the rest of an agent's state is what
the Agents surface is for. A `permission` ask always has one: it reaches a person through a
live agent session, and "claude-local on build-01 is waiting" is what makes an allow-always
decision one a person can size. A workflow `decision` or `question` has none, and the absence
is the answer rather than a field that failed to load — as is a missing `hostType`, which
means the host is no longer configured. `input.opened` carries it too, for the same reason it
carries the options.

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
current operation authority requires `config.write`. Exactly one of `text` and `patch` — they
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

`runId` absent means every run in the store. `methods` absent or empty means all ten.
`since` is a resume cursor and **requires `runId`** — see below. `stopped: false` means the
id was not live; unsubscribing twice is not an error, and closing the socket ends every
subscription on it.

Over `/rpc` these answer `NOT_SUPPORTED` — there is nowhere to push to. They are listed in
`hello.methods` regardless, so a client can tell "this daemon can stream" from "this daemon
is old". The capability is `runs.subscribe`.

### The ten notifications

Six are about a run. Each carries `subscriptionId` (one connection may hold several),
`runId`, `seq` — the sequence number, within that run, of the event behind it, and therefore
**the cursor** — and `at`, the event's own timestamp rather than the moment the frame was
sent. The other four are not about a run and carry no `runId`: `agent.changed`,
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

Sequence numbers are per-run and gap-free, which is what makes the cursor work. Keep the
highest `seq` seen; on reconnect send `subscribe({ runId, since: seq })`; the daemon replays
`since + 1` onwards and then the live stream takes over, with `replayed` saying how many
frames the replay sent. There is no gap and no duplicate: the daemon attaches its listener
**before** reading the log, buffers what arrives during the read, and drops anything at or
below the last replayed sequence number. **A blip costs latency and never data.**

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
one `agents.list` away. A client that folds the cursor therefore tests for a `seq`
(`typeof params.seq === "number"`) rather than assuming one.

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
or validate-only. There is no filesystem watcher; explicit `config.apply` is the asset
refresh boundary, including template-only changes. A workflow editor is still separate work.

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
subscriber. `revision` is enough to know that what is held is stale, and a client that finds
it equal to the revision it already has — its own write, echoed back — re-reads nothing.

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

Behind the `runs.control` capability, and absent entirely from a `--read-only` daemon. Ten
of them: the four that drive runs, `config.set` (documented above, with the read it pairs
with), the four that write to the plan, and `claims.release`.

### `inputs.answer` — settle an open gate or permission ask

```ts
params: { requestId; runId?; optionId; note?; always?: { decision: "allow" | "deny" };
          resume = true }
result: { requestId; runId; answer; permission?; run?; asOf }
```

`optionId` is an option's **`id`** (the free text, for a question that offers none). `resume`
re-drives the run under this daemon's lease and returns once it is parked again or finished,
so `run` is a settled status rather than a snapshot mid-flight; `resume: false` is
`orca answer --no-resume`.

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

### `runs.start` — a workflow and its vars, and nothing else

```ts
params: { workflowId; vars = {}; requestId?; workItemId? }
result: { runId; run: RunSummaryView; asOf }
```

**No request document and no work-item document are written or read.** The constraint that
originally forced that is gone — `JsonFileDocumentStore` re-reads a collection under a lock
before every write (#196), so the store is multi-process safe and a daemon writing documents
beside a CLI no longer clobbers it.

The narrow method is kept by decision. Submitting a *request* and decomposing it into work
items is `orca submit`'s job — a workflow, an agent and an artifact, not a record insert —
and growing this method into it would settle that design inside the schema of a method whose
job is "run this workflow". A `requests.submit` method goes beside this one when it is
designed.

`requestId` and `workItemId` are still accepted: they are recorded on `run.created` and
travel out on `run.changed`, so a client that already knows a work item can start a run
against it and find the run again. A run named after a work item this daemon has not got
falls back to the workflow id, which is the fallback chain `name` has always had.

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

Under `runs.read`, and answered by a `--read-only` daemon too: neither touches a run, a lease
or a log.

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

## What is not here yet

`requests.submit`: submitting a request and decomposing it is a workflow, and the method that
starts one is still to be designed (see `runs.start` above). See `docs/ROADMAP.md`, item 1.
