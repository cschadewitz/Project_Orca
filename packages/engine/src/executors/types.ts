/**
 * Node executors - one per node type. The orchestrator schedules a step,
 * builds a StepContext and calls the executor; the executor does the work and
 * returns an outcome. Custom node types (`custom:<name>`) plug in here.
 */
import type { AgentRegistry, AgentSession } from "@orca/agents";
import type {
  Artifact,
  ArtifactRef,
  ArtifactSpec,
  Clock,
  Logger,
  NodeDef,
  NodeValidation,
  OrcaEventInput,
  StepResult,
  StepRun,
  TemplateRegistry,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowRegistry,
  Workspace,
} from "@orca/core";
import type { Stores } from "@orca/store";
import type { HumanInputPort } from "../human-input.js";
import type { PlanService } from "../plan/service.js";
import type { RunContext } from "../run-context.js";

export interface ResolvedArtifact extends Artifact {
  content: string;
}

export type StepOutcome =
  | { kind: "completed"; result: StepResult }
  | { kind: "failed"; error: { code: string; message: string; details?: Record<string, unknown> }; retryable?: boolean }
  /** The step cannot finish in this process (a human must answer, or a child run parked); the run is paused and re-attempts the node on resume. */
  | { kind: "paused"; reason: string; details?: Record<string, unknown> };

/** Everything an executor may need. Kept as an interface so tests can stub it. */
export interface StepContext {
  /** Runtime binds these to the exact durable gate and reserved destination step under its lease. */
  declareRevision?: (query: import("../human-input.js").HumanInputQuery) => Promise<void>;
  revisionInput?: {
    claim(
      render: (slot: import("../revision-delivery.js").RevisionSlot) => Promise<string>,
    ): Promise<import("../revision-delivery.js").RevisionHandoff>;
    beforeSend(handoff: import("../revision-delivery.js").RevisionHandoff): Promise<void>;
    confirm(handoff: import("../revision-delivery.js").RevisionHandoff): Promise<void>;
    uncertain(handoff: import("../revision-delivery.js").RevisionHandoff): Promise<void>;
  };
  readonly run: RunContext;
  readonly step: StepRun;
  readonly nodeId: string;
  readonly node: NodeDef;
  readonly definition: WorkflowDefinition;
  readonly workspace: Workspace;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly stores: Stores;
  readonly agents: AgentRegistry;
  readonly templates: TemplateRegistry;
  readonly workflows: WorkflowRegistry;
  readonly humanInput: HumanInputPort;
  /** Long-term plan: dependencies, risks, decisions, schedule. */
  readonly plan: PlanService;

  /** Append an event for this run (id/seq/at assigned by the store). */
  emit<E extends OrcaEventInput>(event: Omit<E, "runId">): Promise<void>;
  /** Expression/template context for this step. */
  evalContext(extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Evaluate an expression against the step context. */
  evaluate(expr: string, extra?: Record<string, unknown>): Promise<unknown>;
  /** Render a template body against the step context. */
  render(body: string, extra?: Record<string, unknown>): Promise<string>;
  /**
   * Resolve input artifact refs (own run + ancestors + descendants). The result
   * is aligned with `refs`: entry `i` is the artifact for `refs[i]`, or
   * `undefined` when an optional ref did not resolve. Required refs that are
   * missing throw ARTIFACT_MISSING.
   */
  resolveInputs(refs: ArtifactRef[]): Promise<(ResolvedArtifact | undefined)[]>;
  /** Record a produced artifact (stores content, emits artifact.recorded). */
  recordArtifact(
    spec: ArtifactSpec,
    content: string,
    extra?: { path?: string; parents?: string[]; agentSessionId?: string; agentId?: string },
  ): Promise<Artifact>;
  /**
   * Spawn a child run for a nested graph or registered workflow and wait for it. `branch` is
   * the child's stable key within the step (iteration index, branch name, work-item slug):
   * when this step is a re-attempt after an interruption, a child the previous attempt
   * spawned under the same key is resumed/reused instead of being spawned again.
   *
   * `signal` cancels just this child (the returned state is then `cancelled`), which is how
   * a container abandons siblings whose result can no longer change its own outcome; the
   * parent run's own signal always cancels every child it spawned.
   */
  runChild(
    target: { workflow: string } | { graph: WorkflowGraph; inlineId: string },
    options: {
      vars?: Record<string, unknown>;
      branch?: string;
      workspace?: Workspace;
      workItemId?: string;
      signal?: AbortSignal;
      /** Selection for the child; it inherits the parent run's overrides when absent. */
      overrides?: import("@orca/core").RunOverrides;
    },
  ): Promise<import("@orca/core").RunState>;
  /** Obtain an ACP session for an agent (honours sessionMode). */
  openSession(
    selector: import("@orca/core").AgentSelector,
  ): Promise<{ session: AgentSession; release: () => Promise<void> }>;
}

export interface NodeExecutor<N extends NodeDef = NodeDef> {
  readonly type: N["type"];
  execute(ctx: StepContext & { node: N }): Promise<StepOutcome>;
  /**
   * Check a node of this type at load time (#308). `validateWorkflow` calls it for every
   * `custom:*` node whose executor is registered, so `orca validate` and bootstrap reject a
   * malformed node before any agent has spent a turn. The core schema keeps custom nodes
   * loose, so `node` is the raw definition: parse it here the way `execute` does. Errors
   * block; warnings inform. Issue paths are relative to the node (`.rubric`).
   */
  validate?(node: N): NodeValidation;
}

export class NodeExecutorRegistry {
  private readonly executors = new Map<string, NodeExecutor>();
  register<N extends NodeDef>(executor: NodeExecutor<N>): this {
    this.executors.set(executor.type, executor);
    return this;
  }
  get(type: string): NodeExecutor | undefined {
    return this.executors.get(type);
  }
  types(): string[] {
    return [...this.executors.keys()];
  }
  /**
   * The `validateCustomNode` hook for a `ValidationContext`: the node's executor checks its
   * fields. A type nobody registered is a warning, not an error - the run would fail at that
   * node with NOT_SUPPORTED, but a validation pass without the plugin loaded (`orca validate
   * <file>` against another config) should say what it could not check rather than refuse.
   */
  validateNode(node: NodeDef): NodeValidation | undefined {
    const executor = this.executors.get(node.type);
    if (!executor)
      return { warnings: [{ message: `no executor is registered for '${node.type}'; its fields were not checked` }] };
    return executor.validate?.(node);
  }
}

export const completed = (result: Partial<StepResult> = {}): StepOutcome => ({
  kind: "completed",
  result: { artifactIds: [], data: {}, ...result },
});
export const failed = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryable = false,
): StepOutcome => ({ kind: "failed", error: details ? { code, message, details } : { code, message }, retryable });
export const paused = (reason: string, details?: Record<string, unknown>): StepOutcome => ({
  kind: "paused",
  reason,
  ...(details ? { details } : {}),
});
