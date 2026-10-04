/** Explicit durable continuation receipts; capability registration requires the production runtime. */
import { z } from "zod";
import { RetryOptionsSchema } from "./admission-retry.js";

const id = z.string().min(1).max(512);
export const ContinuationCommandSchema = z.strictObject({
  runId: id,
  expectedBoundary: id,
  decision: z
    .strictObject({ requestId: id, optionId: z.string().min(1).max(16_384), note: z.string().max(16_384).optional() })
    .optional(),
});
export const RunsContinueParamsSchema = z.strictObject({
  command: ContinuationCommandSchema,
  retry: RetryOptionsSchema.default({}),
});
export const ContinuationsGetParamsSchema = z.strictObject({
  continuationId: z.string().regex(/^ct_[a-f0-9-]{36}$/),
});
export const ContinuationsReconcileParamsSchema = ContinuationsGetParamsSchema;
export const ContinuationReceiptSchema = z.strictObject({
  operationId: id,
  continuationId: id,
  runId: id,
  expectedBoundary: id,
  state: z.enum(["prepared", "accepted", "blocked", "settled"]),
  blockedReason: z.enum(["authority-unavailable", "leased", "unsafe-boundary", "generation-unavailable"]).optional(),
});
export const RunsContinueResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("resolved"),
    operationId: id,
    replayed: z.boolean(),
    result: ContinuationReceiptSchema,
  }),
  z.strictObject({ state: z.literal("in-progress"), operationId: id, recovery: z.literal("inspect-or-retry") }),
]);
export const RUNS_CONTINUE_METHOD = "runs.continue";
export const CONTINUATIONS_GET_METHOD = "continuations.get";
export const CONTINUATIONS_RECONCILE_METHOD = "continuations.reconcile";
export type RunsContinueParams = z.infer<typeof RunsContinueParamsSchema>;
export type RunsContinueResult = z.infer<typeof RunsContinueResultSchema>;
