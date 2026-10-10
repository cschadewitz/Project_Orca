/** Authorized local template authoring; source Save and generation Apply are separate commands. */
import { z } from "zod";
import { ConfigApplyResultSchema } from "./config.js";
const identity = z.strictObject({ workspaceId: z.string().min(1), instanceId: z.string().min(1) });
const revision = z.string();
const text = z.string().max(262_144);
export const TemplateDiagnosticSchema = z.object({
  key: z.string().optional(),
  code: z.enum(["duplicate-id", "missing-id", "front-matter", "reference", "compatibility", "invalid"]),
  message: z.string(),
});
export const TemplateCatalogSchema = z.object({
  target: identity,
  catalogRevision: revision,
  /** Config and workflow source fence, independent of instruction-source saves. */
  contextRevision: revision,
  configRevision: revision,
  generation: z.string().min(1),
  assets: z.array(
    z.object({
      key: z.string(),
      id: z.string(),
      revision,
      version: z.string(),
      requires: z.array(z.string()),
      partials: z.array(z.string()),
      usedBy: z.array(z.string()),
      source: z.discriminatedUnion("state", [
        z.object({ state: z.literal("available"), text }),
        z.object({ state: z.literal("withheld") }),
      ]),
    }),
  ),
  assignments: z.array(
    z.object({
      key: z.string(),
      workflowId: z.string(),
      nodeId: z.string(),
      revision,
      templateId: z.string().optional(),
    }),
  ),
  workflows: z.array(z.object({ id: z.string(), version: z.string() })),
  errors: z.array(TemplateDiagnosticSchema),
});
export const TemplateReadParamsSchema = z.strictObject({});
export const TemplateCandidateSchema = z.strictObject({
  target: identity,
  key: z.string().min(1),
  expectedSourceRevision: revision,
  expectedCatalogRevision: revision,
  expectedConfigGeneration: z.string().min(1),
  draftSequence: z.number().int().nonnegative(),
  text,
});
export const TemplateReviewSchema = z.object({
  candidateRevision: z.string().min(1),
  errors: z.array(TemplateDiagnosticSchema),
  compatibility: z.enum(["compatible", "incompatible", "unavailable"]),
  changes: z.array(z.string()),
});
export const TemplatePreviewParamsSchema = z.strictObject({
  candidate: TemplateCandidateSchema.optional(),
  target: identity,
  expectedCatalogRevision: revision,
  expectedConfigGeneration: z.string().min(1),
  id: z.string().min(1),
  pack: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  fixtures: z.strictObject({ values: z.record(z.string(), z.unknown()), artifacts: z.record(z.string(), z.string()) }),
});
export const TemplatePreviewSchema = z.object({
  requestedId: z.string(),
  resolvedId: z.string(),
  fallback: z.boolean(),
  partialIds: z.array(z.string()),
  text,
});
export const TemplateSaveParamsSchema = z.strictObject({
  candidate: TemplateCandidateSchema,
  candidateRevision: z.string().min(1),
});
export const TemplateSaveResultSchema = z.object({
  status: z.literal("saved"),
  candidateRevision: z.string(),
  snapshot: TemplateCatalogSchema,
});
export const TemplateVariantParamsSchema = z.strictObject({
  target: identity,
  key: z.string(),
  expectedSourceRevision: revision,
  expectedCatalogRevision: revision,
  expectedConfigGeneration: z.string(),
  pack: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
export const TemplateVariantResultSchema = z.object({ key: z.string(), text });
export const TemplatePublicationParamsSchema = z.strictObject({
  target: identity,
  expectedCatalogRevision: revision,
  expectedConfigRevision: revision,
  expectedConfigGeneration: z.string().min(1),
  validateOnly: z.boolean().optional(),
});
export const TemplateAssignmentParamsSchema = z.strictObject({
  target: identity,
  expectedCatalogRevision: revision,
  expectedConfigGeneration: z.string(),
  key: z.string(),
  expectedSourceRevision: revision,
  templateId: z.string().min(1),
  version: z.string().min(1),
  validateOnly: z.boolean().optional(),
  candidateRevision: z.string().optional(),
});
export const TemplateAssignmentResultSchema = z.object({
  written: z.boolean(),
  candidateRevision: z.string(),
  snapshot: TemplateCatalogSchema,
});
export const TemplateHistoryParamsSchema = z.strictObject({ target: identity, key: z.string().min(1) });
export const TemplateHistoryResultSchema = z.object({
  entries: z.array(
    z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime(), generation: z.uuid().optional() }),
  ),
  /** Digest-only acknowledged source saves and activations; does not provide old source lookup. */
  scope: z.literal("acknowledged-local-revisions"),
});
export const TEMPLATE_METHOD_CONTRACTS = {
  "templates.get": { params: TemplateReadParamsSchema, result: TemplateCatalogSchema },
  "templates.validate": { params: TemplateCandidateSchema, result: TemplateReviewSchema },
  "templates.preview": { params: TemplatePreviewParamsSchema, result: TemplatePreviewSchema },
  "templates.variant": { params: TemplateVariantParamsSchema, result: TemplateVariantResultSchema },
  "templates.save": { params: TemplateSaveParamsSchema, result: TemplateSaveResultSchema },
  "templates.assign": { params: TemplateAssignmentParamsSchema, result: TemplateAssignmentResultSchema },
  "templates.publish": { params: TemplatePublicationParamsSchema, result: ConfigApplyResultSchema },
  "templates.history": { params: TemplateHistoryParamsSchema, result: TemplateHistoryResultSchema },
} as const;
export type TemplateCatalog = z.infer<typeof TemplateCatalogSchema>;
export type TemplateSourceCandidate = z.infer<typeof TemplateCandidateSchema>;
export type TemplateSourceReview = z.infer<typeof TemplateReviewSchema>;
export type TemplatePreviewParams = z.infer<typeof TemplatePreviewParamsSchema>;
export type TemplateVariantParams = z.infer<typeof TemplateVariantParamsSchema>;
export type TemplatePublicationParams = z.infer<typeof TemplatePublicationParamsSchema>;
export type TemplateAssignmentParams = z.infer<typeof TemplateAssignmentParamsSchema>;
