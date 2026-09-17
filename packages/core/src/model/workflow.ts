/**
 * Workflow definitions - the user-authored graph of SDLC steps.
 *
 * A workflow is a directed graph. Nodes do work (agent steps), make choices
 * (decision / gate), repeat (loop), fan out (parallel), or delegate
 * (subworkflow). Edges connect nodes and may carry a `when` condition written
 * in ORCA's expression language (see expr/).
 *
 * Loops, parallel branches and sub-workflows embed *nested graphs*, which the
 * engine executes as child runs. This keeps the interpreter small and lets any
 * node type appear inside any container.
 */
import { z } from "zod";
import { AgentSelectorSchema } from "./agent.js";
import { ArtifactRefSchema, ArtifactSpecSchema } from "./artifact.js";

export const ConditionSchema = z.string().min(1);
export type Condition = z.infer<typeof ConditionSchema>;

const NodeBaseSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  /**
   * Whole-step retry budget: how many attempts the interpreter gives this node
   * when its executor reports a retryable failure. Any node type may set it -
   * agent nodes may instead use `completion.maxAttempts` (this wins if both are
   * set). Read it with `retryBudget()`.
   */
  maxAttempts: z.number().int().positive().optional(),
  /** Free-form extension data for plugins/UIs (position, colour, owner...). */
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const StartNodeSchema = NodeBaseSchema.extend({ type: z.literal("start") });
export type StartNode = z.infer<typeof StartNodeSchema>;

export const EndNodeSchema = NodeBaseSchema.extend({
  type: z.literal("end"),
  outcome: z.enum(["success", "failure", "cancelled"]).default("success"),
  message: z.string().optional(),
});
export type EndNode = z.infer<typeof EndNodeSchema>;

export const CompletionPolicySchema = z.object({
  /**
   * `turn-end`: the step is done when the agent finishes its prompt turn and
   *   the required artifacts exist (the orchestrator checks after the turn).
   * `artifact-present`: the step is done as soon as the required artifacts
   *   appear on disk, even mid-turn (the orchestrator then cancels the turn).
   *   Only `required: true` deliverables are watched; with none the mode is
   *   equivalent to `turn-end` (validation warns about that).
   */
  mode: z.enum(["turn-end", "artifact-present"]).default("turn-end"),
  /** If artifacts are missing/invalid after a turn, re-prompt this many times. */
  maxFollowUps: z.number().int().nonnegative().default(1),
  /** Whole-step retry budget (new session each time). */
  maxAttempts: z.number().int().positive().default(1),
  timeoutMs: z.number().int().positive().optional(),
});
export type CompletionPolicy = z.infer<typeof CompletionPolicySchema>;

export const AgentNodeSchema = NodeBaseSchema.extend({
  type: z.literal("agent"),
  agent: AgentSelectorSchema,
  /** Prompt template id (from the template registry) ... */
  template: z.string().optional(),
  /** ... or an inline template body. One of the two is required. */
  prompt: z.string().optional(),
  inputs: z.array(ArtifactRefSchema).default([]),
  produces: z.array(ArtifactSpecSchema).default([]),
  completion: CompletionPolicySchema.default({ mode: "turn-end", maxFollowUps: 1, maxAttempts: 1 }),
  /** Extra values exposed to the template as `vars.*` (evaluated as expressions when prefixed with `=`). */
  vars: z.record(z.string(), z.unknown()).default({}),
});
export type AgentNode = z.infer<typeof AgentNodeSchema>;

export const DecisionSourceSchema = z.discriminatedUnion("kind", [
  /** Evaluate an expression; its string/boolean result is the choice. */
  z.object({ kind: z.literal("expression"), expr: ConditionSchema }),
  /** Read a front-matter field from an artifact (e.g. review.verdict). */
  z.object({ kind: z.literal("artifact"), artifact: z.string(), field: z.string().default("choice") }),
  /** Ask an agent; it must produce a `decision` artifact with a `choice` field. */
  z.object({
    kind: z.literal("agent"),
    agent: AgentSelectorSchema,
    template: z.string().optional(),
    prompt: z.string().optional(),
    inputs: z.array(ArtifactRefSchema).default([]),
    produces: ArtifactSpecSchema.optional(),
    field: z.string().default("choice"),
  }),
  /** Ask a human through the HumanInputPort. */
  z.object({ kind: z.literal("human"), question: z.string() }),
]);
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

export const DecisionNodeSchema = NodeBaseSchema.extend({
  type: z.literal("decision"),
  source: DecisionSourceSchema,
  /** Allowed choices. Outgoing edges use `when: choice == '<option>'`. */
  options: z.array(z.string().min(1)).min(1),
  /** Used when the source yields something outside `options`. */
  defaultOption: z.string().optional(),
});
export type DecisionNode = z.infer<typeof DecisionNodeSchema>;

/** Sugar for a human decision (approval gate). */
export const GateNodeSchema = NodeBaseSchema.extend({
  type: z.literal("gate"),
  question: z.string(),
  options: z.array(z.string().min(1)).min(1).default(["approve", "reject"]),
  /** If set, the gate auto-resolves with this option when `autoApproveWhen` is truthy. */
  autoApproveWhen: ConditionSchema.optional(),
  autoOption: z.string().optional(),
});
export type GateNode = z.infer<typeof GateNodeSchema>;

export const SetNodeSchema = NodeBaseSchema.extend({
  type: z.literal("set"),
  /** Values may be expressions when prefixed with `=`, e.g. "=iteration + 1". */
  vars: z.record(z.string(), z.unknown()),
});
export type SetNode = z.infer<typeof SetNodeSchema>;

// Recursive definitions ----------------------------------------------------

export interface WorkflowGraph {
  start: string;
  nodes: Record<string, NodeDef>;
  edges: Edge[];
}

/** A nested graph (inline) or a reference to a registered workflow. */
export type SubworkflowRef = { workflow: string } | { graph: WorkflowGraph };

export interface LoopNode extends z.infer<typeof NodeBaseSchema> {
  type: "loop";
  mode: "while" | "until" | "forEach";
  condition?: Condition;
  items?: Condition;
  itemVar: string;
  indexVar: string;
  maxIterations: number;
  body: SubworkflowRef;
  /** Which child-run outcome should abort the loop early. Default: failure aborts. */
  breakOnFailure: boolean;
}

export interface ParallelNode extends z.infer<typeof NodeBaseSchema> {
  type: "parallel";
  branches?: Record<string, SubworkflowRef>;
  forEach?: { items: Condition; itemVar: string; indexVar: string; body: SubworkflowRef };
  concurrency: number;
  join: "all" | "any";
  /**
   * Stop as soon as one branch settles `join` — the first branch that fails under
   * `all`, the first that succeeds under `any`: pending branches are skipped and
   * running ones cancelled. Default: stop. A parked branch settles nothing.
   */
  failFast: boolean;
}

export interface SubworkflowNode extends z.infer<typeof NodeBaseSchema> {
  type: "subworkflow";
  workflow: string;
  /** Vars seeded into the child run (evaluated as expressions when prefixed with `=`). */
  vars: Record<string, unknown>;
}

export interface CustomNode extends z.infer<typeof NodeBaseSchema> {
  type: `custom:${string}`;
  [key: string]: unknown;
}

export type NodeDef =
  | z.infer<typeof StartNodeSchema>
  | z.infer<typeof EndNodeSchema>
  | AgentNode
  | DecisionNode
  | GateNode
  | SetNode
  | LoopNode
  | ParallelNode
  | SubworkflowNode
  | CustomNode;

export type NodeType = NodeDef["type"];

export interface Edge {
  from: string;
  to: string;
  when?: Condition;
  label?: string;
}

export const EdgeSchema: z.ZodType<Edge> = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  when: ConditionSchema.optional(),
  label: z.string().optional(),
}) as unknown as z.ZodType<Edge>;

export const SubworkflowRefSchema: z.ZodType<SubworkflowRef> = z.lazy(() =>
  z.union([z.object({ workflow: z.string().min(1) }), z.object({ graph: WorkflowGraphSchema })]),
) as unknown as z.ZodType<SubworkflowRef>;

export const LoopNodeSchema: z.ZodType<LoopNode> = z.lazy(() =>
  NodeBaseSchema.extend({
    type: z.literal("loop"),
    mode: z.enum(["while", "until", "forEach"]),
    condition: ConditionSchema.optional(),
    items: ConditionSchema.optional(),
    itemVar: z.string().default("item"),
    indexVar: z.string().default("index"),
    maxIterations: z.number().int().positive().default(10),
    body: SubworkflowRefSchema,
    breakOnFailure: z.boolean().default(true),
  }),
) as unknown as z.ZodType<LoopNode>;

export const ParallelNodeSchema: z.ZodType<ParallelNode> = z.lazy(() =>
  NodeBaseSchema.extend({
    type: z.literal("parallel"),
    branches: z.record(z.string(), SubworkflowRefSchema).optional(),
    forEach: z
      .object({
        items: ConditionSchema,
        itemVar: z.string().default("item"),
        indexVar: z.string().default("index"),
        body: SubworkflowRefSchema,
      })
      .optional(),
    concurrency: z.number().int().positive().default(4),
    join: z.enum(["all", "any"]).default("all"),
    failFast: z.boolean().default(true),
  }),
) as unknown as z.ZodType<ParallelNode>;

export const SubworkflowNodeSchema: z.ZodType<SubworkflowNode> = NodeBaseSchema.extend({
  type: z.literal("subworkflow"),
  workflow: z.string().min(1),
  vars: z.record(z.string(), z.unknown()).default({}),
}) as unknown as z.ZodType<SubworkflowNode>;

export const CustomNodeSchema: z.ZodType<CustomNode> = z
  .looseObject({ type: z.string().regex(/^custom:[a-z0-9][a-z0-9-]*$/) })
  .and(NodeBaseSchema) as unknown as z.ZodType<CustomNode>;

export const NodeDefSchema: z.ZodType<NodeDef> = z.lazy(() =>
  z.union([
    StartNodeSchema,
    EndNodeSchema,
    AgentNodeSchema,
    DecisionNodeSchema,
    GateNodeSchema,
    SetNodeSchema,
    LoopNodeSchema,
    ParallelNodeSchema,
    SubworkflowNodeSchema,
    CustomNodeSchema,
  ]),
) as unknown as z.ZodType<NodeDef>;

export const WorkflowGraphSchema: z.ZodType<WorkflowGraph> = z.lazy(() =>
  z.object({
    start: z.string().min(1),
    nodes: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), NodeDefSchema),
    edges: z.array(EdgeSchema).default([]),
  }),
) as unknown as z.ZodType<WorkflowGraph>;

export interface WorkflowDefinition extends WorkflowGraph {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Default values for `vars`. Overridden by run inputs. */
  vars: Record<string, unknown>;
  /** Documented inputs (name -> description); informational. */
  inputs: Record<string, string>;
  meta?: Record<string, unknown>;
}

export const WorkflowDefinitionSchema: z.ZodType<WorkflowDefinition> = z.lazy(() =>
  z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    version: z.string().default("1"),
    description: z.string().optional(),
    vars: z.record(z.string(), z.unknown()).default({}),
    inputs: z.record(z.string(), z.string()).default({}),
    meta: z.record(z.string(), z.unknown()).optional(),
    start: z.string().min(1),
    nodes: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), NodeDefSchema),
    edges: z.array(EdgeSchema).default([]),
  }),
) as unknown as z.ZodType<WorkflowDefinition>;

/**
 * Attempts the interpreter gives a node before a retryable failure fails the
 * run. Node-level `maxAttempts` wins; agent nodes fall back to their completion
 * policy; everything else runs once.
 */
export function retryBudget(n: NodeDef): number {
  if (typeof n.maxAttempts === "number") return n.maxAttempts;
  const completion = (n as Partial<AgentNode>).completion;
  return completion?.maxAttempts ?? 1;
}

export const CONTAINER_NODE_TYPES = ["loop", "parallel", "subworkflow"] as const;
export function isContainerNode(n: NodeDef): n is LoopNode | ParallelNode | SubworkflowNode {
  return (CONTAINER_NODE_TYPES as readonly string[]).includes(n.type);
}
