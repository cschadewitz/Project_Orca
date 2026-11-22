/**
 * The small shapes several read methods share: an artifact as a client lists it, a work
 * item as a crumb, an error as a client shows it.
 *
 * These are *display* read models. They carry what a screen needs to render an object and
 * to link to it, not the engine's record of it - `ArtifactView` has no provenance graph and
 * no front-matter data, because listing a gate's artifacts must not ship a run's whole
 * artifact history to a client that will render six chips.
 */
import { z } from "zod";

export const ViewErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ViewError = z.infer<typeof ViewErrorSchema>;

export const ArtifactViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  /** Logical name within the run (`spec`, `review-2`); the label a chip shows. */
  name: z.string(),
  /** Monotonic per (run, name): the version a deep link addresses. */
  version: z.number().int().positive(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  /** Absolute path on the producing host, when it was materialised as a file. */
  path: z.string().optional(),
  createdAt: z.string(),
  producedByStepRunId: z.string().optional(),
  /** The body's sha256, hex (protocol 2.4): what a copy of the artifact is checked against. */
  contentHash: z.string().optional(),
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

/** The work item a run or a claim is about, as the object header shows it. */
export const WorkItemViewSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  status: z.string(),
});
export type WorkItemView = z.infer<typeof WorkItemViewSchema>;
