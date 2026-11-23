/**
 * Workflow drafts (#180): a person's copy of one workflow that the visual editor (#181)
 * changes, the validation the panel shows (#182), and an explicit, reviewed publish.
 *
 * **Editing never touches the live file.** A draft is the workflow's YAML text plus a
 * change history, kept beside the workflow in `.drafts/`; every operation edits that text
 * through the `yaml` package's comment-preserving document, so a published change reads in
 * a diff exactly as the same hand edit would. Publishing writes the file, bumps its
 * version, and activates a configuration generation - runs already started stay pinned to
 * the version they began on (#179).
 *
 * **Layout is metadata, not semantics.** Where a person dragged a node is kept in a
 * separate layout record (`.layout/<id>.json` once published) and never in the workflow
 * file, so a drag never shows in a workflow diff and a hand-written workflow with no layout
 * still draws - unpinned nodes are placed by the client's automatic layout.
 *
 * **Every mutation names the revision it was made against.** `expectedRevision` is the
 * draft's monotonic counter; a second window or client editing the same draft is refused
 * with `CONFIG_STALE` rather than silently overwritten. Publish additionally names the
 * `reviewToken` of the exact preview the person confirmed, which binds the draft revision
 * and the base file it was reviewed against.
 */
import { z } from "zod";
import { ConfigApplyResultSchema } from "./config.js";
import { WorkflowDraftDryRunParamsSchema, WorkflowDraftDryRunResultSchema } from "./dry-run.js";

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]*$/;
const NODE_ID = /^[A-Za-z0-9_-]+$/;
const workflowId = z.string().regex(WORKFLOW_ID).max(128);
const nodeId = z.string().regex(NODE_ID).max(128);
const revision = z.number().int().nonnegative();

/**
 * One step into a nested inline graph. A `loop`'s body has no branch; a `parallel` node's
 * named branch is `branch`; a `parallel` node's `forEach` body is `forEach: true`.
 */
export const DraftGraphStepSchema = z.strictObject({
  node: nodeId,
  branch: nodeId.optional(),
  forEach: z.literal(true).optional(),
});
export type DraftGraphStep = z.infer<typeof DraftGraphStepSchema>;
/** Root when empty or absent. Bounded: nothing in a real workflow nests deeper. */
export const DraftGraphPathSchema = z.array(DraftGraphStepSchema).max(8);
export type DraftGraphPath = z.infer<typeof DraftGraphPathSchema>;

/** The stable key a graph's layout is filed under: `""` for the root, `loop` / `fan[a]` / `fan[*]` below it. */
export function draftGraphKey(path: DraftGraphPath | undefined): string {
  return (path ?? [])
    .map((step) =>
      step.branch !== undefined ? `${step.node}[${step.branch}]` : step.forEach ? `${step.node}[*]` : step.node,
    )
    .join("/");
}

/** A node body as the YAML holds it: `type` plus whatever fields that type takes. */
const NodeBodySchema = z.record(z.string(), z.unknown()).refine((node) => typeof node.type === "string", {
  message: "a node needs a type",
});
const graph = DraftGraphPathSchema.optional();
const edgeIndex = z.number().int().nonnegative().max(10_000);
const expression = z.string().max(4_096);
const coordinate = z.number().finite().min(-100_000).max(100_000);

/**
 * The semantic editing operations (docs/design/70-workflow-editing.md). A batch applies in
 * order and either all of it lands, as one revision and one undo step, or none of it does.
 * Edges are addressed by their index in the graph's `edges` list as of the revision the
 * batch names, which is why the batch is revision-checked.
 */
/**
 * A workflow-level capability scope (#335), as the workflow schema takes it: narrow the
 * agent's set, or opt in to what the agent's scope lists as available. Shape only; the
 * daemon validates ids against the catalog and the agent when it validates the draft.
 */
const draftCapabilityId = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const draftCapabilityIds = z.array(draftCapabilityId).max(256);
const DraftCapabilitySelectionSchema = z.strictObject({
  replace: draftCapabilityIds.optional(),
  enable: draftCapabilityIds.optional(),
  disable: draftCapabilityIds.optional(),
});
export const DraftCapabilityScopeSchema = z.strictObject({
  mcpServers: DraftCapabilitySelectionSchema.optional(),
  skills: DraftCapabilitySelectionSchema.optional(),
});
export type DraftCapabilityScope = z.infer<typeof DraftCapabilityScopeSchema>;

export const DraftOperationSchema = z.discriminatedUnion("op", [
  /** A new node. `id` is the person's or a generated name; the inspector renames it. */
  z.strictObject({ op: z.literal("addNode"), graph, id: nodeId, node: NodeBodySchema }),
  /** A new node dropped onto an edge: `from → id → to`, the edge's condition kept on its first half. */
  z.strictObject({ op: z.literal("insertNode"), graph, id: nodeId, node: NodeBodySchema, edge: edgeIndex }),
  /** Field edits on one node. `set` replaces each named top-level field; `unset` removes them. */
  z.strictObject({
    op: z.literal("updateNode"),
    graph,
    id: nodeId,
    set: z.record(z.string(), z.unknown()).optional(),
    unset: z.array(z.string().min(1)).max(64).optional(),
  }),
  /** Every edge and the graph's `start` follow the new name. */
  z.strictObject({ op: z.literal("renameNode"), graph, id: nodeId, to: nodeId }),
  /** Fields the new type does not use are kept in the draft and flagged by validation, never dropped. */
  z.strictObject({ op: z.literal("changeType"), graph, id: nodeId, type: z.string().min(1).max(64) }),
  /**
   * Delete a node. Its edges stay, dangling, and validation names them - the design's rule,
   * so a removal never silently reroutes the graph. `detach` removes them too, for the
   * explicit "delete with its connections" gesture.
   */
  z.strictObject({ op: z.literal("removeNode"), graph, id: nodeId, detach: z.boolean().optional() }),
  /** File order, which is list order; it is not execution order and edges do not change. */
  z.strictObject({ op: z.literal("moveNode"), graph, id: nodeId, before: nodeId.optional() }),
  z.strictObject({
    op: z.literal("addEdge"),
    graph,
    from: nodeId,
    to: nodeId,
    when: expression.optional(),
    label: z.string().max(256).optional(),
  }),
  /** `null` removes `when` or `label`. */
  z.strictObject({
    op: z.literal("updateEdge"),
    graph,
    index: edgeIndex,
    from: nodeId.optional(),
    to: nodeId.optional(),
    when: expression.nullable().optional(),
    label: z.string().max(256).nullable().optional(),
  }),
  z.strictObject({ op: z.literal("removeEdge"), graph, index: edgeIndex }),
  z.strictObject({ op: z.literal("setStart"), graph, id: nodeId }),
  /**
   * The workflow's own name, description and (protocol 2.10, #335) capability scope. Its id is
   * fixed; its version is publish's. `null` removes `description` or `capabilities`.
   */
  z.strictObject({
    op: z.literal("setWorkflow"),
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(4_096).nullable().optional(),
    capabilities: DraftCapabilityScopeSchema.nullable().optional(),
  }),
  /** Pin a node where it was dropped. Layout only: the workflow text does not change. */
  z.strictObject({ op: z.literal("place"), graph, id: nodeId, x: coordinate, y: coordinate }),
  /** Hand a node back to the automatic layout. */
  z.strictObject({ op: z.literal("unpin"), graph, id: nodeId }),
  /** Unpin every node in one graph. */
  z.strictObject({ op: z.literal("tidy"), graph }),
]);
export type DraftOperation = z.infer<typeof DraftOperationSchema>;

/** Pinned positions, per graph key, per node id, in canvas units at zoom 1. */
export const DraftLayoutSchema = z.object({
  graphs: z.record(z.string(), z.record(z.string(), z.object({ x: z.number(), y: z.number() }))),
});
export type DraftLayout = z.infer<typeof DraftLayoutSchema>;

/**
 * One validation finding. Every row names where it is, so the panel can jump to it: the
 * graph, and the node or the edge when the finding is about one.
 */
export const DraftIssueSchema = z.object({
  severity: z.enum(["error", "warning", "note"]),
  message: z.string(),
  /** The validator's own path, for the person who wants to find it in the YAML. */
  path: z.string(),
  graph: DraftGraphPathSchema,
  node: z.string().optional(),
  edge: z.number().int().nonnegative().optional(),
});
export type DraftIssue = z.infer<typeof DraftIssueSchema>;

export const WorkflowDraftViewSchema = z.object({
  workflowId: z.string(),
  owner: z.object({
    principalId: z.string(),
    /** The caller made this draft. Anyone else sees it read-only. */
    you: z.boolean(),
  }),
  revision,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  base: z.object({
    version: z.string(),
    /** sha256 of the workflow file the draft was taken from. */
    revision: z.string(),
    /** False once the file on disk no longer matches: the draft cannot publish over it. */
    current: z.boolean(),
    text: z.string(),
    /** The base, parsed but not schema-defaulted, so a diff compares like with like. */
    document: z.unknown(),
  }),
  /** The draft's YAML, comments and all. */
  text: z.string(),
  /** The draft parsed as written, without schema defaults; absent while the YAML does not parse. */
  document: z.unknown().optional(),
  layout: DraftLayoutSchema,
  issues: z.array(DraftIssueSchema),
  /** Text or layout differ from the base. */
  dirty: z.boolean(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  /** Why publish is refused right now, in a sentence; absent when it is allowed. */
  publishBlocked: z.string().optional(),
});
export type WorkflowDraftView = z.infer<typeof WorkflowDraftViewSchema>;

const target = z.strictObject({ workflowId });
const mutation = z.strictObject({ workflowId, expectedRevision: revision });

export const WorkflowDraftGetResultSchema = z.object({
  /** The caller's own draft, or somebody else's read-only, or none. */
  draft: WorkflowDraftViewSchema.nullable(),
  /** The published layout, so the viewer and a new draft draw the same arrangement. */
  layout: DraftLayoutSchema,
  /** Whether this workflow can be edited here at all, and why not when it cannot. */
  editable: z.boolean(),
  reason: z.string().optional(),
});
export type WorkflowDraftGetResult = z.infer<typeof WorkflowDraftGetResultSchema>;

export const WorkflowDraftReviewSchema = z.object({
  revision,
  baseVersion: z.string(),
  nextVersion: z.string(),
  baseText: z.string(),
  /** Exactly the bytes publish will write. */
  text: z.string(),
  /** Binds publish to this preview: draft revision, base file and published text. */
  reviewToken: z.string(),
});
export type WorkflowDraftReview = z.infer<typeof WorkflowDraftReviewSchema>;

export const WorkflowDraftPublishResultSchema = z.object({
  workflowId: z.string(),
  version: z.string(),
  apply: ConfigApplyResultSchema,
});
export type WorkflowDraftPublishResult = z.infer<typeof WorkflowDraftPublishResultSchema>;

export const WORKFLOW_DRAFT_METHOD_CONTRACTS = {
  "workflowDrafts.get": { params: target, result: WorkflowDraftGetResultSchema },
  "workflowDrafts.open": { params: target, result: WorkflowDraftViewSchema },
  "workflowDrafts.apply": {
    params: mutation.extend({ ops: z.array(DraftOperationSchema).min(1).max(200) }),
    result: WorkflowDraftViewSchema,
  },
  "workflowDrafts.undo": { params: mutation, result: WorkflowDraftViewSchema },
  "workflowDrafts.redo": { params: mutation, result: WorkflowDraftViewSchema },
  "workflowDrafts.review": { params: mutation, result: WorkflowDraftReviewSchema },
  "workflowDrafts.publish": {
    params: mutation.extend({ reviewToken: z.string().min(1).max(128) }),
    result: WorkflowDraftPublishResultSchema,
  },
  "workflowDrafts.discard": {
    params: mutation,
    result: z.object({ discarded: z.literal(true) }),
  },
  /** Protocol 2.8 (#183): simulate this revision of the caller's draft; see dry-run.ts. */
  "workflowDrafts.dryRun": { params: WorkflowDraftDryRunParamsSchema, result: WorkflowDraftDryRunResultSchema },
} as const;
export type WorkflowDraftMethod = keyof typeof WORKFLOW_DRAFT_METHOD_CONTRACTS;
/** The draft reads; every other method in the table writes. */
export const WORKFLOW_DRAFT_READ_METHODS: readonly WorkflowDraftMethod[] = ["workflowDrafts.get"];
