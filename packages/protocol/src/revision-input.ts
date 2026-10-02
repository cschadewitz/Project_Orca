/** Strict revision RPC shapes. Export/registration is reserved until the production service is integrated. */
import { z } from "zod";
import { WorkflowInputSchemaSchema } from "@orca/core/schemas";

const id = z.string().min(1).max(1024);
const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(z.string(), json)]),
);
const bounded = (value: unknown, bytes: number): boolean => {
  const visit = (item: unknown, depth: number): boolean =>
    depth <= 32 &&
    (!(item && typeof item === "object") || Object.values(item).every((child) => visit(child, depth + 1)));
  try {
    return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).length <= bytes;
  } catch {
    return false;
  }
};
export const RevisionPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("text"),
    text: z
      .string()
      .min(1)
      .refine((text) => new TextEncoder().encode(text).length <= 65536),
  }),
  z.strictObject({
    kind: z.literal("values"),
    values: z
      .unknown()
      .refine((value) => bounded(value, 65536))
      .pipe(z.record(z.string(), json)),
  }),
]);
export const RevisionTargetSchema = z.strictObject({
  runId: id,
  stepRunId: id,
  requestId: id,
  destinationId: id,
  expectedRevision: id,
});
export const PendingRevisionTargetSchema = z.strictObject({
  runId: id,
  revisionId: id,
  destinationId: id,
  attemptId: id,
});
export const RevisionCommandSchema = z.strictObject({
  target: RevisionTargetSchema,
  payload: RevisionPayloadSchema,
  actionId: id,
  supersedesRevisionId: id.optional(),
});
export const ReplacePendingRevisionCommandSchema = z.strictObject({
  target: PendingRevisionTargetSchema,
  expectedRevision: id,
  payload: RevisionPayloadSchema,
});
export const RevisionStateSchema = z.enum(["pending", "delivered", "rejected", "superseded"]);
export const RevisionReceiptSchema = z.strictObject({
  revisionId: id,
  target: RevisionTargetSchema,
  state: RevisionStateSchema,
  attemptId: id,
  currentRevisionId: id,
  expectedRevision: id,
});
export const RevisionCapabilitySchema = z.strictObject({
  actionId: id,
  destinationNodeId: id,
  composition: z.literal("replace-revision-slot"),
  payload: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text"), maxBytes: z.number().int().positive().max(65536) }),
    z.strictObject({
      kind: z.literal("values"),
      maxBytes: z.number().int().positive().max(65536),
      inputSchema: WorkflowInputSchemaSchema,
    }),
  ]),
});
export const RevisionBoundaryViewSchema = z.strictObject({
  target: RevisionTargetSchema,
  capability: RevisionCapabilitySchema,
  destinationDescription: z.string(),
});
export const PendingRevisionViewSchema = z.strictObject({
  target: PendingRevisionTargetSchema,
  expectedRevision: id,
  state: RevisionStateSchema,
  payload: RevisionPayloadSchema.optional(),
  boundary: RevisionBoundaryViewSchema.optional(),
  replacementAllowed: z.boolean(),
  unavailableReason: z.enum(["delivered", "target-changed", "cancelled", "delivery-uncertain"]).optional(),
});
const retry = z.strictObject({
  idempotencyKey: z
    .string()
    .min(1)
    .refine((key) => new TextEncoder().encode(key).length <= 128)
    .optional(),
});
export const InputsReviseParamsSchema = z
  .strictObject({ command: RevisionCommandSchema, retry })
  .refine((value) => bounded(value, 262144));
export const InputsReplaceRevisionParamsSchema = z
  .strictObject({ command: ReplacePendingRevisionCommandSchema, retry })
  .refine((value) => bounded(value, 262144));
export const InputsRevisionPendingParamsSchema = z.strictObject({ target: PendingRevisionTargetSchema });
export const RevisionResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("resolved"),
    operationId: id,
    replayed: z.boolean(),
    result: RevisionReceiptSchema,
  }),
  z.strictObject({ state: z.literal("in-progress"), operationId: id, recovery: z.literal("inspect-or-retry") }),
]);
export const REVISION_METHODS = ["inputs.revise", "inputs.revisionPending", "inputs.replaceRevision"] as const;
export type RevisionCommand = z.infer<typeof RevisionCommandSchema>;
export type RevisionPayload = z.infer<typeof RevisionPayloadSchema>;
export type RevisionReceipt = z.infer<typeof RevisionReceiptSchema>;
export type PendingRevisionTarget = z.infer<typeof PendingRevisionTargetSchema>;
export type PendingRevisionView = z.infer<typeof PendingRevisionViewSchema>;
export type ReplacePendingRevisionCommand = z.infer<typeof ReplacePendingRevisionCommandSchema>;
export type RevisionBoundaryView = z.infer<typeof RevisionBoundaryViewSchema>;
export type RevisionResult = z.infer<typeof RevisionResultSchema>;
export type InputsReviseParams = z.infer<typeof InputsReviseParamsSchema>;
export type InputsReplaceRevisionParams = z.infer<typeof InputsReplaceRevisionParamsSchema>;
export type InputsRevisionPendingParams = z.infer<typeof InputsRevisionPendingParamsSchema>;
