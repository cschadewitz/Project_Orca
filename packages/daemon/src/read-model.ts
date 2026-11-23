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
 * The store underneath re-reads too, as of #196: `JsonFileDocumentStore` trusts its cached
 * collection only while the file's `{ino, size, mtimeMs}` is unchanged, so a long-lived
 * daemon shows the work items and requests a CLI wrote beside it rather than the ones it
 * first read. Run logs were never affected - the event store re-reads them - so statuses
 * and trees stay current the same way.
 */
import { isDeepStrictEqual } from "node:util";
import {
  OrcaError,
  RUN_SUMMARY_EVENT_TYPES,
  reduceRun,
  validateRevisionCapability,
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
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkItem,
} from "@orca/core";
import {
  INLINE_SEP,
  previewRecovery,
  workflowRevision,
  type HeldRunLease,
  type Orchestrator,
  type PlanService,
} from "@orca/engine";
import { redactExecutionValue, type WorkItemClaim } from "@orca/store";
import {
  INLINE_WORKFLOW_SEPARATOR,
  LiveDecisionIdentitySchema,
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
  type RunsRecoveryParams,
  type RunsRecoveryResult,
  type RunsGetResult,
  type RunsListParams,
  type RunsListResult,
  type RunOperationsView,
  type RunProgressView,
  type RunSummaryView,
  type RunTraversalView,
  type StepView,
  type ViewError,
  type WorkflowsGetParams,
  type WorkflowsGetResult,
  type WorkflowsListParams,
  type WorkflowsListResult,
  type WorkItemView,
  type SearchParams,
  type SearchResult,
} from "@orca/protocol";
import { PlanModel } from "./plan-model.js";
import { standingRulePreview } from "./standing-preview.js";
import { searchStore, type SearchScope } from "./search-model.js";
import { workflowSummaryView, workflowView } from "./workflow-model.js";

/** Resolve an inline graph only within the stored root, without any live-definition fallback. */
function storedInputDefinition(root: WorkflowDefinition, workflowId: string): WorkflowDefinition | undefined {
  const [rootId, ...path] = workflowId.split(INLINE_WORKFLOW_SEPARATOR);
  if (root.id !== rootId) return undefined;
  if (!path.length) return root;
  let graph: WorkflowGraph = root;
  for (let i = 0; i < path.length; i++) {
    const node = graph.nodes[path[i]!];
    if (node?.type === "loop" && "graph" in node.body) graph = node.body.graph;
    else if (node?.type === "parallel") {
      const body = node.forEach ? node.forEach.body : node.branches?.[path[++i] ?? ""];
      if (!body || !("graph" in body)) return undefined;
      graph = body.graph;
    } else return undefined;
  }
  return {
    id: workflowId,
    name: workflowId,
    version: root.version,
    vars: {},
    inputs: {},
    start: graph.start,
    nodes: graph.nodes,
    edges: graph.edges,
  };
}

/**
 * The events a listing needs: a summary's, the one that says which agent worked the run, and
 * the step transitions its progress counts come from (#340). Agent output, the bulk of a log,
 * is still not read.
 */
const LIST_EVENT_TYPES = [
  ...RUN_SUMMARY_EVENT_TYPES,
  "agent.session.opened",
  "step.scheduled",
  "step.started",
  "step.cancelled",
  "step.skipped",
] as const satisfies readonly OrcaEvent["type"][];

type ProgressBucket = Exclude<keyof RunProgressView, "attempts">;

/** Where one step attempt stands, by its last transition, for `RunProgressView`. */
const STEP_BUCKET: Record<string, ProgressBucket> = {
  "step.scheduled": "active",
  "step.started": "active",
  "step.waiting": "waiting",
  "step.completed": "completed",
  "step.failed": "failed",
  "step.cancelled": "skipped",
  "step.skipped": "skipped",
};

/** The same buckets from a projected step's status. */
const STATUS_BUCKET: Record<StepRun["status"], ProgressBucket> = {
  scheduled: "active",
  running: "active",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  cancelled: "skipped",
  skipped: "skipped",
};

function progressOf(buckets: Iterable<ProgressBucket>): RunProgressView {
  const progress: RunProgressView = { attempts: 0, completed: 0, failed: 0, active: 0, waiting: 0, skipped: 0 };
  for (const bucket of buckets) {
    progress.attempts++;
    progress[bucket]++;
  }
  return progress;
}

/** Whether a row read later still passes the filters that can change after a run starts. */
function stillMatches(view: RunSummaryView, params: RunsListParams): boolean {
  if (params.status?.length && !params.status.includes(view.status)) return false;
  if (params.outcome?.length && !(view.outcome && params.outcome.includes(view.outcome))) return false;
  return true;
}

/** Host load and usage are not measured per run: said, never zeroed (#340). */
const UNAVAILABLE_FACETS: RunOperationsView["facets"] = {
  host: { state: "unavailable", reason: "not-collected" },
  usage: { state: "unavailable", reason: "not-collected" },
};

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
  /** Step attempts by where they stand, in scheduling order. */
  progress: RunProgressView;
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
    contentHash: a.contentHash,
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
  const steps = new Map<string, ProgressBucket>();
  for (const e of events) {
    const bucket = STEP_BUCKET[e.type];
    const stepRunId = bucket ? stepRunIdOf(e) : undefined;
    if (bucket && stepRunId) steps.set(stepRunId, bucket);
  }
  const facts: RunFacts = { summary, progress: progressOf(steps.values()) };
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
function factsFromState(state: RunState, agentByStep: ReadonlyMap<string, { agentId: string }>): RunFacts {
  const progress = progressOf(
    state.stepOrder.flatMap((id) => (state.steps[id] ? [STATUS_BUCKET[state.steps[id].status]] : [])),
  );
  const facts: RunFacts = {
    summary: runSummary(state),
    progress,
    ...(state.run.error ? { error: state.run.error } : {}),
  };
  for (const id of state.stepOrder) {
    const step = state.steps[id];
    if (!step) continue;
    if (step.status === "waiting" && step.waitingOn)
      facts.wait = {
        stepRunId: step.id,
        on: step.waitingOn,
        at: step.startedAt ?? step.scheduledAt,
        ...(step.waitingDetail ? { detail: step.waitingDetail } : {}),
      };
    const agentId = agentByStep.get(step.id)?.agentId;
    if (agentId) facts.agentId = agentId;
  }
  return facts;
}

/**
 * The path a run took through its workflow, in the order it took it: one entry per step run,
 * which is one per *attempt*, so a retried node appears as many times as it was tried.
 *
 * `viaEdge` is the whole reason this exists beside `steps`. A step run records which node it
 * was, never which edge brought the run to it, so the edge has to be recovered by putting
 * the log beside the definition - the pair (previous node visited, this node) looked up in
 * the definition's edges. Where that pair is not an edge there is no edge to name: a retry
 * of the same node, a run resumed into the middle of a graph, a definition this daemon no
 * longer has. In all three the field is absent rather than guessed, because an overlay that
 * drew an edge nobody authored would be worse than one that drew none.
 *
 * A node visited twice by two different edges is two entries with two `viaEdge`s, which is
 * the `ai-sdlc` review-to-build loop: `bump-build` is entered from `await-deps` the first
 * time and from `tests-passed` afterwards.
 */
function traversalView(state: RunState, def: WorkflowDefinition | undefined): RunTraversalView[] {
  const edges = new Set((def?.edges ?? []).map((e) => `${e.from} ${e.to}`));
  const out: RunTraversalView[] = [];
  let previous: string | undefined;
  for (const id of state.stepOrder) {
    const step = state.steps[id];
    if (!step) continue;
    const via = previous !== undefined && edges.has(`${previous} ${step.nodeId}`);
    out.push({
      nodeId: step.nodeId,
      stepRunId: step.id,
      attempt: step.attempt,
      status: displayStatusForStep(step),
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      ...(step.completedAt ? { endedAt: step.completedAt } : {}),
      ...(via ? { viaEdge: { from: previous!, to: step.nodeId } } : {}),
      ...(step.childRunIds.length ? { childRunIds: [...step.childRunIds] } : {}),
    });
    previous = step.nodeId;
  }
  return out;
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
  private leases: Map<string, HeldRunLease> | undefined;

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
    return (await this.lease(summary.id))?.lapsed ?? true;
  }

  /** The lease on a run, if any process holds one; one listing per call, however many runs. */
  async lease(runId: string): Promise<HeldRunLease | undefined> {
    if (!this.leases) {
      this.leases = new Map();
      for (const l of await this.orc.listLeases()) this.leases.set(l.runId, l);
    }
    return this.leases.get(runId);
  }

  /**
   * One row and its operations facts (#340), both read up to one watermark: the newest event
   * first, then the listing's events bounded by it. A commit landing between the two reads is
   * past the watermark, so it is in neither - the row's status and step counts are exactly what
   * `operations.lastSeq` says they are current as of. Only asked for the rows a page returns.
   * The page's filter was applied by the listing pass just before; `runsList` checks the row
   * against it again and keeps the plain row when the run has moved out of it since.
   */
  async operationsRow(runId: string): Promise<RunSummaryView | undefined> {
    const [last] = await this.orc.stores.events.readRange(runId, { before: Number.MAX_SAFE_INTEGER, limit: 1 });
    if (!last) return undefined;
    const events = await this.orc.stores.events.readRange(runId, { types: LIST_EVENT_TYPES, before: last.seq + 1 });
    if (!events.length) return undefined;
    const facts = runFacts(events);
    const view = await this.runView(facts);
    return { ...view, operations: await this.operationsAt(runId, last, facts.progress) };
  }

  /**
   * The operations facts of a projection that already knows its watermark (`runs.get`'s
   * `RunState.lastSeq`): the event at exactly that sequence, never a newer one.
   */
  async operationsOf(
    runId: string,
    lastSeq: number,
    progress: RunProgressView,
  ): Promise<RunOperationsView | undefined> {
    const [last] = await this.orc.stores.events.readRange(runId, { before: lastSeq + 1, limit: 1 });
    return last && last.seq === lastSeq ? this.operationsAt(runId, last, progress) : undefined;
  }

  private async operationsAt(runId: string, last: OrcaEvent, progress: RunProgressView): Promise<RunOperationsView> {
    const lease = await this.lease(runId);
    return {
      lastSeq: last.seq,
      lastActivityAt: last.at,
      progress,
      ...(lease
        ? { owner: { holder: lease.holder, host: lease.host, since: lease.acquiredAt, lapsed: lease.lapsed } }
        : {}),
      facets: UNAVAILABLE_FACETS,
    };
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
      ...(summary.checkpoint ? { checkpoint: { ...summary.checkpoint } } : {}),
      ...(summary.origin ? { origin: { ...summary.origin } } : {}),
      ...(summary.requestId ? { requestId: summary.requestId } : {}),
      ...(workItem ? { workItem } : {}),
      ...(facts.agentId ? { agentId: facts.agentId } : {}),
      ...(viewError(facts.error) ? { error: viewError(facts.error)! } : {}),
    };
  }
}

export interface ReadModelOptions {
  orchestrator: Orchestrator;
  /**
   * The long-term plan, when this daemon serves one (#169). Present means the nine plan read
   * methods are answered and advertised; absent means they are not in the table at all, the
   * same promise `--read-only` makes about the writes. `bootstrap()` always builds one, so in
   * practice a daemon over a real store has it and an embedder projecting runs alone does not.
   */
  plan?: PlanService | undefined;
  /** Defaults to the orchestrator's own clock, so a test can pin every `asOf` and duration. */
  clock?: Clock | undefined;
}

export class ReadModel {
  private readonly orc: Orchestrator;
  private readonly clock: Clock;
  /** The plan projection, or `undefined` when this daemon was given no plan service. */
  readonly plans: PlanModel | undefined;

  constructor(opts: ReadModelOptions) {
    this.orc = opts.orchestrator;
    this.clock = opts.clock ?? opts.orchestrator.clock;
    this.plans = opts.plan
      ? new PlanModel({
          plan: opts.plan,
          orchestrator: opts.orchestrator,
          ...(opts.clock ? { clock: opts.clock } : {}),
        })
      : undefined;
  }

  private pass(): Pass {
    return new Pass(this.orc, this.clock.isoNow());
  }

  /** Newest first, filtered, paged. A run whose log has gone missing is skipped, not faked. */
  async runsList(params: RunsListParams): Promise<RunsListResult> {
    const pass = this.pass();
    const only = params.runIds ? new Set(params.runIds) : undefined;
    const ids = (await this.orc.listRuns()).filter((id) => !only || only.has(id));
    const from = params.createdFrom === undefined ? undefined : Date.parse(params.createdFrom);
    const to = params.createdTo === undefined ? undefined : Date.parse(params.createdTo);
    const rows: RunSummaryView[] = [];
    for (const id of ids) {
      const facts = await pass.runFacts(id);
      if (!facts) continue;
      const s = facts.summary;
      if (params.requestId && s.requestId !== params.requestId) continue;
      if (params.workItemId && s.workItemId !== params.workItemId) continue;
      if (params.parentRunId && s.parentRunId !== params.parentRunId) continue;
      if (params.roots && s.parentRunId) continue;
      if (params.workflowId && s.workflowId !== params.workflowId) continue;
      if (params.workflowVersion && s.workflowVersion !== params.workflowVersion) continue;
      if (params.outcome?.length && !(s.outcome && params.outcome.includes(s.outcome))) continue;
      if (from !== undefined && !(Date.parse(s.createdAt) >= from)) continue;
      if (to !== undefined && !(Date.parse(s.createdAt) < to)) continue;
      const view = await pass.runView(facts);
      if (params.status?.length && !params.status.includes(view.status)) continue;
      rows.push(view);
    }
    // `listRuns` is oldest first and ids are time-ordered, but createdAt is what a client sorts by.
    // The id breaks ties, so a page boundary is the same on every call over the same store.
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const page = rows.slice(params.offset, params.offset + params.limit);
    const runs: RunSummaryView[] = [];
    for (const view of page) {
      const detailed = params.operations ? await pass.operationsRow(view.id) : undefined;
      // The page was filtered on the listing pass. A run that has since moved out of the filter
      // (its status or outcome changed) keeps the plain row that matched, frozen without
      // operations, rather than a newer projection the filter would not have returned.
      runs.push(detailed && stillMatches(detailed, params) ? detailed : view);
    }
    return { runs, total: rows.length, asOf: pass.asOf };
  }

  /** One run, whole: the tree of steps and attempts, its children, its artifacts. */
  async runsGet(params: RunsGetParams): Promise<RunsGetResult> {
    const pass = this.pass();
    const state = await this.orc.getState(params.runId);
    const agentByStep = await this.agentsByStep(params.runId);
    const facts = factsFromState(state, agentByStep);
    const view = await pass.runView(facts);
    const operations = params.operations
      ? await pass.operationsOf(params.runId, state.lastSeq, facts.progress)
      : undefined;
    const run = operations ? { ...view, operations } : view;
    const steps: StepView[] = [];
    for (const id of state.stepOrder) {
      const step = state.steps[id];
      if (step) steps.push(await this.stepView(pass, step, agentByStep.get(step.id)));
    }
    const onDisk = this.versionOnDisk(state.run.workflowId);
    return {
      // Pinned only against a version that is on disk: an unregistered workflow has nothing newer.
      run: { ...run, workflowPinned: onDisk !== undefined && onDisk !== state.run.workflowVersion },
      ...(state.run.provenance ? { provenance: state.run.provenance } : {}),
      workspace: state.run.workspace,
      vars: state.run.vars,
      steps,
      // The graph the run is walking: its pinned definition when the file has moved on (#179).
      traversal: traversalView(
        state,
        await this.definitionOrUndefined(state.run.workflowId, state.run.workflowVersion),
      ),
      artifacts: Object.values(state.artifacts)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(artifactView),
      lastSeq: state.lastSeq,
      asOf: pass.asOf,
    };
  }

  /**
   * `runs.recovery` (#357): the same assessment `orca recovery` prints, read from the run's
   * log and the store. Read-only: no lease, nothing written. `principalId` is the caller, so
   * a run started by someone else says so rather than offering a checkpoint attempt. Without
   * `artifacts` (a caller lacking `artifacts.read`) no artifact is read or named, and each
   * checkpoint is unverified on that point rather than blocked.
   */
  async runsRecovery(params: RunsRecoveryParams, principalId?: string, artifacts = true): Promise<RunsRecoveryResult> {
    const asOf = this.clock.isoNow();
    const summary = await this.orc.getSummary(params.runId);
    let currentConfigGeneration: string | undefined;
    try {
      currentConfigGeneration = this.orc.generations?.current.snapshot.id;
    } catch {
      currentConfigGeneration = undefined;
    }
    const assessment = await previewRecovery(this.orc.stores, params.runId, {
      ...(params.checkpoint ? { checkpoint: params.checkpoint } : {}),
      ...(principalId ? { principalId } : {}),
      artifacts,
      currentWorkflowVersion: this.versionOnDisk(summary.workflowId.split(INLINE_SEP)[0]!),
      currentConfigGeneration,
    });
    return { assessment, asOf };
  }

  /**
   * One page of the log. `after` walks forward from a sequence number, `before` walks back
   * to the `limit` events immediately preceding one; either way the page reads oldest first,
   * so the timeline renders the same code path in both directions.
   *
   * The page is a ranged read, not a slice of the whole log (#208): the store scans to the
   * page and stops, so scrolling up through a run whose log is tens of thousands of
   * `agent.update` lines costs a page rather than the log. `lastSeq` comes from the store
   * for the same reason - it is the end of the log, which no page has to contain.
   *
   * `hasMore` is one event's worth of over-asking: the page is requested one longer than the
   * client asked for, and the extra - which is the *oldest* of a backward page and the
   * newest of a forward one - is dropped after it has answered the question.
   */
  async runsEvents(params: RunsEventsParams): Promise<RunsEventsResult> {
    const asOf = this.clock.isoNow();
    const lastSeq = await this.orc.lastSeq(params.runId);
    if (lastSeq === undefined)
      throw new OrcaError("RUN_NOT_FOUND", `run ${params.runId} not found`, { runId: params.runId });
    const types = params.types;
    const stepRunId = params.stepRunId;
    // An unknown type matches nothing rather than failing: a newer client may ask for an
    // event type this daemon's engine does not emit. The two filters are an AND, and the
    // store applies both *before* it counts against the limit, so the cursors below are
    // cursors into the filtered sequence while staying the run's own sequence numbers.
    const got = await this.orc.eventsRange(params.runId, {
      ...(params.after !== undefined ? { after: params.after } : {}),
      ...(params.before !== undefined ? { before: params.before } : {}),
      limit: params.limit + 1,
      ...(types?.length ? { types } : {}),
      ...(stepRunId !== undefined ? { match: (e: OrcaEvent) => stepRunIdOf(e) === stepRunId } : {}),
    });
    const hasMore = got.length > params.limit;
    const page = !hasMore
      ? got
      : params.before !== undefined
        ? got.slice(got.length - params.limit)
        : got.slice(0, params.limit);
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

  /**
   * Internal restriction projection, never an RPC or a revision capability. The server must
   * authorize and filter the input first. No protected journal, payload or lease is read.
   * A legacy run without a recorded pin is deliberately not inferred from current defaults.
   */
  async inputRevisionActionId(
    input: Pick<OpenInputView, "id" | "kind" | "runId" | "stepRunId" | "nodeId" | "options" | "live">,
  ): Promise<string | undefined> {
    if (input.kind !== "decision" || input.live) return undefined;
    const unavailable = () => new OrcaError("RUN_STATE", "The pinned input declaration is unavailable");
    const current = async () => {
      const events = await this.orc.events(input.runId);
      const created = events[0];
      if (created?.type !== "run.created" || created.runId !== input.runId) throw unavailable();
      const state = reduceRun(events);
      // The row was pending when listed. Retain its restriction if answered concurrently:
      // the scalar says which action is special, never that this request is still writable.
      const request = state.humanInputs[input.id];
      const step = state.steps[input.stepRunId];
      if (
        !request ||
        request.id !== input.id ||
        request.runId !== input.runId ||
        request.stepRunId !== input.stepRunId ||
        request.kind !== "decision" ||
        request.liveDecision ||
        !step ||
        step.runId !== input.runId ||
        step.id !== input.stepRunId ||
        step.nodeId !== input.nodeId
      )
        throw unavailable();
      return { created, request, step };
    };
    const before = structuredClone(await current());
    if (before.created.payload.workflowStored !== true) {
      // Legacy agent-origin decisions are not workflow gates. Their recorded node class
      // cannot declare a corrective branch; unpinned gates/decisions remain unavailable.
      if (before.step.nodeType !== "gate" && before.step.nodeType !== "decision") return undefined;
      throw unavailable();
    }
    const { workflowId, workflowVersion, provenance } = before.created.payload;
    const root = await this.orc.stores.workflows.get(workflowId.split(INLINE_WORKFLOW_SEPARATOR)[0]!, workflowVersion);
    if (!root || root.version !== workflowVersion) throw unavailable();
    const definition = storedInputDefinition(root, workflowId);
    if (
      !definition ||
      (provenance &&
        (provenance.workflow.id !== workflowId ||
          provenance.workflow.version !== workflowVersion ||
          provenance.workflow.revision !== workflowRevision(definition)))
    )
      throw unavailable();
    const node = definition.nodes[before.step.nodeId];
    if (!node || node.type !== before.step.nodeType) throw unavailable();
    const revision = node.type === "gate" || node.type === "decision" ? node.revision : undefined;
    const actionId = revision?.actionId;
    if (revision !== undefined) {
      if (!validateRevisionCapability(definition, before.step.nodeId, revision).ok) throw unavailable();
      if (
        !input.options.some((option) => option.id === actionId) ||
        !before.request.options.some((option) => option.id === actionId)
      )
        throw unavailable();
    }
    const after = await current();
    if (
      !isDeepStrictEqual(after.created, before.created) ||
      after.step.nodeId !== before.step.nodeId ||
      !isDeepStrictEqual(after.request.options, before.request.options)
    )
      throw unavailable();
    return actionId;
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
      artifacts: await Promise.all(
        rows.slice(params.offset, params.offset + params.limit).map((artifact) => this.publicArtifactView(artifact)),
      ),
      total: rows.length,
      asOf,
    };
  }

  /**
   * One artifact, by id or by the (`runId`, `name`, `version?`) address a deep link carries,
   * with its body when the body is text of a sane size. Declining is not an error: the panel
   * still shows what the artifact *is*, and says why it is not showing what it says.
   *
   * It still declines a binary body, and that is now a choice rather than a limitation: the
   * store round-trips bytes since #226, so what stops a 200 MB PNG here is the JSON-RPC wire
   * it would have to travel on, not the store it came from. What did change is that the
   * reason is true - `size` is bytes, so the number it quotes is the number of bytes a
   * download would be.
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
    const view = await this.publicArtifactView(artifact);
    if (!isTextMediaType(artifact.mediaType))
      return {
        artifact: view,
        omitted: {
          reason: "binary",
          detail: `${artifact.mediaType} is not text; ${artifact.size} bytes in the store, which this call does not carry`,
        },
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
    return { artifact: view, text: await this.protectedArtifactText(artifact), asOf };
  }

  /**
   * `search` (#255): a bounded substring scan over event text and text artifacts, newest run
   * first. `scope` is the caller's view - which runs, and whether artifacts - and is absent
   * for a daemon that does not authenticate, which shows everything to everyone.
   */
  search(params: SearchParams, scope?: SearchScope): Promise<SearchResult> {
    return searchStore(
      {
        orc: this.orc,
        isoNow: () => this.clock.isoNow(),
        publicName: async (artifact) => (await this.publicArtifactView(artifact)).name,
        artifactText: (artifact) => this.protectedArtifactText(artifact),
      },
      params,
      scope,
    );
  }

  /**
   * Every workflow this daemon has registered, by id. It is the registry and not the disk:
   * workflows are loaded once at bootstrap from the glob in `orca.config.yaml`, so this is
   * what the daemon would *run*, which is the honest thing for a viewer to draw.
   */
  workflowsList(_params: WorkflowsListParams): WorkflowsListResult {
    const asOf = this.clock.isoNow();
    const workflows = (this.orc.generations?.current.workflows ?? this.orc.workflows).list().map(workflowSummaryView);
    workflows.sort((a, b) => a.id.localeCompare(b.id));
    return { workflows, asOf };
  }

  /**
   * One workflow, whole, with its nested graphs inline. `id` may be a registered workflow's
   * or an inline graph's `parent::node`; either way the resolution is the engine's own
   * (`Orchestrator.resolveDefinition`), so the viewer and the interpreter agree about what a
   * nested id names. An unknown id raises `WORKFLOW_NOT_FOUND`, which is that method's error.
   *
   * `version` answers from the file on disk when it is at that version, and otherwise from
   * the workflow-version store, where `startRun` keeps the definition each run started on
   * (#179) - so a run pinned to an older version can be shown the graph it is walking. A
   * version in neither place is `WORKFLOW_VERSION_NOT_FOUND`, naming what exists, rather than
   * a graph that is not the one that ran. `pinned` says a version is on disk and the answer is
   * not it; a definition only the store has, with no file registered, is not pinned.
   */
  async workflowsGet(params: WorkflowsGetParams): Promise<WorkflowsGetResult> {
    const asOf = this.clock.isoNow();
    const def =
      params.version === undefined
        ? this.orc.resolveDefinition(params.id)
        : await this.orc.definitionFor(params.id, params.version);
    const onDisk = this.versionOnDisk(params.id);
    const pinned = onDisk !== undefined && onDisk !== def.version;
    return { workflow: workflowView(def, await this.recordedVersions(def), pinned), asOf };
  }

  /**
   * Legacy-sensitive withholding for an artifact's run: a protected store refuses this read
   * with RUN_STATE when the run's sensitive history still needs migration. Every artifact
   * read goes through it first, even one addressed by artifact ID.
   */
  private async requireArtifactReadable(artifact: Artifact): Promise<void> {
    await this.orc.stores.events.readRange(artifact.producedBy.runId, { limit: 1 });
  }

  /**
   * The one protected read of an artifact body, shared by `artifacts.get` and `search`: the
   * withholding check before the blob is opened, then the run's secrets redacted. `content`
   * raises ARTIFACT_MISSING itself when the index knows an artifact whose body is gone.
   */
  private async protectedArtifactText(artifact: Artifact): Promise<string> {
    await this.requireArtifactReadable(artifact);
    const privateInputs = await this.orc.stores.execution.getInputs(artifact.producedBy.runId);
    const text = await this.orc.stores.artifacts.content(artifact.id);
    return privateInputs ? redactExecutionValue(text, privateInputs.secrets) : text;
  }

  /** Artifact originals stay authoritative in their store; the wire gets a safe projection. */
  private async publicArtifactView(artifact: Artifact): Promise<ArtifactView> {
    await this.requireArtifactReadable(artifact);
    const view = artifactView(artifact);
    const inputs = await this.orc.stores.execution.getInputs(artifact.producedBy.runId);
    if (!inputs) return view;
    return {
      ...view,
      name: redactExecutionValue(view.name, inputs.secrets),
      ...(view.path ? { path: redactExecutionValue(view.path, inputs.secrets) } : {}),
    };
  }

  // ------------------------------------------------------------------ pieces

  /**
   * The versions of this workflow the daemon can see: the one on disk, plus every version
   * the runs in this store were started against (`run.created` records `workflowVersion`).
   * Oldest first by string order, which is what a version of `"1"`, `"2"`, `"11"` sorts to
   * numerically only by accident - the field is free text in the schema, so this sorts it
   * as text and does not pretend to a numbering scheme workflows do not have.
   *
   * A nested graph's id (`parent::node`) never matches a run's `workflowId` unless the engine
   * spawned a child run for it, which is exactly when it should: a loop body that ran has its
   * own child runs, recorded under that id.
   */
  private async recordedVersions(def: WorkflowDefinition): Promise<string[]> {
    const rootId = def.id.split(INLINE_WORKFLOW_SEPARATOR)[0]!;
    const onDisk = this.versionOnDisk(rootId);
    const versions = new Set<string>([
      def.version,
      ...(onDisk === undefined ? [] : [onDisk]),
      ...(await this.orc.stores.workflows.versions(rootId)),
    ]);
    const pass = this.pass();
    for (const id of await this.orc.listRuns()) {
      const facts = await pass.runFacts(id);
      if (facts?.summary.workflowId === def.id) versions.add(facts.summary.workflowVersion);
    }
    return [...versions].sort((a, b) => a.localeCompare(b));
  }

  /**
   * The run's definition at the version it recorded, or nothing when neither the file nor the
   * store has it. A run with no stored copy falls back to the file on disk, as a run that
   * predates versioning does in the engine.
   */
  private async definitionOrUndefined(workflowId: string, version: string): Promise<WorkflowDefinition | undefined> {
    try {
      return await this.orc.definitionFor(workflowId, version, false);
    } catch (e) {
      if (e instanceof OrcaError && (e.code === "WORKFLOW_NOT_FOUND" || e.code === "WORKFLOW_VERSION_NOT_FOUND"))
        return undefined;
      throw e;
    }
  }

  /** The version of the file on disk for this workflow (or the root of a nested id), if it is registered. */
  private versionOnDisk(workflowId: string): string | undefined {
    const rootId = workflowId.split(INLINE_WORKFLOW_SEPARATOR)[0]!;
    return (this.orc.generations?.current.workflows ?? this.orc.workflows).has(rootId)
      ? (this.orc.generations?.current.workflows ?? this.orc.workflows).get(rootId).version
      : undefined;
  }

  /** `stepRunId -> {agentId, model?}`, from the only event that records which agent worked a step. */
  private async agentsByStep(runId: string): Promise<Map<string, { agentId: string; model?: string }>> {
    const byStep = new Map<string, { agentId: string; model?: string }>();
    for (const e of await this.orc.stores.events.readTypes(runId, ["agent.session.opened"]))
      if (e.type === "agent.session.opened")
        byStep.set(e.payload.stepRunId, {
          agentId: e.payload.agentId,
          ...(e.payload.model !== undefined ? { model: e.payload.model } : {}),
        });
    return byStep;
  }

  private async stepView(
    pass: Pass,
    step: StepRun,
    agent: { agentId: string; model?: string } | undefined,
  ): Promise<StepView> {
    const finishedAt = step.completedAt;
    const duration = elapsed(step.startedAt, finishedAt ?? pass.now);
    const children = await this.childViews(pass, step.children);
    const reusedChildren = step.reusedChildren ? await this.childViews(pass, step.reusedChildren) : undefined;
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
      ...(step.reusedFrom ? { reusedFrom: { ...step.reusedFrom } } : {}),
      ...(reusedChildren?.length ? { reusedChildren } : {}),
      ...(step.effectReview
        ? {
            effectReview: {
              decision: step.effectReview.decision,
              at: step.effectReview.at,
              ...(step.effectReview.note ? { note: step.effectReview.note } : {}),
            },
          }
        : {}),
      ...(step.iteration === undefined ? {} : { iteration: step.iteration }),
      ...(step.waitingOn ? { waitingOn: step.waitingOn } : {}),
      ...(step.startedAt ? { startedAt: step.startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      ...(duration === undefined ? {} : { durationMs: duration }),
      ...(agent ? { agentId: agent.agentId } : {}),
      ...(agent?.model !== undefined ? { model: agent.model } : {}),
      ...(step.agentSessionId ? { agentSessionId: step.agentSessionId } : {}),
      ...(step.result?.choice ? { choice: step.result.choice } : {}),
      ...(step.result?.message ? { message: step.result.message } : {}),
      ...(viewError(step.error) ? { error: viewError(step.error)! } : {}),
    };
  }

  private async childViews(pass: Pass, links: StepRun["children"]): Promise<ChildRunView[]> {
    const children: ChildRunView[] = [];
    for (const link of links) {
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
    return children;
  }

  private async inputView(pass: Pass, request: HumanInputRequest, state: RunState): Promise<OpenInputView> {
    const identity = LiveDecisionIdentitySchema.safeParse(request.liveDecision);
    const target = identity.success
      ? { ...identity.data, runId: request.runId, stepRunId: request.stepRunId, requestId: request.id }
      : undefined;
    const facts = factsFromState(state, new Map());
    const live = target
      ? {
          target,
          state: (await pass.leaseLapsed(facts.summary))
            ? ("expired" as const)
            : (this.orc.liveInput?.port.inspect(target) ?? ("owner-unavailable" as const)),
        }
      : undefined;
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
      ...(live ? { live } : {}),
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
      ...(session ? { agent: { id: session.agentId, hostId: session.hostId, ...(hostType ? { hostType } : {}) } } : {}),
      // What each "always" would write, bound to this ask and agent (#702). Only with an
      // agent: a rule is written for one, and a preview that named none could not be checked.
      ...(session ? standingPreview(request, state, session.agentId) : {}),
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

function standingPreview(
  request: HumanInputRequest,
  state: RunState,
  agentId: string,
): Pick<OpenInputView, "standing"> {
  const allow = standingRulePreview(request, state, agentId, "allow");
  const deny = standingRulePreview(request, state, agentId, "deny");
  return allow && deny ? { standing: { allow, deny } } : {};
}
