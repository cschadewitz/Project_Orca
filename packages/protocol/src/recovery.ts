/**
 * Recovery of a run (#357, protocol 2.5): the three calls behind the app's recovery panel.
 *
 * - `runs.recovery` reads. It is the same assessment `orca recovery <runId>` prints - Resume,
 *   New run and Checkpoint attempt, each with why it is or is not available, the steps whose
 *   effects nobody can confirm, and each checkpoint's reuse and repeat lists. It writes
 *   nothing and takes no lease, so a read-only daemon answers it.
 * - `runs.reviewEffect` records an operator's review of one step attempt that may have acted
 *   outside ORCA and never finished: `run-again` lets resume or a checkpoint attempt run it
 *   again, `abandon` ends the run there. Nothing repeats such a step without one.
 * - `runs.recover` starts a checkpoint attempt of a failed run through retry-safe admission:
 *   one attempt per idempotency key, created and then driven by the daemon, as `runs.admit`
 *   drives an admitted run. Its receipts are read and reconciled through `admissions.get` and
 *   `admissions.reconcile`, like any other admission.
 *
 * New method names only: a 2.4 client never calls them, and a 2.5 client asks `hello.methods`
 * before it shows the panel's buttons.
 */
import { z } from "zod";
import { EffectReviewDecisionSchema, RecoveryAssessmentSchema } from "@orca/core/schemas";
import { AdmissionExpectedScopeSchema, AdmissionInProgressSchema, RetryKeySchema } from "./admission-retry.js";
import { RunSummaryViewSchema } from "./runs.js";

export const RUNS_RECOVERY_METHOD = "runs.recovery";
export const RUNS_REVIEW_EFFECT_METHOD = "runs.reviewEffect";
export const RUNS_RECOVER_METHOD = "runs.recover";

// ---------------------------------------------------------------- runs.recovery

export const RunsRecoveryParamsSchema = z.strictObject({
  runId: z.string().min(1),
  /** One checkpoint, by step run id or by a node id that names exactly one: its detail and readiness. */
  checkpoint: z.string().min(1).optional(),
});
export type RunsRecoveryParams = z.infer<typeof RunsRecoveryParamsSchema>;

export const RunsRecoveryResultSchema = z.object({
  assessment: RecoveryAssessmentSchema,
  asOf: z.string(),
});
export type RunsRecoveryResult = z.infer<typeof RunsRecoveryResultSchema>;

// ------------------------------------------------------------ runs.reviewEffect

export const RunsReviewEffectParamsSchema = z.strictObject({
  runId: z.string().min(1),
  /** The step attempt reviewed: an uncertain step from `runs.recovery`. */
  stepRunId: z.string().min(1),
  decision: EffectReviewDecisionSchema,
  /** Why: recorded on `step.effect.reviewed` and shown with the review. */
  note: z.string().max(2000).optional(),
});
export type RunsReviewEffectParams = z.infer<typeof RunsReviewEffectParamsSchema>;

export const RunsReviewEffectResultSchema = z.object({
  run: RunSummaryViewSchema,
  asOf: z.string(),
});
export type RunsReviewEffectResult = z.infer<typeof RunsReviewEffectResultSchema>;

// ----------------------------------------------------------------- runs.recover

export const RunsRecoverParamsSchema = z.strictObject({
  /** The failed run to recover. */
  runId: z.string().min(1),
  /** The checkpoint. The latest one that is not blocked when absent. */
  checkpoint: z.string().min(1).optional(),
  /** The same key returns the same attempt; the same key for a different run or checkpoint conflicts. */
  idempotencyKey: RetryKeySchema.optional(),
  /** A client guard, never authority: refuse unless the caller is this principal in this workspace. */
  expectedScope: AdmissionExpectedScopeSchema.optional(),
});
export type RunsRecoverParams = z.infer<typeof RunsRecoverParamsSchema>;

const Receipt = { operationId: z.string().min(1), admissionId: z.string().min(1) };
export const RunsRecoverReceiptSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...Receipt,
    state: z.literal("accepted"),
    /** The attempt: a new run, driven by the daemon from here. */
    runId: z.string().min(1),
    sourceRunId: z.string().min(1),
  }),
  z.strictObject({
    ...Receipt,
    state: z.literal("recoverable-failure"),
    runId: z.string().min(1).optional(),
    failure: z.strictObject({ code: z.string(), message: z.string(), recovery: z.literal("reconcile") }),
  }),
]);
export const RunsRecoverResultSchema = z.union([RunsRecoverReceiptSchema, AdmissionInProgressSchema]);
export type RunsRecoverResult = z.infer<typeof RunsRecoverResultSchema>;
