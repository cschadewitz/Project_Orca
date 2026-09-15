/**
 * Artifacts are the unit of hand-off between SDLC steps.
 *
 * Following the AI-native SDLC playbook, each stage ends by committing a
 * durable artifact (intent.md -> spec.md -> plan.md -> code/PR -> test report
 * -> review -> deploy report). The next stage's prompt is rendered from a
 * template *plus* the previous artifacts. ORCA never forwards raw chat
 * transcripts between agents; only artifacts cross step boundaries.
 */
import { z } from "zod";

/** Kinds shipped with ORCA. Plugins may register additional kinds. */
export const BUILTIN_ARTIFACT_KINDS = [
  "request", // the user's original feature/system request, normalised
  "decomposition", // request broken into work items (front matter: items[])
  "intent", // Plan stage: intent.md
  "spec", // Design stage: spec.md (requirements + design)
  "plan", // Build stage: implementation plan
  "implementation", // Build stage: summary of code changes (branch, commits, files)
  "test-report", // Test stage
  "review", // Deploy stage: review report (front matter: verdict)
  "deploy-report", // Deploy stage
  "metrics-report", // Maintain stage
  "decision", // any agent- or human-made decision (front matter: choice)
  "generic",
] as const;

export type BuiltinArtifactKind = (typeof BUILTIN_ARTIFACT_KINDS)[number];

export const ArtifactKindSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "artifact kinds are kebab-case");
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactProvenanceSchema = z.object({
  runId: z.string(),
  stepRunId: z.string().optional(),
  nodeId: z.string().optional(),
  agentSessionId: z.string().optional(),
  agentId: z.string().optional(),
  hostId: z.string().optional(),
});
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  kind: ArtifactKindSchema,
  /** Logical name within a run, e.g. "spec" or "review-2". Defaults to kind. */
  name: z.string(),
  /** Workspace-relative path where the artifact was materialised, if any. */
  path: z.string().optional(),
  mediaType: z.string().default("text/markdown"),
  contentHash: z.string(),
  size: z.number().int().nonnegative(),
  /** Monotonic per (run, name); a re-run of a step produces version+1. */
  version: z.number().int().positive(),
  producedBy: ArtifactProvenanceSchema,
  /** Artifacts this one was derived from (inputs to the producing step). */
  parents: z.array(z.string()).default([]),
  /** Structured data lifted from front matter / JSON body. */
  data: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Validation rules a node can attach to an artifact it expects. */
export const ArtifactValidationSchema = z.object({
  /** Front-matter fields that must be present and non-empty. */
  requiredFields: z.array(z.string()).optional(),
  /** Allowed values per front-matter field, e.g. { verdict: ["approve","changes-requested"] }. */
  fieldValues: z.record(z.string(), z.array(z.string())).optional(),
  /** Minimum body length in characters (guards against empty files). */
  minBodyLength: z.number().int().nonnegative().optional(),
});
export type ArtifactValidation = z.infer<typeof ArtifactValidationSchema>;

/**
 * What a node promises to produce. `path` is a template rendered against the
 * step context, e.g. ".orca/artifacts/{{workItem.slug}}/spec.md".
 */
export const ArtifactSpecSchema = z.object({
  kind: ArtifactKindSchema,
  name: z.string().optional(),
  path: z.string(),
  mediaType: z.string().optional(),
  required: z.boolean().default(true),
  validate: ArtifactValidationSchema.optional(),
});
export type ArtifactSpec = z.infer<typeof ArtifactSpecSchema>;

/**
 * How a node refers to artifacts it consumes. Resolution order: an explicit
 * `fromNode` beats `kind`/`name` lookups; `latest` picks the highest version
 * visible to the run (including parent runs, so sub-workflows see their
 * caller's artifacts).
 */
export const ArtifactRefSchema = z.object({
  kind: ArtifactKindSchema.optional(),
  name: z.string().optional(),
  fromNode: z.string().optional(),
  /** Alias used in the template context (`artifacts.<as>`). Defaults to name ?? kind. */
  as: z.string().optional(),
  required: z.boolean().default(true),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
