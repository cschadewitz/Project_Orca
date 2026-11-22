/**
 * RunContext - the live, in-memory view of one run while the orchestrator is
 * executing it. It owns the projected RunState, appends events (keeping the
 * projection in sync), and builds the expression/template context that
 * conditions and prompts are evaluated against.
 */
import {
  applyEvent,
  isOrcaError,
  latestStepForNode,
  OrcaError,
  reduceRun,
  type Artifact,
  type Clock,
  type Logger,
  type OrcaEvent,
  type OrcaEventInput,
  type Request,
  type Run,
  type RunState,
  type RunStatus,
  type WorkItem,
  type WorkflowDefinition,
  type Workspace,
} from "@orca/core";
import {
  executionEvents,
  redactExecutionValue,
  unavailable,
  type ExecutionInputs,
  type Lease,
  type Stores,
} from "@orca/store";
import { executionLogger } from "./execution-inputs.js";
import type { ResolvedArtifact } from "./executors/types.js";
import { projectWorkItems, type ProjectedWorkItem } from "./program/work-items.js";

/** Events that change what a fan-out step knows about its branches - and so, about its work items. */
const BRANCH_EVENTS = new Set<string>(["child.spawned", "child.finished", "branch.skipped"]);

/** Run statuses a child can no longer leave on its own. */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled"]);

/**
 * Container steps whose children are fan-out branches, not a sequence (both run on `FanOut`).
 * A branch that starts after another finished - a concurrency limit, `dependsOn`, a later
 * plan wave - did not follow on from it, so it never sees that branch's artifacts.
 */
const FAN_OUT_STEPS: ReadonlySet<string> = new Set(["parallel", "custom:plan-dispatch"]);

/**
 * What the projection tells the planning layer once it has written. `PlanService` implements
 * it; taking the hook as an interface keeps the engine's core free of a plan-layer import.
 */
export interface WorkItemProjectionSink {
  onWorkItemsProjected(changes: readonly ProjectedWorkItem[], runId: string): Promise<void>;
}

export interface RunContextDeps {
  stores: Stores;
  clock: Clock;
  logger: Logger;
  /** Load another run's state (parents/children) - provided by the orchestrator. */
  loadState(runId: string): Promise<RunState>;
  /** Notified of the work-item transitions each projection writes, if this deployment plans. */
  plan?: WorkItemProjectionSink;
}

export class RunContext {
  readonly abort = new AbortController();
  /**
   * Set when this interpreter's run lease was taken away (#267). The abort that follows is
   * *not* an operator's cancel: the log belongs to whoever holds the lease now, so the
   * interpreter stops without appending anything to it - no `step.cancelled`, no
   * `run.cancelled`. Only the orchestrator's lease heartbeat sets this.
   */
  leaseLost = false;
  /** Verified actor of an explicit cancellation while this context is live. */
  cancelActor: import("@orca/core").MutationActor | undefined;
  /** Installed by the interpreter before any execution write. */
  lease: Lease | undefined;
  /** Serialize private sensitivity promotions from parallel children. */
  private sensitivityUpdate: Promise<void> = Promise.resolve();
  /**
   * Artifact bodies by content hash. Blobs are content-addressed and therefore immutable, and
   * `evalContext()` runs for every render, condition, route and input resolution - without this
   * each of those re-read every visible artifact from disk.
   */
  private readonly contentByHash = new Map<string, Promise<string>>();
  /**
   * Secret values (#336) read for sessions this interpreter opened, its child runs' included.
   * Memory only: they redact events and logs as they are written and are never stored, so a
   * resumed interpreter knows only the values its own sessions read again.
   */
  private readonly runtimeSecrets = new Set<string>();
  private constructor(
    readonly id: string,
    readonly definition: WorkflowDefinition,
    public state: RunState,
    private readonly deps: RunContextDeps,
    private readonly publicProjection: RunState,
    private executionInputs?: ExecutionInputs,
  ) {}

  static async load(id: string, definition: WorkflowDefinition, deps: RunContextDeps): Promise<RunContext> {
    const events = await deps.stores.events.read(id);
    if (events.length === 0) throw new OrcaError("RUN_NOT_FOUND", `run ${id} has no events`);
    const first = events[0];
    const inputs = await deps.stores.execution.getInputs(id);
    if (first?.type === "run.created" && first.payload.executionInputsStored && !inputs) throw unavailable();
    if (inputs && (inputs.workflowId !== definition.id || inputs.workflowVersion !== definition.version))
      throw unavailable();
    const authoritative = await executionEvents(events, deps.stores.execution);
    if (inputs && authoritative[0]?.type === "run.created")
      authoritative[0] = {
        ...authoritative[0],
        payload: { ...authoritative[0].payload, vars: structuredClone(inputs.vars) },
      };
    const state = reduceRun(authoritative);
    return new RunContext(id, definition, state, deps, reduceRun(events), inputs);
  }

  /** A public reader must never receive the interpreter's private vars or event payloads. */
  publicState(): RunState {
    return this.publicProjection;
  }

  get workspace(): Workspace {
    return this.state.run.workspace;
  }
  get logger(): Logger {
    return executionLogger(this.deps.logger, () => this.redactionInputs());
  }

  /** Remember secret values a session of this run read, so nothing written later carries them. */
  addRuntimeSecrets(values: readonly string[]): void {
    for (const value of values) if (value.length) this.runtimeSecrets.add(value);
  }

  /**
   * `value` with every runtime secret value replaced by `[REDACTED]`, keys left as they are.
   * For writes that do not go through `emitOwned`: artifact bodies, their metadata, and what
   * planning derives from them.
   */
  redactRuntimeSecrets<T>(value: T): T {
    return this.runtimeSecrets.size ? redactExecutionValue(value, [...this.runtimeSecrets]) : value;
  }

  private redactionInputs(): ExecutionInputs | undefined {
    if (!this.runtimeSecrets.size) return this.executionInputs;
    const secrets = [...(this.executionInputs?.secrets ?? []), ...this.runtimeSecrets];
    return { ...(this.executionInputs ?? ({} as ExecutionInputs)), secrets };
  }

  /** Promote before any exact child result returns; immutable admission vars are never rewritten. */
  async inheritSensitivity(child: ExecutionInputs): Promise<void> {
    const update = this.sensitivityUpdate.then(() => this.withOwnership(() => this.inheritSensitivityOwned(child)));
    this.sensitivityUpdate = update.catch(() => undefined);
    await update;
  }

  /** Caller already holds this context's mutation fence; never nest withOwnership. */
  async inheritSensitivityOwned(child: ExecutionInputs): Promise<void> {
    if (this.leaseLost) throw new OrcaError("RUN_LEASED", `ownership of run ${this.id} was lost`);
    let inputs = await this.deps.stores.execution.getInputs(this.id);
    if (!inputs) {
      const first = (await this.deps.stores.events.readRange(this.id, { limit: 1 }))[0];
      if (first?.type !== "run.created") throw unavailable();
      inputs = {
        runId: this.id,
        workflowId: first.payload.workflowId,
        workflowVersion: first.payload.workflowVersion,
        vars: first.payload.vars,
        sensitiveNames: [],
        secrets: [],
      };
      await this.deps.stores.execution.putInputs(inputs);
    }
    const present = new Set(inputs.secrets.map((value) => JSON.stringify(value)));
    const secrets = child.secrets.filter((value) => !present.has(JSON.stringify(value)));
    const sensitiveNames = child.sensitiveNames.filter((name) => !inputs.sensitiveNames.includes(name));
    if (secrets.length || sensitiveNames.length)
      await this.deps.stores.execution.addSensitivity(this.id, { secrets, sensitiveNames });
    this.executionInputs = await this.deps.stores.execution.getInputs(this.id);
    if (!this.executionInputs) throw unavailable();
  }

  async withOwnership<T>(write: () => Promise<T>): Promise<T> {
    if (this.leaseLost) throw new OrcaError("RUN_LEASED", `ownership of run ${this.id} was lost`);
    try {
      return this.lease ? await this.deps.stores.leases.withOwnership(this.lease, write) : await write();
    } catch (error) {
      if (error instanceof OrcaError && error.code === "RUN_LEASED") {
        this.leaseLost = true;
        this.abort.abort(error.message);
      }
      throw error;
    }
  }

  async emit(input: Omit<OrcaEventInput, "runId">, prepare?: () => Promise<void>): Promise<OrcaEvent> {
    return this.withOwnership(async () => {
      await prepare?.();
      return this.emitOwned(input);
    });
  }

  /** Only within withOwnership: live answers and their standing write share one mutex. */
  async emitOwned(input: Omit<OrcaEventInput, "runId">): Promise<OrcaEvent> {
    // A secret value never reaches the log, nor the interpreter's own projection (#336).
    // Keys are structure (ids, field names), so only values are rewritten.
    if (this.runtimeSecrets.size) input = { ...input, payload: this.redactRuntimeSecrets(input.payload) };
    const e = await this.deps.stores.events.append({ ...input, runId: this.id } as OrcaEventInput);
    // The returned event is public; the interpreter keeps its exact authoritative payload.
    applyEvent(this.state, { ...e, payload: input.payload } as OrcaEvent);
    applyEvent(this.publicProjection, e);
    // A turn record is the evidence that a prompt may have been sent, and the prompt goes out
    // right after it: it must survive a crash or power loss first, or a lost record would
    // let a step that acted look as if it never had (#357). A store that cannot sync an exact
    // event cannot carry that evidence, so the prompt is not sent. The record is applied first:
    // it is in the log either way, so a failed sync never lets this attempt look undispatched.
    if (e.type === "agent.turn.started") {
      if (!this.deps.stores.events.synchronizeEvent)
        throw new OrcaError("NOT_SUPPORTED", "this event store cannot make an agent turn durable before it is sent");
      await this.deps.stores.events.synchronizeEvent(e);
    }
    if (BRANCH_EVENTS.has(e.type)) await this.syncWorkItemsOwned();
    return e;
  }

  /**
   * Refresh the WorkItem documents from this run's log. The documents are a cache of a
   * projection (see program/work-items.ts), never an independent record, so it is always
   * safe - and on resume, necessary - to recompute them from the events alone.
   */
  async syncWorkItems(): Promise<void> {
    return this.withOwnership(() => this.syncWorkItemsOwned());
  }

  private async syncWorkItemsOwned(): Promise<void> {
    const changes = await projectWorkItems(this.deps.stores, this.state, this.deps.clock.isoNow());
    if (changes.length && this.deps.plan) await this.deps.plan.onWorkItemsProjected(changes, this.id);
  }

  async request(): Promise<Request | undefined> {
    return this.state.run.requestId ? this.deps.stores.requests.get(this.state.run.requestId) : undefined;
  }
  async workItem(): Promise<WorkItem | undefined> {
    return this.state.run.workItemId ? this.deps.stores.workItems.get(this.state.run.workItemId) : undefined;
  }

  /**
   * Own artifacts + every ancestor's + every ancestor's *earlier siblings* (with their
   * descendants) + every descendant's, newest version per name.
   *
   * "Earlier sibling" = another child of the same sequential container step, bound to the
   * same work item (or, like this run, to none), that was spawned before this run and had
   * already finished when this run was created. That is what lets loop iteration N read what
   * iteration N-1 produced (a review-then-fix `loop` node). Fan-out branches (`parallel`,
   * `custom:plan-dispatch`) never see each other, even when one starts after another has
   * finished: item B's first build must not take item A's review as feedback to act on.
   * In a plan, context from another item travels explicitly, in `vars.upstream`.
   */
  async visibleArtifacts(): Promise<Map<string, Artifact>> {
    const all: Artifact[] = [];
    const seen = new Set<string>();
    const collect = async (state: RunState, direction: "up" | "down" | "both") => {
      if (seen.has(state.run.id)) return;
      seen.add(state.run.id);
      all.push(...Object.values(state.artifacts));
      if ((direction === "up" || direction === "both") && state.run.parentRunId) {
        const parent = await this.deps.loadState(state.run.parentRunId);
        for (const sibling of await this.earlierSiblings(parent, state.run)) await collect(sibling, "down");
        await collect(parent, "up");
      }
      if (direction === "down" || direction === "both") {
        for (const s of Object.values(state.steps))
          for (const c of s.childRunIds) await collect(await this.deps.loadState(c), "down");
      }
    };
    await collect(this.state, "both");
    const map = new Map<string, Artifact>();
    for (const a of all) {
      const cur = map.get(a.name);
      if (!cur || cur.version < a.version || (cur.version === a.version && cur.createdAt < a.createdAt))
        map.set(a.name, a);
    }
    return map;
  }

  /**
   * The children of `run`'s container step that were spawned before it and had already
   * finished when it was created, oldest first. The spawn-order cut (`children` is in
   * `child.spawned` order) plus the `completedAt` cut keep this independent of when it is
   * asked: a run's set of earlier siblings never changes while it executes. A fan-out step's
   * children have none, and a sibling bound to a different work item than `run` is never one.
   */
  private async earlierSiblings(parent: RunState, run: Run): Promise<RunState[]> {
    const step =
      Object.values(parent.steps).find((s) => s.childRunIds.includes(run.id)) ??
      (run.parentStepRunId ? parent.steps[run.parentStepRunId] : undefined);
    if (!step || FAN_OUT_STEPS.has(step.nodeType)) return [];
    const out: RunState[] = [];
    for (const link of step.children) {
      if (link.runId === run.id) break; // everything from here on was spawned after us
      if (!link.status || !FINISHED.has(link.status)) continue;
      const state = await this.deps.loadState(link.runId).catch((error: unknown) => {
        if (isOrcaError(error, "RUN_NOT_FOUND")) return undefined;
        throw error; // Missing/corrupt protected execution material is never an absent sibling.
      });
      if (state?.run.completedAt && state.run.completedAt <= run.createdAt && state.run.workItemId === run.workItemId)
        out.push(state);
    }
    return out;
  }

  /**
   * Artifact body, read once per content hash for the lifetime of this context.
   *
   * A read that fails raises `ARTIFACT_MISSING` rather than standing in an empty string
   * (#270): an artifact that is in the index but whose blob is gone, unreadable or
   * truncated would otherwise render as a blank spec in a prompt and be decided on as
   * `undefined`, and the run would "succeed" against nothing. Only successes are cached -
   * the blob may come back (a restored store, a remounted disk), so the next render tries
   * again instead of inheriting one bad read for the lifetime of the context.
   */
  private content(a: Artifact): Promise<string> {
    let body = this.contentByHash.get(a.contentHash);
    if (!body) {
      const read: Promise<string> = this.deps.stores.artifacts.content(a.id).catch((cause: unknown) => {
        if (this.contentByHash.get(a.contentHash) === read) this.contentByHash.delete(a.contentHash);
        throw new OrcaError(
          "ARTIFACT_MISSING",
          `artifact '${a.name}' v${a.version} (${a.id}) is in the index but its body could not be read: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { artifactId: a.id, name: a.name, version: a.version, contentHash: a.contentHash },
          { cause },
        );
      });
      body = read;
      this.contentByHash.set(a.contentHash, body);
    }
    return body;
  }

  async nextArtifactVersion(name: string): Promise<number> {
    const visible = await this.visibleArtifacts();
    return (visible.get(name)?.version ?? 0) + 1;
  }

  /** The most recent decision choice made in this run. */
  lastChoice(): string | undefined {
    for (let i = this.state.stepOrder.length - 1; i >= 0; i--) {
      const s = this.state.steps[this.state.stepOrder[i]!];
      if (s?.result?.choice !== undefined) return s.result.choice;
    }
    return undefined;
  }

  /** Context object for expressions and templates. Documented in docs/DATA-MODEL.md. */
  async evalContext(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const [request, workItem, visible] = await Promise.all([this.request(), this.workItem(), this.visibleArtifacts()]);
    const artifacts: Record<string, ResolvedArtifact> = {};
    const byKind: Record<string, ResolvedArtifact> = {};
    const bodies = await Promise.all([...visible.values()].map((a) => this.content(a)));
    let i = 0;
    for (const [name, a] of visible) {
      const view: ResolvedArtifact = { ...a, content: bodies[i++]! };
      artifacts[name] = view;
      const cur = byKind[a.kind];
      if (!cur || cur.createdAt < a.createdAt) byKind[a.kind] = view;
    }
    const steps: Record<string, unknown> = {};
    for (const nodeId of Object.keys(this.definition.nodes)) {
      const s = latestStepForNode(this.state, nodeId);
      if (s) steps[nodeId] = s;
    }
    const vars = this.state.run.vars;
    let contextItem: unknown = workItem;
    if (!contextItem && vars.workItem !== undefined && "workItem" in this.definition.inputs) {
      const item = vars.workItem as Record<string, unknown> | null;
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.slug !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(item.slug) ||
        typeof item.title !== "string" ||
        !item.title.trim() ||
        typeof item.description !== "string" ||
        !item.description.trim() ||
        (item.acceptanceCriteria !== undefined &&
          (!Array.isArray(item.acceptanceCriteria) ||
            !item.acceptanceCriteria.every((criterion) => typeof criterion === "string")))
      )
        throw new OrcaError("WORKFLOW_INVALID", "vars.workItem requires a safe slug, title and description");
      contextItem = item;
    }
    if (this.state.run.workItemId && !workItem)
      throw new OrcaError("WORKFLOW_INVALID", `work item ${this.state.run.workItemId} is missing`);
    if ("workItem" in this.definition.inputs && !contextItem)
      throw new OrcaError(
        "WORKFLOW_INVALID",
        "workflow requires workItem; use submit or pass --var workItem with slug, title and description",
      );
    return {
      run: {
        id: this.id,
        workflowId: this.state.run.workflowId,
        status: this.state.run.status,
        parentRunId: this.state.run.parentRunId,
        vars,
      },
      vars,
      workspace: this.workspace,
      request,
      workItem: contextItem,
      artifacts,
      artifactsByKind: byKind,
      steps,
      choice: this.lastChoice(),
      iteration: vars.iteration,
      item: vars.item,
      index: vars.index,
      now: this.deps.clock.isoNow(),
      ...extra,
    };
  }
}
