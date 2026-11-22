/** Additive receipt schemas. Registration/capabilities require production wiring. */
import { z } from "zod";
import { SubmissionCommandSchema } from "@orca/core/schemas";
import { RunsStartParamsSchema } from "./control.js";
import type { DirectAdmissionResult, RetryResult, RetryOptions } from "../../core/src/model/admission-retry.js";
export const RetryKeySchema = z.string().refine((key) => {
  const bytes = new TextEncoder().encode(key).length;
  return bytes >= 1 && bytes <= 128;
}, "Retry key must contain 1–128 UTF-8 bytes");
export const RetryOptionsSchema = z.strictObject({ idempotencyKey: RetryKeySchema.optional() });
export const RetryRequestsSubmitParamsSchema = SubmissionCommandSchema.extend({
  idempotencyKey: RetryKeySchema.optional(),
});
export const AdmissionExpectedScopeSchema = z.strictObject({
  principalId: z.string().min(1).max(512),
  workspaceId: z.uuid(),
});
export const RunsAdmitParamsSchema = RunsStartParamsSchema.extend({
  expectedScope: AdmissionExpectedScopeSchema.optional(),
  idempotencyKey: RetryKeySchema.optional(),
}).strict();
export const AdmissionsGetParamsSchema = z.strictObject({ operationId: z.string().regex(/^retry_[a-f0-9-]{36}$/) });
export const AdmissionsReconcileParamsSchema = AdmissionsGetParamsSchema;
/**
 * `admissions.find` (#883): a direct admission's receipt by its idempotency key, without
 * claiming the key. Listed in `hello.methods`, not as a capability. `absent` holds only for
 * the moment it was read: a submission still in flight may claim the key afterwards.
 */
export const AdmissionsFindParamsSchema = z.strictObject({
  idempotencyKey: RetryKeySchema,
  expectedScope: AdmissionExpectedScopeSchema.optional(),
});
export const ADMISSIONS_FIND_METHOD = "admissions.find";
/**
 * `admissions.fence` (#883): claim a direct admission's idempotency key so no later
 * `runs.admit` under it admits a run. Answers the admission already under the key, if any;
 * else a resolved receipt whose result is `{ state: "fenced" }`.
 */
export const AdmissionsFenceParamsSchema = z.strictObject({
  idempotencyKey: RetryKeySchema,
  workflowId: z.string().min(1),
  /** Required: a fence lands only in the workspace and principal the caller enrolled. */
  expectedScope: AdmissionExpectedScopeSchema,
});
export const ADMISSIONS_FENCE_METHOD = "admissions.fence";
export const RUNS_ADMIT_METHOD = "runs.admit";
export const ADMISSIONS_GET_METHOD = "admissions.get";
export const ADMISSIONS_RECONCILE_METHOD = "admissions.reconcile";
export type RunsAdmitParams = z.infer<typeof RunsAdmitParamsSchema>;
/** Successful wire receipts always expose their authorized journal reference. */
const ReceiptFields = { operationId: z.string().min(1), admissionId: z.string().min(1) };
export const RunsAdmitResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...ReceiptFields, state: z.literal("prepared") }),
  z.strictObject({ ...ReceiptFields, state: z.literal("accepted"), runId: z.string().min(1) }),
  z.strictObject({
    ...ReceiptFields,
    state: z.literal("recoverable-failure"),
    runId: z.string().min(1).optional(),
    failure: z.strictObject({ code: z.string(), message: z.string(), recovery: z.literal("reconcile") }),
  }),
]);
export const AdmissionInProgressSchema = z.strictObject({
  state: z.literal("in-progress"),
  operationId: z.string().min(1),
  recovery: z.literal("inspect-or-retry"),
});
export type RunsAdmitResult = DirectAdmissionResult & { operationId: string };
export type AdmissionRetryResult = RetryResult<unknown>;
/** Recovery preserves the outer envelope; callers validate its nested result by retained kind. */
export const AdmissionRetryResultSchema = z.discriminatedUnion("state", [
  AdmissionInProgressSchema,
  z.strictObject({
    state: z.literal("resolved"),
    operationId: z.string().min(1),
    replayed: z.boolean(),
    result: z.unknown(),
  }),
]);

/** Called once per explicit user intent; the caller retains this object across transport retries. */
export function newAdmissionIntent(idempotencyKey: string = globalThis.crypto.randomUUID()): Readonly<RetryOptions> {
  return Object.freeze({ idempotencyKey: RetryKeySchema.parse(idempotencyKey) });
}

export const AdmissionsFindResultSchema = z.union([
  z.strictObject({ state: z.literal("absent") }),
  AdmissionRetryResultSchema,
]);
export type AdmissionsFindResult = z.infer<typeof AdmissionsFindResultSchema>;
