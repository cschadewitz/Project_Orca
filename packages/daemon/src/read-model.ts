/**
 * The read model: `Orchestrator` and its stores in, the display shapes of `@orca/protocol`
 * out. The method table (methods.ts) is a thin wrapper over this, so the projection can be
 * used directly by an embedder and tested without a socket.
 *
 * Three things happen here that no client should have to do for itself:
 *
 * - **The status fold.** Engine status + outcome + what a step waits on + whether a lease
 *   still backs the claim to be running become one `DisplayStatus` (`@orca/protocol`'s
 *   `displayStatusForRun`). A run whose log says `running` but whose lease has lapsed is
 *   `stale` here, which is the only place that can know it: it takes the lease store.
 * - **Naming.** A run is named after the work item it advances, else the request, else the
 *   workflow. That takes two document stores and a fallback chain, once, on this side.
 * - **Paging.** Event pages are cut by sequence number in both directions.
 *
 * Every method builds a `Pass`: a per-call cache of run summaries, work items, requests and
 * leases. One `runs.list` over a hundred runs sharing one work item reads that work item
 * once, and no cache outlives the call, so nothing here serves a name it cached earlier.
 *
 * The store underneath is another matter: `JsonFileDocumentStore` holds a collection in
 * memory for the life of the process, so a long-lived daemon will keep showing the work
 * items and requests it first read while a CLI writes new ones beside it (#196). Run logs
 * are not affected - the event store re-reads them - so statuses and trees stay current.
 */
import {
  OrcaError,
  RUN_SUMMARY_EVENT_TYPES,
  reduceRunSummary,
  runSummary,
  type Artifact,
  type Clock,
  type ErrorInfo,
  type HumanInputRequest,
  type OrcaEvent,
  type Request,
  type RunState,
  type RunSummary,
  type StepRun,
  type WorkItem,
} from "@orca/core";
import type { Orchestrator } from "@orca/engine";
import type { WorkItemClaim } from "@orca/store";
import {
  displayStatusForRun,
  displayStatusForStep,
  isTextMediaType,
  type ArtifactsGetParams,
  type ArtifactsGetResult,
  type ArtifactsListParams,
  type ArtifactsListResult,
  type ArtifactView,
  type ChildRunView,
  type ClaimsListParams,
  type ClaimsListResult,
  type ClaimView,
  type InputsListParams,
  type InputsListResult,
  type OpenInputView,
  type RunsEventsParams,
  type RunsEventsResult,
  type RunsGetParams,
  type RunsGetResult,
  type RunsListParams,
  type RunsListResult,
  type RunSummaryView,
  type StepView,
  type ViewError,
  type WorkItemView,
} from "@orca/protocol";

/** The events a listing needs: a summary's, plus the one that says which agent worked the run. */
const LIST_EVENT_TYPES = [
  ...RUN_SUMMARY_EVENT_TYPES,
  "agent.session.opened",
] as const satisfies readonly OrcaEvent["type"][];

/** What the run is parked on right now, as the last unresolved `step.waiting` recorded it. */
interface WaitFacts {
  stepRunId: string;
  on: string;
  detail?: string | undefined;
  at: string;
}

/** Everything a `RunSummaryView` needs that is not a name or a clock. */
interface RunFacts {
  summary: RunSummary;
  wait?: WaitFacts | undefined;
  agentId?: string | undefined;
  error?: ErrorInfo | undefined;
}

function viewError(e: ErrorInfo | undefined): ViewError | undefined {
  return e ? { code: e.code, message: e.message } : undefined;
}

function artifactView(a: Artifact): ArtifactView {
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    version: a.version,
    mediaType: a.mediaType,
    size: a.size,
    createdAt: a.createdAt,
    ...(a.path ? { path: a.path } : {}),
    ...(a.producedBy.stepRunId ? { producedByStepRunId: a.producedBy.stepRunId } : {}),
  };
}

/** The agent a step opened a session with, as `agent.session.opened` recorded it. */
export interface AgentSessionRef {
  agentId: string;
  hostId: string;
}

/**
 * Which agent worked each step of a run. `agent.session.opened` is the only event that says
 * so, and it says it once per session, so one filtered pass over the log answers for every
 * step in it - which is why this builds the whole map rather than searching for one step.
 *
 * It lives here, and `ControlModel.agentForStep` calls it, because both surfaces are asking
 * the same question of the same log: `inputs.list` needs it to name who is blocked (#248)
 * and `inputs.answer` needs it to know whose permission policy an "always" rule belongs in.
 * Two scans would be two chances to disagree about a step with more than one session.
 *
 * The last session for a step wins: a step retried against a second agent is being worked by
 * that one now.
 */
export async function agentSessionsByStep(orc: Orchestrator, runId: string): Promise<Map<string, AgentSessionRef>> {
  const byStep = new Map<string, AgentSessionRef>();
  for (const e of await orc.stores.events.readTypes(runId, ["agent.session.opened"]))
    if (e.type === "agent.session.opened")
      byStep.set(e.payload.stepRunId, { agentId: e.payload.agentId, hostId: e.payload.hostId });
  return byStep;
}

/**
 * The step run a log entry is about, when it is about one. Every step-scoped event carries
 * `stepRunId` in its payload and no run-scoped event does, so this is the whole of the
 * `runs.events` step filter - and a run-level event matching nothing is the right answer,
 * not an omission.
 */
function stepRunIdOf(e: OrcaEvent): string | undefined {
  const payload: unknown = e.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const id = (payload as { stepRunId?: unknown }).stepRunId;
  return typeof id === "string" ? id : undefined;
}

function workItemView(w: WorkItem): WorkItemView {
  return { id: w.id, slug: w.slug, title: w.title, status: w.status };
}

/** Milliseconds between two ISO timestamps, never negative (clocks and ordering both drift). */
function elapsed(from: string | undefined, to: string | number): number | undefined {
  if (!from) return undefined;
  const start = Date.parse(from);
  const end = typeof to === "number" ? to : Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/**
 * Fold a run's listing events into the facts a row needs. `reduceRunSummary` owns the
 * status; this adds what a summary does not carry - the open wait, the agent, the error -
 * from the same events, so a listing still costs one filtered pass over each log.
 */
function runFacts(events: readonly OrcaEvent[]): RunFacts {
  const summary = reduceRunSummary(events);
  const facts: RunFacts = { summary };
  for (const e of events) {
    switch (e.type) {
      case "step.waiting":
        facts.wait = {
          stepRunId: e.payload.stepRunId,
          on: e.payload.on,
          at: e.at,
          ...(e.payload.detail ? { detail: e.payload.detail } : {}),
        };
        break;
      // `reduceRunSummary` leaves `waiting` on any step settling; stay in step with it.
      case "step.completed":
      case "step.failed":
      case "run.completed":
      case "run.cancelled":
        facts.wait = undefined;
        break;
      case "run.failed":
        facts.wait = undefined;
        facts.error = e.payload.error;
        break;
      case "agent.session.opened":
        facts.agentId = e.payload.agentId;
        break;
      default:
        break;
    }
  }
  return facts;
}

/** The same facts from a full projection, for `runs.get`, which has already reduced the log. */
function factsFromState(state: RunState, agentByStep: ReadonlyMap<string, string>): RunFacts {
  const facts: RunFacts = { summary: runSummary(state), ...(state.run.error ? { error: state.run.error } : {}) };
  for (const id of state.stepOrder) {
    const step = state.steps[id];
    if (!step) continue;
    if (step.status === "waiting" && step.waitingOn)
      facts.wait = { stepRunId: step.id, on: step.waitingOn, at: step.startedAt ?? step.scheduledAt };
    const agentId = agentByStep.get(step.id);
    if (agentId) facts.agentId = agentId;
  }
  return facts;
}

/**
 * One call's caches. Names come from documents that several runs share, and liveness from a
 * lease listing that costs one directory read however many runs are in it.
 */
class Pass {
  private readonly workItems = new Map<string, WorkItem | undefined>();
  private readonly requests = new Map<string, Request | undefined>();
  private readonly facts = new Map<string, RunFacts | undefined>();
  private readonly agentSessions = new Map<string, Map<string, AgentSessionRef>>();
  private leases: Map<string, boolean> | undefined;

  constructor(
    private readonly orc: Orchestrator,
    readonly asOf: string,
  ) {}

  get now(): number {
    return Date.parse(this.asOf);
  }

  async workItem(id: string | undefined): Promise<WorkItem | undefined> {
    if (!id) return undefined;
    if (!this.workItems.has(id)) this.workItems.set(id, await this.orc.stores.workItems.get(id));
    return this.workItems.get(id);
  }

  async request(id: string | undefined): Promise<Request | undefined> {
    if (!id) return undefined;
    if (!this.requests.has(id)) this.requests.set(id, await this.orc.stores.requests.get(id));
    return this.requests.get(id);
  }

  /**
   * Which agent worked each step of this run. Cached per run because a run parked on three
   * permission asks would otherwise scan its log three times for the same answer.
   */
  async agentSession(runId: string, stepRunId: string): Promise<AgentSessionRef | undefined> {
    let byStep = this.agentSessions.get(runId);
    if (!byStep) {
      byStep = await agentSessionsByStep(this.orc, runId);
      this.agentSessions.set(runId, byStep);
    }
    return byStep.get(stepRunId);
  }

  /** `undefined` when the run has no log - a child a parent still points at, a rolled-back store. */
  async runFacts(runId: string): Promise<RunFacts | undefined> {
    if (!this.facts.has(runId)) {
      const events = await this.orc.stores.events.readTypes(runId, LIST_EVENT_TYPES);
      this.facts.set(runId, events.length ? runFacts(events) : undefined);
    }
    return this.facts.get(runId);
  }

  /**
   * Whether the process that claimed a run has stopped heartbeating. A run whose log says it
   * is going needs a live lease to back that up: a lapsed lease *or no lease at all* means
   * nobody is driving it, because an interpreter takes the lease before it appends and
   * releases it only once the run is parked or finished.
   */
  async leaseLapsed(summary: RunSummary): Promise<boolean> {
    if (summary.status !== "running" && summary.status !== "waiting") return false;
    if (!this.leases) {
      this.leases = new Map();
      for (const l of await this.orc.listLeases()) this.leases.set(l.runId, l.lapsed);
    }
    return this.leases.get(summary.id) ?? true;
  }

  /** The work item a run advances, the request behind it, and what to call the run. */
  async naming(summary: RunSummary): Promise<{ name: string; workItem?: WorkItemView }> {
    const item = await this.workItem(summary.workItemId);
    if (item) return { name: item.title, workItem: workItemView(item) };
    const request = await this.request(summary.requestId);
    return { name: request?.title ?? summary.workflowId };
  }

  async runView(facts: RunFacts): Promise<RunSummaryView> {
    const { summary, wait } = facts;
    const { name, workItem } = await this.naming(summary);
    const status = displayStatusForRun(summary, {
      waitingOn: wait?.on,
      leaseLapsed: await this.leaseLapsed(summary),
    });
    const duration = elapsed(summary.startedAt, summary.completedAt ?? this.now);
    return {
      id: summary.id,
      name,
      workflowId: summary.workflowId,
      workflowVersion: summary.workflowVersion,
      status,
      createdAt: summary.createdAt,
      ...(summary.outcome ? { outcome: summary.outcome } : {}),
      ...(wait
        ? { waitingOn: wait.on, waitingSince: wait.at, ...(wait.detail ? { waitingDetail: wait.detail } : {}) }
        : {}),
      ...(summary.startedAt ? { startedAt: summary.startedAt } : {}),
      ...(summary.completedAt ? { finishedAt: summary.completedAt } : {}),
      ...(duration === undefined ? {} : { durationMs: duration }),
      ...(summary.parentRunId ? { parentRunId: summary.parentRunId } : {}),
      ...(summary.requestId ? { requestId: summary.requestId } : {}),
      ...(workItem ? { workItem } : {}),
      ...(facts.agentId ? { agentId: facts.agentId } : {}),
      ...(viewError(facts.error) ? { error: viewError(facts.error)! } : {}),
    };
  }
}

export interface ReadModelOptions {
  orchestrator: Orchestrator;
  /** Defaults to the orchestrator's own clock, so a test can pin every `asOf` and duration. */
  clock?: Clock | undefined;
}

export class ReadModel {
  private readonly orc: Orchestrator;
  private readonly clock: Clock;

  constructor(opts: ReadModelOptions) {
    this.orc = opts.orchestrator;
    this.clock = opts.clock ?? opts.orchestrator.clock;
  }

  private pass(): Pass {
    return new Pass(this.orc, this.clock.isoNow());
  }

  /** Newest first, filtered, paged. A run whose log has gone missing is skipped, not faked. */
  async runsList(params: RunsListParams): Promise<RunsListResult> {
    const pass = this.pass();
    const ids = await this.orc.listRuns();
    const rows: RunSummaryView[] = [];
    for (const id of ids) {
      const facts = await pass.runFacts(id);
      if (!facts) continue;
      const s = facts.summary;
      if (params.requestId && s.requestId !== params.requestId) continue;
      if (params.workItemId && s.workItemId !== params.workItemId) continue;
      if (params.parentRunId && s.parentRunId !== params.parentRunId) continue;
      if (params.roots && s.parentRunId) continue;
      const view = await pass.runView(facts);
      if (params.status?.length && !params.status.includes(view.status)) continue;
      rows.push(view);
    }
    // `listRuns` is oldest first and ids are time-ordered, but createdAt is what a client sorts by.
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return {
      runs: rows.slice(params.offset, params.offset + params.limit),
      total: rows.length,
      asOf: pass.asOf,
    };
  }

  /** One run, whole: the tree of steps and attempts, its children, its artifacts. */
  async runsGet(params: RunsGetParams): Promise<RunsGetResult> {
    const pass = this.pass();
    const state = await this.orc.getState(params.runId);
    const agentByStep = await this.agentsByStep(params.runId);
    const run = await pass.runView(factsFromState(state, agentByStep));
    const steps: StepView[] = [];
    for (const id of state.stepOrder) {
      const step = state.steps[id];
      if (step) steps.push(await this.stepView(pass, step, agentByStep.get(step.id)));
    }
    return {
      run,
      workspace: state.run.workspace,
      vars: state.run.vars,
      steps,
      artifacts: Object.values(state.artifacts)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(artifactView),
      lastSeq: state.lastSeq,
      asOf: pass.asOf,
    };
  }

  /**
   * One page of the log. `after` walks forward from a sequence number, `before` walks back
   * to the `limit` events immediately preceding one; either way the page reads oldest first,
   * so the timeline renders the same code path in both directions.
   *
   * The run's log is read whole and cut in memory. That is deliberate for now: the store has
   * no index by sequence number, and inventing one before the event stream (the WebSocket
   * that will push these same events) knows what it needs would be guesswork.
   */
  async runsEvents(params: RunsEventsParams): Promise<RunsEventsResult> {
    const asOf = this.clock.isoNow();
    const all = await this.orc.events(params.runId);
    if (!all.length) throw new OrcaError("RUN_NOT_FOUND", `run ${params.runId} not found`, { runId: params.runId });
    const lastSeq = all[all.length - 1]!.seq;
    const types = params.types;
    const stepRunId = params.stepRunId;
    // An unknown type matches nothing rather than failing: a newer client may ask for an
    // event type this daemon's engine does not emit. The two filters are an AND, and both
    // cut the log *before* it is paged, so the cursors below are cursors into the filtered
    // sequence while staying the run's own sequence numbers.
    const matching =
      types?.length || stepRunId
        ? all.filter(
            (e) =>
              (!types?.length || types.includes(e.type)) && (stepRunId === undefined || stepRunIdOf(e) === stepRunId),
          )
        : all;

    let page: OrcaEvent[];
    let hasMore: boolean;
    if (params.before !== undefined) {
      const earlier = matching.filter((e) => e.seq < params.before!);
      page = earlier.slice(Math.max(0, earlier.length - params.limit));
      hasMore = earlier.length > page.length;
    } else {
      const after = params.after;
      const later = after === undefined ? matching : matching.filter((e) => e.seq > after);
      page = later.slice(0, params.limit);
      hasMore = later.length > page.length;
    }
    const first = page[0];
    const last = page[page.length - 1];
    return {
      events: page,
      ...(last ? { nextCursor: last.seq } : {}),
      ...(first ? { prevCursor: first.seq } : {}),
      hasMore,
      lastSeq,
      asOf,
    };
  }

  /** Every open gate and permission ask, longest-waiting first: the attention surface. */
  async inputsList(params: InputsListParams): Promise<InputsListResult> {
    const pass = this.pass();
    const pending = params.runId ? await this.orc.pendingInputs(params.runId) : await this.orc.pendingInputs();
    const kinds = params.kind;
    const states = new Map<string, RunState>();
    const inputs: OpenInputView[] = [];
    for (const request of pending) {
      if (kinds?.length && !kinds.includes(request.kind)) continue;
      let state = states.get(request.runId);
      if (!state) {
        state = await this.orc.getState(request.runId);
        states.set(request.runId, state);
      }
      inputs.push(await this.inputView(pass, request, state));
    }
    inputs.sort((a, b) => b.waitingMs - a.waitingMs || a.id.localeCompare(b.id));
    return { inputs, waiting: inputs.length, asOf: pass.asOf };
  }

  /** Who owns which work item, and whether the run that took it is still alive. */
  async claimsList(params: ClaimsListParams): Promise<ClaimsListResult> {
    const pass = this.pass();
    const held = (await this.orc.stores.claims.list()).filter(
      (c) => (!params.runId || c.runId === params.runId) && (!params.workItemId || c.workItemId === params.workItemId),
    );
    held.sort((a, b) => a.at.localeCompare(b.at) || a.workItemId.localeCompare(b.workItemId));
    const claims: ClaimView[] = [];
    for (const claim of held) claims.push(await this.claimView(pass, claim));
    return { claims, asOf: pass.asOf };
  }

  /**
   * The artifact index, filtered: a run's artifacts, one name's versions, one step's
   * output. Metadata only - a version list must not cost the bodies it lists.
   */
  async artifactsList(params: ArtifactsListParams): Promise<ArtifactsListResult> {
    const asOf = this.clock.isoNow();
    const found = await this.orc.stores.artifacts.list({
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.name ? { name: params.name } : {}),
    });
    const rows = found
      .filter((a) => !params.producedByStepRunId || a.producedBy.stepRunId === params.producedByStepRunId)
      // Grouped by name, oldest version first: `version` is monotonic per (run, name), so
      // this is the version list the panel steps through with `[` and `]`.
      .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.id.localeCompare(b.id));
    return {
      artifacts: rows.slice(params.offset, params.offset + params.limit).map(artifactView),
      total: rows.length,
      asOf,
    };
  }

  /**
   * One artifact, by id or by the (`runId`, `name`, `version?`) address a deep link carries,
   * with its body when the body is text of a sane size. Declining is not an error: the panel
   * still shows what the artifact *is*, and says why it is not showing what it says.
   */
  async artifactsGet(params: ArtifactsGetParams): Promise<ArtifactsGetResult> {
    const asOf = this.clock.isoNow();
    const store = this.orc.stores.artifacts;
    let artifact: Artifact | undefined;
    if (params.artifactId !== undefined) {
      artifact = await store.get(params.artifactId);
    } else {
      const versions = await store.list({ runId: params.runId!, name: params.name! });
      artifact =
        params.version === undefined
          ? versions.reduce<Artifact | undefined>(
              (best, a) => (!best || a.version > best.version ? a : best),
              undefined,
            )
          : versions.find((a) => a.version === params.version);
    }
    if (!artifact) {
      const address =
        params.artifactId !== undefined
          ? params.artifactId
          : `${params.name}${params.version === undefined ? "" : `@v${params.version}`} in run ${params.runId}`;
      throw new OrcaError("ARTIFACT_MISSING", `artifact ${address} not found`, {
        ...(params.artifactId === undefined
          ? {
              runId: params.runId,
              name: params.name,
              ...(params.version === undefined ? {} : { version: params.version }),
            }
          : { artifactId: params.artifactId }),
      });
    }
    const view = artifactView(artifact);
    if (!isTextMediaType(artifact.mediaType))
      return {
        artifact: view,
        omitted: { reason: "binary", detail: `${artifact.mediaType} is not text; ${artifact.size} bytes in the store` },
        asOf,
      };
    if (artifact.size > params.maxBytes)
      return {
        artifact: view,
        omitted: {
          reason: "tooLarge",
          detail: `${artifact.size} bytes, past the ${params.maxBytes} this call asked for`,
        },
        asOf,
      };
    // `content` is the one read that touches a blob, and it raises ARTIFACT_MISSING itself
    // when the index knows an artifact whose body is gone.
    return { artifact: view, text: await store.content(artifact.id), asOf };
  }

  // ------------------------------------------------------------------ pieces

  /** `stepRunId -> agentId`, from the only event that records which agent worked a step. */
  private async agentsByStep(runId: string): Promise<Map<string, string>> {
    const byStep = new Map<string, string>();
    for (const e of await this.orc.stores.events.readTypes(runId, ["agent.session.opened"]))
      if (e.type === "agent.session.opened") byStep.set(e.payload.stepRunId, e.payload.agentId);
    return byStep;
  }

  private async stepView(pass: Pass, step: StepRun, agentId: string | undefined): Promise<StepView> {
    const finishedAt = step.completedAt;
    const duration = elapsed(step.startedAt, finishedAt ?? pass.now);
    const children: ChildRunView[] = [];
    for (const link of step.children) {
      const facts = await pass.runFacts(link.runId);
      const naming = facts ? await pass.naming(facts.summary) : undefined;
      const status = facts
        ? displayStatusForRun(facts.summary, {
            waitingOn: facts.wait?.on,
            leaseLapsed: await pass.leaseLapsed(facts.summary),
          })
        : // The parent's log says it spawned this run and the store has no log for it.
          "stale";
      children.push({
        runId: link.runId,
        name: naming?.name ?? link.runId,
        status,
        ...(facts?.summary.outcome ? { outcome: facts.summary.outcome } : {}),
        ...(link.branch ? { branch: link.branch } : {}),
        ...(link.workItemId ? { workItemId: link.workItemId } : {}),
        ...(link.resumed ? { resumed: true } : {}),
      });
    }
    return {
      id: step.id,
      runId: step.runId,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      attempt: step.attempt,
      status: displayStatusForStep(step),
      scheduledAt: step.scheduledAt,
      inputArtifactIds: [...step.inputArtifactIds],
      outputArtifactIds: [...(step.result?.artifactIds ?? [])],
      children,
      skippedBranches: step.skippedBranches.map((b) => ({
        branch: b.branch,
        reason: b.reason,
        ...(b.workItemId ? { workItemId: b.workItemId } : {}),
      })),
      ...(step.iteration === undefined ? {} : { iteration: step.iteration }),
      ...(step.waitingOn ? { waitingOn: step.waitingOn } : {}),
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(duration === undefined ? {} : { durationMs: duration }),
      ...(agentId ? { agentId } : {}),
      ...(step.agentSessionId ? { agentSessionId: step.agentSessionId } : {}),
      ...(step.result?.choice ? { choice: step.result.choice } : {}),
      ...(step.result?.message ? { message: step.result.message } : {}),
      ...(viewError(step.error) ? { error: viewError(step.error)! } : {}),
    };
  }

  private async inputView(pass: Pass, request: HumanInputRequest, state: RunState): Promise<OpenInputView> {
    const facts = factsFromState(state, new Map());
    const { name, workItem } = await pass.naming(facts.summary);
    const step = state.steps[request.stepRunId];
    // What the asking step had in hand: the artifacts the answer is about.
    const artifacts = (step?.inputArtifactIds ?? [])
      .map((id) => state.artifacts[id])
      .filter((a): a is Artifact => Boolean(a))
      .map(artifactView);
    // Who is blocked (#248). A permission ask always has an agent session on its step - an
    // `ask` reaches a person only through a live one - and a workflow gate never does, so
    // the absence here is the answer rather than a lookup that failed. The transport comes
    // from the registry and not the log, because a host's type is configuration: a log that
    // had frozen a copy of it would be wrong the first time somebody moved the agent.
    const session = await pass.agentSession(request.runId, request.stepRunId);
    const registry = this.orc.agents;
    const hostType = session && registry.hasHost(session.hostId) ? registry.host(session.hostId).spec.type : undefined;
    return {
      id: request.id,
      kind: request.kind,
      question: request.question,
      // The whole `GateOption` travels as of protocol 1.4 (#161): the id is what
      // `inputs.answer` sends back, and the label, the consequence clause and the
      // `destructive` flag are what the card is allowed to draw. No mapping - the model's
      // shape *is* the wire's shape here, and anything less let a client answer a question
      // it could not show.
      options: request.options,
      context: request.context,
      runId: request.runId,
      runName: name,
      stepRunId: request.stepRunId,
      requestedAt: request.requestedAt,
      waitingMs: elapsed(request.requestedAt, pass.now) ?? 0,
      artifacts,
      ...(step?.nodeId ? { nodeId: step.nodeId } : {}),
      ...(session
        ? { agent: { id: session.agentId, hostId: session.hostId, ...(hostType ? { hostType } : {}) } }
        : {}),
      ...(workItem ? { workItem } : {}),
    };
  }

  private async claimView(pass: Pass, claim: WorkItemClaim): Promise<ClaimView> {
    const facts = await pass.runFacts(claim.runId);
    const item = await pass.workItem(claim.workItemId);
    const naming = facts ? await pass.naming(facts.summary) : undefined;
    const status = facts
      ? displayStatusForRun(facts.summary, {
          waitingOn: facts.wait?.on,
          leaseLapsed: await pass.leaseLapsed(facts.summary),
        })
      : "stale";
    // The same rule `Orchestrator.releaseClaim` enforces: an owner that cannot resume.
    const dead = !facts || ["completed", "failed", "cancelled"].includes(facts.summary.status);
    return {
      workItemId: claim.workItemId,
      branch: claim.branch,
      claimedAt: claim.at,
      owner: {
        runId: claim.runId,
        status,
        missing: !facts,
        releasable: dead,
        ...(naming ? { name: naming.name } : {}),
      },
      ...(item ? { workItem: workItemView(item) } : {}),
      ...(claim.stepRunId ? { stepRunId: claim.stepRunId } : {}),
    };
  }
}
