/**
 * Store format marker and cross-version carryover policy (#566).
 *
 * A store records the format (store epoch) and the ORCA version that last wrote it in
 * `store-format.json`. Every writer checks it before touching anything else:
 *
 * - Same format, or an unmarked store this format's line already wrote: open in place (and
 *   stamp). An app update that keeps the format, the automatic desktop path, needs nothing else.
 * - The previous supported format, or an unmarked store from before that line: ordinary startup
 *   refuses (CARRYOVER_REQUIRED). `orca store carry-forward`, run with every other ORCA process
 *   stopped, converts it explicitly (store-format-carryover.ts): a verified whole-store backup
 *   into `format-backups/`, a check that nothing else wrote meanwhile, a read of the store under
 *   the current format, and only then the marker. Any failure leaves the prior format in charge.
 * - An older format this build no longer reads: refuse, naming the release to open it with first.
 * - A format this build does not know (in practice, one written by a newer ORCA): refuse for
 *   reads and writes alike. The store is never rewritten.
 *
 * `STORE_FORMAT_EPOCH` must equal `storeEpoch` in `release-compatibility.json`; a test holds
 * them together. Changing the epoch means appending to {@link STORE_FORMAT_HISTORY}.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OrcaError } from "@orca/core";
import { withFileLock } from "./file-lock.js";
import {
  CarryoverRefused,
  pruneFormatBackups,
  stageCarryover,
  STORE_FORMAT_BACKUP_DIR,
} from "./store-format-carryover.js";

export {
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_BACKUP_MANIFEST,
  STORE_FORMAT_BACKUP_RETENTION,
} from "./store-format-carryover.js";

/** Oldest first. `release` is the first release line that wrote the format. */
export const STORE_FORMAT_HISTORY: readonly { epoch: string; release: string }[] = [
  { epoch: "ownership-fences-v1", release: "0.6" },
  { epoch: "operator-journals-v4", release: "0.7" },
];
export const STORE_FORMAT_EPOCH = STORE_FORMAT_HISTORY.at(-1)!.epoch;
/** This format and the one before it are read in place. */
export const SUPPORTED_STORE_FORMATS: readonly string[] = STORE_FORMAT_HISTORY.slice(-2).map((f) => f.epoch);
export const STORE_FORMAT_FILE = "store-format.json";
const LOCK = ".store-format.lock";

const MarkerSchema = z.object({
  format: z.literal(1),
  epoch: z.string().regex(/^[a-z0-9-]{1,64}$/),
  writtenBy: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  backup: z.string().min(1).max(256).optional(),
});
export type StoreFormatMarker = z.infer<typeof MarkerSchema>;

/** NEWER, TOO_OLD and DAMAGED describe the marker; the rest are carryover refusals. */
export type StoreFormatReason =
  "NEWER" | "TOO_OLD" | "DAMAGED" | "CARRYOVER_REQUIRED" | "BUSY" | "UNREADABLE" | "BACKUPS_UNSAFE";
export class StoreFormatError extends OrcaError {
  override readonly name = "StoreFormatError";
  constructor(
    readonly reason: StoreFormatReason,
    message: string,
    storeDir: string,
  ) {
    super("STORE_FORMAT", message, { reason, storeDir });
  }
}

export type StoreFormatOutcome =
  /** `adopted`: an unmarked store this format's line wrote, now stamped without conversion. */
  | { status: "fresh" | "current" | "adopted"; epoch: string }
  /** Carried forward explicitly by {@link carryStoreForward}, after a verified backup. */
  | { status: "carried"; epoch: string; from: string | "unmarked"; backup: string };

export interface StoreFormatOptions {
  /** The ORCA version doing the open, recorded in the marker. */
  appVersion: string;
  /** "read" checks only and never writes (closed update validation). */
  mode: "write" | "read";
  /** Injected for tests. */
  now?: () => Date;
}

/** Read the marker without checking it; `undefined` when the store has none. */
export async function readStoreFormat(storeDir: string): Promise<StoreFormatMarker | undefined> {
  let text: string;
  try {
    text = await readFile(join(storeDir, STORE_FORMAT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return MarkerSchema.parse(JSON.parse(text));
  } catch {
    throw new StoreFormatError(
      "DAMAGED",
      `${join(storeDir, STORE_FORMAT_FILE)} is damaged. Restore a complete backup of the store, or stop ORCA and repair the file.`,
      storeDir,
    );
  }
}

/** Whether the store holds anything an earlier ORCA wrote (marker-less stores only). */
async function holdsData(storeDir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(storeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return names.some((n) => n === ".workspace-identified" || (!n.startsWith(".") && n !== STORE_FORMAT_BACKUP_DIR));
}

function judge(storeDir: string, marker: StoreFormatMarker, current: string): void {
  if (SUPPORTED_STORE_FORMATS.includes(marker.epoch)) return;
  const index = STORE_FORMAT_HISTORY.findIndex((f) => f.epoch === marker.epoch);
  const mine = STORE_FORMAT_HISTORY.findIndex((f) => f.epoch === current);
  if (index >= 0 && index < mine) {
    const bridge = STORE_FORMAT_HISTORY[index + 1]!;
    throw new StoreFormatError(
      "TOO_OLD",
      `This store was written by ORCA ${marker.writtenBy} (store format ${marker.epoch}), which this ORCA no longer opens directly. Open it once with ORCA ${bridge.release}.x to carry it forward, then try again.`,
      storeDir,
    );
  }
  throw new StoreFormatError(
    "NEWER",
    `This store was written by ORCA ${marker.writtenBy} (store format ${marker.epoch}), which is newer than this ORCA can open. Nothing was changed. Install ORCA ${marker.writtenBy} or later` +
      (marker.backup
        ? `, or restore the backup in ${marker.backup} to use this version (changes made after that backup are not in it).`
        : "."),
    storeDir,
  );
}

/** Written only by builds of the current format's line (#566 rehearsal: v0.6.0 has neither). */
async function identifiedAsCurrent(storeDir: string): Promise<boolean> {
  const names = await readdir(storeDir).catch(() => [] as string[]);
  return names.includes(".workspace-identified") && names.includes("workspace-identity");
}

const carryoverRequired = (storeDir: string, from: string) =>
  new StoreFormatError(
    "CARRYOVER_REQUIRED",
    `This store was written ${from === "unmarked" ? "by an ORCA release before 0.7" : `in store format ${from}`}, and this ORCA (store format ${STORE_FORMAT_EPOCH}) does not convert it during ordinary startup. Stop every ORCA app, daemon and command using it, then run \`orca store carry-forward\` once. Nothing was changed.`,
    storeDir,
  );

async function stamp(storeDir: string, appVersion: string, now: Date, backup: string | undefined): Promise<void> {
  const value: StoreFormatMarker = {
    format: 1,
    epoch: STORE_FORMAT_EPOCH,
    writtenBy: appVersion,
    updatedAt: now.toISOString(),
    ...(backup ? { backup } : {}),
  };
  const tmp = join(storeDir, `${STORE_FORMAT_FILE}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, join(storeDir, STORE_FORMAT_FILE));
}

/**
 * Check the store's format before any other store access. Ordinary startup never converts a
 * store: it opens the current format, stamps a fresh store or an unmarked store this format's
 * line already wrote, and refuses everything else (CARRYOVER_REQUIRED for an older format,
 * which {@link carryStoreForward} handles explicitly). Throws {@link StoreFormatError}.
 */
export async function enterStoreFormat(storeDir: string, options: StoreFormatOptions): Promise<StoreFormatOutcome> {
  const current = STORE_FORMAT_EPOCH;
  const check = async () => {
    const marker = await readStoreFormat(storeDir);
    if (marker) judge(storeDir, marker, current);
    return marker;
  };
  const classify = async (marker: StoreFormatMarker | undefined) => {
    if (marker?.epoch === current) return "current" as const;
    if (marker) throw carryoverRequired(storeDir, marker.epoch);
    if (!(await holdsData(storeDir))) return "fresh" as const;
    if (await identifiedAsCurrent(storeDir)) return "adopted" as const;
    throw carryoverRequired(storeDir, "unmarked");
  };
  if (options.mode === "read") return { status: await classify(await check()), epoch: current };
  await mkdir(storeDir, { recursive: true });
  return withFileLock(join(storeDir, LOCK), async () => {
    const marker = await check();
    const status = await classify(marker);
    const now = (options.now ?? (() => new Date()))();
    if (status !== "current" || marker?.writtenBy !== options.appVersion)
      await stamp(storeDir, options.appVersion, now, marker?.backup);
    return { status, epoch: current };
  });
}

/**
 * The explicit, offline carryover of an older-format store (`orca store carry-forward`). The
 * caller states that every other ORCA process using the store is stopped; this still refuses
 * when quiescence cannot be confirmed (store-format-carryover.ts), and stamps the current
 * format only after a verified backup and a read check. Throws {@link StoreFormatError}.
 */
export async function carryStoreForward(
  storeDir: string,
  options: { appVersion: string; now?: () => Date; afterCopy?: () => Promise<void> },
): Promise<StoreFormatOutcome> {
  const current = STORE_FORMAT_EPOCH;
  return withFileLock(join(storeDir, LOCK), async () => {
    const marker = await readStoreFormat(storeDir);
    if (marker) judge(storeDir, marker, current);
    if (marker?.epoch === current) return { status: "current", epoch: current };
    if (!marker && !(await holdsData(storeDir)))
      throw new StoreFormatError("UNREADABLE", `${storeDir} holds no ORCA store to carry forward.`, storeDir);
    const from = marker?.epoch ?? "unmarked";
    const now = (options.now ?? (() => new Date()))();
    let backup: string;
    try {
      const staged = await stageCarryover(storeDir, from, current, now, {
        ...(options.afterCopy ? { afterCopy: options.afterCopy } : {}),
      });
      backup = await staged.commit();
    } catch (error) {
      if (error instanceof CarryoverRefused) throw new StoreFormatError(error.failure, error.message, storeDir);
      throw error;
    }
    await stamp(storeDir, options.appVersion, now, backup);
    await pruneFormatBackups(storeDir, backup);
    return { status: "carried", epoch: current, from, backup };
  });
}
