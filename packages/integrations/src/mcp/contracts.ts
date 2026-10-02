/** Frozen consumer shapes from runtime-operator-parallel-contract.md; no local retry state. */
import { z } from "zod";
import { SubmissionCommandSchema } from "@orca/core/schemas";
import {
  OperatorIdSchema as id,
  OperatorTargetSchema as target,
  OperatorPageParamsSchema,
  OperatorPageResultSchema,
  OperatorDiscoverySchema,
  OperatorConfigSchema,
  OperatorPreflightParamsSchema,
  OperatorPreflightResultSchema,
  OperatorArtifactParamsSchema,
  OperatorArtifactResultSchema,
  LiveDecisionTargetSchema,
} from "@orca/protocol";

const retry = z.strictObject({ idempotencyKey: z.string().min(1).max(200) });
const guard = { workflowId: id, workflowVersion: id, expectedWorkflowRevision: id, expectedConfigGeneration: id };
const direct = z.strictObject({
  ...guard,
  vars: z.record(z.string(), z.unknown()).optional(),
  requestId: id.optional(),
  workItemId: id.optional(),
});
const request = SubmissionCommandSchema.extend(guard);
const failure = z.object({ code: z.string().max(100), recovery: z.literal("reconcile") });
const admission = z.discriminatedUnion("state", [
  z.object({ state: z.literal("prepared"), admissionId: id, requestId: id.optional() }),
  z.object({ state: z.literal("accepted"), admissionId: id, requestId: id.optional(), runId: id }),
  z.object({
    state: z.literal("recoverable-failure"),
    admissionId: id,
    requestId: id.optional(),
    runId: id.optional(),
    failure,
  }),
]);
const requestAdmission = z.discriminatedUnion("state", [
  z.object({ state: z.literal("prepared"), admissionId: id, requestId: id }),
  z.object({ state: z.literal("accepted"), admissionId: id, requestId: id, runId: id }),
  z.object({ state: z.literal("recoverable-failure"), admissionId: id, requestId: id, runId: id.optional(), failure }),
]);
const retried = <T extends z.ZodType>(result: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("resolved"), operationId: id, replayed: z.boolean(), result }),
    z.object({ state: z.literal("in-progress"), operationId: id, recovery: z.literal("inspect-or-retry") }),
  ]);
const continuationCommand = z.strictObject({
  runId: id,
  expectedBoundary: id,
  decision: z
    .strictObject({ requestId: id, optionId: z.string().min(1).max(16_384), note: z.string().max(16_384).optional() })
    .optional(),
});
const continuation = z.object({
  operationId: id,
  continuationId: id,
  runId: id,
  expectedBoundary: id,
  state: z.enum(["prepared", "accepted", "blocked", "settled"]),
  blockedReason: z.enum(["authority-unavailable", "leased", "unsafe-boundary", "generation-unavailable"]).optional(),
});
const revisionTarget = z.strictObject({
  runId: id,
  stepRunId: id,
  requestId: id,
  destinationId: id,
  expectedRevision: id,
});
const revisionCommand = z.strictObject({
  target: revisionTarget,
  payload: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), text: z.string().max(16_384) }),
    z.strictObject({ kind: z.literal("values"), values: z.record(z.string(), z.unknown()) }),
  ]),
  actionId: id,
  supersedesRevisionId: id.optional(),
});
const revisionReceipt = z.object({
  revisionId: id,
  target: revisionTarget,
  state: z.enum(["pending", "delivered", "rejected", "superseded"]),
  attemptId: id,
  currentRevisionId: id,
  expectedRevision: id,
});
const decision = z.discriminatedUnion("lifetime", [
  z.strictObject({
    lifetime: z.literal("durable"),
    runId: id,
    stepRunId: id,
    requestId: id,
    optionId: z.string().min(1).max(16_384),
    note: z.string().max(16_384).optional(),
    resume: z.literal(false),
  }),
  z.strictObject({
    lifetime: z.literal("live"),
    live: LiveDecisionTargetSchema.strict(),
    optionId: z.string().min(1).max(16_384),
    note: z.string().max(16_384).optional(),
  }),
]);
const receipt = z.object({ runId: id, requestId: id.optional(), asOf: z.iso.datetime() });

/** Explicit private-daemon adapter endpoints. Each delegates to one shared application service. */
export const MCP_OPERATIONS = {
  discover: { method: "operator.discover", input: z.strictObject({}), output: OperatorDiscoverySchema, write: false },
  page: { method: "operator.page", input: OperatorPageParamsSchema, output: OperatorPageResultSchema, write: false },
  config: { method: "operator.config", input: z.strictObject({ target }), output: OperatorConfigSchema, write: false },
  preflight: {
    method: "operator.preflight",
    input: OperatorPreflightParamsSchema,
    output: OperatorPreflightResultSchema,
    write: false,
  },
  artifact: {
    method: "operator.artifact",
    input: OperatorArtifactParamsSchema,
    output: OperatorArtifactResultSchema,
    write: false,
  },
  submitRequest: {
    method: "operator.submitRequest",
    input: z.strictObject({ target, command: request, retry }),
    output: retried(requestAdmission),
    write: true,
  },
  admitRun: {
    method: "operator.admitRun",
    input: z.strictObject({ target, command: direct, retry }),
    output: retried(admission),
    write: true,
  },
  admission: {
    method: "operator.admission",
    input: z.strictObject({ target, operationId: id }),
    output: retried(admission),
    write: false,
  },
  reconcileAdmission: {
    method: "operator.reconcileAdmission",
    input: z.strictObject({ target, operationId: id }),
    output: retried(admission),
    write: true,
  },
  cancel: {
    method: "operator.cancel",
    input: z.strictObject({ target, runId: id, reason: z.string().max(2000).optional() }),
    output: receipt,
    write: true,
  },
  answer: { method: "operator.answer", input: z.strictObject({ target, decision }), output: receipt, write: true },
  continueRun: {
    method: "operator.continueRun",
    input: z.strictObject({ target, command: continuationCommand, retry }),
    output: retried(continuation),
    write: true,
  },
  continuation: {
    method: "operator.continuation",
    input: z.strictObject({ target, continuationId: id }),
    output: continuation,
    write: false,
  },
  reconcileContinuation: {
    method: "operator.reconcileContinuation",
    input: z.strictObject({ target, continuationId: id }),
    output: continuation,
    write: true,
  },
  revise: {
    method: "operator.revise",
    input: z.strictObject({ target, command: revisionCommand, retry }),
    output: retried(revisionReceipt),
    write: true,
  },
} as const;
export type McpOperation = keyof typeof MCP_OPERATIONS;
export type McpInput<K extends McpOperation> = z.input<(typeof MCP_OPERATIONS)[K]["input"]>;
export type McpOutput<K extends McpOperation> = z.output<(typeof MCP_OPERATIONS)[K]["output"]>;

/** Server-created authenticated path. Implementations recheck credentials/grants before diagnostics and effects. */
export interface AuthenticatedOperatorBackend {
  call<K extends McpOperation>(operation: K, input: McpInput<K>): Promise<McpOutput<K>>;
}
