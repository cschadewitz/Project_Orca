/**
 * `search` - substring search over event text and artifact contents, answered by the daemon
 * within a bound (#255, protocol 2.2).
 *
 * The palette's search section used to cover step and artifact *names* only, because
 * `runs.events` pages rather than matches and scanning every log from the renderer on each
 * keystroke would be a denial of service against your own daemon. This is the daemon-side
 * method that section was waiting for.
 *
 * Decisions, in the order the issue asked them:
 *
 * - **Scope**: the whole store, newest run first, or one run when `runId` is given.
 * - **What is searched**: the text of events - every string in an event's payload except
 *   identifiers (keys ending `Id`/`Ids`), so a hit is words a person or an agent wrote, not
 *   an id that happens to contain the query - and the contents of text artifacts
 *   (`isTextMediaType`) up to a size cap. Binary artifacts are not searched (#226).
 * - **What comes back**: a hit is a place. An event hit carries its `runId` and `seq`, and the
 *   step it belongs to as a node and attempt when it has one; an artifact hit carries its
 *   `runId`, `name` and `version`. That is enough for a client to build the canonical
 *   `orca://` URL without a second read, so the route table stays the single resolver.
 * - **Matching**: case-insensitive substring. Nothing ranked, fuzzy or regex: that would be
 *   a promise about a corpus nobody has measured.
 * - **Bounding**: `limit` hits and a deadline. When either cuts the scan short the result
 *   says which (`truncated`), so a client can say "more may exist" rather than imply none.
 *   The deadline is cooperative: it is checked between storage reads, and a read already in
 *   flight finishes, so a slow disk can carry an answer past it by one read.
 * - **Cost**: there is no index. Each call reads logs from disk, newest run first, until the
 *   limit or the deadline; durable indexing belongs to #339/#341.
 *
 * It sits under `runs.read` (it is listed in `READ_METHODS`), so a `--read-only` daemon
 * answers it, and it shows a caller only what `runs.events` and `artifacts.get` would: runs
 * the caller can see, and artifact hits only with `artifacts.read`. A caller whose scope is
 * limited to some runs must name one in `runId`; a search across the whole store is refused
 * with `AUTH_FORBIDDEN` for it until there is an authorization-scoped run catalog.
 */
import { z } from "zod";

export const SEARCH_METHOD = "search";

/** The shortest query the daemon scans for: one character would match nearly everything. */
export const SEARCH_MIN_QUERY = 2;
/** Artifacts larger than this are not read for a search; `artifacts.get` still shows them. */
export const SEARCH_ARTIFACT_MAX_BYTES = 256_000;
/** How long one call may scan before it answers with what it has. */
export const SEARCH_DEADLINE_MS = 1_500;

export const SEARCH_KINDS = ["event", "artifact"] as const;
export const SearchKindSchema = z.enum(SEARCH_KINDS);
export type SearchKind = z.infer<typeof SearchKindSchema>;

export const SearchParamsSchema = z.object({
  /** Matched case-insensitively as a substring. Surrounding whitespace is ignored. */
  query: z
    .string()
    .max(200)
    .transform((q) => q.trim())
    .pipe(z.string().min(SEARCH_MIN_QUERY)),
  /** One run. Absent: every run in the store the caller can see, newest first. */
  runId: z.string().min(1).optional(),
  /** Which kinds of hit to look for. Absent: both. */
  kinds: z.array(SearchKindSchema).min(1).optional(),
  limit: z.number().int().positive().max(100).default(20),
});
export type SearchParams = z.infer<typeof SearchParamsSchema>;

/** A short piece of the matched text around the match, for a result row's second column. */
const Excerpt = z.string().max(400);

export const SearchEventHitSchema = z.object({
  kind: z.literal("event"),
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  type: z.string(),
  /** The step the event belongs to, as its route addresses it, when it belongs to one. */
  step: z.object({ nodeId: z.string(), attempt: z.number().int().positive() }).optional(),
  excerpt: Excerpt,
});
export type SearchEventHit = z.infer<typeof SearchEventHitSchema>;

export const SearchArtifactHitSchema = z.object({
  kind: z.literal("artifact"),
  runId: z.string(),
  artifactId: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  excerpt: Excerpt,
});
export type SearchArtifactHit = z.infer<typeof SearchArtifactHitSchema>;

export const SearchHitSchema = z.discriminatedUnion("kind", [SearchEventHitSchema, SearchArtifactHitSchema]);
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z.object({
  /** Newest run first; within a run, events in log order, then artifacts by name and version. */
  hits: z.array(SearchHitSchema),
  /** Present when the scan stopped before the whole scope was read, and why. */
  truncated: z.enum(["limit", "deadline"]).optional(),
  /** How many runs were read, whole or in part. */
  scannedRuns: z.number().int().nonnegative(),
  asOf: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
