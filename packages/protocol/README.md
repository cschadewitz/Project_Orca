# `@orca/protocol`

The wire contract between the ORCA daemon (`orca serve`) and its clients. Zod schemas, so
both ends validate at the boundary and the TypeScript types fall out of them. It depends on
`@orca/core` for the domain types and on nothing else — a client that depends only on this
package cannot reach the engine, the stores or the transports (ADR 0008).

Everything below is exported from the package root.

## Transport

`POST /rpc` with one **request** envelope, answering with one **response** envelope;
`GET /health` for supervisors. `notification` exists in the envelope union for the event
stream that arrives with the first subscribe method.

```ts
{ kind: "request",  id, method, params? }
{ kind: "response", id, ok: true,  result }
{ kind: "response", id, ok: false, error: { code, message, details? } }
{ kind: "notification", method, params? }
```

`code` is an `OrcaErrorCode` from `core` or one of `PROTOCOL_VERSION`, `PROTOCOL_METHOD`,
`PROTOCOL_MESSAGE`. Invalid params are `PROTOCOL_MESSAGE` with the Zod issues in `details`.

`PROTOCOL_VERSION` is `{ major, minor }`: `major` changes when a message changes shape or
meaning, `minor` when messages or fields are added. Compatible when the majors match and the
daemon's minor is at least the client's.

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
`hello` and nothing else. `READ_METHODS` is the five below.

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
result: { run: RunSummaryView; workspace; vars; steps: StepView[];
          artifacts: ArtifactView[]; lastSeq; asOf }
```

`steps` is every step run in scheduling order — one entry per *attempt*, so a retried node
appears more than once with ascending `attempt`; a tree groups by `nodeId` (and `iteration`,
inside a loop). Each `StepView` carries `status`, `waitingOn?`, its timestamps and
`durationMs?`, `agentId?` / `agentSessionId?`, `inputArtifactIds` / `outputArtifactIds`,
`choice?`, `message?`, `error?`, its `children` (`ChildRunView`: `runId`, `name`, `status`,
`branch?`, `workItemId?`, `resumed?`) and its `skippedBranches` — the fan-out branches that
never became child runs, so the whole fan-out is shown and not just the part that ran.

`RUN_NOT_FOUND` when the store has no log for `runId`.

### `runs.events` — the timeline, paged by sequence number

```ts
params: { runId; after?: number; before?: number; types?: string[]; limit = 200 }
result: { events: OrcaEvent[]; nextCursor?; prevCursor?; hasMore; lastSeq; asOf }
```

`after` walks forward from a sequence number, `before` takes the `limit` events immediately
preceding one; giving both is an error. Either way the page reads oldest first, so live and
historical rendering are one code path. `types` filters, and an unknown type matches nothing
rather than failing. `lastSeq` is the run's, not the page's.

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

> The design asks for a consequence per option; the engine's options are plain strings, so
> plain strings is what travels. A client renders them and does not invent explanations.

### `claims.list` — who owns which work item

```ts
params: { runId?; workItemId? }
result: { claims: ClaimView[]; asOf }
```

Oldest first. A claim is `workItemId`, `workItem?`, `branch`, `stepRunId?`, `claimedAt` and
its `owner`: `runId`, `name?`, `status`, `missing` (no log for that run any more, shown as
`stale`), and `releasable` — true when the owning run cannot resume, which is exactly when
`orca claims release` does not need `--force`.

## What is not here yet

Writes (`answer`, `resume`, `cancel`, `startRun`), the WebSocket carrying `notification`s
for `Orchestrator.subscribe()`, and the plan methods. See `docs/ROADMAP.md`, item 1.
