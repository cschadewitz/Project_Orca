/**
 * RunContext - the live, in-memory view of one run while the orchestrator is
 * executing it. It owns the projected RunState, appends events (keeping the
 * projection in sync), and builds the expression/template context that
 * conditions and prompts are evaluated against.
 */
import {
  applyEvent,
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
import type { Stores } from "@orca/store";
import type { ResolvedArtifact } from "./executors/types.js";
import { projectWorkItems, type ProjectedWorkItem } from "./program/work-items.js";

/** Events that change what a fan-out step knows about its branches - and so, about its work items. */
const BRANCH_EVENTS = new Set<string>(["child.spawned", "child.finished", "branch.skipped"]);

/** Run statuses a child can no longer leave on its own. */
const FINISHED: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled"]);

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
   * Artifact bodies by content hash. Blobs are content-addressed and therefore immutable, and
   * `evalContext()` runs for every render, condition, route and input resolution - without this
   * each of those re-read every visible artifact from disk.
   */
  private readonly contentByHash = new Map<string, Promise<string>>();
  private constructor(
    readonly id: string,
    readonly definition: WorkflowDefinition,
    public state: RunState,
    private readonly deps: RunContextDeps,
  ) {}

  static async load(id: string, definition: WorkflowDefinition, deps: RunContextDeps): Promise<RunContext> {
    const events = await deps.stores.events.read(id);
    if (events.length === 0) throw new OrcaError("RUN_NOT_FOUND", `run ${id} has no events`);
    return new RunContext(id, definition, reduceRun(events), deps);
  }

  get workspace(): Workspace {
    return this.state.run.workspace;
  }
  get logger(): Logger {
    return this.deps.logger;
  }

  async emit(input: Omit<OrcaEventInput, "runId">): Promise<OrcaEvent> {
    const e = await this.deps.stores.events.append({ ...input, runId: this.id } as OrcaEventInput);
    applyEvent(this.state, e);
    if (BRANCH_EVENTS.has(e.type)) await this.syncWorkItems();
    return e;
  }

  /**
   * Refresh the WorkItem documents from this run's log. The documents are a cache of a
   * projection (see program/work-items.ts), never an independent record, so it is always
   * safe - and on resume, necessary - to recompute them from the events alone.
   */
  async syncWorkItems(): Promise<void> {
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
   * "Earlier sibling" = another child of the same container step that was spawned before
   * this run and had already finished when this run was created. That is what lets loop
   * iteration N read what iteration N-1 produced (a review-then-fix `loop` node) while
   * keeping concurrent `parallel` branches - which do not precede each other - from
   * observing each other mid-flight.
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
   * asked: a run's set of earlier siblings never changes while it executes.
   */
  private async earlierSiblings(parent: RunState, run: Run): Promise<RunState[]> {
    const step =
      Object.values(parent.steps).find((s) => s.childRunIds.includes(run.id)) ??
      (run.parentStepRunId ? parent.steps[run.parentStepRunId] : undefined);
    if (!step) return [];
    const out: RunState[] = [];
    for (const link of step.children) {
      if (link.runId === run.id) break; // everything from here on was spawned after us
      if (!link.status || !FINISHED.has(link.status)) continue;
      const state = await this.deps.loadState(link.runId).catch(() => undefined);
      if (state?.run.completedAt && state.run.completedAt <= run.createdAt) out.push(state);
    }
    return out;
  }

  /** Artifact body, read once per content hash for the lifetime of this context. */
  private content(a: Artifact): Promise<string> {
    let body = this.contentByHash.get(a.contentHash);
    if (!body) {
      body = this.deps.stores.artifacts.content(a.id).catch(() => "");
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
      workItem,
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
