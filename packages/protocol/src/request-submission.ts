/** Additive Request admission, separate from explicit runs.start. Registered only when wired. */
import { z } from "zod";
import { SubmissionCommandSchema } from "@orca/core/schemas";
import type { SubmissionResult } from "@orca/core";

export const REQUESTS_SUBMIT_METHOD = "requests.submit";
export const REQUESTS_RECONCILE_METHOD = "requests.reconcile";
export const REQUESTS_ADMISSION_METHOD = "requests.admission";
export const REQUESTS_ADMISSIONS_METHOD = "requests.admissions";
export const RequestsSubmitParamsSchema = SubmissionCommandSchema.extend({ idempotencyKey: z.string().optional() });
export const RequestsAdmissionParamsSchema = z.strictObject({ admissionId: z.string().min(1) });
export const RequestsAdmissionsParamsSchema = z.strictObject({});
export type RequestsSubmitParams = z.infer<typeof RequestsSubmitParamsSchema>;
export type RequestsAdmissionParams = z.infer<typeof RequestsAdmissionParamsSchema>;
export type RequestsSubmitResult = SubmissionResult;
export type RequestsAdmissionResult = SubmissionResult;
export type RequestsAdmissionsResult = { admissions: SubmissionResult[] };

type FailureCode = Extract<SubmissionResult, { state: "recoverable-failure" }>["failure"]["code"];
/** Runtime receipt validation for app clients; preserves Request identity on every state. */
export const RequestsSubmitResultSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ state: z.literal("prepared"), admissionId: z.string().min(1), requestId: z.string().min(1) }),
    z.strictObject({
      state: z.literal("accepted"),
      admissionId: z.string().min(1),
      requestId: z.string().min(1),
      runId: z.string().min(1),
    }),
    z.strictObject({
      state: z.literal("recoverable-failure"),
      admissionId: z.string().min(1),
      requestId: z.string().min(1),
      runId: z.string().min(1).optional(),
      failure: z.strictObject({
        code: z.custom<FailureCode>((v) => typeof v === "string"),
        message: z.string(),
        recovery: z.literal("reconcile"),
      }),
    }),
  ])
  .transform((receipt): SubmissionResult => {
    if (receipt.state !== "recoverable-failure") return receipt;
    return {
      state: receipt.state,
      admissionId: receipt.admissionId,
      requestId: receipt.requestId,
      failure: receipt.failure,
      ...(receipt.runId === undefined ? {} : { runId: receipt.runId }),
    };
  });
