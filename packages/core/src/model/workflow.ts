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
import { GateOptionSchema } from "./run.js";
import { WorkflowInputSchemaSchema, type WorkflowInputSchema } from "./workflow-inputs.js";

// Typed launch inputs (#330). Re-exported here so they reach `@orca/core/schemas` with the model.
export * from "./workflow-inputs.js";
export { checkInputValue, validateWorkflowInputs, type WorkflowInputsResult } from "../workflow/inputs.js";

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
  /**
   * Read a field from an artifact's data (e.g. review.verdict). An exact top-level key
   * takes precedence; otherwise `field` is a dotted path (`answers.conflict.choice`) (#309).
   */
  z.object({ kind: z.literal("artifact"), artifact: z.string(), field: z.string().default("choice") }),
  /** Ask an agent; it must produce a `decision` artifact with a `choice` field (also a dotted path). */
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
  /**
   * Evaluate a `decision-matrix` artifact (weighted criteria x options). The
   * choice is the artifact's `chosen` option if valid, else the top-ranked one.
   * The decision is recorded in the Plan when the run belongs to one.
   */
  z.object({
    kind: z.literal("matrix"),
    artifact: z.string().default("decisionMatrix"),
    decision: z.string().optional(),
  }),
]);
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

export const DecisionNodeSchema = NodeBaseSchema.extend({
  type: z.literal("decision"),
  source: DecisionSourceSchema,
  /**
   * Allowed choices. Either a bare word - which reads as an option that is its own
   * id and label - or `{ id, label, consequence?, destructive? }`, so a workflow can
   * say what choosing one *does* and mark the one a UI must not make easy to hit
   * (docs/design/20-attention-and-gates.md, #247).
   *
   * Everything downstream compares the **id**: the source's result is matched
   * against the ids, `defaultOption` names one, and an outgoing edge's
   * `when: choice == '<option>'` is that id too. A label may therefore be reworded
   * without touching the graph or invalidating an answer already in a log.
   */
  options: z.array(GateOptionSchema).min(1),
  /** An option's `id`, used when the source yields something outside `options`. */
  defaultOption: z.string().optional(),
});
export type DecisionNode = z.infer<typeof DecisionNodeSchema>;

/** Sugar for a human decision (approval gate). */
export const GateNodeSchema = NodeBaseSchema.extend({
  type: z.literal("gate"),
  question: z.string(),
  /**
   * What the person is offered. As on a decision node: a bare word is an option that
   * is its own id and label, and the object form carries the consequence clause and
   * the `destructive` flag an attention card needs before it offers a choice (#247).
   * The answer recorded is the **id**, and that is what `autoOption` and an edge's
   * `when: choice == '<option>'` compare against.
   */
  options: z
    .array(GateOptionSchema)
    .min(1)
    .default([
      { id: "approve", label: "approve" },
      { id: "reject", label: "reject" },
    ]),
  /** If set, the gate auto-resolves with this option when `autoApproveWhen` is truthy. */
  autoApproveWhen: ConditionSchema.optional(),
  /** An option's `id`. Defaults to the first option's when `autoApproveWhen` fires. */
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

/**
 * Fan out over a list. Beyond the plain "one child per item" case, an item may carry a
 * stable identity (`key`), wait for its siblings (`dependsOn`), choose its own workflow
 * (`workflow`) and stand for a WorkItem (`workItemId`) - which is all the program level
 * needs to drive a decomposition through the SDLC loop without a bespoke fan-out node.
 * Every expression is evaluated per item with `itemVar`/`indexVar` in scope.
 */
export interface ParallelForEach {
  items: Condition;
  itemVar: string;
  indexVar: string;
  /** Stable branch key for this item (default: its index). Also the key `dependsOn` refers to. */
  key?: Condition;
  /** Branch keys that must succeed before this item starts; yields a string or string[]. */
  dependsOn?: Condition;
  /** Workflow id to run for this item instead of `body`, when it yields a non-empty string. */
  workflow?: Condition;
  /** WorkItem this item stands for; its child run is bound to that work item. */
  workItemId?: Condition;
  /** What to run per item. Optional only when `workflow` always resolves to an id. */
  body?: SubworkflowRef;
}

export interface ParallelNode extends z.infer<typeof NodeBaseSchema> {
  type: "parallel";
  branches?: Record<string, SubworkflowRef>;
  forEach?: ParallelForEach;
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
);

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
        key: ConditionSchema.optional(),
        dependsOn: ConditionSchema.optional(),
        workflow: ConditionSchema.optional(),
        workItemId: ConditionSchema.optional(),
        body: SubworkflowRefSchema.optional(),
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
  /** Vars handed to the child run (evaluated as expressions when prefixed with `=`). */
  vars: z.record(z.string(), z.unknown()).default({}),
});

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
);

export const WorkflowGraphSchema: z.ZodType<WorkflowGraph> = z.lazy(() =>
  z.object({
    start: z.string().min(1),
    nodes: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), NodeDefSchema),
    edges: z.array(EdgeSchema).default([]),
  }),
);

export interface WorkflowDefinition extends WorkflowGraph {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Default values for `vars`. Overridden by run inputs. */
  vars: Record<string, unknown>;
  /** Documented inputs (name -> description); informational. */
  inputs: Record<string, string>;
  /**
   * Typed launch-input declarations (#330), enforced when a run is admitted. Absent means the
   * legacy behaviour: `inputs` documents, nothing is checked. See docs/workflow-inputs.md.
   */
  inputSchema?: WorkflowInputSchema | undefined;
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
    inputSchema: WorkflowInputSchemaSchema.optional(),
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
