/**
 * `workflows.list` and `workflows.get` - the two methods the workflow viewer (#177) reads,
 * and the shapes it draws a graph from.
 *
 * These are *display* read models like everything else here, not `WorkflowDefinition` on the
 * wire (ADR 0008). The difference is concentrated in the node: a `NodeDef` is a
 * discriminated union of ten types whose bodies carry nested graphs, artifact specs and
 * completion policies, and a client that received it whole would be re-implementing the
 * engine's model in order to draw nine boxes. A `WorkflowNodeView` instead carries the node's
 * identity and type as first-class fields and everything else as `fields`: a flat,
 * display-shaped record of exactly the configuration the viewer shows per node type
 * (an agent's role and template, a decision's source, a gate's options, a loop's bounds, a
 * subworkflow's target). `fields` is `unknown`-valued on purpose - a `custom:<name>` node is
 * a plugin's, and the protocol has nothing true to say about its shape.
 *
 * **Nested graphs are inline *and* addressable.** A `loop`, a `parallel` or an inline
 * `subworkflow` body is a graph of its own, and it arrives as a nested `WorkflowView` under
 * the node that holds it. Each one's `id` is the id the engine itself uses for it -
 * `parent::node`, or `parent::node::branch` for a named parallel branch - so a viewer may
 * either draw the nested graph it already has or fetch it again with `workflows.get`, and
 * both routes name the same graph. These graphs are small (the shipped `ai-sdlc` is sixteen
 * nodes) and a run overlay needs the whole of one, so the wire carries them rather than
 * making the collapse control a round trip.
 */
import { z } from "zod";

export const WORKFLOWS_LIST_METHOD = "workflows.list";
export const WORKFLOWS_GET_METHOD = "workflows.get";

/**
 * The separator in an inline graph's id: `ai-sdlc::review-loop`, and
 * `program::fanout::analysis` for one named branch of a `parallel`. It is the engine's own
 * spelling (`Orchestrator.resolveDefinition`), published here so a client can build the id
 * of a nested graph it wants to fetch rather than parsing one it was given.
 */
export const INLINE_WORKFLOW_SEPARATOR = "::";

/** One edge, as the canvas draws it. `when` is ORCA's expression language, shown verbatim. */
export const WorkflowEdgeViewSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** The condition this edge is taken under; absent means the default edge. */
  when: z.string().optional(),
  /** The author's words for the edge, when they wrote any - the label the canvas prints. */
  label: z.string().optional(),
});
export type WorkflowEdgeView = z.infer<typeof WorkflowEdgeViewSchema>;

/**
 * One node, as the canvas draws it and the inspector lists it.
 *
 * `type` is the node type verbatim, which is one of the nine the design system has an icon
 * for or a `custom:<name>` a plugin registered; a client that does not know a type draws the
 * generic node rather than dropping it.
 *
 * `fields` is the per-type configuration, flattened for display and never the node's whole
 * record: the base fields (`name`, `description`, `meta`) are lifted out or dropped, and a
 * nested graph is replaced by the `nested` entry that carries it. What each type puts there
 * today:
 *
 * | type | `fields` |
 * | --- | --- |
 * | `start` | nothing |
 * | `end` | `outcome`, `message?` |
 * | `agent` | `role?` / `agentId?`, `template?`, `prompt?`, `inputs`, `produces`, `completion` |
 * | `decision` | `source`, `options`, `defaultOption?` |
 * | `gate` | `question`, `options`, `autoApproveWhen?`, `autoOption?` |
 * | `set` | `vars` |
 * | `loop` | `mode`, `condition?`, `items?`, `itemVar`, `indexVar`, `maxIterations`, `breakOnFailure`, `workflow?` |
 * | `parallel` | `concurrency`, `join`, `failFast`, `branches?`, `forEach?` |
 * | `subworkflow` | `workflow`, `vars` |
 * | `custom:*` | whatever the plugin's node carries, minus the base fields |
 *
 * `workflow` on a container is the id of a *registered* workflow it delegates to; a container
 * whose body is written inline has a `nested` graph instead, and one may have neither
 * (a `parallel` that picks its workflow per item with an expression).
 */
export interface WorkflowNodeView {
  id: string;
  type: string;
  /** The author's name for the node. Absent means the canvas prints the id. */
  name?: string;
  description?: string;
  /** The per-type configuration, display-shaped. See the table above. */
  fields: Record<string, unknown>;
  /** The whole-step retry budget, when this node sets one (`retryBudget`). */
  maxAttempts?: number;
  /**
   * The graphs written inline inside this node - a loop body, a `forEach` body, one per
   * named `parallel` branch. Each carries its own `parent::node` id, so a viewer that
   * collapses them can re-fetch one by id instead of holding it.
   */
  nested?: WorkflowView[];
}

/**
 * One workflow, whole: what `workflows.get` answers and what a nested graph arrives as.
 *
 * `versions` is on the top-level view only; a nested graph has no version of its own -
 * it is part of its parent's file and is stamped with the parent's version.
 */
export interface WorkflowView {
  /** The workflow id, or `parent::node` for a graph written inline inside one. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** The node the run enters at. */
  start: string;
  /** Documented inputs (name → description); informational, shown by the run-start form. */
  inputs?: Record<string, string>;
  /** The workflow's default `vars`, before a run's inputs override them. */
  vars?: Record<string, unknown>;
  nodes: WorkflowNodeView[];
  edges: WorkflowEdgeView[];
  /**
   * Every version of this workflow the daemon can *see*, oldest first: the version on disk,
   * every version kept in the store's workflow-version store (#179: `startRun` keeps the
   * definition each run started on), and every version a run in this store recorded on
   * `run.created`. A version that only a pre-v0.6.0 run recorded may have no stored
   * definition, so `workflows.get({ id, version })` answers for the stored ones and the one
   * on disk, and `WORKFLOW_VERSION_NOT_FOUND` for the rest.
   *
   * Absent on a nested graph.
   */
  versions?: string[];
  /**
   * This view is of a version other than the one on disk: a stored definition a run is pinned
   * to (`◷ pinned`, docs/design/70-workflow-editing.md). Absent on a nested graph.
   */
  pinned?: boolean;
}

export const WorkflowNodeViewSchema: z.ZodType<WorkflowNodeView> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    fields: z.record(z.string(), z.unknown()),
    maxAttempts: z.number().int().positive().optional(),
    nested: z.array(WorkflowViewSchema).optional(),
  }),
) as unknown as z.ZodType<WorkflowNodeView>;

export const WorkflowViewSchema: z.ZodType<WorkflowView> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    start: z.string(),
    inputs: z.record(z.string(), z.string()).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    nodes: z.array(WorkflowNodeViewSchema),
    edges: z.array(WorkflowEdgeViewSchema),
    versions: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
  }),
) as unknown as z.ZodType<WorkflowView>;

/**
 * One workflow as a row: the picker, the viewer's workflow list, and the run-start form's
 * choices (#178).
 *
 * There is deliberately no "shipped or user-defined" flag. A daemon loads every workflow
 * from the glob in `orca.config.yaml` into one registry, which keeps the id, the name and
 * the graph and not the path it came from - so the daemon cannot tell the two apart, and a
 * field that guessed would be wrong for anyone who copied `ai-sdlc.yaml` into their own
 * workspace and edited it. It is an omission, not an oversight.
 */
export const WorkflowSummaryViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The version on disk right now. `versions` on `workflows.get` says which others have run. */
  version: z.string(),
  description: z.string().optional(),
  /** How many nodes the top-level graph has. Nodes inside a nested graph are not counted. */
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  /** The node a run enters at. */
  start: z.string(),
});
export type WorkflowSummaryView = z.infer<typeof WorkflowSummaryViewSchema>;

export const WorkflowsListParamsSchema = z.object({});
export type WorkflowsListParams = z.infer<typeof WorkflowsListParamsSchema>;

export const WorkflowsListResultSchema = z.object({
  /** Every workflow the daemon has registered, by id. */
  workflows: z.array(WorkflowSummaryViewSchema),
  asOf: z.string(),
});
export type WorkflowsListResult = z.infer<typeof WorkflowsListResultSchema>;

export const WorkflowsGetParamsSchema = z.object({
  /**
   * A registered workflow's id, or an inline graph's `parent::node` (`parent::node::branch`
   * for a named `parallel` branch).
   */
  id: z.string().min(1),
  /**
   * The version to return: the one on disk, or one kept in the workflow-version store (#179).
   * Anything else answers `WORKFLOW_VERSION_NOT_FOUND`, with the versions that exist in the
   * details, rather than a graph that is not the one asked for.
   */
  version: z.string().min(1).optional(),
});
export type WorkflowsGetParams = z.infer<typeof WorkflowsGetParamsSchema>;

export const WorkflowsGetResultSchema = z.object({
  workflow: WorkflowViewSchema,
  asOf: z.string(),
});
export type WorkflowsGetResult = z.infer<typeof WorkflowsGetResultSchema>;
