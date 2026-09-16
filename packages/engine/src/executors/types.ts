/**
 * Node executors - one per node type. The orchestrator schedules a step,
 * builds a StepContext and calls the executor; the executor does the work and
 * returns an outcome. Custom node types (`custom:<name>`) plug in here.
 */
import type { AgentRegistry, AgentSession } from "@orca/agents";
import type { Artifact, ArtifactRef, ArtifactSpec, Clock, Logger, NodeDef, OrcaEventInput, StepResult, StepRun, TemplateRegistry, WorkflowDefinition, WorkflowGraph, WorkflowRegistry, Workspace } from "@orca/core";
import type { Stores } from "@orca/store";
import type { HumanInputPort } from "../human-input.js";
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

  /** Append an event for this run (id/seq/at assigned by the store). */
  emit<E extends OrcaEventInput>(event: Omit<E, "runId">): Promise<void>;
  /** Expression/template context for this step. */
  evalContext(extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Evaluate an expression against the step context. */
  evaluate(expr: string, extra?: Record<string, unknown>): Promise<unknown>;
  /** Render a template body against the step context. */
  render(body: string, extra?: Record<string, unknown>): Promise<string>;
  /** Resolve input artifact refs (own run + ancestors + descendants). */
  resolveInputs(refs: ArtifactRef[]): Promise<ResolvedArtifact[]>;
  /** Record a produced artifact (stores content, emits artifact.recorded). */
  recordArtifact(spec: ArtifactSpec, content: string, extra?: { path?: string; parents?: string[]; agentSessionId?: string; agentId?: string }): Promise<Artifact>;
  /** Spawn a child run for a nested graph or registered workflow and wait for it. */
  runChild(target: { workflow: string } | { graph: WorkflowGraph; inlineId: string }, options: { vars?: Record<string, unknown>; branch?: string; workspace?: Workspace; workItemId?: string }): Promise<import("@orca/core").RunState>;
  /** Obtain an ACP session for an agent (honours sessionMode). */
  openSession(selector: import("@orca/core").AgentSelector): Promise<{ session: AgentSession; release: () => Promise<void> }>;
}

export interface NodeExecutor<N extends NodeDef = NodeDef> {
  readonly type: N["type"];
  execute(ctx: StepContext & { node: N }): Promise<StepOutcome>;
}

export class NodeExecutorRegistry {
  private readonly executors = new Map<string, NodeExecutor>();
  register<N extends NodeDef>(executor: NodeExecutor<N>): this {
    this.executors.set(executor.type, executor as unknown as NodeExecutor);
    return this;
  }
  get(type: string): NodeExecutor | undefined {
    return this.executors.get(type);
  }
  types(): string[] {
    return [...this.executors.keys()];
  }
}

export const completed = (result: Partial<StepResult> = {}): StepOutcome => ({ kind: "completed", result: { artifactIds: [], data: {}, ...result } });
export const failed = (code: string, message: string, details?: Record<string, unknown>, retryable = false): StepOutcome => ({ kind: "failed", error: details ? { code, message, details } : { code, message }, retryable });
export const paused = (reason: string, details?: Record<string, unknown>): StepOutcome => ({ kind: "paused", reason, ...(details ? { details } : {}) });
