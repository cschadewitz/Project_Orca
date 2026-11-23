/**
 * Convert a file store into a SQLite store of its own, beside it (#339): `orca store sqlite
 * convert`. The file store is left exactly as it was.
 *
 * Switching a store to SQLite in place cannot be made safe while a released ORCA (0.7.0 and
 * earlier) may still be running against it: those versions never read the format marker, do not
 * register as writers, and leave nothing in the store while idle that could be checked for. A
 * conversion never changes what they have open. Under the source's format lock, with this
 * ORCA's own writers refused (store-writers.ts):
 *
 * 1. The source is copied whole into `<store>-sqlite.partial-<id>` beside it, byte-checked, and
 *    must not have changed meanwhile.
 * 2. The copy, which nothing else has open, is switched in place (`switchStoreToSqlite` with
 *    `copyOf`): imported, verified, bound, fenced against released ORCA (sqlite/legacy-fence.ts)
 *    and marked as SQLite, recording the source and the signature of its files.
 * 3. The copy is renamed to `<store>-sqlite`, and the caller publishes it (`publish`: the CLI
 *    names it as the store in the workspace's config). The source must still be unchanged right
 *    before; the published store is never taken back.
 *
 * Nothing opens the new store until it is published, and no released ORCA has ever had it open,
 * so the fence holds for every one of them that reads the config afterwards. One that was already
 * running keeps the file store, and what it writes there is not in the new store:
 * {@link convertedSourceChanged} reports it.
 */
import { randomUUID } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createCopy, syncDirectory } from "./durable-file.js";
import { withFileLock } from "./file-lock.js";
import { FileLeaseStore, lapsed } from "./lease-store.js";
import { readSqliteSwitchJournal } from "./sqlite/legacy-fence.js";
import {
  CarryoverRefused,
  copyStoreInto,
  posixPrivateCopy,
  sameStoreSnapshot,
  snapshotStore,
  storeSnapshotSignature,
  type PrivateCopyBackend,
} from "./store-format-carryover.js";
import {
  readStoreFormat,
  STORE_FORMAT_EPOCH,
  STORE_FORMAT_LOCK,
  StoreFormatError,
  switchStoreToSqlite,
} from "./store-format.js";
import { SQLITE_STORE_FORMAT_EPOCH, STORE_FORMAT_FILE } from "./store-backend.js";
import { beginStoreSwitch, liveStoreWriters } from "./store-writers.js";

/** The name a converted store takes beside its source: `.orca` becomes `.orca-sqlite`. */
export const CONVERTED_STORE_SUFFIX = "-sqlite";

/** Where {@link convertStoreToSqlite} puts the SQLite store converted from `storeDir`. */
export function convertedStoreDir(storeDir: string): string {
  return join(dirname(storeDir), `${basename(storeDir)}${CONVERTED_STORE_SUFFIX}`);
}

export interface ConvertToSqliteOptions {
  appVersion: string;
  /**
   * Make the converted store the workspace's store. Called once, under the source's format lock,
   * with the source unchanged since it was copied; when it returns, the conversion is done.
   */
  publish: (convertedDir: string) => Promise<void>;
  now?: () => Date;
  privacy?: PrivateCopyBackend;
  /** Injected for tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /** Injected for tests: runs after the copy, before the source is checked again. */
  afterCopy?: () => Promise<void>;
  /** Injected for tests: runs after the converted store is in place, before it is published. */
  beforePublish?: () => Promise<void>;
}

export type ConvertToSqliteOutcome =
  /** Converted now; or `finished`: converted earlier and published only now. */
  | { status: "converted" | "finished"; convertedDir: string }
  /** The store is already on SQLite: nothing to convert. */
  | { status: "current"; epoch: string };

const refused = (storeDir: string, message: string) => new StoreFormatError("SWITCH_REFUSED", message, storeDir);

/** Convert `storeDir` (a file store) into {@link convertedStoreDir}. Throws {@link StoreFormatError}. */
export async function convertStoreToSqlite(
  storeDir: string,
  options: ConvertToSqliteOptions,
): Promise<ConvertToSqliteOutcome> {
  const target = convertedStoreDir(storeDir);
  const now = (options.now ?? (() => new Date()))();
  const privacy = options.privacy ?? posixPrivateCopy;
  return withFileLock(join(storeDir, STORE_FORMAT_LOCK), async (): Promise<ConvertToSqliteOutcome> => {
    if (await readSqliteSwitchJournal(storeDir))
      throw new StoreFormatError(
        "INTERRUPTED",
        "A switch of this store to SQLite in place was interrupted. Start ORCA once to finish or undo it, then convert it. Nothing was changed.",
        storeDir,
      );
    const marker = await readStoreFormat(storeDir);
    if (marker?.epoch === SQLITE_STORE_FORMAT_EPOCH) return { status: "current", epoch: marker.epoch };
    if (!marker)
      throw refused(
        storeDir,
        "This store has no format marker yet. Open it once with this ORCA (start it, or run any command against it), then convert it. Nothing was changed.",
      );
    if (marker.epoch !== STORE_FORMAT_EPOCH)
      throw refused(
        storeDir,
        `This store is in store format ${marker.epoch}, not this ORCA's ${STORE_FORMAT_EPOCH}. Carry it forward first (\`orca store carry-forward\`), then convert it. Nothing was changed.`,
      );
    if ((options.platform ?? process.platform) === "win32")
      throw new StoreFormatError(
        "UNDURABLE",
        "This ORCA does not yet change a store's format on Windows, because it cannot yet prove that what it writes survives a power cut (#947). Nothing was changed, and the store stays on files.",
        storeDir,
      );
    const announcement = beginStoreSwitch(storeDir, options.appVersion);
    try {
      const writers = liveStoreWriters(storeDir);
      if (writers.length)
        throw new StoreFormatError(
          "BUSY",
          `This store is open in another ORCA process (${writers
            .slice(0, 3)
            .map((w) => `${w.purpose} ${w.pid} on ${w.host}, ORCA ${w.appVersion}`)
            .join("; ")}). Stop it, then convert the store again. Nothing was changed.`,
          storeDir,
        );
      const existing = await readStoreFormat(target).catch(() => "unreadable" as const);
      if (existing !== undefined || (await present(target))) {
        // Converted before and not published (interrupted, or the publication was lost): publish
        // that store, as long as the source is still what was converted. It may have been in use
        // already, so it is never replaced or removed here.
        const from =
          existing !== "unreadable" && existing?.epoch === SQLITE_STORE_FORMAT_EPOCH
            ? existing.convertedFrom
            : undefined;
        if (from?.store !== storeDir)
          throw refused(
            storeDir,
            `${target} already exists and is not this store's conversion. Move it out of the way, then convert again. Nothing was changed.`,
          );
        if (storeSnapshotSignature(await snapshotStore(storeDir)) !== from.signature)
          throw new StoreFormatError(
            "SOURCE_CHANGED",
            `${target} was converted from this store, which has changed since, so it was not put in use. Move ${target} out of the way to convert again. Nothing was changed.`,
            storeDir,
          );
        await options.publish(target);
        return { status: "finished", convertedDir: target };
      }
      await removePartials(target);
      await refuseActiveRuns(storeDir);

      const before = await snapshotStore(storeDir);
      const partial = `${target}.partial-${randomUUID()}`;
      try {
        if (!(await copyStoreInto(storeDir, partial, before, privacy))) throw busy(storeDir);
        // The marker is left out of a snapshot; the copy starts in the same format.
        await createCopy(join(storeDir, STORE_FORMAT_FILE), join(partial, STORE_FORMAT_FILE));
        await syncDirectory(partial);
        await options.afterCopy?.();
        if (!sameStoreSnapshot(before, await snapshotStore(storeDir))) throw busy(storeDir);
        const signature = storeSnapshotSignature(before);
        await switchStoreToSqlite(partial, {
          appVersion: options.appVersion,
          now: () => now,
          privacy,
          ...(options.platform ? { platform: options.platform } : {}),
          copyOf: { storeDir, signature },
        });
        if (!sameStoreSnapshot(before, await snapshotStore(storeDir))) throw busy(storeDir);
        if (await present(target)) throw busy(storeDir);
        await rename(partial, target);
        await syncDirectory(dirname(target));
      } catch (error) {
        await rm(partial, { recursive: true, force: true });
        throw error;
      }
      try {
        await options.beforePublish?.();
        if (!sameStoreSnapshot(before, await snapshotStore(storeDir))) throw busy(storeDir);
      } catch (error) {
        // Not published, so nothing has opened it: it goes, and the store stays as it is.
        await rm(target, { recursive: true, force: true });
        await syncDirectory(dirname(target));
        throw error;
      }
      await options.publish(target);
      return { status: "converted", convertedDir: target };
    } catch (error) {
      if (error instanceof CarryoverRefused) throw new StoreFormatError(error.failure, error.message, storeDir);
      throw error;
    } finally {
      announcement.end();
    }
  });
}

/**
 * For a store converted from a file store: whether that store changed after it was copied (a
 * released ORCA that was still running there), so what was written there is not in this one.
 * `undefined` for a store that was not converted.
 */
export async function convertedSourceChanged(
  storeDir: string,
): Promise<{ source: string; changed: boolean; present: boolean } | undefined> {
  const marker = await readStoreFormat(storeDir);
  const from = marker?.convertedFrom;
  if (!from) return undefined;
  if (!(await present(from.store))) return { source: from.store, changed: false, present: false };
  const signature = storeSnapshotSignature(await snapshotStore(from.store));
  return { source: from.store, changed: signature !== from.signature, present: true };
}

const busy = (storeDir: string) =>
  new StoreFormatError(
    "BUSY",
    "The store changed while it was being converted, so the copy may not hold everything and nothing was put in use. Stop whatever is writing to it (an older ORCA still running), then convert it again.",
    storeDir,
  );

async function refuseActiveRuns(storeDir: string): Promise<void> {
  let leases;
  try {
    leases = await new FileLeaseStore(storeDir).list();
  } catch (error) {
    throw new StoreFormatError(
      "BUSY",
      `Run leases in this store could not be read, so it cannot be confirmed that no run is active: ${(error as Error).message}. Nothing was changed.`,
      storeDir,
    );
  }
  const live = leases.filter((lease) => !lapsed(lease));
  if (live.length)
    throw new StoreFormatError(
      "BUSY",
      `Run ${live[0]!.resource} is still being interpreted by pid ${live[0]!.pid} on ${live[0]!.host}. Let it finish or stop it, then convert the store. Nothing was changed.`,
      storeDir,
    );
}

/** Copies an interrupted conversion left behind; never published, so nothing has them open. */
async function removePartials(target: string): Promise<void> {
  const prefix = `${basename(target)}.partial-`;
  let names: string[];
  try {
    names = await readdir(dirname(target));
  } catch {
    return;
  }
  for (const name of names) if (name.startsWith(prefix)) await rm(join(dirname(target), name), { recursive: true });
}

async function present(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}
