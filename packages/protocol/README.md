# `@orca/protocol`

The wire contract between the ORCA daemon (`orca serve`) and its clients. Zod schemas, so
both ends validate at the boundary and the TypeScript types fall out of them. It depends on
`@orca/core` for the domain types and on nothing else — a client that depends only on this
package cannot reach the engine, the stores or the transports (ADR 0008).

Everything below is exported from the package root.

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
`PROTOCOL_MESSAGE`, or one of the four the control methods add (`CONTROL_ERROR_CODES`):

| code | means | `details` |
| --- | --- | --- |
| `INPUT_ANSWERED` | somebody answered that question already | `requestId`, `runId`, `answer` |
| `INPUT_OPTION_UNKNOWN` | not an option this question offers | `requestId`, `options` |
| `RUN_NOT_WAITING` | the run is not parked on anything, or has finished | `runId`, `status` |
| `RUN_LEASED_ELSEWHERE` | another **live** process is interpreting it | `runId`, `holder`, `pid`, `host`, `renewedAt` |

They exist because a screen has to tell those four apart, and the engine says `RUN_STATE` to
all of them — the right shape for a CLI that prints a message, the wrong one for a client
that branches. Invalid params are `PROTOCOL_MESSAGE` with the Zod issues in `details`.

`PROTOCOL_VERSION` is `{ major, minor }`: `major` changes when a message changes shape or
meaning, `minor` when messages or fields are added. Compatible when the majors match and the
daemon's minor is at least the client's.

A client that only reads never opens a socket: `hello` and every read method work over
`/rpc` with none. `DaemonHandle.socketUrl` is present only when the daemon was given an
engine feed, and `socketUrlFor(httpUrl)` derives it (`http`→`ws`, `https`→`wss`, plus
`SOCKET_PATH`).

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
result: { protocol, orcaVersion, storeDir?, capabilities: DaemonCapability[], methods?: string[] }
```

`capabilities` is coarse (`runs.read`, `runs.subscribe`, `runs.control`, `plan.read`,
`plan.write`); `methods` (protocol 1.1) is exactly what this daemon answers, so a newer
client can light up one screen against an older daemon. A daemon serving no store answers
`hello` and nothing else. `READ_METHODS` is the seven below, `CONTROL_METHODS` the four that
write and `AGENT_METHODS` the two about agents.

**`methods` is the check that matters, not `capabilities`.** `orca serve --read-only` leaves
the control methods out of the dispatch table *and* out of `methods`, and drops
`runs.control` from `capabilities`: a control call against it answers `PROTOCOL_METHOD`, not
a refusal. That is deliberate — a client should be able to hide a button rather than find out
at the moment of pressing it that there is nothing behind it.

> **The control port is not access control.** `orca serve` binds loopback and authenticates
> nobody, so any local process can answer a gate, cancel a run or start one. The per-run
> lease stops a *second writer*; it does not stop a caller. ADR 0008 records that as an
> accepted cost.

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
`durationMs?`, `agentId?` / `agentSessionId?`, `inputArtifactIds` / `outputArtifactIds`,
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
`nodes`, `edges`, `versions?`. A `WorkflowNodeView` carries `id`, `type`, `name?`,
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

**`versions` is what the daemon can see, not what it can serve.** ORCA records
`workflowVersion` on `run.created` but keeps no copy of that definition — a workflow is one
file at whatever version it is at now — so `versions` is the version on disk unioned with the
versions the store's runs were started against. `workflows.get({ id, version })` therefore
answers only for the version on disk and gives `WORKFLOW_NOT_FOUND` for any other, with both
versions in the details. A client uses the list to say a run is pinned to a version that is no
longer the newest, not to offer a picker that would 404.

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

## The push channel

### `subscribe` / `unsubscribe` — socket only

```ts
params: { runId?; methods?: NotificationMethod[]; since? }
result: { subscriptionId; replayed }

params: { subscriptionId }
result: { stopped }
```

`runId` absent means every run in the store. `methods` absent or empty means all eight.
`since` is a resume cursor and **requires `runId`** — see below. `stopped: false` means the
id was not live; unsubscribing twice is not an error, and closing the socket ends every
subscription on it.

Over `/rpc` these answer `NOT_SUPPORTED` — there is nowhere to push to. They are listed in
`hello.methods` regardless, so a client can tell "this daemon can stream" from "this daemon
is old". The capability is `runs.subscribe`.

### The eight notifications

Six are about a run. Each carries `subscriptionId` (one connection may hold several),
`runId`, `seq` — the sequence number, within that run, of the event behind it, and therefore
**the cursor** — and `at`, the event's own timestamp rather than the moment the frame was
sent. The other two, `agent.changed` and `workflows.changed`, are about the process and carry
none of `runId` or `seq`; they have their own sections below.

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
a separate CLI process is not pushed and appears on the next read (`docs/ROADMAP.md`, item 1;
#196).

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

### `workflows.changed` — declared, and not yet sent

```ts
params: { subscriptionId; id; version; at }
```

The second push that is not about a run, added in **1.7** (#174). Like `agent.changed` it has
no `runId` and no cursor: a client re-reads `workflows.get`.

**Nothing emits it today, and that is the honest state rather than an omission.** ORCA loads
workflows once, at bootstrap, from the glob in `orca.config.yaml`; there is no file watcher
and no reload path, so the daemon has no moment at which it could truthfully say a workflow
changed, and inventing one would be a runtime feature smuggled in behind a notification. It
is on the wire now so the viewer (#177) can subscribe from the version it ships in, and so
the editor (#181) — where publishing a draft *is* a write the daemon performs — has a frame
to send rather than a protocol bump mid-feature. A client that subscribes today never hears
one, which is what a workflow nobody edited looks like.

## The control methods

Behind the `runs.control` capability, and absent entirely from a `--read-only` daemon.

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

**No request document and no work-item document are written or read (#196.)** Those two
collections live in `JsonFileDocumentStore`, which holds a collection in memory and rewrites
it whole, so a daemon and a CLI writing beside each other would each keep serving what they
first read and each clobber the other. Run logs are not affected — the event store re-reads
them — which is precisely why this may append `run.created` and may not create a document.

`requestId` and `workItemId` are still accepted: they are recorded on `run.created` and
travel out on `run.changed`, so a client that already knows a work item can start a run
against it and find the run again. A run named after a work item this daemon has not got
falls back to the workflow id, which is the fallback chain `name` has always had. When #196
closes, a `requests.submit` method can go beside this one.

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

The plan methods over `PlanService`, and `requests.submit` (blocked on #196). See
`docs/ROADMAP.md`, item 1.
