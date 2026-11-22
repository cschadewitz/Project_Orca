/**
 * Store format marker and cross-version carryover policy (#566).
 *
 * A store records the format (store epoch) and the ORCA version that last wrote it in
 * `store-format.json`. Every writer checks it before touching anything else:
 *
 * - Same format: open in place. An app update that keeps the format needs nothing else.
 * - The previous supported format, or an unmarked store written before the marker existed:
 *   open in place, but copy the whole store into `format-backups/` before the first write.
 *   Only the newest {@link STORE_FORMAT_BACKUP_RETENTION} complete backups are kept.
 * - An older format this build no longer reads: refuse, naming the release to open it with first.
 * - A format this build does not know (in practice, one written by a newer ORCA): refuse for
 *   reads and writes alike. The store is never rewritten.
 *
 * `STORE_FORMAT_EPOCH` must equal `storeEpoch` in `release-compatibility.json`; a test holds
 * them together. Changing the epoch means appending to {@link STORE_FORMAT_HISTORY}.
 */
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { OrcaError } from "@orca/core";
import { withFileLock } from "./file-lock.js";

/** Oldest first. `release` is the first release line that wrote the format. */
export const STORE_FORMAT_HISTORY: readonly { epoch: string; release: string }[] = [
  { epoch: "ownership-fences-v1", release: "0.6" },
  { epoch: "operator-journals-v4", release: "0.7" },
];
export const STORE_FORMAT_EPOCH = STORE_FORMAT_HISTORY.at(-1)!.epoch;
/** This format and the one before it are read in place. */
export const SUPPORTED_STORE_FORMATS: readonly string[] = STORE_FORMAT_HISTORY.slice(-2).map((f) => f.epoch);
export const STORE_FORMAT_FILE = "store-format.json";
export const STORE_FORMAT_BACKUP_DIR = "format-backups";
export const STORE_FORMAT_BACKUP_RETENTION = 2;
const LOCK = ".store-format.lock";
/** Never copied into a backup: the backups themselves, locks and update-window guards. */
const NOT_BACKED_UP = (name: string) =>
  name === STORE_FORMAT_BACKUP_DIR || name.endsWith(".lock") || name.startsWith(".orca-update-window");

const MarkerSchema = z.object({
  format: z.literal(1),
  epoch: z.string().regex(/^[a-z0-9-]{1,64}$/),
  writtenBy: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  backup: z.string().min(1).max(256).optional(),
});
export type StoreFormatMarker = z.infer<typeof MarkerSchema>;

export type StoreFormatReason = "NEWER" | "TOO_OLD" | "DAMAGED";
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
    const backup = await backupStore(storeDir, from, now);
    await stamp(backup);
    await pruneBackups(storeDir);
    return { status: "carried", epoch: current, from, backup };
  });
}

/** Copy everything but the backups into a new complete backup; published by rename only. */
async function backupStore(storeDir: string, from: string, now: Date): Promise<string> {
  const root = join(storeDir, STORE_FORMAT_BACKUP_DIR);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const name = `${now.toISOString().replace(/[:.]/g, "-")}-from-${from}`;
  const partial = join(root, `.partial-${randomUUID()}`);
  await mkdir(partial, { mode: 0o700 });
  for (const entry of await readdir(storeDir)) {
    if (NOT_BACKED_UP(entry) || entry.startsWith(`${STORE_FORMAT_FILE}.`)) continue;
    await cp(join(storeDir, entry), join(partial, entry), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      filter: (source) => !basename(source).endsWith(".lock"),
    });
  }
  let target = join(root, name);
  for (let n = 1; await exists(target); n++) target = join(root, `${name}-${n}`);
  await rename(partial, target);
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Keep the newest complete backups; drop leftovers of interrupted copies too. */
async function pruneBackups(storeDir: string): Promise<void> {
  const root = join(storeDir, STORE_FORMAT_BACKUP_DIR);
  const names = await readdir(root);
  for (const name of names.filter((n) => n.startsWith(".partial-")))
    await rm(join(root, name), { recursive: true, force: true });
  const complete = names.filter((n) => !n.startsWith(".")).sort();
  for (const name of complete.slice(0, Math.max(0, complete.length - STORE_FORMAT_BACKUP_RETENTION)))
    await rm(join(root, name), { recursive: true, force: true });
}
