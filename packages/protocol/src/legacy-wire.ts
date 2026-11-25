/**
 * Wire fields renamed with the product (0.9, the rename to Orrery), for one release.
 *
 * A daemon sends each renamed field under both names, so a client from before the rename still
 * finds the one it requires; a reader takes either, so a client from now on still reads a daemon
 * from before. 0.10 stops sending and reading the old names. The old halves are marked
 * `rename-keep`; until the codemod runs the two names are the same and all of this is a no-op.
 */
import { z } from "zod";

/** The release a daemon runs, in `hello` and `operator.discover`. */
export const VERSION_FIELD = "orcaVersion";
/** Its name before the rename: sent beside it and read when it is absent, until 0.10. */
export const LEGACY_VERSION_FIELD = "orcaVersion"; // rename-keep: the pre-rename wire field

/** What a result declares for the old name, ahead of the current field, so parsing keeps it. */
export const LEGACY_VERSION_SHAPE = { orcaVersion: z.string().max(100).optional() }; // rename-keep: pre-rename wire field

/** The old name's half of a result, for a daemon to spread ahead of the current field. */
export function legacyVersionField(version: string): z.infer<z.ZodObject<typeof LEGACY_VERSION_SHAPE>> {
  return { [LEGACY_VERSION_FIELD]: version };
}

/** `schema`, reading the version under its old name when a daemon from before the rename sent only that. */
export function readingLegacyVersion<T extends z.ZodType>(schema: T) {
  return z.preprocess((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const record = raw as Record<string, unknown>;
    if (record[VERSION_FIELD] !== undefined || typeof record[LEGACY_VERSION_FIELD] !== "string") return raw;
    return { ...record, [VERSION_FIELD]: record[LEGACY_VERSION_FIELD] };
  }, schema);
}
