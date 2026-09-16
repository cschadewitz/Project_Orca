/**
 * RunContext - the live, in-memory view of one run while the orchestrator is
 * executing it. It owns the projected RunState, appends events (keeping the
 * projection in sync), and builds the expression/template context that
 * conditions and prompts are evaluated against.
 */
import { applyEvent, artifactsByName, latestStepForNode, OrcaError, reduceRun, type Artifact, type Clock, type Logger, type OrcaEvent, type OrcaEventInput, type Request, type RunState, type WorkItem, type WorkflowDefinition, type Workspace } from "@orca/core";
import type { Stores } from "@orca/store";

export interface RunContextDeps {
  stores: Stores;
  clock: Clock;
  logger: Logger;
  /** Load another run's state (parents/children) - provided by the orchestrator. */
  loadState(runId: string): Promise<RunState>;
}

export interface ArtifactView extends Artifact {
  content: string;
}

export class RunContext {
  readonly abort = new AbortController();
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
    return e;
  }

  async request(): Promise<Request | undefined> {
    return this.state.run.requestId ? this.deps.stores.requests.get(this.state.run.requestId) : undefined;
  }
  async workItem(): Promise<WorkItem | undefined> {
    return this.state.run.workItemId ? this.deps.stores.workItems.get(this.state.run.workItemId) : undefined;
  }

  /** Own artifacts + every ancestor's + every descendant's, newest version per name. */
  async visibleArtifacts(): Promise<Map<string, Artifact>> {
    const all: Artifact[] = [];
    const seen = new Set<string>();
    const collect = async (state: RunState, direction: "up" | "down" | "both") => {
      if (seen.has(state.run.id)) return;
      seen.add(state.run.id);
      all.push(...Object.values(state.artifacts));
      if ((direction === "up" || direction === "both") && state.run.parentRunId) {
        await collect(await this.deps.loadState(state.run.parentRunId), "up");
      }
      if (direction === "down" || direction === "both") {
        for (const s of Object.values(state.steps)) for (const c of s.childRunIds) await collect(await this.deps.loadState(c), "down");
      }
    };
    await collect(this.state, "both");
    const map = new Map<string, Artifact>();
    for (const a of all) {
      const cur = map.get(a.name);
      if (!cur || cur.version < a.version || (cur.version === a.version && cur.createdAt < a.createdAt)) map.set(a.name, a);
    }
    return map;
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
    const artifacts: Record<string, ArtifactView> = {};
    const byKind: Record<string, ArtifactView> = {};
    for (const [name, a] of visible) {
      const view: ArtifactView = { ...a, content: await this.deps.stores.artifacts.content(a.id).catch(() => "") };
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
      run: { id: this.id, workflowId: this.state.run.workflowId, status: this.state.run.status, parentRunId: this.state.run.parentRunId, vars },
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

  static artifactsByName = artifactsByName;
}
