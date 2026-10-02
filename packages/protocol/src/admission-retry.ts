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
export const RunsAdmitParamsSchema = RunsStartParamsSchema.extend({
  idempotencyKey: RetryKeySchema.optional(),
}).strict();
export const AdmissionsGetParamsSchema = z.strictObject({ operationId: z.string().regex(/^retry_[a-f0-9-]{36}$/) });
export const AdmissionsReconcileParamsSchema = AdmissionsGetParamsSchema;
export const RUNS_ADMIT_METHOD = "runs.admit";
export const ADMISSIONS_GET_METHOD = "admissions.get";
export const ADMISSIONS_RECONCILE_METHOD = "admissions.reconcile";
export type RunsAdmitParams = z.infer<typeof RunsAdmitParamsSchema>;
export type RunsAdmitResult = DirectAdmissionResult & { operationId: string };
export type AdmissionRetryResult = RetryResult<unknown>;

/** Called once per explicit user intent; the caller retains this object across transport retries. */
export function newAdmissionIntent(idempotencyKey: string = globalThis.crypto.randomUUID()): Readonly<RetryOptions> {
  return Object.freeze({ idempotencyKey: RetryKeySchema.parse(idempotencyKey) });
}
