/**
 * Store format marker and cross-version carryover policy (#566).
 *
 * A store records the format (store epoch) and the ORCA version that last wrote it in
 * `store-format.json`. Every writer checks it before touching anything else:
 *
 * - Same format: open in place. An app update that keeps the format needs nothing else.
 * - The previous supported format, or an unmarked store written before the marker existed:
 *   carry it forward (store-format-carryover.ts): back the whole store up into
 *   `format-backups/`, verify the copy and that nothing else wrote meanwhile, read the store
 *   under the current format, and only then stamp the marker. Any failure refuses startup and
 *   leaves the prior format authoritative.
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
export type StoreFormatReason = "NEWER" | "TOO_OLD" | "DAMAGED" | "BUSY" | "UNREADABLE" | "BACKUPS_UNSAFE";
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
  | { status: "fresh" | "current"; epoch: string }
  /** Opened in place after carrying an older store forward; `backup` is absent in read mode. */
  | { status: "carried"; epoch: string; from: string | "unmarked"; backup?: string };

export interface StoreFormatOptions {
  /** The ORCA version doing the open, recorded in the marker. */
  appVersion: string;
  /** "read" checks only and never writes (closed update validation). */
  mode: "write" | "read";
  /** Injected for tests. */
  now?: () => Date;
  /** Test seam: runs after the backup copy, before the store is re-checked. */
  afterCopy?: () => Promise<void>;
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

/**
 * Check the store's format before any other store access and, in write mode, carry an older
 * store forward: back it up whole, then stamp the current format. Throws {@link StoreFormatError}.
 */
export async function enterStoreFormat(storeDir: string, options: StoreFormatOptions): Promise<StoreFormatOutcome> {
  const current = STORE_FORMAT_EPOCH;
  const check = async () => {
    const marker = await readStoreFormat(storeDir);
    if (marker) judge(storeDir, marker, current);
    return marker;
  };
  if (options.mode === "read") {
    const marker = await check();
    if (!marker)
      return (await holdsData(storeDir))
        ? { status: "carried", epoch: current, from: "unmarked" }
        : { status: "fresh", epoch: current };
    return marker.epoch === current
      ? { status: "current", epoch: current }
      : { status: "carried", epoch: current, from: marker.epoch };
  }
  await mkdir(storeDir, { recursive: true });
  return withFileLock(join(storeDir, LOCK), async () => {
    const marker = await check();
    const now = (options.now ?? (() => new Date()))();
    const stamp = async (backup?: string) => {
      const value: StoreFormatMarker = {
        format: 1,
        epoch: current,
        writtenBy: options.appVersion,
        updatedAt: now.toISOString(),
        ...(backup ? { backup } : marker?.backup ? { backup: marker.backup } : {}),
      };
      const tmp = join(storeDir, `${STORE_FORMAT_FILE}.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, join(storeDir, STORE_FORMAT_FILE));
    };
    if (marker?.epoch === current) {
      if (marker.writtenBy !== options.appVersion) await stamp();
      return { status: "current", epoch: current };
    }
    if (!marker && !(await holdsData(storeDir))) {
      await stamp();
      return { status: "fresh", epoch: current };
    }
    const from = marker?.epoch ?? "unmarked";
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
    await stamp(backup);
    await pruneFormatBackups(storeDir, backup);
    return { status: "carried", epoch: current, from, backup };
  });
}
