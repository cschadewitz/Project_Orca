/**
 * Orchestrator - the workflow interpreter.
 *
 * One run = one token walking the graph from `start` to an `end` node.
 * Concurrency comes from `parallel` nodes, which spawn child runs. Every state
 * transition is an event; a run can be resumed from its log at any time.
 */
import { ConfigurationGenerations, type GenerationMaterial } from "./configuration-generation.js";
import { configuredGenerationSecrets, launchProvenance } from "./configuration-provenance.js";

import { AgentRegistry, LocalHost, openAcpSession, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import { applyModel, currentModel, selectedModel } from "./session-model.js";
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
  RiskMatrixConfigSchema,
  retryBudget,
  RUN_SUMMARY_EVENT_TYPES,
  runSummary,
  sha256,
  silentLogger,
  systemClock,
  TemplateRegistry,
  validateWorkflowInputs,
  WorkflowRegistry,
  type AgentSelector,
  type Artifact,
  type ArtifactRef,
  type RunOverrides,
  type ArtifactSpec,
  type Clock,
  type Edge,
  type HumanInputRequest,
  type Logger,
  type MutationActor,
  type NodeDef,
  type OrcaEvent,
  type OrcaEventInput,
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
  executionEvents,
  ProtectedEventStore,
  unavailable,
  describeLease,
  keepLease,
  lapsed,
  ownsLease,
  type EventFilter,
  type EventListener,
  type EventRange,
  type HeldLease,
  type Lease,
  type Stores,
  type WorkItemClaim,
} from "@orca/store";
import { prepareAdmissionExecution, type AdmissionExecutionRuntime } from "./admission-execution.js";
import { correlateRequestAdmission } from "./program/request-admission-event.js";
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
import { recoverReleasedWorkItem } from "./program/work-items.js";
import { RunContext } from "./run-context.js";
import type { LiveHumanInput, ExecutionResumeAuthority, ExecutionActivity } from "./live-input.js";
import { protectExecutionInputs } from "./execution-inputs.js";
import { LocalWorkspaceProvider, type WorkspaceProvider } from "./workspace/provider.js";

/** Opens an agent session; defaults to ACP over stdio (local or ssh). Integrations can substitute other transports. */
export type SessionFactory = (options: OpenSessionOptions) => Promise<AgentSession>;

export interface OrchestratorOptions {
  /** Trusted current authority for bounded first attachment of admitted roots. */
  admissionExecution?: AdmissionExecutionRuntime;
  revisionRuntime?: {
    /** Reserve exactly the declared next attempt before scheduling; refuse ambiguous replay. */
    reserveStep(rc: RunContext, nodeId: string): Promise<string | undefined>;
    forStep(rc: RunContext, step: StepRun): Pick<StepContext, "declareRevision" | "revisionInput">;
  };
  stores: Stores;
  agents: AgentRegistry;
  workflows: WorkflowRegistry;
  templates: TemplateRegistry;
  executors?: NodeExecutorRegistry;
  humanInput?: HumanInputPort;
  /** Daemon-owned callbacks; execution authority lifetime is independent of any UI connection. */
  liveInput?: {
    port: LiveHumanInput;
    executionSignal(runId: string): AbortSignal;
    prepareExecution?(runId: string): Promise<void>;
    releaseExecution?(runId: string): void;
    withResumeAuthority?(
      runId: string,
      authority: ExecutionResumeAuthority | undefined,
      operation: () => Promise<RunState>,
    ): Promise<RunState>;
  };
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

/**
 * The keeper of an attached run's lease, plus whether a heartbeat has already found the lease
 * gone. `held` answers the same question, but `lost` is latched by `onLost` and so survives
 * whatever the keeper does next; an interpreter reads it once it has a context to stop (#267).
 */
type AttachedLease = HeldLease & { readonly lost: boolean };

/** A work-item claim together with the state of the run that holds it. */
export type HeldClaim = WorkItemClaim & { owner: RunSummary["status"] | "missing" };

/** Called as each downstream agent session opens; see `Orchestrator.onAgentSessionOpened`. */
export type AgentSessionOpenedListener = (info: { runId: string; agentId: string; session: AgentSession }) => void;

export interface StartRunOptions {
  /** Server-owned Request admission metadata; never part of workflow vars or wire launch params. */
  requestAdmissionId?: string;
  /** Trusted admission journal only; never accepted by wire schemas. */
  admissionRunId?: string;
  directAdmissionId?: string;
  /** Only trusted in-process callers supply actor metadata; transports bind it server-side. */
  actor?: MutationActor;
  workflowId?: string;
  inline?: { graph: WorkflowGraph; id: string; version?: string };
  vars?: Record<string, unknown>;
  /** Trusted captured-launch attribution; never accepted from wire launch params. */
  itemWorkflowSource?: "config.program.itemWorkflow";
  workspace?: Workspace;
  requestId?: string;
  workItemId?: string;
  parentRunId?: string;
  parentStepRunId?: string;
  /**
   * Per-run selection (#186): role -> agent, model, item workflow, template pack. Validated
   * before `run.created` is appended and recorded in it, so a replay resolves the same agents.
   */
  overrides?: RunOverrides;
  /**
   * Launch this version of `workflowId` rather than the one on disk (#330): the definition the
   * workflow-version store kept for it, or the loaded one when it is at this version and has
   * never been stored. Any other version is `WORKFLOW_VERSION_NOT_FOUND`, never the latest.
   */
  workflowVersion?: string;
  /**
   * The `revision` a preflight (`workflows.validateInputs`) returned. The selected definition
   * must still have it, or the launch is refused as `WORKFLOW_INVALID` before anything is
   * written - so a client never validates one definition and starts another.
   */
  expectedWorkflowRevision?: string;
}

export const INLINE_SEP = "::";

/**
 * The deterministic content digest of a definition (#330): SHA-256 over its JSON with object
 * keys sorted and `undefined` members dropped, so the copy on disk and the copy the
 * workflow-version store round-trips hash alike. Version text alone is not identity - a file
 * can change without its `version` changing - so this is what a preflight hands a client and
 * what admission and the same-version collision check compare.
 */
export function workflowRevision(def: WorkflowDefinition): string {
  return `sha256:${sha256(canonicalJson(def))}`;
}

function versionCollision(def: WorkflowDefinition): OrcaError {
  return new OrcaError(
    "WORKFLOW_INVALID",
    `workflow '${def.id}' version ${def.version} differs from the definition already recorded for that version; ` +
      "a recorded version is immutable, so change the workflow's version",
    { id: def.id, version: def.version },
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export class Orchestrator {
  runtimeActivity?: ExecutionActivity;
  get attachedExecutionCount(): number {
    return this.running.size;
  }
  private readonly leaseKeepers = new Set<HeldLease>();
  get leaseActivityCount(): number {
    return this.leaseKeepers.size;
  }
  admissionExecution: AdmissionExecutionRuntime | undefined;
  generations: ConfigurationGenerations | undefined;
  generationHumanInput: ((generation: GenerationMaterial) => HumanInputPort) | undefined;
  generationWorkspaceProvider: ((generation: GenerationMaterial) => WorkspaceProvider) | undefined;
  private readonly contextGenerations = new WeakMap<RunContext, GenerationMaterial>();
  private async admissionGeneration(
    opts: StartRunOptions,
    supplied?: GenerationMaterial,
  ): Promise<GenerationMaterial | undefined> {
    const selected = supplied ?? this.generations?.current;
    if (!opts.parentRunId) return selected;
    const first = (await this.stores.events.readRange(opts.parentRunId, { limit: 1 }))[0];
    const id = first?.type === "run.created" ? first.payload.provenance?.configGeneration : undefined;
    if (!id) return supplied;
    if (!this.generations) throw unavailable();
    if (supplied && supplied.snapshot.id !== id)
      throw new OrcaError("CONFIG_STALE", "child generation differs from parent");
    return this.generations.restore(id);
  }
  readonly stores: Stores;
  readonly agents: AgentRegistry;
  readonly workflows: WorkflowRegistry;
  readonly templates: TemplateRegistry;
  readonly executors: NodeExecutorRegistry;
  humanInput: HumanInputPort;
  liveInput: OrchestratorOptions["liveInput"];
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

  private readonly revisionRuntime: OrchestratorOptions["revisionRuntime"];
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
  private readonly sessionOpenedListeners = new Set<AgentSessionOpenedListener>();

  constructor(o: OrchestratorOptions) {
    this.admissionExecution = o.admissionExecution;
    this.revisionRuntime = o.revisionRuntime;
    this.stores = {
      ...o.stores,
      events:
        o.stores.events instanceof ProtectedEventStore
          ? o.stores.events
          : new ProtectedEventStore(o.stores.events, o.stores.execution, o.stores.workflows),
    };
    this.agents = o.agents;
    this.workflows = o.workflows;
    this.templates = o.templates;
    this.executors = o.executors ?? builtinExecutors();
    this.liveInput = o.liveInput;
    this.humanInput = o.humanInput ?? o.liveInput?.port ?? autoHumanInput();
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

  /** Side-effect-free admission used by Request submission before its first persistent write. */
  async validateStartRun(
    opts: StartRunOptions,
    supplied?: GenerationMaterial,
  ): Promise<{ definition: WorkflowDefinition; vars: Record<string, unknown>; generation?: GenerationMaterial }> {
    if (
      opts.requestAdmissionId !== undefined &&
      (!opts.requestAdmissionId || !opts.requestId || !opts.actor || opts.parentRunId)
    )
      throw new OrcaError("RUN_STATE", "request admission correlation is unavailable");
    const generation = await this.admissionGeneration(opts, supplied);
    // Admission (#330): select, check the preflight revision, check the selection and the
    // launch vars - all before anything is written, provisioned or appended, so a refused
    // launch leaves no definition, workspace, run, agent or child behind.
    const def = opts.inline
      ? this.inlineDefinition(opts.inline.id, opts.inline.graph, opts.inline.version ?? "1")
      : await this.selectDefinition(opts.workflowId!, opts.workflowVersion, generation?.workflows);
    if (opts.expectedWorkflowRevision !== undefined && opts.expectedWorkflowRevision !== workflowRevision(def))
      throw new OrcaError(
        "WORKFLOW_INVALID",
        `workflow '${def.id}' changed since its inputs were validated; validate them again before starting`,
      );
    if (opts.overrides)
      this.validateOverrides(def, opts.overrides, generation?.agents, generation?.workflows, generation?.templates);
    const inputs = validateWorkflowInputs(def, opts.vars ?? {});
    if (!inputs.validation.ok) {
      const { errors, warnings } = inputs.validation;
      const listed = errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`);
      throw new OrcaError(
        "WORKFLOW_INPUT_INVALID",
        `workflow '${def.id}' inputs are invalid: ${listed.join("; ")}${errors.length > 3 ? `; and ${errors.length - 3} more` : ""}`,
        { errors, warnings },
      );
    }
    return { definition: def, vars: inputs.vars, ...(generation ? { generation } : {}) };
  }

  /** Create a run (emits run.created) without executing it. */
  async startRun(opts: StartRunOptions, supplied?: GenerationMaterial): Promise<string> {
    const associatedRequest = opts.requestId ? await this.stores.requests.get(opts.requestId) : undefined;
    const item = opts.workItemId ? await this.stores.workItems.get(opts.workItemId) : undefined;
    if (opts.requestId && !associatedRequest) throw new OrcaError("RUN_STATE", "associated Request is unavailable");
    if (opts.workItemId && (!item || !(await this.stores.requests.get(item.requestId))))
      throw new OrcaError("RUN_STATE", "associated work item is unavailable");
    if (associatedRequest && item && item.requestId !== associatedRequest.id)
      throw new OrcaError("RUN_STATE", "Request and work item associations do not match");
    const { definition: def, vars, generation } = await this.validateStartRun(opts, supplied);
    const provenance = generation
      ? launchProvenance(generation, def, vars, opts.vars ?? {}, opts.overrides, opts.itemWorkflowSource)
      : undefined;
    if (generation) {
      if (!this.generations) throw unavailable();
      await this.generations.restore(generation.snapshot.id);
    }
    if (
      opts.admissionRunId &&
      (!/^run_[a-f0-9-]{36}$/.test(opts.admissionRunId) ||
        !opts.actor ||
        opts.parentRunId ||
        (!opts.directAdmissionId && !opts.requestAdmissionId) ||
        (opts.directAdmissionId && opts.requestAdmissionId))
    )
      throw new OrcaError("RUN_STATE", "Invalid reserved admission identity");
    const runId = opts.admissionRunId ?? newId("run", this.clock.now());
    if (
      opts.admissionRunId &&
      ((await this.stores.events.readRange(runId, { limit: 1 })).length ||
        (await this.stores.execution.getInputs(runId)))
    )
      throw new OrcaError("RUN_STATE", "Reserved admission was already prepared; reconcile its original receipt");
    // A child with an explicit workspace still has to validate its parent's sealed
    // sensitivity state before copying vars. Missing overlays must never downgrade it.
    const parentFirst = opts.parentRunId
      ? (await this.stores.events.readRange(opts.parentRunId, { limit: 1 }))[0]
      : undefined;
    const parentInputs = opts.parentRunId ? await this.stores.execution.getInputs(opts.parentRunId) : undefined;
    if (parentFirst?.type === "run.created" && parentFirst.payload.executionInputsStored && !parentInputs)
      throw unavailable();
    // Resolve the historical provider before committing any run-specific private input.
    // An unavailable reconstruction is an admission refusal, not an orphaned run record.
    const selectedWorkspaceProvider = opts.workspace
      ? undefined
      : generation && this.generationWorkspaceProvider
        ? this.generationWorkspaceProvider(generation)
        : this.workspaceProvider;
    // Record only after every admission/inherited-integrity check, before public run creation.
    const workflowStored = await this.recordDefinition(def);
    let protectedInputs = protectExecutionInputs(runId, def, vars, parentInputs);
    const configuredSecrets = generation ? configuredGenerationSecrets(generation) : [];
    if (configuredSecrets.length)
      protectedInputs = {
        ...(protectedInputs ?? { runId, workflowId: def.id, workflowVersion: def.version, vars, sensitiveNames: [] }),
        secrets: [...(protectedInputs?.secrets ?? []), ...configuredSecrets],
      };
    // Authenticate actor and lineage even for public application inputs.
    if (!protectedInputs && (opts.actor || opts.parentRunId || generation))
      protectedInputs = {
        runId,
        workflowId: def.id,
        workflowVersion: def.version,
        vars,
        sensitiveNames: [],
        secrets: [],
      };
    if (protectedInputs) await this.stores.execution.putInputs(protectedInputs);
    const request = opts.requestId ? await this.stores.requests.get(opts.requestId) : undefined;
    const workItem = opts.workItemId ? await this.stores.workItems.get(opts.workItemId) : undefined;
    const workspace =
      opts.workspace ??
      (await selectedWorkspaceProvider!.provision({
        runId,
        workflowId: def.id,
        request,
        workItem,
        parent: opts.parentRunId ? (await this.executionState(opts.parentRunId)).run.workspace : undefined,
      }));
    const created: Extract<OrcaEventInput, { type: "run.created" }> = {
      type: "run.created",
      runId,
      payload: {
        ...(opts.actor ? { actor: opts.actor } : {}),
        workflowId: def.id,
        workflowVersion: def.version,
        ...(provenance ? { provenance } : {}),
        workspace,
        vars,
        ...(protectedInputs ? { executionInputsStored: true as const } : {}),
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
        ...(opts.workItemId ? { workItemId: opts.workItemId } : {}),
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
        ...(opts.parentStepRunId ? { parentStepRunId: opts.parentStepRunId } : {}),
        ...(opts.overrides ? { overrides: opts.overrides } : {}),
        ...(workflowStored ? { workflowStored: true as const } : {}),
      },
    };
    await this.stores.events.append(
      opts.requestAdmissionId
        ? await correlateRequestAdmission(created, opts.requestAdmissionId, this.stores.execution)
        : opts.directAdmissionId
          ? { ...created, payload: { ...created.payload, directAdmissionId: opts.directAdmissionId } }
          : created,
    );
    return runId;
  }

  /**
   * Drive ordinary runs or first-attach admitted roots. Repeated inflight/terminal calls
   * are safe; an admitted root with a prior start requires explicit resume/continuation.
   */
  run(runId: string): Promise<RunState> {
    return this.runAttachment(runId, false);
  }

  private runAttachment(runId: string, recovery: boolean): Promise<RunState> {
    const inflight = this.running.get(runId);
    if (inflight) return inflight;
    const release = this.runtimeActivity?.enter("execution");
    const p = this.executeLeased(runId, recovery)
      .then(async () => {
        const projected = this.live.get(runId)?.publicState() ?? (await this.getState(runId));
        if (isTerminal(projected)) this.cacheTerminalState(runId, projected);
        return projected;
      })
      .finally(() => {
        this.running.delete(runId);
        this.live.delete(runId);
        release?.();
      });
    this.running.set(runId, p);
    return p;
  }

  async startAndRun(opts: StartRunOptions): Promise<RunState> {
    return this.run(await this.startRun(opts));
  }

  async cancel(runId: string, reason?: string, actor?: MutationActor): Promise<void> {
    const rc = this.live.get(runId);
    if (rc) {
      // AbortController keeps the first reason; retain the same winning actor as well.
      if (rc.abort.signal.aborted) return;
      rc.cancelActor = actor;
      rc.abort.abort(reason ?? "cancelled");
      for (const s of Object.values(rc.state.steps)) for (const c of s.childRunIds) await this.cancel(c, reason, actor);
    } else {
      const state = await this.getState(runId);
      if (isTerminal(state)) return;
      // A parked run tree: cancel the children it is waiting on, then close its own open step.
      for (const s of Object.values(state.steps)) for (const c of s.childRunIds) await this.cancel(c, reason, actor);
      // Closing a run we are not driving is still writing to its log, so it goes through the
      // same lease: cancelling a run another process is interpreting has to be refused there,
      // not raced into the log (that process would keep appending afterwards).
      const holder = newId("orc", this.clock.now());
      const lease = await this.stores.leases.acquire({
        resource: runLeaseResource(runId),
        holder,
        ttlMs: this.leaseTtlMs,
        note: "cancel",
      });
      if (!ownsLease(lease, holder))
        throw new OrcaError(
          "RUN_LEASED",
          `run ${runId} is being interpreted by pid ${lease.pid} on ${lease.host}: cancel it there, or take the lease with 'orca leases break ${runId} --force'`,
          { runId, ...describeLease(lease) },
        );
      try {
        await this.stores.leases.withOwnership(lease, async () => {
          const events = await executionEvents(await this.stores.events.read(runId), this.stores.execution);
          const fresh = reduceRun(events);
          if (isTerminal(fresh)) return;
          for (const s of openSteps(fresh))
            await this.stores.events.append({ type: "step.cancelled", runId, payload: { stepRunId: s.id } });
          await this.stores.events.append({
            type: "run.cancelled",
            runId,
            payload: { ...(reason ? { reason } : {}), ...(actor ? { actor } : {}) },
          });
        });
      } finally {
        await this.stores.leases.release(lease);
      }
    }
  }

  /** Projected state of a run. Treat it as read-only: a live or terminal run's projection is shared. */
  async getState(runId: string): Promise<RunState> {
    const live = this.live.get(runId);
    if (live) return live.publicState();
    const cached = this.terminalStates.get(runId);
    if (cached) return cached;
    const events = await this.stores.events.read(runId);
    if (events.length === 0) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
    const state = reduceRun(events);
    if (isTerminal(state)) this.cacheTerminalState(runId, state);
    return state;
  }

  /** Exact interpreter-only state. Public callers must use getState/run. */
  private async executionState(runId: string): Promise<RunState> {
    const live = this.live.get(runId);
    if (live) return live.state;
    const events = await this.stores.events.read(runId);
    if (!events.length) throw new OrcaError("RUN_NOT_FOUND", `run ${runId} not found`);
    const first = events[0];
    const inputs = await this.stores.execution.getInputs(runId);
    if (first?.type === "run.created" && first.payload.executionInputsStored && !inputs) throw unavailable();
    return reduceRun(await executionEvents(events, this.stores.execution));
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
  /** One page of a run's log. A reader that pages - the timeline, a resuming subscription - takes this, not `events`. */
  eventsRange(runId: string, range?: EventRange): Promise<OrcaEvent[]> {
    return this.stores.events.readRange(runId, range);
  }
  /** The run's highest `seq`, or `undefined` when the store has no such run. */
  lastSeq(runId: string): Promise<number | undefined> {
    return this.stores.events.lastSeq(runId);
  }
  subscribe(listener: EventListener, filter?: EventFilter): () => void {
    return this.stores.events.subscribe(listener, filter);
  }
  /**
   * Every downstream agent session as it opens, in process. `agent.session.opened` records
   * that it happened; this hands over the live session, for a caller that needs its state -
   * the ACP facade reads `configOptions` to learn which models an agent offers (#189).
   */
  onAgentSessionOpened(listener: AgentSessionOpenedListener): () => void {
    this.sessionOpenedListeners.add(listener);
    return () => this.sessionOpenedListeners.delete(listener);
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
    if (live) return runSummary(live.publicState());
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
   *
   * `note` is free text the person wrote beside the answer. It is recorded on
   * `human.answered` and nothing reads it back: no executor branches on it, and
   * `answerFromPreviousAttempt` picks up the answer alone when the run resumes.
   */
  async answer(
    requestId: string,
    answer: string,
    runId?: string,
    note?: string,
    afterAnswer?: (request: HumanInputRequest, state: RunState) => Promise<void>,
    actor?: MutationActor,
  ): Promise<HumanInputRequest> {
    const candidate = (runId ? pendingHumanInputs(await this.getState(runId)) : await this.pendingInputs()).find(
      (h) => h.id === requestId,
    );
    if (!candidate) throw new OrcaError("RUN_STATE", `no pending human input '${requestId}'`, { requestId });
    // Each mutation has its own holder, including concurrent calls on this instance.
    const holder = newId("orc", this.clock.now());
    const lease = await this.stores.leases.acquire({ resource: runLeaseResource(candidate.runId), holder });
    if (!ownsLease(lease, holder)) throw new OrcaError("RUN_LEASED", `run ${candidate.runId} is being modified`);
    try {
      return await this.stores.leases.withOwnership(lease, () =>
        this.answerOwned(requestId, answer, candidate.runId, note, afterAnswer, actor),
      );
    } finally {
      await this.stores.leases.release(lease);
    }
  }

  private async answerOwned(
    requestId: string,
    answer: string,
    runId: string,
    note?: string,
    afterAnswer?: (request: HumanInputRequest, state: RunState) => Promise<void>,
    actor?: MutationActor,
  ): Promise<HumanInputRequest> {
    // Read the durable log under ownership; a cached paused context may precede another answer.
    const events = await executionEvents(await this.stores.events.read(runId), this.stores.execution);
    const fresh = reduceRun(events);
    const request = pendingHumanInputs(fresh).find((h) => h.id === requestId);
    if (!request) throw new OrcaError("RUN_STATE", `no pending human input '${requestId}'`, { requestId });
    const state = fresh;
    if (request.kind === "permission")
      throw new OrcaError("RUN_STATE", "tool permission callbacks cannot be answered from a parked log", {
        liveInputState: "expired",
      });
    if (state.run.status !== "paused")
      throw new OrcaError(
        "RUN_STATE",
        `run ${request.runId} is ${state.run.status}, not paused: answer it through the process running it`,
        { runId: request.runId, status: state.run.status },
      );
    // An answer is an option's id, never its label: a label may be reworded, and what
    // is recorded here is compared against the options again when the run is re-driven.
    const ids = request.options.map((o) => o.id);
    const created = events.find((event) => event.type === "run.created");
    // Preserve pre-versioning restoration; a missing recorded definition refuses before answering.
    const definition = await this.definitionFor(
      state.run.workflowId,
      state.run.workflowVersion,
      created?.type === "run.created" && created.payload.workflowStored === true,
    );
    const source = definition.nodes[state.steps[request.stepRunId]?.nodeId ?? ""];
    if ((source?.type === "gate" || source?.type === "decision") && source.revision?.actionId === answer)
      throw new OrcaError("NOT_SUPPORTED", "Use Request changes with explicit corrective input for this branch");
    if (ids.length && !ids.includes(answer)) {
      const protectedInputs = await this.stores.execution.getInputs(runId);
      throw new OrcaError(
        "RUN_STATE",
        protectedInputs ? "the answer is not an offered option" : `'${answer}' is not one of: ${ids.join(", ")}`,
        {
          requestId,
          ...(protectedInputs ? {} : { options: ids }),
        },
      );
    }
    await this.stores.events.append({
      type: "human.answered",
      runId: request.runId,
      // The note is the person's reasoning, not part of the decision: the run branches on
      // `answer` alone, and the note is recorded beside it so the log says why (#238).
      payload: {
        stepRunId: request.stepRunId,
        requestId,
        answer,
        ...(note ? { note } : {}),
        ...(actor ? { actor } : {}),
      },
    });
    const accepted = { ...request, answer };
    // The exact gate is durably accepted under ownership before a standing rule can be
    // written. Failure of the additional write leaves this one-time answer parked and
    // propagates to the caller; no automatic resume follows it.
    await afterAnswer?.(accepted, state);
    // Callers receive the public answer shape, not the hydrated private gate context.
    return reduceRun(await this.stores.events.read(runId)).humanInputs[requestId]!;
  }

  /**
   * Continue a parked run together with the ancestors parked on it: parents
   * pause when a child pauses, so the topmost paused ancestor is re-driven and
   * re-attaches to its children on the way down.
   */
  async resume(runId: string): Promise<RunState> {
    let id = runId;
    for (;;) {
      const state = await this.executionState(id);
      if (!state.run.parentRunId) break;
      if ((await this.executionState(state.run.parentRunId)).run.status !== "paused") break;
      id = state.run.parentRunId;
    }
    return this.runAttachment(id, true);
  }

  /**
   * Internal durable-continuation attachment. The acknowledgement waits only for the
   * fenced durable transition, never for execution. The callback already owns the
   * mutation fence: use rc.emitOwned, not rc.emit/withOwnership or public answer/resume.
   * It must revalidate the exact continuation boundary and persist its attached CAS.
   * Any caller using withResumeAuthority MUST enclose the completion lifetime, not
   * just this method's acknowledgement, so renewed authority survives execution.
   */
  async attachContinuation(
    runId: string,
    options: { beforeExecute: (rc: RunContext) => Promise<void> },
  ): Promise<{ runId: string; completion: Promise<RunState> }> {
    // Reserve synchronously, including against ordinary run() on this instance.
    if (this.running.has(runId)) throw new OrcaError("RUN_LEASED", "execution is already attached");
    const release = this.runtimeActivity?.enter("execution");
    let acknowledge!: () => void;
    let refuse!: (error: unknown) => void;
    const attached = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      refuse = reject;
    });
    const completion = this.executeContinuationLeased(runId, options.beforeExecute, acknowledge)
      .then(async () => {
        const projected = this.live.get(runId)?.publicState() ?? (await this.getState(runId));
        if (isTerminal(projected)) this.cacheTerminalState(runId, projected);
        return projected;
      })
      .finally(() => {
        this.running.delete(runId);
        this.live.delete(runId);
        release?.();
      });
    this.running.set(runId, completion);
    // Before acknowledgement the caller has no completion handle. After it, a
    // detached caller still cannot generate an unhandled rejection in the daemon.
    void completion.catch(refuse);
    await attached;
    return { runId, completion };
  }

  private async executeContinuationLeased(
    runId: string,
    beforeExecute: (rc: RunContext) => Promise<void>,
    acknowledge: () => void,
  ): Promise<RunState> {
    const summary = await this.getSummary(runId);
    if (summary.status !== "paused") throw new OrcaError("RUN_STATE", "continuation requires a paused root");
    let rc: RunContext | undefined;
    const held = await this.takeRunLease(runId, summary.workflowId, () => rc);
    try {
      rc = await this.loadContext(runId);
      rc.lease = held.lease;
      if (held.lost || !held.held) {
        rc.leaseLost = true;
        throw new OrcaError("RUN_LEASED", "continuation execution lease was lost");
      }
      const context = rc;
      await context.withOwnership(async () => {
        const first = (await this.stores.events.readRange(runId, { limit: 1 }))[0];
        const state = context.state;
        const last = state.steps[state.stepOrder.at(-1) ?? ""];
        const node = last && context.definition.nodes[last.nodeId];
        const inputs = Object.values(state.humanInputs).filter((input) => input.stepRunId === last?.id);
        if (
          first?.type !== "run.created" ||
          !first.executionPayloadRef ||
          !first.payload.workflowStored ||
          !state.run.provenance ||
          !this.contextGenerations.has(context) ||
          state.run.parentRunId ||
          state.run.status !== "paused" ||
          !last ||
          (last.status !== "waiting" && last.status !== "running") ||
          !(node?.type === "gate" || (node?.type === "decision" && node.source.kind === "human")) ||
          inputs.length !== 1 ||
          inputs[0]!.kind !== "decision" ||
          inputs[0]!.liveDecision
        )
          throw new OrcaError("RUN_STATE", "continuation requires a sealed durable root decision boundary");
        // Execution authority is checked under the same fence as the attached marker.
        await this.liveInput?.prepareExecution?.(runId);
        await this.validateOwnedWorkspace(context);
        await prepareAdmissionExecution(this.stores, context, this.admissionExecution, true);
        await beforeExecute(context);
      });
      acknowledge();
      return await this.execute(context);
    } finally {
      try {
        this.liveInput?.releaseExecution?.(runId);
      } finally {
        await held.release();
      }
    }
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
    // Cancel stale child execution before taking the claim mutex: execution takes
    // lease -> claim, so the inverse order would deadlock a concurrent dispatcher.
    let retryCancelledRunId: string | undefined;
    if (dead) {
      const item = await this.stores.workItems.get(workItemId);
      if (item?.status === "in-progress" && item.runId && (await this.cancelAbandonedChild(item.runId, claim.runId)))
        retryCancelledRunId = item.runId;
    }
    // Compare-and-delete against the incumbent we inspected: a claim another run took in the meantime survives.
    await this.stores.claims.release(workItemId, claim.runId, async () => {
      const item = await this.stores.workItems.get(workItemId);
      let child;
      if (item?.runId) {
        try {
          const childEvents = await this.stores.events.read(item.runId);
          child = childEvents.length ? reduceRun(childEvents).run : undefined;
        } catch (error) {
          if (!(error instanceof OrcaError) || error.code !== "RUN_NOT_FOUND") throw error;
        }
      }
      const changes = await recoverReleasedWorkItem(
        this.stores,
        workItemId,
        child,
        this.clock.isoNow(),
        retryCancelledRunId,
      );
      await this.plan.onWorkItemsProjected(changes, claim.runId);
    });
    this.logger.info("work item claim released", {
      workItemId,
      runId: claim.runId,
      branch: claim.branch,
      owner,
      forced: !dead,
    });
    return { ...claim, owner };
  }

  /** Close only unowned, unparked abandoned execution, checking state under its lease. */
  private async cancelAbandonedChild(runId: string, parentRunId: string): Promise<boolean> {
    const events = await this.stores.events.read(runId);
    if (!events.length) return false;
    const snapshot = reduceRun(events);
    if (snapshot.run.parentRunId !== parentRunId) return false;
    if (snapshot.run.status !== "running" && snapshot.run.status !== "created") return false;
    const holder = newId("orc", this.clock.now());
    const lease = await this.stores.leases.acquire({
      resource: runLeaseResource(runId),
      holder,
      note: "recover abandoned claim",
    });
    if (!ownsLease(lease, holder)) return false;
    try {
      return await this.stores.leases.withOwnership(lease, async () => {
        const state = reduceRun(await this.stores.events.read(runId));
        if (state.run.parentRunId !== parentRunId) return false;
        if (state.run.status !== "running" && state.run.status !== "created") return false;
        const lastId = state.stepOrder.at(-1);
        const last = lastId ? state.steps[lastId] : undefined;
        if (last?.status === "completed" && last.result?.outcome) {
          await this.stores.events.append({
            type: "run.completed",
            runId,
            payload: {
              outcome: last.result.outcome,
              ...(last.result.message ? { message: last.result.message } : {}),
            },
          });
          return false; // Recover the terminal outcome; it is not work to redispatch.
        }
        // A live or parked descendant still owns work: do not redispatch its ancestor.
        for (const step of Object.values(state.steps))
          for (const childId of step.childRunIds) {
            const childEvents = await this.stores.events.read(childId);
            if (
              childEvents.length &&
              !isTerminal(reduceRun(childEvents)) &&
              !(await this.cancelAbandonedChild(childId, runId))
            )
              return false;
          }
        for (const step of openSteps(state))
          await this.stores.events.append({ type: "step.cancelled", runId, payload: { stepRunId: step.id } });
        await this.stores.events.append({
          type: "run.cancelled",
          runId,
          payload: { reason: "abandoned work-item claim released for redispatch" },
        });
        return true;
      });
    } finally {
      await this.stores.leases.release(lease);
    }
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
   * Refused while any of them is live unless `force`. Breaking and every execution write
   * share the ownership mutex, so an obsolete holder's next append is refused immediately.
   * The heartbeat also stops local execution, including while no events are being emitted.
   * Legacy records require quiesced recovery; `force` cannot make old unfenced writers safe.
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
    const workflows = this.generations?.current.workflows ?? this.workflows;
    if (!workflowId.includes(INLINE_SEP)) return workflows.get(workflowId);
    return this.walkInline(workflows.get(workflowId.split(INLINE_SEP)[0]!), workflowId);
  }

  /**
   * The definition a run recorded as `(workflowId, version)` (#179). The file on disk when it is
   * still at that version; otherwise the copy `startRun` kept in the workflow-version store. A
   * run that predates versioning (`stored` false: its `run.created` carries no
   * `workflowStored`) and has no stored copy runs on whatever file is current, as it always
   * did. Anything else - a version neither stored nor on disk - is `WORKFLOW_VERSION_NOT_FOUND`,
   * naming the versions that do exist, rather than silently running the newest.
   */
  async definitionFor(workflowId: string, version: string, stored = true): Promise<WorkflowDefinition> {
    const rootId = workflowId.split(INLINE_SEP)[0]!;
    const live = this.workflows.has(rootId) ? this.workflows.get(rootId) : undefined;
    // A run that recorded its definition walks that snapshot, even when the file on disk has
    // since been edited without a version bump (#330); the file is the fallback for a store that
    // lost it. A run from before versioning keeps its old order: the file first.
    let root: WorkflowDefinition | undefined = stored
      ? ((await this.stores.workflows.get(rootId, version)) ?? (live?.version === version ? live : undefined))
      : live?.version === version
        ? live
        : await this.stores.workflows.get(rootId, version);
    // Predates versioning: whatever is current, and an unknown workflow is the registry's error.
    if (!root && !stored) root = live ?? this.workflows.get(rootId);
    if (!root) throw await this.versionNotFound(rootId, version, live);
    return workflowId.includes(INLINE_SEP) ? this.walkInline(root, workflowId) : root;
  }

  /**
   * The definition a new run of `workflowId` would be admitted on, and the one a preflight
   * validates against (#330), so the two cannot disagree.
   *
   * With a `version`: the copy the workflow-version store kept for it, else the loaded file
   * when it is at that version (a workflow that has never run). Anything else is
   * `WORKFLOW_VERSION_NOT_FOUND` - never the latest instead.
   *
   * Without one: the loaded file, provided that a stored definition of the same version, if
   * any, is the same content. A version is immutable once a run has recorded it, so an edit
   * that kept the version is `WORKFLOW_INVALID` here rather than a new run silently starting
   * on a definition its resume would not find.
   */
  async selectDefinition(
    workflowId: string,
    version?: string,
    workflows = this.generations?.current.workflows ?? this.workflows,
  ): Promise<WorkflowDefinition> {
    if (version !== undefined) {
      const live = workflows.has(workflowId) ? workflows.get(workflowId) : undefined;
      const def =
        (await this.stores.workflows.get(workflowId, version)) ?? (live?.version === version ? live : undefined);
      if (!def) throw await this.versionNotFound(workflowId, version, live);
      return def;
    }
    const live = workflows.get(workflowId);
    const kept = await this.stores.workflows.get(live.id, live.version);
    if (kept && workflowRevision(kept) !== workflowRevision(live)) throw versionCollision(live);
    return live;
  }

  private async versionNotFound(
    rootId: string,
    version: string,
    live: WorkflowDefinition | undefined,
  ): Promise<OrcaError> {
    const available = [
      ...new Set([...(await this.stores.workflows.versions(rootId)), ...(live ? [live.version] : [])]),
    ];
    return new OrcaError(
      "WORKFLOW_VERSION_NOT_FOUND",
      `workflow '${rootId}' version ${version} is neither stored nor on disk; ${
        available.length ? `available: ${available.join(", ")}` : "no version of it exists"
      }`,
      { id: rootId, version, available },
    );
  }

  /**
   * Keep the definition a run is starting on, so it can be resumed after the file changes.
   * True when the store holds the run's root definition at this version afterwards. The store
   * is write-once, so when this call did not write it - an earlier run did, or another process
   * won a race to the first write - what is there is read back and must be this same content.
   */
  private async recordDefinition(def: WorkflowDefinition): Promise<boolean> {
    if (def.id.includes(INLINE_SEP)) {
      // A nested graph is part of its root's file; the root was kept when the parent started.
      return (await this.stores.workflows.get(def.id.split(INLINE_SEP)[0]!, def.version)) !== undefined;
    }
    if (await this.stores.workflows.put(def)) return true;
    const kept = await this.stores.workflows.get(def.id, def.version);
    if (!kept || workflowRevision(kept) !== workflowRevision(def)) throw versionCollision(def);
    return true;
  }

  private walkInline(root: WorkflowDefinition, workflowId: string): WorkflowDefinition {
    const [, ...path] = workflowId.split(INLINE_SEP);
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

  /**
   * Refuse a selection record before the run exists (#186): every agent it names must be
   * configured, and every role the workflow's own nodes ask for must be filled under it -
   * rather than failing on the first step that needs the agent.
   */
  private validateOverrides(
    def: WorkflowDefinition,
    overrides: RunOverrides,
    agents = this.agents,
    workflows = this.workflows,
    templates = this.templates,
  ): void {
    agents.validateOverrides(overrides);
    if (overrides.itemWorkflow !== undefined && !workflows.has(overrides.itemWorkflow))
      throw new OrcaError("WORKFLOW_NOT_FOUND", "Selected item workflow is unavailable");
    if (overrides.templatePack !== undefined && !templates.packs().includes(overrides.templatePack))
      throw new OrcaError("TEMPLATE_NOT_FOUND", "Selected template pack is unavailable");
    const scoped = agents.withOverrides(overrides);
    for (const node of Object.values(def.nodes)) {
      const selector = (node as { agent?: unknown }).agent;
      if (selector && typeof selector === "object" && "role" in selector) scoped.resolve(selector as AgentSelector);
    }
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
    if (
      first.payload.workflowStored &&
      (first.payload.provenance || (await this.stores.execution.getInputs(runId))) &&
      !(await this.stores.workflows.get(first.payload.workflowId.split(INLINE_SEP)[0]!, first.payload.workflowVersion))
    )
      throw new OrcaError(
        "WORKFLOW_VERSION_NOT_FOUND",
        "protected execution requires its original stored workflow snapshot",
      );
    const def = await this.definitionFor(
      first.payload.workflowId,
      first.payload.workflowVersion,
      first.payload.workflowStored === true,
    );
    const rc = await RunContext.load(runId, def, {
      stores: this.stores,
      clock: this.clock,
      logger: this.logger.child({ runId }),
      loadState: (id) => this.executionState(id),
      plan: this.plan,
    });
    if (first.payload.provenance) {
      if (!this.generations) throw unavailable();
      const generation = await this.generations.restore(first.payload.provenance.configGeneration);
      if (workflowRevision(def) !== first.payload.provenance.workflow.revision) throw unavailable();
      this.contextGenerations.set(rc, generation);
    }
    this.live.set(runId, rc);
    return rc;
  }

  /**
   * Take the run's single-writer lease, drive it, give the lease back. Everything that
   * *writes* to a run's log happens inside here; reading and reducing it does not, because a
   * reader cannot corrupt anyone's story.
   */
  private async executeLeased(runId: string, recovery: boolean): Promise<RunState> {
    // The summary comes first because it is cheap - it never replays the step events - and it
    // answers both questions that have to be answered before the log is reduced: what to write
    // on the lease, and whether this run is finished. A finished run is not driven at all, so
    // it needs no lease and must never be left holding one.
    const summary = await this.getSummary(runId);
    if (isTerminalStatus(summary.status)) return this.getState(runId);
    // Then the lease, *before* `loadContext` (#267): loading caches a RunContext in `this.live`,
    // and an interpreter that is about to be refused must leave nothing behind there for the
    // next attach - or for a `getState` or `cancel` in this process - to reuse.
    let rc: RunContext | undefined;
    const held = await this.takeRunLease(runId, summary.workflowId, () => rc);
    try {
      rc = await this.loadContext(runId);
      rc.lease = held.lease;
      // The window between taking the lease and having a context to stop is the one place
      // `onLost` cannot act on (#267): it fires, finds no `rc`, and returns. Reading the flag
      // here closes it - an interpreter whose lease went away while the log was being reduced
      // must refuse, not execute, because `execute` writes. `held.held` is the same answer from
      // the keeper's side, and either being false is enough.
      if (held.lost || !held.held) {
        // Mark the cached context too: a `cancel` in this process must not write to a log we
        // no longer own either, and `this.live` now has this `rc` in it.
        rc.leaseLost = true;
        throw new OrcaError(
          "RUN_LEASED",
          `the lease on run ${runId} was taken away while its log was being loaded here; this interpreter stopped without writing. The run is now whoever holds the lease's to drive.`,
          { runId },
        );
      }
      // Terminal again only if it finished between the summary and here; releasing is enough.
      if (isTerminal(rc.state)) return rc.state;
      const context = rc;
      await context.withOwnership(async () => {
        await this.liveInput?.prepareExecution?.(runId);
        await this.validateOwnedWorkspace(context);
        await prepareAdmissionExecution(this.stores, context, this.admissionExecution, recovery);
      });
      return await this.execute(rc);
    } finally {
      this.liveInput?.releaseExecution?.(runId);
      await held.release();
    }
  }

  /**
   * Claim the right to interpret `runId`, and keep claiming it: an attached interpreter
   * heartbeats for as long as it is attached, so a second one can tell "still working, mostly
   * waiting on an agent" from "died an hour ago" without a human deciding. Losing the lease
   * mid-run (only an operator can take a live one away) stops this interpreter where it
   * stands, without a further write, rather than letting two interpreters append to one log.
   *
   * `attached` is read at heartbeat time rather than taken as a value because the lease is
   * taken before the context exists; a lease lost in that window has nothing to stop yet, so
   * it is remembered in `lost` instead and `executeLeased` reads it once there is a context.
   */
  private async takeRunLease(
    runId: string,
    note: string,
    attached: () => RunContext | undefined,
  ): Promise<AttachedLease> {
    const lease = await this.stores.leases.acquire({
      resource: runLeaseResource(runId),
      holder: this.leaseHolder,
      ttlMs: this.leaseTtlMs,
      note,
    });
    if (!ownsLease(lease, this.leaseHolder))
      throw new OrcaError(
        "RUN_LEASED",
        `run ${runId} is already being interpreted by pid ${lease.pid} on ${lease.host} (last heartbeat ${lease.renewedAt}): wait for it, or take the lease with 'orca leases break ${runId} --force'`,
        { runId, ...describeLease(lease) },
      );
    let lost = false;
    const keeper = keepLease(this.stores.leases, lease, {
      ...(this.leaseRenewMs !== undefined ? { renewMs: this.leaseRenewMs } : {}),
      onLost: () => {
        lost = true;
        const rc = attached();
        (rc?.logger ?? this.logger).error("run lease lost; stopping this interpreter", {
          resource: lease.resource,
          runId,
        });
        if (!rc) return;
        // The flag, not the abort reason, is what tells the interpreter apart from an operator's
        // cancel: a cancel we own still writes `run.cancelled`, a lost lease writes nothing.
        rc.leaseLost = true;
        rc.abort.abort(`lease on run ${runId} was taken away; another process may now be driving it`);
      },
    });
    this.leaseKeepers.add(keeper);
    return {
      ...keeper,
      get lease() {
        return keeper.lease;
      },
      get held() {
        return keeper.held;
      },
      get renewalSettled() {
        return keeper.renewalSettled;
      },
      get lost() {
        return lost;
      },
      release: async () => {
        try {
          await keeper.release();
        } finally {
          // Bounded release may leave a renewal holding the mutation mutex. Retain
          // its activity until actual settlement without extending shutdown waits.
          const settled = () => this.leaseKeepers.delete(keeper);
          void keeper.renewalSettled.then(settled, settled);
        }
      },
    };
  }

  /** Caller holds the execution lease's mutation fence, before consuming attachment evidence. */
  private async validateOwnedWorkspace(rc: RunContext): Promise<void> {
    if (rc.workspace.rootProvisioning) {
      const generation = this.contextGenerations.get(rc);
      const provider =
        generation && this.generationWorkspaceProvider
          ? this.generationWorkspaceProvider(generation)
          : this.workspaceProvider;
      if (!provider.validate) throw unavailable();
      await provider.validate(rc.workspace);
    }
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
          if (last.result?.outcome) {
            await rc.emit({
              type: "run.completed",
              payload: {
                outcome: last.result.outcome,
                ...(last.result.message ? { message: last.result.message } : {}),
              },
            });
            return rc.state;
          }
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
        const stepRunId = (await this.revisionRuntime?.reserveStep(rc, nodeId)) ?? newId("step", this.clock.now());
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
      if (rc.leaseLost) {
        // The lease was taken away mid-run (#267). Another interpreter may already be reducing
        // and extending this log, so there is nothing safe to say here: a `step.cancelled` or
        // `run.cancelled` from this process would cancel *their* run. Stop, say why in the log
        // of this process (not of the run), and let the caller know the run is not ours.
        log.error("run lease lost; stopping without writing to the run's log", { stoppedAt: err.code });
        throw new OrcaError(
          "RUN_LEASED",
          `the lease on run ${runId} was taken away while it was being interpreted here; this interpreter stopped without writing. The run is now whoever holds the lease's to drive.`,
          { runId },
        );
      }
      if (err.code === "CANCELLED" || rc.abort.signal.aborted) {
        // A step interrupted mid-flight (an agent turn, a parked human question) never reports back; close it here.
        for (const s of openSteps(rc.state)) await rc.emit({ type: "step.cancelled", payload: { stepRunId: s.id } });
        await rc.emit({
          type: "run.cancelled",
          payload: { reason: err.message, ...(rc.cancelActor ? { actor: rc.cancelActor } : {}) },
        });
      } else {
        log.error("run failed", { error: err });
        await rc.emit({ type: "run.failed", payload: { error: err } });
      }
      return rc.state;
    } finally {
      await this.closeRunSessions(runId);
      if (rc.state.run.workItemId && isTerminal(rc.state))
        await rc.withOwnership(() => this.plan.onRunFinished(rc.state.run));
    }
  }

  /** Pick the outgoing edge: first conditional edge whose `when` is truthy, else the unconditional one. */
  private async route(rc: RunContext, nodeId: string, result: StepResult): Promise<Edge | undefined> {
    const edges = outgoing(rc.definition, nodeId);
    if (edges.length === 0) return undefined;
    // Only build the eval context when something asks a question of it. Since #270 an
    // unreadable artifact body fails the context instead of reading as "", and a graph
    // whose edges are all unconditional has no reason to touch a blob to pick one.
    if (!edges.some((e) => e.when)) return edges.find((e) => !e.when);
    const ctx = await rc.evalContext({ choice: result.choice ?? rc.lastChoice(), result });
    for (const e of edges) if (e.when && evaluateCondition(e.when, ctx)) return e;
    return edges.find((e) => !e.when);
  }

  private async executeStep(rc: RunContext, step: StepRun, node: NodeDef): Promise<StepOutcome> {
    const executor = (this.contextGenerations.get(rc)?.executors ?? this.executors).get(node.type);
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
      return {
        kind: "failed",
        error: err,
        retryable:
          err.code !== "WORKFLOW_INVALID" && err.code !== "NOT_SUPPORTED" && err.code !== "AGENT_MODEL_NOT_FOUND",
      };
    }
  }

  private stepContext(rc: RunContext, step: StepRun, node: NodeDef): StepContext {
    const self = this;
    const ctx: StepContext = {
      ...this.revisionRuntime?.forStep(rc, step),
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
      agents: (this.contextGenerations.get(rc)?.agents ?? this.agents).withOverrides(rc.state.run.overrides),
      templates: this.contextGenerations.get(rc)?.templates ?? this.templates,
      workflows: this.contextGenerations.get(rc)?.workflows ?? this.workflows,
      humanInput: abortableHumanInput(
        this.contextGenerations.has(rc) && this.generationHumanInput
          ? this.generationHumanInput(this.contextGenerations.get(rc)!)
          : this.humanInput,
        rc.abort.signal,
      ),
      plan: this.plan,

      async emit(event) {
        await rc.emit(event);
      },
      async evalContext(extra) {
        const vars = rc.state.run.vars;
        const selected =
          typeof vars.planId === "string"
            ? vars.planId
            : typeof vars.plan === "string"
              ? vars.plan
              : self.plan.defaults.planKey;
        const plan = (await self.plan.planForRun(rc.state.run)) ?? (await self.plan.getPlan(selected));
        const riskMatrix = plan?.riskMatrix ?? RiskMatrixConfigSchema.parse(self.plan.defaults.riskMatrix);
        return rc.evalContext({ step, riskMatrix, ...(extra ?? {}) });
      },
      async evaluate(expr, extra) {
        return evaluateExpression(expr, await ctx.evalContext(extra));
      },
      async render(body, extra) {
        return renderTemplate(body, await ctx.evalContext(extra), { partials: ctx.templates.partials });
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
          (await rc.withOwnership(() =>
            self.startRun({
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
              ...(options.overrides
                ? { overrides: options.overrides }
                : rc.state.run.overrides
                  ? { overrides: rc.state.run.overrides }
                  : {}),
            }),
          ));
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
        const onAbort = () => void self.cancel(childId, "parent cancelled", rc.cancelActor);
        rc.abort.signal.addEventListener("abort", onAbort, { once: true });
        // The caller may also cancel this one child on its own (e.g. a fail-fast parallel
        // abandoning the siblings of a branch that already decided the join).
        const own = options.signal;
        const onOwnAbort = () =>
          void self.cancel(childId, typeof own?.reason === "string" ? own.reason : "cancelled by parent step");
        if (own?.aborted) onOwnAbort();
        else own?.addEventListener("abort", onOwnAbort, { once: true });
        try {
          await self.run(childId);
          const childInputs = await self.stores.execution.getInputs(childId);
          if (childInputs) await rc.inheritSensitivity(childInputs);
          const result = await self.executionState(childId);
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
      // Bytes, not characters (#226): `size` is what `artifacts.get` quotes when it declines
      // a body, and what a store's blob actually occupies. The two differ on any artifact
      // that is not pure ASCII, which is most prose with a dash in it.
      size: Buffer.byteLength(content, "utf8"),
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
    await rc.emit({ type: "artifact.recorded", payload: { stepRunId: step.id, artifact } }, () =>
      this.stores.artifacts.put(artifact, content),
    );
    // Planning intake happens inline so the next node sees risks/decisions/dependencies this artifact carried.
    const rejected = await rc.withOwnership(() => this.plan.onArtifactRecorded(rc.state.run, artifact));
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
    const { agent, host } = (this.contextGenerations.get(rc)?.agents ?? this.agents)
      .withOverrides(rc.state.run.overrides)
      .resolve(selector);
    if (
      rc.workspace.rootProvisioning &&
      (process.platform !== "linux" || !(host instanceof LocalHost) || host.id !== rc.workspace.hostId)
    )
      throw new OrcaError("RUN_STATE", "Owned root workspace requires its matching supported local execution host");
    const key = `${rc.id}:${agent.id}`;
    const model = selectedModel(rc.state.run.overrides, agent);
    const pooled = agent.sessionMode === "per-run" ? this.sessions.get(key) : undefined;
    if (pooled) {
      pooled.current.step = step;
      const now = currentModel(pooled.session);
      // The pooled session is already on the run's model, or has no option to drift in.
      if (model === undefined || now === undefined || now === model)
        return { session: pooled.session, release: async () => {} };
      // It drifted (the agent switched model itself): re-apply rather than run a step on a
      // model the run did not select. An agent that refuses gets a fresh session instead.
      try {
        await applyModel(pooled.session, agent, model);
        await rc.emit({
          type: "agent.update",
          payload: {
            stepRunId: step.id,
            sessionId: pooled.session.id,
            update: { kind: "config_option_update", text: `model re-applied: ${model} (was ${now})` },
          },
        });
        return { session: pooled.session, release: async () => {} };
      } catch (e) {
        if (e instanceof OrcaError && e.code === "AGENT_MODEL_NOT_FOUND") throw e;
        rc.logger.warn("pooled session refused the model; reopening it", { agent: agent.id, model });
        this.sessions.delete(key);
        await pooled.session.close().catch(() => undefined);
        await rc
          .emit({ type: "agent.session.closed", payload: { stepRunId: step.id, sessionId: pooled.session.id } })
          .catch(() => undefined);
      }
    }
    const current = { step };
    let pendingAsks = 0;
    const humanInput = abortableHumanInput(this.humanInput, rc.abort.signal);
    // Opening a session *is* the ACP handshake, so it is also where agent health comes from:
    // one that returns is a live agent, one that throws is a spawn or handshake that failed.
    // Nothing polls - health only ever reflects work a run asked for (#222).
    const handshake = this.agents.health.begin(agent.id);
    let session: AgentSession;
    let continuity: Parameters<NonNullable<OpenSessionOptions["onSessionContinuity"]>>[0] | undefined;
    try {
      session = await this.sessionFactory({
        host,
        agent,
        cwd: rc.workspace.cwd,
        logger: rc.logger,
        clock: this.clock,
        onSessionContinuity: (state) => {
          continuity = state;
        },
        // Each `ask` permission is its own human-input request: an agent may block on
        // several tool calls at once, and every one must be listed, answerable and
        // logged independently (one id per session made concurrent asks collide).
        askPermission: async (req, invocation) => {
          const stepRunId = current.step.id;
          const live =
            this.liveInput && invocation
              ? {
                  identity: {
                    instanceId: this.liveInput.port.instanceId,
                    sessionId: invocation.sessionId,
                    turnId: invocation.turnId,
                    invocationId: invocation.invocationId,
                  },
                  signal: AbortSignal.any([rc.abort.signal, invocation.signal, this.liveInput.executionSignal(rc.id)]),
                  withOwnership: <T>(operation: () => Promise<T>) =>
                    rc.withOwnership(async () => {
                      // Polling expires idle asks; acceptance must also check the initiating
                      // actor now, after acquiring the original interpreter's lease mutex.
                      if (this.liveInput!.executionSignal(rc.id).aborted)
                        throw new OrcaError("RUN_STATE", "live execution authority expired", {
                          liveInputState: "expired",
                        });
                      return operation();
                    }),
                  emitOwned: (event: Parameters<RunContext["emitOwned"]>[0]) => rc.emitOwned(event),
                }
              : undefined;
          const offered = req.options.filter((o) => !live || o.kind === "allow_once" || o.kind === "reject_once");
          // A remembered-only ask has no supported one-time decision. Do not park an
          // impossible-to-answer live card until its turn eventually times out.
          if (live && offered.length === 0) return undefined;
          return askHumanInput({
            port: live ? this.liveInput!.port : humanInput,
            ...(live ? { live } : {}),
            emit: (e) => rc.emit(e),
            clock: this.clock,
            runId: rc.id,
            stepRunId,
            kind: "permission",
            question: req.toolCall.title ?? "Allow tool call?",
            // ACP already separates the two: `optionId` is what the agent is answered
            // with, `name` is what the host shows. Keep them apart here too.
            // ACP remembered choices grant policy inside the agent. Live responses only
            // offer one-time choices; ORCA standing rules use the separately authorized writer.
            options: offered.map((o) => ({ id: o.optionId, label: o.name || o.optionId })),
            // Whose turn is being held open (#248). It is recorded here because here is
            // where it is known: an attention card has to name the agent, and the push that
            // opens the card is a pure function of the event it comes from.
            agent: { id: agent.id, hostId: host.spec.id },
            context: { toolCall: req.toolCall },
            onRequested: () => {
              pendingAsks++;
            },
            onSettled: async () => {
              pendingAsks--;
              // The agent turn is still in flight; go back to waiting on it once no ask is pending.
              if (pendingAsks === 0)
                await rc
                  .emit({ type: "step.waiting", payload: { stepRunId, on: "agent-turn" } })
                  .catch(() => undefined);
            },
          });
        },
        onPermission: (info) => {
          if (rc.abort.signal.aborted) return;
          void rc
            .emit({
              type: "agent.permission",
              payload: {
                stepRunId: current.step.id,
                sessionId: session.id,
                title: info.title,
                decision: info.decision,
                ...(info.toolCallId ? { toolCallId: info.toolCallId } : {}),
              },
            })
            .catch((error: unknown) =>
              rc.logger.warn("permission audit append failed", { error: describeError(error) }),
            );
        },
      });
    } catch (e) {
      handshake.failed(e);
      throw e;
    }
    // Until the release function or pool takes ownership, every startup failure
    // must close the newly created session, including a failed opened-event append.
    try {
      handshake.ok();
      // The run's model goes on before any turn does; a model nobody offers fails the step here.
      if (model !== undefined) await applyModel(session, agent, model);
      const applied = model ?? currentModel(session);
      await rc.emit({
        type: "agent.session.opened",
        payload: {
          stepRunId: step.id,
          sessionId: session.id,
          agentId: agent.id,
          hostId: host.id,
          cwd: rc.workspace.cwd,
          ...(applied !== undefined ? { model: applied } : {}),
          ...(continuity ? { continuity } : {}),
        },
      });
      for (const listener of this.sessionOpenedListeners) {
        try {
          listener({ runId: rc.id, agentId: agent.id, session });
        } catch (e) {
          rc.logger.warn("agent session listener threw", { error: String(e) });
        }
      }
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
    } catch (error) {
      await session.close().catch((cleanupError: unknown) =>
        rc.logger.warn("agent session startup cleanup failed", {
          sessionId: session.id,
          error: describeError(cleanupError),
        }),
      );
      throw error;
    }
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
  return isTerminalStatus(state.run.status);
}

/** The same question of a status alone, for the summary a run is leased against. */
function isTerminalStatus(status: RunSummary["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Steps that have been scheduled but not yet settled (scheduled, running or waiting). */
function openSteps(state: RunState): StepRun[] {
  return state.stepOrder
    .map((id) => state.steps[id]!)
    .filter((s) => s.status === "scheduled" || s.status === "running" || s.status === "waiting");
}
