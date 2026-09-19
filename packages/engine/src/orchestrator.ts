/**
 * Orchestrator - the workflow interpreter.
 *
 * One run = one token walking the graph from `start` to an `end` node.
 * Concurrency comes from `parallel` nodes, which spawn child runs. Every state
 * transition is an event; a run can be resumed from its log at any time.
 */
import { AgentRegistry, openAcpSession, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import {
  describeError,
  evaluateCondition,
  evaluateExpression,
  newId,
  OrcaError,
  outgoing,
  pendingHumanInputs,
  reduceRunSummary,
  renderTemplate,
  retryBudget,
  RUN_SUMMARY_EVENT_TYPES,
  runSummary,
  sha256,
  silentLogger,
  systemClock,
  TemplateRegistry,
  WorkflowRegistry,
  type AgentSelector,
  type Artifact,
  type ArtifactRef,
  type ArtifactSpec,
  type Clock,
  type Edge,
  type HumanInputRequest,
  type Logger,
  type NodeDef,
  type OrcaEvent,
  type RunState,
  type RunSummary,
  type StepResult,
  type StepRun,
  type WorkflowDefinition,
  type WorkflowGraph,
  type Workspace,
} from "@orca/core";
import { reduceRun } from "@orca/core";
import {
  DEFAULT_LEASE_TTL_MS,
  describeLease,
  keepLease,
  lapsed,
  ownsLease,
  type EventFilter,
  type EventListener,
  type HeldLease,
  type Lease,
  type Stores,
  type WorkItemClaim,
} from "@orca/store";
import { builtinExecutors } from "./executors/index.js";
import {
  NodeExecutorRegistry,
  paused,
  type ResolvedArtifact,
  type StepContext,
  type StepOutcome,
} from "./executors/types.js";
import {
  abortableHumanInput,
  askHumanInput,
  autoHumanInput,
  isHumanInputPending,
  type HumanInputPort,
} from "./human-input.js";
import { PlanService } from "./plan/service.js";
import { RunContext } from "./run-context.js";
import { LocalWorkspaceProvider, type WorkspaceProvider } from "./workspace/provider.js";

/** Opens an agent session; defaults to ACP over stdio (local or ssh). Integrations can substitute other transports. */
export type SessionFactory = (options: OpenSessionOptions) => Promise<AgentSession>;

export interface OrchestratorOptions {
  stores: Stores;
  agents: AgentRegistry;
  workflows: WorkflowRegistry;
  templates: TemplateRegistry;
  executors?: NodeExecutorRegistry;
  humanInput?: HumanInputPort;
  workspaceProvider?: WorkspaceProvider;
  sessionFactory?: SessionFactory;
  /** Planning layer; created over `stores` when omitted. */
  plan?: PlanService;
  clock?: Clock;
  logger?: Logger;
  /** Single-writer lease per run; see `runLease` for what the defaults mean. */
  lease?: RunLeaseOptions;
}

export interface RunLeaseOptions {
  /**
   * How long a run's lease survives without a heartbeat, in ms. Default 60 s. It has to be
   * comfortably longer than the gap between heartbeats *and* than any pause the event loop
   * might take, because a lease that lapses under a live interpreter is exactly the
   * two-writer situation it exists to prevent.
   */
  ttlMs?: number;
  /** Heartbeat interval, in ms. Default `ttlMs / 3`. */
  renewMs?: number;
  /**
   * Identity of this attachment, shared by every run it drives. Defaults to a fresh id per
   * Orchestrator; set it when a process must be able to reclaim its own leases after a
   * restart (a daemon with a stable instance id).
   */
  holder?: string;
}

/** A lease together with whether it may be taken over without an operator saying so. */
export type HeldRunLease = Lease & { runId: string; lapsed: boolean };

/** A work-item claim together with the state of the run that holds it. */
export type HeldClaim = WorkItemClaim & { owner: RunSummary["status"] | "missing" };

export interface StartRunOptions {
  workflowId?: string;
  inline?: { graph: WorkflowGraph; id: string; version?: string };
  vars?: Record<string, unknown>;
  workspace?: Workspace;
  requestId?: string;
  workItemId?: string;
  parentRunId?: string;
  parentStepRunId?: string;
}

export const INLINE_SEP = "::";

export class Orchestrator {
  readonly stores: Stores;
  readonly agents: AgentRegistry;
  readonly workflows: WorkflowRegistry;
  readonly templates: TemplateRegistry;
  readonly executors: NodeExecutorRegistry;
  humanInput: HumanInputPort;
  workspaceProvider: WorkspaceProvider;
  sessionFactory: SessionFactory;
  readonly plan: PlanService;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Who this orchestrator is, as far as the lease store is concerned. One id for the whole
   * instance: a run it is already driving is re-acquired rather than blocked, so nested
   * `runChild` calls and a resumed attach never deadlock against themselves.
   */
  readonly leaseHolder: string;
  private readonly leaseTtlMs: number;
  private readonly leaseRenewMs: number | undefined;

  private readonly live = new Map<string, RunContext>();
  private readonly running = new Map<string, Promise<RunState>>();
  /**
   * Reduced states of runs that have reached a terminal status. A terminal run's log does not grow
   * again, so its projection is worth keeping: `visibleArtifacts()` walks the whole parent/child
   * tree on every condition and prompt render, and without this each walk re-read and re-parsed
   * every completed child's log. Any append for a run drops its entry (see the subscription in the
   * constructor), so the cache cannot outlive a run that is somehow restarted in this process.
   * Bounded FIFO - a long-lived orchestrator would otherwise hold every run it ever touched.
   */
  private readonly terminalStates = new Map<string, RunState>();
  /** Per-run pooled sessions. `current.step` is the step using the session right now, so events from a long-lived session are attributed correctly. */
  private readonly sessions = new Map<string, { session: AgentSession; current: { step: StepRun } }>();

  constructor(o: OrchestratorOptions) {
    this.stores = o.stores;
    this.agents = o.agents;
    this.workflows = o.workflows;
    this.templates = o.templates;
    this.executors = o.executors ?? builtinExecutors();
    this.humanInput = o.humanInput ?? autoHumanInput();
    this.workspaceProvider = o.workspaceProvider ?? new LocalWorkspaceProvider(process.cwd());
    this.sessionFactory = o.sessionFactory ?? openAcpSession;
    this.clock = o.clock ?? systemClock;
    this.logger = o.logger ?? silentLogger;
    this.leaseHolder = o.lease?.holder ?? newId("orc", this.clock.now());
    this.leaseTtlMs = o.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.leaseRenewMs = o.lease?.renewMs;
    this.plan =
      o.plan ??
      new PlanService({ stores: this.stores, clock: this.clock, logger: this.logger.child({ component: "plan" }) });
    this.stores.events.subscribe((e) => void this.terminalStates.delete(e.runId));
  }

  // ---------------------------------------------------------------- public API

  /** Create a run (emits run.created) without executing it. */
  async startRun(opts: StartRunOptions): Promise<string> {
    const def = opts.inline
      ? this.inlineDefinition(opts.inline.id, opts.inline.graph, opts.inline.version ?? "1")
      : this.workflows.get(opts.workflowId!);
    const runId = newId("run", this.clock.now());
    const request = opts.requestId ? await this.stores.requests.get(opts.requestId) : undefined;
    const workItem = opts.workItemId ? await this.stores.workItems.get(opts.workItemId) : undefined;
    const workspace =
      opts.workspace ??
      (await this.workspaceProvider.provision({
        runId,
        workflowId: def.id,
        request,
        workItem,
        parent: opts.parentRunId ? (await this.getState(opts.parentRunId)).run.workspace : undefined,
      }));
    await this.stores.events.append({
      type: "run.created",
      runId,
      payload: {
        workflowId: def.id,
        workflowVersion: def.version,
        workspace,
        vars: { ...def.vars, ...(opts.vars ?? {}) },
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        ...(opts.workItemId ? { workItemId: opts.workItemId } : {}),
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
        ...(opts.parentStepRunId ? { parentStepRunId: opts.parentStepRunId } : {}),
      },
    });
    return runId;
  }

  /** Execute (or resume) a run until it reaches a terminal state. Safe to call twice. */
  run(runId: string): Promise<RunState> {
    const inflight = this.running.get(runId);
    if (inflight) return inflight;
    const p = this.executeLeased(runId)
      .then((state) => {
        if (isTerminal(state)) this.cacheTerminalState(runId, state);
        return state;
      })
      .finally(() => {
        this.running.delete(runId);
        this.live.delete(runId);
      });
    this.running.set(runId, p);
    return p;
  }

  async startAndRun(opts: StartRunOptions): Promise<RunState> {
    return this.run(await this.startRun(opts));
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    const rc = this.live.get(runId);
    if (rc) {
      rc.abort.abort(reason ?? "cancelled");
      for (const s of Object.values(rc.state.steps)) for (const c of s.childRunIds) await this.cancel(c, reason);
    } else {
      const state = await this.getState(runId);
      if (isTerminal(state)) return;
      // A parked run tree: cancel the children it is waiting on, then close its own open step.
      for (const s of Object.values(state.steps)) for (const c of s.childRunIds) await this.cancel(c, reason);
      // Closing a run we are not driving is still writing to its log, so it goes through the
      // same lease: cancelling a run another process is interpreting has to be refused there,
      // not raced into the log (that process would keep appending afterwards).
      const lease = await this.stores.leases.acquire({
        resource: runLeaseResource(runId),
        holder: this.leaseHolder,
        ttlMs: this.leaseTtlMs,
        note: "cancel",
      });
      if (!ownsLease(lease, this.leaseHolder))
        throw new OrcaError(
          "RUN_LEASED",
          `run ${runId} is being interpreted by pid ${lease.pid} on ${lease.host}: cancel it there, or take the lease with 'orca leases break ${runId} --force'`,
          { runId, ...describeLease(lease) },
        );
      try {
        for (const s of openSteps(state))
          await this.stores.events.append({ type: "step.cancelled", runId, payload: { stepRunId: s.id } });
        await this.stores.events.append({ type: "run.cancelled", runId, payload: reason ? { reason } : {} });
      } finally {
        await this.stores.leases.release(lease);
      }
    }
  }

  /** Projected state of a run. Treat it as read-only: a live or terminal run's projection is shared. */
  async getState(runId: string): Promise<RunState> {
    const live = this.live.get(runId);
    if (live) return live.state;
    const cached = this.terminalStates.get(runId);
    if (cached) return cached;
    const events = await this.stores.events.read(runId);
    if (events.length === 0) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
    const state = reduceRun(events);
    if (isTerminal(state)) this.cacheTerminalState(runId, state);
    return state;
  }

  private cacheTerminalState(runId: string, state: RunState): void {
    if (this.terminalStates.size >= TERMINAL_STATE_CACHE_SIZE) {
      const oldest = this.terminalStates.keys().next();
      if (!oldest.done) this.terminalStates.delete(oldest.value);
    }
    this.terminalStates.set(runId, state);
  }

  events(runId: string): Promise<OrcaEvent[]> {
    return this.stores.events.read(runId);
  }
  subscribe(listener: EventListener, filter?: EventFilter): () => void {
    return this.stores.events.subscribe(listener, filter);
  }
  listRuns(): Promise<string[]> {
    return this.stores.events.listRuns();
  }

  /**
   * One summary per run in the store, oldest first. Unlike `getState` per id
   * this never replays a run's step or agent events, so listing stays cheap as
   * logs grow.
   */
  async listRunSummaries(): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const id of await this.listRuns()) out.push(await this.getSummary(id));
    return out;
  }

  async getSummary(runId: string): Promise<RunSummary> {
    const live = this.live.get(runId);
    if (live) return runSummary(live.state);
    const events = await this.stores.events.readTypes(runId, RUN_SUMMARY_EVENT_TYPES);
    if (events.length === 0) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
    return reduceRunSummary(events);
  }

  // ------------------------------------------------------------ human input

  /** Human-input requests still waiting for an answer: in one run and its descendants, or in every run of the store. */
  async pendingInputs(runId?: string): Promise<HumanInputRequest[]> {
    const out: HumanInputRequest[] = [];
    const seen = new Set<string>();
    const visit = async (id: string, descend: boolean) => {
      if (seen.has(id)) return;
      seen.add(id);
      let state: RunState;
      try {
        state = await this.getState(id);
      } catch (e) {
        // A child a parent's log points at, whose own log is gone (a rolled-back store) is
        // asking nobody anything. The same tolerance `runTree` has: one missing log must not
        // take down the answer for every other run.
        if (e instanceof OrcaError && e.code === "RUN_NOT_FOUND") return;
        throw e;
      }
      out.push(...pendingHumanInputs(state));
      if (descend) for (const s of Object.values(state.steps)) for (const c of s.childRunIds) await visit(c, true);
    };
    if (runId) await visit(runId, true);
    else for (const id of await this.listRuns()) await visit(id, false);
    return out;
  }

  /**
   * Record a human's answer in the run's event log. The run must be parked
   * (`run.paused`, see PausingHumanInput); it is not continued here - call
   * `resume()` afterwards. Throws RUN_STATE if the request is not pending, the
   * run is live in some process, or the answer is not one of the options.
   */
  async answer(requestId: string, answer: string, runId?: string): Promise<HumanInputRequest> {
    const request = (runId ? pendingHumanInputs(await this.getState(runId)) : await this.pendingInputs()).find(
      (h) => h.id === requestId,
    );
    if (!request) throw new OrcaError("RUN_STATE", `no pending human input '${requestId}'`, { requestId });
    const state = await this.getState(request.runId);
    if (state.run.status !== "paused")
      throw new OrcaError(
        "RUN_STATE",
        `run ${request.runId} is ${state.run.status}, not paused: answer it through the process running it`,
        { runId: request.runId, status: state.run.status },
      );
    if (request.options.length && !request.options.includes(answer))
      throw new OrcaError("RUN_STATE", `'${answer}' is not one of: ${request.options.join(", ")}`, {
        requestId,
        options: request.options,
      });
    await this.stores.events.append({
      type: "human.answered",
      runId: request.runId,
      payload: { stepRunId: request.stepRunId, requestId, answer },
    });
    return { ...request, answer };
  }

  /**
   * Continue a parked run together with the ancestors parked on it: parents
   * pause when a child pauses, so the topmost paused ancestor is re-driven and
   * re-attaches to its children on the way down.
   */
  async resume(runId: string): Promise<RunState> {
    let id = runId;
    for (;;) {
      const state = await this.getState(id);
      if (!state.run.parentRunId) break;
      if ((await this.getState(state.run.parentRunId)).run.status !== "paused") break;
      id = state.run.parentRunId;
    }
    return this.run(id);
  }

  // ------------------------------------------------------------------ claims

  /**
   * Who owns which work item (see store/claim-store.ts), each with the status of the run
   * holding it - `missing` when that run's log is gone, e.g. the store was rolled back under a
   * claim. Optionally only the claims one run holds.
   */
  async listClaims(runId?: string): Promise<HeldClaim[]> {
    const claims = (await this.stores.claims.list()).filter((c) => !runId || c.runId === runId);
    const out: HeldClaim[] = [];
    for (const claim of claims.sort((a, b) => a.at.localeCompare(b.at) || a.workItemId.localeCompare(b.workItemId)))
      out.push({ ...claim, owner: await this.ownerStatus(claim.runId) });
    return out;
  }

  /**
   * Take a work item away from the run that claimed it, so another dispatcher may launch it.
   * A claim is never released on its own - a finished run keeps its items so they are not
   * dispatched twice, and a claim outlives the process that took it - so this is the
   * operator's act, for a run that is dead: it is refused while the owner could still resume
   * (running, paused or waiting) unless `force`, which is what a paused-and-abandoned run needs.
   */
  async releaseClaim(workItemId: string, opts: { force?: boolean } = {}): Promise<HeldClaim> {
    const claim = await this.stores.claims.get(workItemId);
    if (!claim) throw new OrcaError("CLAIM_NOT_FOUND", `work item ${workItemId} is not claimed`, { workItemId });
    const owner = await this.ownerStatus(claim.runId);
    const dead = owner === "missing" || owner === "completed" || owner === "failed" || owner === "cancelled";
    if (!dead && !opts.force)
      throw new OrcaError(
        "RUN_STATE",
        `work item ${workItemId} is claimed by run ${claim.runId}, which is ${owner}, not finished: resume or cancel that run, or release with force`,
        { workItemId, runId: claim.runId, status: owner },
      );
    // Compare-and-delete against the incumbent we inspected: a claim another run took in the meantime survives.
    await this.stores.claims.release(workItemId, claim.runId);
    this.logger.info("work item claim released", {
      workItemId,
      runId: claim.runId,
      branch: claim.branch,
      owner,
      forced: !dead,
    });
    return { ...claim, owner };
  }

  private async ownerStatus(runId: string): Promise<HeldClaim["owner"]> {
    try {
      return (await this.getSummary(runId)).status;
    } catch (e) {
      if (e instanceof OrcaError && e.code === "RUN_NOT_FOUND") return "missing";
      throw e;
    }
  }

  // ------------------------------------------------------------------ leases

  /**
   * The run leases on file - who is interpreting what right now - each marked with whether it
   * has lapsed (its holder stopped heartbeating, or its process is gone). A lapsed lease is
   * taken over by the next `run()` on its own; only a live one needs `breakLease`.
   */
  async listLeases(): Promise<HeldRunLease[]> {
    const now = this.clock.now();
    return (await this.stores.leases.list())
      .filter((l) => l.resource.startsWith(RUN_LEASE_PREFIX))
      .map((l) => ({ ...l, runId: l.resource.slice(RUN_LEASE_PREFIX.length), lapsed: lapsed(l, now) }))
      .sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.runId.localeCompare(b.runId));
  }

  /**
   * Take a run's leases away from their holder, so another interpreter may attach.
   *
   * The whole subtree by default, not just `runId`: resuming a parent re-attaches to the
   * children its interrupted attempt spawned and drives them too, so an operator who takes
   * over a parent and leaves a child leased has taken over nothing - the resume stops at the
   * first `runChild`. Pass `descendants: false` for exactly one run.
   *
   * Refused while any of them is live unless `force`. A live lease means some process is
   * heartbeating for that run this second, and breaking it is precisely what puts two writers
   * on one log; the broken holder finds out at its next heartbeat and cancels itself, so
   * `force` accepts a window of one heartbeat in which it may still append. It is there for
   * what the TTL cannot see - a holder in another pid namespace or on another host that the
   * operator knows is gone (#103) - and is the same operator act as `releaseClaim`.
   *
   * Returns what was broken, the named run first.
   */
  async breakLease(runId: string, opts: { force?: boolean; descendants?: boolean } = {}): Promise<HeldRunLease[]> {
    const now = this.clock.now();
    const ids = opts.descendants === false ? [runId] : await this.runTree(runId);
    const found: HeldRunLease[] = [];
    for (const id of ids) {
      const lease = await this.stores.leases.get(runLeaseResource(id));
      if (lease) found.push({ ...lease, runId: id, lapsed: lapsed(lease, now) });
    }
    if (!found.length)
      throw new OrcaError("LEASE_NOT_FOUND", `no lease is held on run ${runId} or its descendants`, { runId });
    const live = found.filter((l) => !l.lapsed);
    if (live.length && !opts.force)
      throw new OrcaError(
        "RUN_STATE",
        `${live.map((l) => `run ${l.runId} (pid ${l.pid} on ${l.host}, last heartbeat ${l.renewedAt})`).join(", ")} still heartbeating: stop that process, or break with force`,
        { runId, live: live.map(describeLease) },
      );
    for (const l of found) {
      await this.stores.leases.forceRelease(runLeaseResource(l.runId));
      this.logger.warn("run lease broken", {
        runId: l.runId,
        holder: l.holder,
        pid: l.pid,
        host: l.host,
        forced: !l.lapsed,
      });
    }
    return found;
  }

  /** `runId` and every descendant its log knows about, parents before children. */
  private async runTree(runId: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = async (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      out.push(id);
      let state: RunState;
      try {
        state = await this.getState(id);
      } catch (e) {
        // A child whose log is gone cannot hold a lease worth breaking either.
        if (e instanceof OrcaError && e.code === "RUN_NOT_FOUND") return;
        throw e;
      }
      for (const s of Object.values(state.steps)) for (const c of s.childRunIds) await visit(c);
    };
    await visit(runId);
    return out;
  }

  // ------------------------------------------------------------- definitions

  /** Inline graphs get ids like `parent::loopNode` or `parent::parallelNode::branch`. */
  resolveDefinition(workflowId: string): WorkflowDefinition {
    if (!workflowId.includes(INLINE_SEP)) return this.workflows.get(workflowId);
    const [rootId, ...path] = workflowId.split(INLINE_SEP);
    const root = this.workflows.get(rootId!);
    let graph: WorkflowGraph = root;
    for (let i = 0; i < path.length; i++) {
      const node: NodeDef | undefined = graph.nodes[path[i]!];
      if (!node)
        throw new OrcaError("WORKFLOW_NOT_FOUND", `inline workflow ${workflowId}: node '${path[i]}' not found`);
      if (node.type === "loop") {
        if (!("graph" in node.body))
          throw new OrcaError("WORKFLOW_NOT_FOUND", `inline workflow ${workflowId}: loop body is a reference`);
        graph = node.body.graph;
      } else if (node.type === "parallel") {
        if (node.forEach) {
          if (!node.forEach.body || !("graph" in node.forEach.body))
            throw new OrcaError("WORKFLOW_NOT_FOUND", `inline workflow ${workflowId}: forEach body is a reference`);
          graph = node.forEach.body.graph;
        } else {
          const branch = path[++i];
          const ref = branch !== undefined ? node.branches?.[branch] : undefined;
          if (!ref || !("graph" in ref))
            throw new OrcaError("WORKFLOW_NOT_FOUND", `inline workflow ${workflowId}: branch '${branch}' not found`);
          graph = ref.graph;
        }
      } else
        throw new OrcaError(
          "WORKFLOW_NOT_FOUND",
          `inline workflow ${workflowId}: node '${path[i]}' has no nested graph`,
        );
    }
    return this.inlineDefinition(workflowId, graph, root.version);
  }

  private inlineDefinition(id: string, graph: WorkflowGraph, version: string): WorkflowDefinition {
    return { id, name: id, version, vars: {}, inputs: {}, start: graph.start, nodes: graph.nodes, edges: graph.edges };
  }

  // -------------------------------------------------------------- interpreter

  private async loadContext(runId: string): Promise<RunContext> {
    const existing = this.live.get(runId);
    if (existing) return existing;
    const events = await this.stores.events.read(runId);
    const first = events[0];
    if (!first || first.type !== "run.created") throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
    const def = this.resolveDefinition(first.payload.workflowId);
    const rc = await RunContext.load(runId, def, {
      stores: this.stores,
      clock: this.clock,
      logger: this.logger.child({ runId }),
      loadState: (id) => this.getState(id),
      plan: this.plan,
    });
    this.live.set(runId, rc);
    return rc;
  }

  /**
   * Take the run's single-writer lease, drive it, give the lease back. Everything that
   * *writes* to a run's log happens inside here; reading and reducing it does not, because a
   * reader cannot corrupt anyone's story.
   */
  private async executeLeased(runId: string): Promise<RunState> {
    const rc = await this.loadContext(runId);
    // A finished run is not driven at all, so it needs no lease.
    if (isTerminal(rc.state)) return rc.state;
    const held = await this.takeRunLease(runId, rc);
    try {
      return await this.execute(rc);
    } finally {
      await held.release();
    }
  }

  /**
   * Claim the right to interpret `runId`, and keep claiming it: an attached interpreter
   * heartbeats for as long as it is attached, so a second one can tell "still working, mostly
   * waiting on an agent" from "died an hour ago" without a human deciding. Losing the lease
   * mid-run (only an operator can take a live one away) cancels the run rather than letting
   * two interpreters append to one log.
   */
  private async takeRunLease(runId: string, rc: RunContext): Promise<HeldLease> {
    const lease = await this.stores.leases.acquire({
      resource: runLeaseResource(runId),
      holder: this.leaseHolder,
      ttlMs: this.leaseTtlMs,
      note: rc.definition.id,
    });
    if (!ownsLease(lease, this.leaseHolder))
      throw new OrcaError(
        "RUN_LEASED",
        `run ${runId} is already being interpreted by pid ${lease.pid} on ${lease.host} (last heartbeat ${lease.renewedAt}): wait for it, or take the lease with 'orca leases break ${runId} --force'`,
        { runId, ...describeLease(lease) },
      );
    return keepLease(this.stores.leases, lease, {
      ...(this.leaseRenewMs !== undefined ? { renewMs: this.leaseRenewMs } : {}),
      onLost: () => {
        rc.logger.error("run lease lost; stopping this interpreter", { resource: lease.resource });
        rc.abort.abort(`lease on run ${runId} was taken away; another process may now be driving it`);
      },
    });
  }

  private async execute(rc: RunContext): Promise<RunState> {
    const runId = rc.id;
    // A run resumed after a crash may have left stale WorkItem documents behind; the log is the
    // truth, so recompute them before doing anything else (no-op for runs without work items).
    await rc.syncWorkItems();
    const def = rc.definition;
    const log = rc.logger;

    try {
      if (rc.state.run.status === "created") await rc.emit({ type: "run.started", payload: {} });
      else if (rc.state.run.status === "paused") await rc.emit({ type: "run.resumed", payload: {} });

      // Figure out where to (re)start.
      let nodeId = def.start;
      let attempt = 1;
      const lastId = rc.state.stepOrder[rc.state.stepOrder.length - 1];
      const last = lastId ? rc.state.steps[lastId] : undefined;
      if (last) {
        if (last.status === "completed") {
          const next = await this.route(rc, last.nodeId, last.result ?? { artifactIds: [], data: {} });
          if (!next) throw new OrcaError("RUN_STATE", `resume: no route from completed step ${last.nodeId}`);
          nodeId = next.to;
        } else {
          // Re-attempt the interrupted step. Container steps re-attach to the child runs this
          // attempt already spawned (see runChild) rather than spawning them again.
          if (last.status !== "failed") await rc.emit({ type: "step.cancelled", payload: { stepRunId: last.id } });
          nodeId = last.nodeId;
          attempt = last.attempt + 1;
        }
      }

      let viaEdge: Edge | undefined;
      for (;;) {
        // Yield to the macrotask queue once per step: purely in-memory workflows would otherwise
        // starve timers and I/O (including cancel() calls and event subscribers).
        await new Promise<void>((r) => setImmediate(r));
        if (rc.abort.signal.aborted) throw new OrcaError("CANCELLED", String(rc.abort.signal.reason ?? "cancelled"));
        const node = def.nodes[nodeId];
        if (!node) throw new OrcaError("WORKFLOW_INVALID", `node '${nodeId}' not found in ${def.id}`);
        const stepRunId = newId("step", this.clock.now());
        await rc.emit({
          type: "step.scheduled",
          payload: {
            stepRunId,
            nodeId,
            nodeType: node.type,
            attempt,
            ...(viaEdge ? { viaEdge: { from: viaEdge.from, ...(viaEdge.label ? { label: viaEdge.label } : {}) } } : {}),
          },
        });
        const step = rc.state.steps[stepRunId]!;
        log.info("step", { node: nodeId, type: node.type, attempt });
        const outcome = await this.executeStep(rc, step, node);
        if (rc.abort.signal.aborted) throw new OrcaError("CANCELLED", String(rc.abort.signal.reason ?? "cancelled"));

        if (outcome.kind === "paused") {
          log.info("run paused", { node: nodeId, reason: outcome.reason });
          await rc.emit({ type: "run.paused", payload: { reason: outcome.reason } });
          return rc.state;
        }
        if (outcome.kind === "failed") {
          const willRetry = outcome.retryable !== false && attempt < retryBudget(node);
          await rc.emit({ type: "step.failed", payload: { stepRunId, error: outcome.error, willRetry } });
          if (willRetry) {
            attempt++;
            continue;
          }
          await rc.emit({ type: "run.failed", payload: { error: outcome.error } });
          return rc.state;
        }

        await rc.emit({ type: "step.completed", payload: { stepRunId, result: outcome.result } });
        // Terminal by result, not by node type: any executor may end the run by returning an outcome.
        if (outcome.result.outcome) {
          await rc.emit({
            type: "run.completed",
            payload: {
              outcome: outcome.result.outcome,
              ...(outcome.result.message ? { message: outcome.result.message } : {}),
            },
          });
          return rc.state;
        }
        const edge = await this.route(rc, nodeId, outcome.result);
        if (!edge) {
          await rc.emit({
            type: "run.failed",
            payload: {
              error: {
                code: "WORKFLOW_INVALID",
                message: `no outgoing edge matched from '${nodeId}' (choice=${outcome.result.choice ?? "none"})`,
              },
            },
          });
          return rc.state;
        }
        viaEdge = edge;
        nodeId = edge.to;
        attempt = 1;
      }
    } catch (e) {
      const err = describeError(e);
      if (err.code === "CANCELLED" || rc.abort.signal.aborted) {
        // A step interrupted mid-flight (an agent turn, a parked human question) never reports back; close it here.
        for (const s of openSteps(rc.state)) await rc.emit({ type: "step.cancelled", payload: { stepRunId: s.id } });
        await rc.emit({ type: "run.cancelled", payload: { reason: err.message } });
      } else {
        log.error("run failed", { error: err });
        await rc.emit({ type: "run.failed", payload: { error: err } });
      }
      return rc.state;
    } finally {
      await this.closeRunSessions(runId);
      if (rc.state.run.workItemId && isTerminal(rc.state)) await this.plan.onRunFinished(rc.state.run);
    }
  }

  /** Pick the outgoing edge: first conditional edge whose `when` is truthy, else the unconditional one. */
  private async route(rc: RunContext, nodeId: string, result: StepResult): Promise<Edge | undefined> {
    const edges = outgoing(rc.definition, nodeId);
    if (edges.length === 0) return undefined;
    const ctx = await rc.evalContext({ choice: result.choice ?? rc.lastChoice(), result });
    for (const e of edges) if (e.when && evaluateCondition(e.when, ctx)) return e;
    return edges.find((e) => !e.when);
  }

  private async executeStep(rc: RunContext, step: StepRun, node: NodeDef): Promise<StepOutcome> {
    const executor = this.executors.get(node.type);
    if (!executor)
      return {
        kind: "failed",
        error: { code: "NOT_SUPPORTED", message: `no executor registered for node type '${node.type}'` },
        retryable: false,
      };
    const ctx = this.stepContext(rc, step, node);
    await rc.emit({ type: "step.started", payload: { stepRunId: step.id, inputArtifactIds: [] } });
    try {
      return await executor.execute(ctx);
    } catch (e) {
      if (rc.abort.signal.aborted) throw e;
      if (isHumanInputPending(e)) return paused(e.message, e.details);
      const err = describeError(e);
      return { kind: "failed", error: err, retryable: err.code !== "WORKFLOW_INVALID" && err.code !== "NOT_SUPPORTED" };
    }
  }

  private stepContext(rc: RunContext, step: StepRun, node: NodeDef): StepContext {
    const self = this;
    const ctx: StepContext = {
      run: rc,
      step,
      nodeId: step.nodeId,
      node,
      definition: rc.definition,
      workspace: rc.workspace,
      signal: rc.abort.signal,
      logger: rc.logger.child({ step: step.nodeId }),
      clock: this.clock,
      stores: this.stores,
      agents: this.agents,
      templates: this.templates,
      workflows: this.workflows,
      humanInput: abortableHumanInput(this.humanInput, rc.abort.signal),
      plan: this.plan,

      async emit(event) {
        await rc.emit(event);
      },
      evalContext: (extra) => rc.evalContext({ step, ...(extra ?? {}) }),
      async evaluate(expr, extra) {
        return evaluateExpression(expr, await ctx.evalContext(extra));
      },
      async render(body, extra) {
        return renderTemplate(body, await ctx.evalContext(extra), { partials: self.templates.partials });
      },
      async resolveInputs(refs) {
        const resolved = await self.resolveInputs(rc, refs);
        // Record what the step actually read: `step.started` was appended before the executor ran,
        // so the ids are only known here (see the `step.inputs` event).
        const ids = resolved.filter((a): a is ResolvedArtifact => a !== undefined).map((a) => a.id);
        const fresh = [...new Set(ids)].filter((id) => !step.inputArtifactIds.includes(id));
        if (fresh.length) await rc.emit({ type: "step.inputs", payload: { stepRunId: step.id, artifactIds: fresh } });
        return resolved;
      },
      recordArtifact: (spec, content, extra) => self.recordArtifact(rc, step, spec, content, extra ?? {}),
      async runChild(target, options) {
        // A re-attempted (resumed) container step re-attaches to the children its interrupted
        // attempt already spawned for this branch: finished ones are reused as-is, unfinished
        // ones are resumed from their own logs. Only branches never started get a new run.
        const resumedId = self.interruptedChild(rc, step, options.branch);
        const childId =
          resumedId ??
          (await self.startRun({
            ...("workflow" in target
              ? { workflowId: target.workflow }
              : { inline: { graph: target.graph, id: target.inlineId, version: rc.definition.version } }),
            parentRunId: rc.id,
            parentStepRunId: step.id,
            ...(options.vars ? { vars: { ...rc.state.run.vars, ...options.vars } } : { vars: rc.state.run.vars }),
            ...(options.workspace
              ? { workspace: options.workspace }
              : options.workItemId
                ? {}
                : { workspace: rc.workspace }),
            ...(options.workItemId ? { workItemId: options.workItemId } : {}),
            ...(rc.state.run.requestId ? { requestId: rc.state.run.requestId } : {}),
          }));
        if (resumedId)
          rc.logger.info("child re-attached", {
            step: step.nodeId,
            child: childId,
            ...(options.branch ? { branch: options.branch } : {}),
          });
        await rc.emit({
          type: "child.spawned",
          payload: {
            stepRunId: step.id,
            childRunId: childId,
            ...(options.branch ? { branch: options.branch } : {}),
            ...(options.workItemId ? { workItemId: options.workItemId } : {}),
            ...(resumedId ? { resumed: true } : {}),
          },
        });
        const onAbort = () => void self.cancel(childId, "parent cancelled");
        rc.abort.signal.addEventListener("abort", onAbort, { once: true });
        // The caller may also cancel this one child on its own (e.g. a fail-fast parallel
        // abandoning the siblings of a branch that already decided the join).
        const own = options.signal;
        const onOwnAbort = () =>
          void self.cancel(childId, typeof own?.reason === "string" ? own.reason : "cancelled by parent step");
        if (own?.aborted) onOwnAbort();
        else own?.addEventListener("abort", onOwnAbort, { once: true });
        try {
          const result = await self.run(childId);
          await rc.emit({
            type: "child.finished",
            payload: {
              stepRunId: step.id,
              childRunId: childId,
              status: result.run.status,
              ...(result.run.outcome ? { outcome: result.run.outcome } : {}),
            },
          });
          return result;
        } finally {
          rc.abort.signal.removeEventListener("abort", onAbort);
          own?.removeEventListener("abort", onOwnAbort);
        }
      },
      openSession: (selector) => self.openSession(rc, step, selector),
    };
    return ctx;
  }

  /**
   * Find the child run that an earlier, interrupted attempt of this step spawned for `branch`.
   * Prior attempts of a node are its contiguous predecessors in `stepOrder` with descending
   * attempt numbers; a later visit of the same node through a graph back-edge starts again at
   * attempt 1, so it never picks up children from an earlier visit. Children already attached
   * to the current attempt are skipped so one prior child is claimed at most once.
   */
  private interruptedChild(rc: RunContext, step: StepRun, branch: string | undefined): string | undefined {
    if (step.attempt <= 1) return undefined;
    const claimed = new Set(step.childRunIds);
    const order = rc.state.stepOrder;
    let i = order.indexOf(step.id) - 1;
    for (let attempt = step.attempt - 1; i >= 0 && attempt >= 1; i--, attempt--) {
      const prev = rc.state.steps[order[i]!];
      if (!prev || prev.nodeId !== step.nodeId || prev.attempt !== attempt) break;
      for (let c = prev.children.length - 1; c >= 0; c--) {
        const link = prev.children[c]!;
        if (link.branch === branch && !claimed.has(link.runId)) return link.runId;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- artifacts

  /** Returns one entry per ref (undefined for unresolved optional refs) so callers can pair results with refs by position. */
  private async resolveInputs(rc: RunContext, refs: ArtifactRef[]): Promise<(ResolvedArtifact | undefined)[]> {
    const visible = await rc.visibleArtifacts();
    const out: (ResolvedArtifact | undefined)[] = [];
    for (const ref of refs) {
      let found: Artifact | undefined;
      if (ref.fromNode) {
        const step = Object.values(rc.state.steps)
          .filter((s) => s.nodeId === ref.fromNode && s.status === "completed")
          .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
          .pop();
        const ids = step?.result?.artifactIds ?? [];
        found = ids
          .map((id) => rc.state.artifacts[id])
          .find((a) => a && (!ref.kind || a.kind === ref.kind) && (!ref.name || a.name === ref.name));
      } else if (ref.name) {
        found = visible.get(ref.name);
      } else if (ref.kind) {
        found = [...visible.values()]
          .filter((a) => a.kind === ref.kind)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .pop();
      }
      if (!found) {
        if (ref.required)
          throw new OrcaError("ARTIFACT_MISSING", `required input artifact not found: ${JSON.stringify(ref)}`);
        out.push(undefined);
        continue;
      }
      out.push({ ...found, content: await this.stores.artifacts.content(found.id) });
    }
    return out;
  }

  private async recordArtifact(
    rc: RunContext,
    step: StepRun,
    spec: ArtifactSpec,
    content: string,
    extra: { path?: string; parents?: string[]; agentSessionId?: string; agentId?: string },
  ): Promise<Artifact> {
    const { extractStructuredData } = await import("@orca/core");
    const name = spec.name ?? spec.kind;
    const mediaType = spec.mediaType ?? (extra.path?.endsWith(".json") ? "application/json" : "text/markdown");
    const artifact: Artifact = {
      id: newId("art", this.clock.now()),
      kind: spec.kind,
      name,
      mediaType,
      contentHash: sha256(content),
      size: content.length,
      version: await rc.nextArtifactVersion(name),
      producedBy: {
        runId: rc.id,
        stepRunId: step.id,
        nodeId: step.nodeId,
        hostId: rc.workspace.hostId,
        ...(extra.agentSessionId ? { agentSessionId: extra.agentSessionId } : {}),
        ...(extra.agentId ? { agentId: extra.agentId } : {}),
      },
      parents: extra.parents ?? [],
      data: extractStructuredData(content, mediaType),
      createdAt: this.clock.isoNow(),
      ...(extra.path ? { path: extra.path } : {}),
    };
    await this.stores.artifacts.put(artifact, content);
    await rc.emit({ type: "artifact.recorded", payload: { stepRunId: step.id, artifact } });
    // Planning intake happens inline so the next node sees risks/decisions/dependencies this artifact carried.
    const rejected = await this.plan.onArtifactRecorded(rc.state.run, artifact);
    if (rejected.length)
      await rc.emit({
        type: "plan.signals.rejected",
        payload: { stepRunId: step.id, artifactId: artifact.id, issues: rejected },
      });
    return artifact;
  }

  // ----------------------------------------------------------------- sessions

  private async openSession(
    rc: RunContext,
    step: StepRun,
    selector: AgentSelector,
  ): Promise<{ session: AgentSession; release: () => Promise<void> }> {
    const { agent, host } = this.agents.resolve(selector);
    const key = `${rc.id}:${agent.id}`;
    const pooled = agent.sessionMode === "per-run" ? this.sessions.get(key) : undefined;
    if (pooled) {
      pooled.current.step = step;
      return { session: pooled.session, release: async () => {} };
    }
    const current = { step };
    let pendingAsks = 0;
    const humanInput = abortableHumanInput(this.humanInput, rc.abort.signal);
    const session = await this.sessionFactory({
      host,
      agent,
      cwd: rc.workspace.cwd,
      logger: rc.logger,
      clock: this.clock,
      // Each `ask` permission is its own human-input request: an agent may block on
      // several tool calls at once, and every one must be listed, answerable and
      // logged independently (one id per session made concurrent asks collide).
      askPermission: async (req) => {
        const stepRunId = current.step.id;
        return askHumanInput({
          port: humanInput,
          emit: (e) => rc.emit(e),
          clock: this.clock,
          runId: rc.id,
          stepRunId,
          kind: "permission",
          question: req.toolCall.title ?? "Allow tool call?",
          options: req.options.map((o) => o.optionId),
          context: { toolCall: req.toolCall },
          onRequested: () => {
            pendingAsks++;
          },
          onSettled: async () => {
            pendingAsks--;
            // The agent turn is still in flight; go back to waiting on it once no ask is pending.
            if (pendingAsks === 0)
              await rc.emit({ type: "step.waiting", payload: { stepRunId, on: "agent-turn" } }).catch(() => undefined);
          },
        });
      },
      onPermission: (info) =>
        void rc.emit({
          type: "agent.permission",
          payload: {
            stepRunId: current.step.id,
            sessionId: session.id,
            title: info.title,
            decision: info.decision,
            ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
          },
        }),
    });
    await rc.emit({
      type: "agent.session.opened",
      payload: { stepRunId: step.id, sessionId: session.id, agentId: agent.id, hostId: host.id, cwd: rc.workspace.cwd },
    });
    const close = async () => {
      await session.close();
      await rc
        .emit({ type: "agent.session.closed", payload: { stepRunId: current.step.id, sessionId: session.id } })
        .catch(() => undefined);
    };
    if (agent.sessionMode === "per-run") {
      const pooled = { session, current };
      this.sessions.set(key, pooled);
      // A pooled session whose connection went away (wedged agent killed after a cancel, or a
      // crash) must not be handed to the next step; let that step open a fresh one instead.
      void session.closed.then(() => {
        if (this.sessions.get(key) === pooled) this.sessions.delete(key);
      });
      return { session, release: async () => {} };
    }
    return { session, release: close };
  }

  private async closeRunSessions(runId: string): Promise<void> {
    for (const [key, s] of this.sessions) {
      if (key.startsWith(`${runId}:`)) {
        this.sessions.delete(key);
        await s.session.close().catch(() => undefined);
      }
    }
  }
}

const TERMINAL_STATE_CACHE_SIZE = 256;

/** Lease resources are namespaced, because a store will hold leases on more than runs. */
const RUN_LEASE_PREFIX = "run:";
export function runLeaseResource(runId: string): string {
  return `${RUN_LEASE_PREFIX}${runId}`;
}

export function isTerminal(state: RunState): boolean {
  return state.run.status === "completed" || state.run.status === "failed" || state.run.status === "cancelled";
}

/** Steps that have been scheduled but not yet settled (scheduled, running or waiting). */
function openSteps(state: RunState): StepRun[] {
  return state.stepOrder
    .map((id) => state.steps[id]!)
    .filter((s) => s.status === "scheduled" || s.status === "running" || s.status === "waiting");
}
