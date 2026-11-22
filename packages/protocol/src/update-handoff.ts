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
 * Before converting, the daemon moves the record onto its own claim (bounded by
 * {@link HANDOFF_ATTEMPTS}), so a carryover interrupted by a crash is retried by the next start
 * under the same proof. A finished or refused carryover removes the record.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fenceRead, FenceDirectorySchema, type FirstRunWriterHold } from "./first-run-fence.js";

/** In the store's top level; store carryover never copies or compares it. */
export const UPDATE_HANDOFF_FILE = "update-handoff.json";
/** Starts that may try to carry one store forward under one handoff (the first, then retries). */
export const HANDOFF_ATTEMPTS = 3;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
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

/** Durable replace. The store directory is private (0700, or a protected owner-only DACL that
 * new files inherit on Windows), and the reader verifies the file before trusting it. */
export function writeUpdateHandoff(storeDir: string, value: UpdateHandoff): void {
  const text = JSON.stringify(UpdateHandoffSchema.parse(value)) + "\n";
  const temporary = join(storeDir, `${UPDATE_HANDOFF_FILE}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, join(storeDir, UPDATE_HANDOFF_FILE));
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

/** `undefined` when there is none; a damaged, linked or foreign-owned record is never trusted. */
export function readUpdateHandoff(storeDir: string): UpdateHandoff | undefined {
  const path = join(storeDir, UPDATE_HANDOFF_FILE);
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
    return UpdateHandoffSchema.parse(JSON.parse(fenceRead(path)));
  } catch {
    return undefined;
  }
}

export function removeUpdateHandoff(storeDir: string): void {
  try {
    unlinkSync(join(storeDir, UPDATE_HANDOFF_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  syncDirectory(storeDir);
}

/**
 * Remove the handoff only when the record on disk is exactly `issued` (the receipt its writer
 * kept); a replacement, or a record moved onto a later claim, is left. Returns whether it was
 * removed.
 */
export function removeIssuedUpdateHandoff(storeDir: string, issued: UpdateHandoff): boolean {
  if (!same(readUpdateHandoff(storeDir), issued)) return false;
  removeUpdateHandoff(storeDir);
  return true;
}

/**
 * Remove the handoff only under proof this writer owns it: the fence holds, and the record on
 * disk satisfies `owns`, with the fence re-checked immediately before the unlink (no await in
 * between). Otherwise nothing in the store is changed. Returns whether it was removed.
 */
export function spendUpdateHandoff(hold: FirstRunWriterHold, owns: (handoff: UpdateHandoff) => boolean): boolean {
  if (!hold.check()) return false;
  const current = readUpdateHandoff(hold.storeDir);
  if (!current || !owns(current) || !hold.check()) return false;
  removeUpdateHandoff(hold.storeDir);
  return true;
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
  const handoff = readUpdateHandoff(hold.storeDir);
  if (!handoff) return { ok: false, reason: "none" };
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
  writeUpdateHandoff(hold.storeDir, moved);
  if (!hold.check()) return { ok: false, reason: "fence-not-held" };
  return { ok: true, handoff: moved };
}
