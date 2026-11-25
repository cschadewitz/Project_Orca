/**
 * Requests and work items - the "level above" the SDLC loop.
 *
 * A Request is a large feature or system ask. ORCA decomposes it into a tree of
 * WorkItems (epic -> feature -> task) with dependencies; each leaf work item is
 * driven through an SDLC workflow run.
 */
import { z } from "zod";
import { RunOverridesSchema } from "./run.js";
import type { MutationActor } from "../events/events.js";
import type { OrcaErrorCode } from "../errors.js";
import {
  DecisionInputSchema,
  DependencyRefSchema,
  StoredDependencyRefSchema,
  RiskInputSchema,
  WorkItemPrioritySchema,
} from "./plan.js";

export const RequestSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("issue"), url: z.string(), provider: z.string().optional() }),
  z.object({ kind: z.literal("kepler-task"), taskId: z.string(), taskDir: z.string().optional() }),
  z.object({ kind: z.literal("t3code-thread"), threadId: z.string(), projectId: z.string().optional() }),
  z.object({ kind: z.literal("acp-session"), sessionId: z.string() }),
  z.object({ kind: z.literal("api"), clientId: z.string().optional() }),
]);
export type RequestSource = z.infer<typeof RequestSourceSchema>;

/** Legacy v1 correlation name, reserved against caller spoofing; new launches use out-of-band metadata. */
export const SUBMISSION_CORRELATION_VAR = "__orcaAdmissionId"; // rename-keep: variable recorded in stored runs

/** A new Request, never a caller-selected association or execution identity. */
export const SubmissionCommandSchema = z.strictObject({
  title: z.string().trim().min(1),
  body: z.string(),
  source: RequestSourceSchema.optional(),
  labels: z.array(z.string()).optional(),
  workflowId: z.string().min(1).optional(),
  workflowVersion: z.string().min(1).optional(),
  expectedWorkflowRevision: z.string().min(1).optional(),
  expectedConfigGeneration: z.string().min(1).optional(),
  vars: z
    .record(z.string(), z.unknown())
    .refine((vars) => !Object.hasOwn(vars, "request") && !Object.hasOwn(vars, SUBMISSION_CORRELATION_VAR), {
      message: "request and admission correlation are supplied by the submission service",
    })
    .optional(),
  overrides: RunOverridesSchema.optional(),
});
export type SubmissionCommand = z.infer<typeof SubmissionCommandSchema>;

export type SubmissionResult =
  | { state: "prepared"; admissionId: string; requestId: string }
  | { state: "accepted"; admissionId: string; requestId: string; runId: string }
  | {
      state: "recoverable-failure";
      admissionId: string;
      requestId: string;
      runId?: string;
      failure: { code: OrcaErrorCode; message: string; recovery: "reconcile" };
    };

/** Verified server-side authority. Rechecks must consult live grants/revocation. */
export interface SubmissionAuthority {
  readonly workspaceId: string;
  readonly actor: MutationActor;
  authorize(this: void, command: SubmissionCommand): Promise<void>;
  onRunAdmitted(this: void, runId: string): Promise<void>;
  /** Verify existing exact durable ownership without attributing or repairing it. */
  verifyRunAdmitted?(runId: string): Promise<void>;
}

export interface SubmissionService {
  submit(
    command: SubmissionCommand,
    authority: SubmissionAuthority,
    retry?: import("./admission-retry.js").RetryOptions,
  ): Promise<SubmissionResult>;
  reconcile(admissionId: string, authority: SubmissionAuthority): Promise<SubmissionResult>;
  inspect(admissionId: string, authority: SubmissionAuthority): Promise<SubmissionResult>;
  list(authority: SubmissionAuthority): Promise<SubmissionResult[]>;
}

export const RequestStatusSchema = z.enum([
  "new",
  "decomposing",
  "in-progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
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

export const WorkItemStatusSchema = z.enum([
  "pending",
  "ready",
  "in-progress",
  "blocked",
  "done",
  "failed",
  "cancelled",
]);
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
  /**
   * Dependency references as written in the decomposition (see `parseDependencyRef`).
   * Once the item is registered in a Plan, `Dependency` records are the source of truth.
   */
  dependsOn: z.array(StoredDependencyRefSchema).default([]),
  /** Workflow to run for this item; defaults to the program's `itemWorkflow`. */
  workflowId: z.string().optional(),
  /** Repository / workspace hints for the workspace provider. */
  repo: z.string().optional(),
  status: WorkItemStatusSchema.default("pending"),
  runId: z.string().optional(),
  estimate: z.string().optional(),
  /** Plan this item is tracked in (set by `custom:plan-register`). */
  planId: z.string().optional(),
  priority: WorkItemPrioritySchema.default("normal"),
  /** Artifact kind -> newest artifact id produced by this item's runs. Drives stage-level dependencies. */
  produced: z.record(z.string(), z.string()).default({}),
  /** Why the item is not being dispatched right now (waiting on another request, held for risk, ...). */
  deferredReason: z.string().optional(),
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
  dependsOn: z.array(DependencyRefSchema).default([]),
  parent: z.string().optional(),
  repo: z.string().optional(),
  workflow: z.string().optional(),
  estimate: z.string().optional(),
  priority: WorkItemPrioritySchema.default("normal"),
  /** Risk keys (declared in `risks`) this item is exposed to. */
  risks: z.array(z.string()).default([]),
});
export type DecompositionItem = z.infer<typeof DecompositionItemSchema>;
export type DecompositionItemInput = z.input<typeof DecompositionItemSchema>;

export const DecompositionSchema = z.object({
  items: z.array(DecompositionItemSchema).min(1),
  rationale: z.string().optional(),
  /** Risks the planner already sees; refined later by the risk assessment step. */
  risks: z.array(RiskInputSchema).default([]),
  /** Decisions that must be made before some items can start (`blocks` lists their slugs). */
  decisions: z.array(DecisionInputSchema).default([]),
});
export type Decomposition = z.infer<typeof DecompositionSchema>;
