/** Schema-only preparation. These contracts register no RPC, grant or capability. */
import { z } from "zod";
import { SubmissionCommandSchema } from "@orca/core/schemas";
import { RunsStartParamsSchema } from "./control.js";
import { AdmissionsGetParamsSchema, RetryKeySchema } from "./admission-retry.js";
import {
  ContinuationCommandSchema,
  ContinuationReceiptSchema,
  ContinuationsGetParamsSchema,
  RunsContinueResultSchema,
} from "./continuation-admission.js";
import { RevisionCommandSchema, RevisionResultSchema } from "./revision-input.js";
import { LiveDecisionTargetSchema } from "./live-input.js";
import { OperatorTargetSchema } from "./operator-reads.js";

const id = z.string().min(1);
const target = OperatorTargetSchema;
const retry = z.strictObject({ idempotencyKey: RetryKeySchema });
const guards = {
  workflowId: RunsStartParamsSchema.shape.workflowId,
  workflowVersion: RunsStartParamsSchema.shape.workflowVersion.unwrap(),
  expectedWorkflowRevision: RunsStartParamsSchema.shape.expectedWorkflowRevision.unwrap(),
  expectedConfigGeneration: SubmissionCommandSchema.shape.expectedConfigGeneration.unwrap(),
};
export const OperatorDirectCommandSchema = RunsStartParamsSchema.omit({ idempotencyKey: true }).extend(guards).strict();
export const OperatorRequestCommandSchema = SubmissionCommandSchema.extend(guards);
const failure = z.object({ code: z.string(), recovery: z.literal("reconcile") });
const direct = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("prepared"), admissionId: id }),
  z.strictObject({ state: z.literal("accepted"), admissionId: id, runId: id }),
  z.strictObject({ state: z.literal("recoverable-failure"), admissionId: id, runId: id.optional(), failure }),
]);
const request = z.discriminatedUnion("state", [
  z.object({ state: z.literal("prepared"), admissionId: id, requestId: id }),
  z.object({ state: z.literal("accepted"), admissionId: id, requestId: id, runId: id }),
  z.object({ state: z.literal("recoverable-failure"), admissionId: id, requestId: id, runId: id.optional(), failure }),
]);
const retried = <T extends z.ZodType>(result: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("resolved"), operationId: id, replayed: z.boolean(), result }),
    z.object({ state: z.literal("in-progress"), operationId: id, recovery: z.literal("inspect-or-retry") }),
  ]);
const decision = z.discriminatedUnion("lifetime", [
  z.strictObject({
    lifetime: z.literal("durable"),
    runId: id,
    stepRunId: id,
    requestId: id,
    optionId: z.string().min(1).max(16384),
    note: z.string().max(16384).optional(),
    resume: z.literal(false),
  }),
  z.strictObject({
    lifetime: z.literal("live"),
    live: LiveDecisionTargetSchema.strict(),
    optionId: z.string().min(1).max(16384),
    note: z.string().max(16384).optional(),
  }),
]);
const receipt = z.object({ runId: id, requestId: id.optional(), asOf: z.iso.datetime() });
const lookup = z.strictObject({ target, operationId: AdmissionsGetParamsSchema.shape.operationId });
const continuationLookup = z.strictObject({
  target,
  continuationId: ContinuationsGetParamsSchema.shape.continuationId,
});
// Request first: stripping a request result through the direct shape would lose requestId.
const admitted = retried(z.union([request, direct]));
export const OperatorMutationContracts = {
  "operator.submitRequest": {
    params: z.strictObject({ target, command: OperatorRequestCommandSchema, retry }),
    result: retried(request),
  },
  "operator.admitRun": {
    params: z.strictObject({ target, command: OperatorDirectCommandSchema, retry }),
    result: retried(direct),
  },
  "operator.admission": { params: lookup, result: admitted },
  "operator.reconcileAdmission": { params: lookup, result: admitted },
  "operator.cancel": {
    params: z.strictObject({ target, runId: id, reason: z.string().max(2000).optional() }),
    result: receipt,
  },
  "operator.answer": { params: z.strictObject({ target, decision }), result: receipt },
  "operator.continueRun": {
    params: z.strictObject({ target, command: ContinuationCommandSchema, retry }),
    result: RunsContinueResultSchema,
  },
  "operator.continuation": { params: continuationLookup, result: ContinuationReceiptSchema },
  "operator.reconcileContinuation": { params: continuationLookup, result: ContinuationReceiptSchema },
  "operator.revise": {
    params: z.strictObject({ target, command: RevisionCommandSchema, retry }),
    result: RevisionResultSchema,
  },
} as const;
export type OperatorMutationName = keyof typeof OperatorMutationContracts;
export type OperatorMutationParams<N extends OperatorMutationName> = z.infer<
  (typeof OperatorMutationContracts)[N]["params"]
>;
export type OperatorMutationResult<N extends OperatorMutationName> = z.infer<
  (typeof OperatorMutationContracts)[N]["result"]
>;
