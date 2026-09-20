/**
 * `artifacts.list`, `artifacts.get` - the two reads behind the docked artifact panel.
 *
 * Artifacts are the hand-off between agents (ADR 0002), so the panel has to answer two
 * questions: which versions of this name exist, and what does one of them say. `list` is
 * the first - `ArtifactView` metadata only, never bodies, because a run with forty
 * artifacts would otherwise ship megabytes to draw a version list. `get` is the second, one
 * artifact at a time.
 *
 * `Artifact.version` is monotonic per (run, name), which is what makes `spec@v3` an address:
 * `get` takes either an `artifactId` or a (`runId`, `name`, `version?`) triple, and without
 * a `version` it answers the latest.
 *
 * A body travels as text or not at all. The store holds every blob as a UTF-8 string, but
 * the artifact's `mediaType` is what says whether that string is something to render, and
 * `size` is the index's own byte count - so a binary or oversized body is declined here,
 * with the reason, rather than being read off disk and thrown at a client.
 */
import { z } from "zod";
import { ArtifactViewSchema } from "./views.js";

export const ARTIFACTS_LIST_METHOD = "artifacts.list";
export const ARTIFACTS_GET_METHOD = "artifacts.get";

/** Media types that are text without saying `text/`. */
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/x-ndjson",
  "application/sql",
  "application/x-sh",
  "application/x-patch",
]);

/**
 * Whether a body of this media type is text a client can render. Generous with the
 * structured suffixes (`+json`, `+xml`, `+yaml`): a media type nobody registered is still
 * text when it says so.
 */
export function isTextMediaType(mediaType: string): boolean {
  const type = (mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (type.startsWith("text/")) return true;
  if (/\+(json|xml|yaml)$/.test(type)) return true;
  return TEXT_MEDIA_TYPES.has(type);
}

export const ArtifactsListParamsSchema = z.object({
  /** One run's artifacts. Absent: every artifact in the store. */
  runId: z.string().min(1).optional(),
  /** One logical name - every version of it, which is the panel's version list. */
  name: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  /** Only what this step run produced: the artifact chips on a step. */
  producedByStepRunId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).default(200),
  offset: z.number().int().nonnegative().default(0),
});
export type ArtifactsListParams = z.infer<typeof ArtifactsListParamsSchema>;

export const ArtifactsListResultSchema = z.object({
  /** Grouped by `name`, oldest version first: `v1, v2, v3` reads in that order. */
  artifacts: z.array(ArtifactViewSchema),
  /** How many match the filter, so a client can page without asking again. */
  total: z.number().int().nonnegative(),
  asOf: z.string(),
});
export type ArtifactsListResult = z.infer<typeof ArtifactsListResultSchema>;

/** The default body cap: enough for any artifact a person wrote, short of a machine's dump. */
export const ARTIFACT_TEXT_LIMIT_BYTES = 1_000_000;

export const ArtifactsGetParamsSchema = z
  .object({
    /** Address by id, or by the (`runId`, `name`, `version?`) triple below - one or the other. */
    artifactId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    /** Absent means the latest version of that name in that run. */
    version: z.number().int().positive().optional(),
    /** Bodies bigger than this are declined with `omitted.reason: "tooLarge"`. */
    maxBytes: z.number().int().positive().max(64_000_000).default(ARTIFACT_TEXT_LIMIT_BYTES),
  })
  .refine((p) => (p.artifactId !== undefined) !== (p.runId !== undefined && p.name !== undefined), {
    message: "address an artifact by 'artifactId', or by 'runId' and 'name' with an optional 'version'",
  });
export type ArtifactsGetParams = z.infer<typeof ArtifactsGetParamsSchema>;

export const ARTIFACT_OMITTED_REASONS = ["binary", "tooLarge"] as const;
export type ArtifactOmittedReason = (typeof ARTIFACT_OMITTED_REASONS)[number];

/** Why a body is not in the result. The size is on the `ArtifactView` beside it. */
export const ArtifactOmittedSchema = z.object({
  reason: z.enum(ARTIFACT_OMITTED_REASONS),
  /** In words, because it is what a panel shows where the body would have been. */
  detail: z.string(),
});
export type ArtifactOmitted = z.infer<typeof ArtifactOmittedSchema>;

export const ArtifactsGetResultSchema = z.object({
  artifact: ArtifactViewSchema,
  /** The body, verbatim. Present exactly when `omitted` is absent. */
  text: z.string().optional(),
  /** Present exactly when `text` is absent: the body exists and is not being shown. */
  omitted: ArtifactOmittedSchema.optional(),
  asOf: z.string(),
});
export type ArtifactsGetResult = z.infer<typeof ArtifactsGetResultSchema>;
