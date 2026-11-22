/**
 * Node-only. The updater's ownership of a desktop store, carried across an app update into the
 * first start of the new app (#897).
 *
 * Before the Windows updater launches the installer it has already closed admission on the
 * bundled daemon, drained it, stopped it, observed that exact child exit and recorded the
 * terminal evidence in the first-run journal. It then writes this record into the store, bound
 * to the exact store and workspace directories, to the journal claim of the daemon it stopped,
 * and to the version being installed.
 *
 * The record grants nothing by itself. The new daemon may carry the store forward only when it
 * also holds the first-run writer fence ({@link FirstRunWriterHold}) and its own claim directly
 * follows the one the record names: that proves no other reservation, and so no other
 * participating writer, opened the store between the update stop and this start. Any later
 * reservation has a different predecessor, so a record that was not used in time is inert.
 *
 * Each record lives at a path named by the claim it passes ownership from
 * (`update-handoff.json.<claimHash>`), and the updater publishes it without replacing anything
 * ({@link publishUpdateHandoff}: create-exclusive). A stale updater can therefore only ever write
 * the record for its own stopped claim; it can never replace a newer valid record, which names
 * another claim. Readers look only at the record for the claim they directly follow.
 *
 * Before converting, the daemon moves the record onto its own claim (bounded by
 * {@link HANDOFF_ATTEMPTS}), so a carryover interrupted by a crash is retried by the next start
 * under the same proof. A finished or refused carryover removes the record. Only a writer that
 * holds the fence ever replaces or removes a record, and only the one for its own claim or the
 * claim it follows ({@link spendUpdateHandoff}); the updater never does.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fenceRead, FenceDirectorySchema, type FirstRunWriterHold } from "./first-run-fence.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * The prefix of every record in the store's top level (`update-handoff.json.<claimHash>`); store
 * carryover never copies or compares anything named with it.
 */
export const UPDATE_HANDOFF_FILE = "update-handoff.json";
/** The record passing ownership from `claimHash`. */
export const updateHandoffPath = (storeDir: string, claimHash: string): string =>
  join(storeDir, `${UPDATE_HANDOFF_FILE}.${digest.parse(claimHash)}`);
/** Starts that may try to carry one store forward under one handoff (the first, then retries). */
export const HANDOFF_ATTEMPTS = 3;
const version = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[0-9A-Za-z.+-]+$/);
export const UpdateHandoffSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("orca-update-handoff"),
  /** The journal claim this handoff passes ownership from: the stopped daemon's, or a retry's. */
  reservationId: z.uuid(),
  claimHash: digest,
  workspace: FenceDirectorySchema,
  store: FenceDirectorySchema,
  /** The app version that stopped the daemon, and the version it installed. */
  from: version,
  to: version,
  /** Admission was closed and the daemon reported no active work before it was stopped. */
  drained: z.literal(true),
  /** Starts that have already begun a carryover under this handoff. */
  attempts: z.number().int().min(0).max(HANDOFF_ATTEMPTS),
  createdAt: z.string().min(1).max(64),
});
export type UpdateHandoff = z.infer<typeof UpdateHandoffSchema>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const serialize = (value: UpdateHandoff) => JSON.stringify(UpdateHandoffSchema.parse(value)) + "\n";

/**
 * The updater's publication: the record for the stopped claim, created exclusively and flushed.
 * Throws (EEXIST) rather than replace anything already at that path; a crash mid-write leaves a
 * record that never parses, which grants nothing. The store directory is private (0700, or a
 * protected owner-only DACL that new files inherit on Windows), and readers verify the file.
 */
export function publishUpdateHandoff(storeDir: string, value: UpdateHandoff): void {
  const text = serialize(value);
  const fd = openSync(
    updateHandoffPath(storeDir, value.claimHash),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(storeDir);
}

/**
 * A fenced writer's durable replace of the record for `value.claimHash` (its own claim, when it
 * moves a handoff onto itself). Never called by the updater.
 */
export function writeUpdateHandoff(storeDir: string, value: UpdateHandoff): void {
  const text = serialize(value);
  const temporary = join(storeDir, `${UPDATE_HANDOFF_FILE}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, updateHandoffPath(storeDir, value.claimHash));
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Left for the next writer: never read, never trusted.
    }
    throw error;
  }
  syncDirectory(storeDir);
}

/**
 * The record passing ownership from `claimHash`, or `undefined` when there is none; a damaged,
 * linked or foreign-owned record, or one naming another claim than its path, is never trusted.
 */
export function readUpdateHandoff(storeDir: string, claimHash: string): UpdateHandoff | undefined {
  const path = updateHandoffPath(storeDir, claimHash);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // fenceRead verifies the owner, a single link and (on Windows) an owner-only ACL; on POSIX the
  // record must also be owner-only.
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) return undefined;
  try {
    const handoff = UpdateHandoffSchema.parse(JSON.parse(fenceRead(path)));
    return handoff.claimHash === claimHash ? handoff : undefined;
  } catch {
    return undefined;
  }
}

export function removeUpdateHandoff(storeDir: string, claimHash: string): void {
  try {
    unlinkSync(updateHandoffPath(storeDir, claimHash));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  syncDirectory(storeDir);
}

/**
 * Remove a handoff only under proof this writer owns it: only the records for this writer's own
 * claim and the claim it directly follows are considered, the fence holds, and the record on
 * disk satisfies `owns`, with the fence re-checked immediately before each unlink (no await in
 * between). Otherwise nothing in the store is changed. Returns whether one was removed.
 */
export function spendUpdateHandoff(hold: FirstRunWriterHold, owns: (handoff: UpdateHandoff) => boolean): boolean {
  let spent = false;
  for (const claim of [hold.claimHash, hold.previous]) {
    if (claim === null || !hold.check()) continue;
    const current = readUpdateHandoff(hold.storeDir, claim);
    if (!current || !owns(current) || !hold.check()) continue;
    removeUpdateHandoff(hold.storeDir, claim);
    spent = true;
  }
  return spent;
}

/**
 * A handoff for an update that kept the store format, once its daemon holds the store: one that
 * names this exact store and either the claim this writer directly follows (the stopped daemon's)
 * or this writer's own claim (an earlier start of this writer moved it). Anything else is left.
 */
export function spendSameFormatHandoff(hold: FirstRunWriterHold): boolean {
  return spendUpdateHandoff(
    hold,
    (handoff) =>
      same(handoff.store, hold.store) &&
      same(handoff.workspace, hold.workspace) &&
      (handoff.claimHash === hold.claimHash || (hold.previous !== null && handoff.claimHash === hold.previous)),
  );
}

export type HandoffRefusal =
  | "none"
  | "not-first-run"
  | "fence-not-held"
  | "other-store"
  | "not-next-reservation"
  | "other-version"
  | "attempts-exhausted";

/**
 * Whether this writer may carry its store forward automatically: it holds the first-run writer
 * fence for the exact store the handoff names, its claim directly follows the handoff's, and it
 * is the version the update installed. On success the handoff is moved onto this writer's own
 * claim before anything is copied, so a crash mid-carryover leaves the next start able to retry.
 */
export function claimUpdateHandoff(
  hold: FirstRunWriterHold | undefined,
  appVersion: string,
  now: () => Date = () => new Date(),
): { ok: true; handoff: UpdateHandoff } | { ok: false; reason: HandoffRefusal } {
  if (!hold) return { ok: false, reason: "not-first-run" };
  // Only the record for the claim this writer directly follows can be its handoff.
  const handoff = hold.previous === null ? undefined : readUpdateHandoff(hold.storeDir, hold.previous);
  if (!handoff) return { ok: false, reason: hold.previous === null ? "not-next-reservation" : "none" };
  if (!hold.check()) return { ok: false, reason: "fence-not-held" };
  if (!same(handoff.store, hold.store) || !same(handoff.workspace, hold.workspace))
    return { ok: false, reason: "other-store" };
  if (hold.previous === null || handoff.claimHash !== hold.previous)
    return { ok: false, reason: "not-next-reservation" };
  if (handoff.to !== appVersion) return { ok: false, reason: "other-version" };
  if (handoff.attempts >= HANDOFF_ATTEMPTS) return { ok: false, reason: "attempts-exhausted" };
  const moved: UpdateHandoff = {
    ...handoff,
    reservationId: hold.reservationId,
    claimHash: hold.claimHash,
    attempts: handoff.attempts + 1,
    createdAt: now().toISOString(),
  };
  // Moved onto this writer's own claim first, then the record it came from is removed: a crash
  // in between leaves the moved record for the next start, and the old one inert.
  writeUpdateHandoff(hold.storeDir, moved);
  if (!hold.check()) return { ok: false, reason: "fence-not-held" };
  removeUpdateHandoff(hold.storeDir, handoff.claimHash);
  if (!hold.check()) return { ok: false, reason: "fence-not-held" };
  return { ok: true, handoff: moved };
}
