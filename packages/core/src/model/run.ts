/**
 * Runtime state of a workflow execution.
 *
 * Runs and step runs are *projections* of the event log (see events/reduce.ts);
 * these types describe the read model the engine and UIs work with.
 */
import { RunProvenanceSchema } from "./run-provenance.js";
import { z } from "zod";
import { ArtifactSchema } from "./artifact.js";

export const RunStatusSchema = z.enum(["created", "running", "waiting", "paused", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StepStatusSchema = z.enum([
  "scheduled",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
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
  /**
   * The branch (or detached commit) the checkout was on before the provider switched it to
   * `branch` — set by the local provider, which shares one checkout between runs (#139).
   */
  previousBranch: z.string().optional(),
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
  /** The work item this branch stands for, when the container bound one to it. */
  workItemId: z.string().optional(),
  /** True when a resumed attempt re-attached to a child spawned by an interrupted attempt. */
  resumed: z.boolean().optional(),
  status: RunStatusSchema.optional(),
  outcome: RunOutcomeSchema.optional(),
});
export type ChildRunLink = z.infer<typeof ChildRunLinkSchema>;

/** Why a fan-out branch never became a child run. */
export const BranchSkipReasonSchema = z.enum(["dependency", "failFast", "claimed"]);
export type BranchSkipReason = z.infer<typeof BranchSkipReasonSchema>;

/**
 * A branch of a fan-out step that was never started: a prerequisite branch did not succeed
 * (`dependency`), a sibling already settled the join under `failFast`, or the work item the
 * branch stands for is already owned by another run (`claimed`). Recorded so the *whole*
 * fan-out - not just the part that ran - is reconstructible from the event log.
 */
export const SkippedBranchSchema = z.object({
  branch: z.string(),
  reason: BranchSkipReasonSchema,
  workItemId: z.string().optional(),
});
export type SkippedBranch = z.infer<typeof SkippedBranchSchema>;

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
  /** Fan-out branches of this step that never became child runs. */
  skippedBranches: z.array(SkippedBranchSchema).default([]),
  scheduledAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

/**
 * Per-run selection: which agent fills a role, which model an agent uses, which workflow a
 * program runs per item and which template pack renders prompts. Recorded in `run.created`
 * so a replay resolves the same agents the live run did; a log without it means no overrides.
 */
export const RunOverridesSchema = z
  .object({
    /** role -> agent id; consulted before the config's role mapping. */
    roles: z.record(z.string(), z.string()).optional(),
    /** One model id for the only agent in play, or agent id -> model id. */
    model: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
    itemWorkflow: z.string().optional(),
    templatePack: z.string().optional(),
  })
  .strict();
export type RunOverrides = z.infer<typeof RunOverridesSchema>;

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
  /** The run's selection overrides, from `run.created`; absent on runs that had none. */
  overrides: RunOverridesSchema.optional(),
  provenance: RunProvenanceSchema.optional(),
  error: ErrorInfoSchema.optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * The cheap projection of a run: what a listing needs (`orca runs`), without
 * the steps, artifacts and agent chatter. Rebuilt from a handful of lifecycle
 * events rather than the whole log - see reduceRunSummary.
 */
export const RunSummarySchema = RunSchema.pick({
  id: true,
  workflowId: true,
  workflowVersion: true,
  status: true,
  outcome: true,
  requestId: true,
  workItemId: true,
  parentRunId: true,
  overrides: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/**
 * One option a gate, a decision or an agent `ask` offers a person.
 *
 * `id` is the contract: it is what `human.answered.answer` carries and what a
 * client sends back, so a label can be reworded - translated, shortened for a
 * card, given a verb - without invalidating an answer already in a log. `label`
 * is the words shown; `consequence` is the clause that says what choosing it
 * does; `destructive` marks the one a UI must not make easy to hit by accident
 * (docs/design/20-attention-and-gates.md).
 */
const GateOptionObjectSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  consequence: z.string().optional(),
  destructive: z.boolean().optional(),
});
export type GateOption = z.infer<typeof GateOptionObjectSchema>;

/** What a caller may hand us: the full option, or the bare string that used to be one. */
export type GateOptionInput = string | GateOption;

/**
 * The one place a bare string becomes an option. Before v0.4.0 options *were*
 * strings, in the event log and in every caller, and a string answer was
 * compared against them - so a string reads as an option that is its own id and
 * its own label, which makes every answer ever recorded still match.
 *
 * `GateOptionSchema` applies this on read (an old `human.requested` line, an old
 * `RunState` snapshot); emitters apply it on write, so nothing written from here
 * on holds a bare string.
 */
export function toGateOption(option: GateOptionInput): GateOption {
  return typeof option === "string" ? { id: option, label: option } : option;
}

export const GateOptionSchema = z.union([z.string().transform(toGateOption), GateOptionObjectSchema]);

/** Runtime correlation only; these four identifiers survive protected public projection. */
export const HumanInputLiveIdentitySchema = z.object({
  instanceId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  invocationId: z.string().min(1),
});

export const HumanInputRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepRunId: z.string(),
  kind: z.enum(["decision", "permission", "question"]),
  question: z.string(),
  options: z.array(GateOptionSchema).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
  liveDecision: HumanInputLiveIdentitySchema.optional(),
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

/**
 * The one definition of "this run delivered what was asked of it". Every container join,
 * the program-level work-item projection and the CLI exit code agree on it, so changing
 * how e.g. `cancelled` counts is a one-line change.
 */
export function outcomeSucceeded(status: RunStatus | undefined, outcome?: RunOutcome): boolean {
  return status === "completed" && outcome === "success";
}

/** `outcomeSucceeded` for a whole run state - the usual caller. */
export function succeeded(state: Pick<RunState, "run">): boolean {
  return outcomeSucceeded(state.run.status, state.run.outcome);
}
