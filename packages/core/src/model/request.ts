/**
 * Requests and work items - the "level above" the SDLC loop.
 *
 * A Request is a large feature or system ask. ORCA decomposes it into a tree of
 * WorkItems (epic -> feature -> task) with dependencies; each leaf work item is
 * driven through an SDLC workflow run.
 */
import { z } from "zod";

export const RequestSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("issue"), url: z.string(), provider: z.string().optional() }),
  z.object({ kind: z.literal("kepler-task"), taskId: z.string(), taskDir: z.string().optional() }),
  z.object({ kind: z.literal("t3code-thread"), threadId: z.string(), projectId: z.string().optional() }),
  z.object({ kind: z.literal("acp-session"), sessionId: z.string() }),
  z.object({ kind: z.literal("api"), clientId: z.string().optional() }),
]);
export type RequestSource = z.infer<typeof RequestSourceSchema>;

export const RequestStatusSchema = z.enum(["new", "decomposing", "in-progress", "blocked", "completed", "failed", "cancelled"]);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const RequestSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  body: z.string(),
  source: RequestSourceSchema.default({ kind: "manual" }),
  status: RequestStatusSchema.default("new"),
  /** Program-level run driving this request, once started. */
  programRunId: z.string().optional(),
  labels: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Request = z.infer<typeof RequestSchema>;

export const WorkItemKindSchema = z.enum(["epic", "feature", "task", "spike"]);
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>;

export const WorkItemStatusSchema = z.enum(["pending", "ready", "in-progress", "blocked", "done", "failed", "cancelled"]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkItemSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  parentId: z.string().optional(),
  /** Stable, human-readable key from the decomposition (e.g. "auth-api"). Used in artifact paths and branch names. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  description: z.string().default(""),
  kind: WorkItemKindSchema.default("task"),
  acceptanceCriteria: z.array(z.string()).default([]),
  /** Slugs (or ids) of work items that must be done first. */
  dependsOn: z.array(z.string()).default([]),
  /** Workflow to run for this item; defaults to the program's `itemWorkflow`. */
  workflowId: z.string().optional(),
  /** Repository / workspace hints for the workspace provider. */
  repo: z.string().optional(),
  status: WorkItemStatusSchema.default("pending"),
  runId: z.string().optional(),
  estimate: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

/** The shape ORCA expects in a `decomposition` artifact's front matter. */
export const DecompositionItemSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  description: z.string().default(""),
  kind: WorkItemKindSchema.default("task"),
  acceptanceCriteria: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  parent: z.string().optional(),
  repo: z.string().optional(),
  workflow: z.string().optional(),
  estimate: z.string().optional(),
});
export type DecompositionItem = z.infer<typeof DecompositionItemSchema>;

export const DecompositionSchema = z.object({
  items: z.array(DecompositionItemSchema).min(1),
  rationale: z.string().optional(),
});
export type Decomposition = z.infer<typeof DecompositionSchema>;
