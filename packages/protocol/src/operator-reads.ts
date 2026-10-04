/** Bounded, allowlisted operator projections. Registration is an integrator-owned seam. */
import { z } from "zod";
import { ValidationResultSchema } from "./workflow-inputs.js";
import { LiveInputViewSchema } from "./live-input.js";

export const OPERATOR_PAGE_SIZE = 50;
export const OPERATOR_MAX_PAGE_SIZE = 100;
export const OPERATOR_MAX_RESULT_BYTES = 256 * 1024;
export const OPERATOR_CONTENT_BYTES = 16 * 1024;
export const OperatorIdSchema = z.string().min(1).max(512);
export const OperatorTargetSchema = z.strictObject({ workspaceId: z.uuid(), instanceId: z.uuid() });
export const OperatorScopeSchema = z.object({
  runs: z.enum(["owned", "all"]),
  workflows: z.union([z.literal("*"), z.array(OperatorIdSchema).max(100)]),
  permissions: z.array(z.string().max(80)).max(32),
});
export const OperatorDiscoverySchema = z.object({
  target: OperatorTargetSchema,
  protocol: z.object({ major: z.number().int(), minor: z.number().int() }),
  orcaVersion: z.string().max(100),
  principalId: OperatorIdSchema,
  authentication: z.literal("credential"),
  scope: OperatorScopeSchema,
  operations: z.array(z.string().max(80)).max(100),
  collections: z.array(z.string().max(80)).max(20),
  asOf: z.iso.datetime(),
});
export type OperatorDiscovery = z.infer<typeof OperatorDiscoverySchema>;
export type OperatorTarget = z.infer<typeof OperatorTargetSchema>;
export const OperatorCollectionSchema = z.enum([
  "runs",
  "steps",
  "children",
  "events",
  "inputs",
  "artifacts",
  "workflows",
  "graph",
  "requests",
  "items",
  "provenance",
  "choices",
]);
export type OperatorCollection = z.infer<typeof OperatorCollectionSchema>;
export const OperatorPageParamsSchema = z.strictObject({
  target: OperatorTargetSchema,
  collection: OperatorCollectionSchema,
  runId: OperatorIdSchema.optional(),
  workflowId: OperatorIdSchema.optional(),
  workflowVersion: OperatorIdSchema.optional(),
  stepRunId: OperatorIdSchema.optional(),
  requestId: OperatorIdSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(OPERATOR_MAX_PAGE_SIZE).default(OPERATOR_PAGE_SIZE),
});
export type OperatorPageParams = z.infer<typeof OperatorPageParamsSchema>;
/** Text here must come from the public sensitivity projection, never protected execution material. */
export const OperatorRowSchema = z.object({
  id: OperatorIdSchema,
  kind: z.string().min(1).max(100),
  runId: OperatorIdSchema.optional(),
  stepRunId: OperatorIdSchema.optional(),
  nodeId: OperatorIdSchema.optional(),
  workflowId: OperatorIdSchema.optional(),
  workflowVersion: OperatorIdSchema.optional(),
  workflowRevision: OperatorIdSchema.optional(),
  configGeneration: OperatorIdSchema.optional(),
  parentRunId: OperatorIdSchema.optional(),
  childRunId: OperatorIdSchema.optional(),
  requestId: OperatorIdSchema.optional(),
  workItemId: OperatorIdSchema.optional(),
  artifactId: OperatorIdSchema.optional(),
  agentId: OperatorIdSchema.optional(),
  modelId: OperatorIdSchema.optional(),
  templateId: OperatorIdSchema.optional(),
  source: z.string().max(100).optional(),
  from: OperatorIdSchema.optional(),
  to: OperatorIdSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().optional(),
  status: z.string().max(100).optional(),
  errorCode: z.string().max(100).optional(),
  at: z.string().max(100).optional(),
  text: z.string().optional(),
  options: z
    .array(z.object({ id: OperatorIdSchema, label: z.string(), destructive: z.boolean().optional() }))
    .optional(),
  live: LiveInputViewSchema.optional(),
  version: z.number().int().positive().optional(),
  mediaType: z.string().max(200).optional(),
  size: z.number().int().nonnegative().optional(),
  contentHash: OperatorIdSchema.optional(),
  expectedBoundary: OperatorIdSchema.optional(),
  omitted: z.array(z.string().max(100)).max(32).optional(),
});
export type OperatorRow = z.infer<typeof OperatorRowSchema>;
export const OperatorPageResultSchema = z.object({
  target: OperatorTargetSchema,
  items: z.array(OperatorRowSchema).max(OPERATOR_MAX_PAGE_SIZE),
  asOf: z.iso.datetime(),
  revision: OperatorIdSchema,
  nextCursor: z.string().max(2048).optional(),
  truncated: z.boolean(),
  restartRequired: z.boolean(),
});
export type OperatorPageResult = z.infer<typeof OperatorPageResultSchema>;
export const OperatorConfigSchema = z.object({
  target: OperatorTargetSchema,
  activeGeneration: OperatorIdSchema,
  activeRevision: OperatorIdSchema,
  savedRevision: OperatorIdSchema,
  state: z.enum(["active", "pending", "restart-required", "invalid"]),
  asOf: z.iso.datetime(),
});
export const OperatorPreflightParamsSchema = z.strictObject({
  target: OperatorTargetSchema,
  purpose: z.enum(["request", "workflow"]),
  workflowId: OperatorIdSchema.optional(),
  workflowVersion: OperatorIdSchema.optional(),
  vars: z.record(z.string(), z.unknown()).default({}),
});
export const OperatorPreflightResultSchema = z.object({
  target: OperatorTargetSchema,
  workflowId: OperatorIdSchema,
  workflowVersion: OperatorIdSchema,
  expectedWorkflowRevision: OperatorIdSchema,
  expectedConfigGeneration: OperatorIdSchema,
  validation: ValidationResultSchema,
  asOf: z.iso.datetime(),
});
export const OperatorArtifactParamsSchema = z.strictObject({
  target: OperatorTargetSchema,
  runId: OperatorIdSchema,
  artifactId: OperatorIdSchema,
  maxBytes: z.number().int().positive().max(OPERATOR_CONTENT_BYTES).default(OPERATOR_CONTENT_BYTES),
});
export const OperatorArtifactResultSchema = z.object({
  target: OperatorTargetSchema,
  artifact: OperatorRowSchema,
  text: z.string().optional(),
  omitted: z.enum(["binary", "tooLarge", "sensitive"]).optional(),
  asOf: z.iso.datetime(),
});
export const OPERATOR_METHODS = [
  "operator.discover",
  "operator.page",
  "operator.config",
  "operator.preflight",
  "operator.artifact",
] as const;
