/**
 * Runtime state of a workflow execution.
 *
 * Runs and step runs are *projections* of the event log (see events/reduce.ts);
 * these types describe the read model the engine and UIs work with.
 */
import { z } from "zod";
import { ArtifactSchema } from "./artifact.js";

export const RunStatusSchema = z.enum(["created", "running", "waiting", "paused", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum(["scheduled", "running", "waiting", "completed", "failed", "cancelled", "skipped"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

export const RunOutcomeSchema = z.enum(["success", "failure", "cancelled"]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** Where the agents for this run do their work. */
export const WorkspaceSchema = z.object({
  hostId: z.string(),
  /** Absolute path on the host. */
  cwd: z.string(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  /** Provider that created it (git-worktree, kepler, t3code, ...). */
  provider: z.string().optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const StepResultSchema = z.object({
  /** For decision nodes / gates. */
  choice: z.string().optional(),
  /** Set by a terminal step (an `end` node, or any node type that ends the run): the run's outcome. */
  outcome: RunOutcomeSchema.optional(),
  /** Closing message for a terminal step, copied into `run.completed`. */
  message: z.string().optional(),
  /** Output artifacts recorded by the step. */
  artifactIds: z.array(z.string()).default([]),
  /** Free-form data exposed to expressions as `steps.<nodeId>.result.data`. */
  data: z.record(z.string(), z.unknown()).default({}),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const ErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

/** A child run spawned by a container step, keyed by branch (loop index, branch name, work-item slug). */
export const ChildRunLinkSchema = z.object({
  runId: z.string(),
  branch: z.string().optional(),
  /** True when a resumed attempt re-attached to a child spawned by an interrupted attempt. */
  resumed: z.boolean().optional(),
  status: RunStatusSchema.optional(),
  outcome: RunOutcomeSchema.optional(),
});
export type ChildRunLink = z.infer<typeof ChildRunLinkSchema>;

export const StepRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  nodeType: z.string(),
  attempt: z.number().int().positive(),
  status: StepStatusSchema,
  waitingOn: z.string().optional(),
  iteration: z.number().int().nonnegative().optional(),
  agentSessionId: z.string().optional(),
  inputArtifactIds: z.array(z.string()).default([]),
  result: StepResultSchema.optional(),
  error: ErrorInfoSchema.optional(),
  childRunIds: z.array(z.string()).default([]),
  /** Same children as `childRunIds`, with their branch key and last known status. */
  children: z.array(ChildRunLinkSchema).default([]),
  scheduledAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

export const RunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  status: RunStatusSchema,
  outcome: RunOutcomeSchema.optional(),
  requestId: z.string().optional(),
  workItemId: z.string().optional(),
  parentRunId: z.string().optional(),
  parentStepRunId: z.string().optional(),
  workspace: WorkspaceSchema,
  vars: z.record(z.string(), z.unknown()).default({}),
  error: ErrorInfoSchema.optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const HumanInputRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepRunId: z.string(),
  kind: z.enum(["decision", "permission", "question"]),
  question: z.string(),
  options: z.array(z.string()).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
  answer: z.string().optional(),
  requestedAt: z.string(),
  answeredAt: z.string().optional(),
});
export type HumanInputRequest = z.infer<typeof HumanInputRequestSchema>;

/** Full read model for one run, rebuilt from its events. */
export const RunStateSchema = z.object({
  run: RunSchema,
  steps: z.record(z.string(), StepRunSchema),
  /** Step runs in scheduling order. */
  stepOrder: z.array(z.string()),
  artifacts: z.record(z.string(), ArtifactSchema),
  humanInputs: z.record(z.string(), HumanInputRequestSchema),
  lastSeq: z.number().int().nonnegative(),
});
export type RunState = z.infer<typeof RunStateSchema>;
