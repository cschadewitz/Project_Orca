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
 * 1. The source is copied whole into staging beside it (`<store>-sqlite.staging-<id>/store`,
 *    with a record of who made it), byte-checked, and must not have changed meanwhile.
 * 2. The copy, which nothing else has open, is switched in place (`switchStoreToSqlite` with
 *    `copyOf`): imported, verified, bound, fenced against released ORCA (sqlite/legacy-fence.ts)
 *    and marked as SQLite, recording the source and the signature of its files.
 * 3. With the source still unchanged, the copy is renamed to `<store>-sqlite`; from then on it is
 *    never removed. It is checked to be a complete conversion of the source as the source is now
 *    (`checkConverted`), and the caller publishes it (`publish`: the CLI names it in the
 *    workspace's config, if the config still names the source). A conversion that stopped after
 *    the rename is finished by the next one, through the same check, or refused and left alone.
 *
 * Nothing opens the new store until it is published, and no released ORCA has ever had it open,
 * so the fence holds for every one of them that reads the config afterwards. One that was already
 * running keeps the file store, and what it writes there is not in the new store:
 * {@link convertedSourceChanged} reports it.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { createCopy, createDurable, syncDirectory } from "./durable-file.js";
import { withFileLock } from "./file-lock.js";
import { FileLeaseStore, lapsed } from "./lease-store.js";
import { legacyFenceComplete, readSqliteSwitchJournal } from "./sqlite/legacy-fence.js";
import { boundStoreId, verifySqliteMetadata } from "./sqlite/maintenance.js";
import { SQLITE_METADATA_FILE } from "./sqlite/stores.js";
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
import { beginStoreSwitch, liveStoreWriters, storeWriterAlive } from "./store-writers.js";

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
      if ((await readStoreFormat(target).catch(() => "unreadable" as const)) !== undefined || (await present(target))) {
        // Converted before and not published (interrupted, or the publication was refused or
        // lost). It may already be in use, so it is never replaced or removed: it is published
        // only once it proves to be a complete conversion of this store as the store is now.
        await checkConverted(storeDir, target);
        await options.publish(target);
        return { status: "finished", convertedDir: target };
      }
      await reclaimStaging(storeDir, target);
      await refuseActiveRuns(storeDir);

      const before = await snapshotStore(storeDir);
      // Staging is ours alone: a directory with a record of who made it, and the copy inside it.
      const staging = `${target}${STAGING_INFIX}${randomUUID()}`;
      const copy = join(staging, "store");
      try {
        await privacy.mkdir(staging);
        await createDurable(
          join(staging, STAGING_RECORD),
          JSON.stringify({ source: storeDir, pid: process.pid, host: hostname() }) + "\n",
        );
        await syncDirectory(dirname(staging));
        if (!(await copyStoreInto(storeDir, copy, before, privacy))) throw busy(storeDir);
        // The marker is left out of a snapshot; the copy starts in the same format.
        await createCopy(join(storeDir, STORE_FORMAT_FILE), join(copy, STORE_FORMAT_FILE));
        await syncDirectory(copy);
        await options.afterCopy?.();
        if (!sameStoreSnapshot(before, await snapshotStore(storeDir))) throw busy(storeDir);
        await switchStoreToSqlite(copy, {
          appVersion: options.appVersion,
          now: () => now,
          privacy,
          ...(options.platform ? { platform: options.platform } : {}),
          copyOf: { storeDir, signature: storeSnapshotSignature(before) },
        });
        // The last check of the source before the copy takes its final name: once it has, it
        // is never taken back.
        if (!sameStoreSnapshot(before, await snapshotStore(storeDir))) throw busy(storeDir);
        if (await present(target)) throw busy(storeDir);
        await rename(copy, target);
        await syncDirectory(dirname(target));
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      await rm(staging, { recursive: true, force: true });
      // From here a failure leaves the converted store where it is; the next conversion checks
      // it again and publishes it, or refuses and leaves it for the operator.
      await options.beforePublish?.();
      await checkConverted(storeDir, target);
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

const STAGING_INFIX = ".staging-";
const STAGING_RECORD = "staging.json";

/**
 * Staging an interrupted conversion of this store left behind: only a directory whose record
 * names this store and a process on this host that is gone. Anything else with a similar name is
 * left alone (it is not provably ours, or its process may still be at work); staging names are
 * unique, so it never stands in the way.
 */
async function reclaimStaging(storeDir: string, target: string): Promise<void> {
  const prefix = `${basename(target)}${STAGING_INFIX}`;
  let names: string[];
  try {
    names = await readdir(dirname(target));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dirname(target), name);
    let record: { source?: unknown; pid?: unknown; host?: unknown };
    try {
      record = JSON.parse(await readFile(join(path, STAGING_RECORD), "utf8")) as typeof record;
    } catch {
      continue;
    }
    if (record.source !== storeDir || typeof record.pid !== "number" || typeof record.host !== "string") continue;
    if (storeWriterAlive({ pid: record.pid, host: record.host })) continue;
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * `target` is a complete conversion of `storeDir` as `storeDir` is now, safe to name as the
 * workspace's store: its marker names this store and its files' signature; no switch of it is
 * half done; the legacy fence is complete; and its database is the one it is bound to, and
 * verifies. Checked under the target's own format lock. Anything else refuses, leaving both
 * stores and the config as they are.
 */
async function checkConverted(storeDir: string, target: string): Promise<void> {
  const notConversion = (why: string) =>
    refused(
      storeDir,
      `${target} is not a complete conversion of this store (${why}), so it was not put in use. It was left as it is; move it out of the way to convert again. Nothing else was changed.`,
    );
  await withFileLock(join(target, STORE_FORMAT_LOCK), async () => {
    const marker = await readStoreFormat(target).catch(() => undefined);
    if (marker?.epoch !== SQLITE_STORE_FORMAT_EPOCH || !marker.sqliteId) throw notConversion("no SQLite marker");
    if (marker.convertedFrom?.store !== storeDir) throw notConversion("converted from another store");
    if (await readSqliteSwitchJournal(target).catch(() => true)) throw notConversion("its switch is not finished");
    if (!(await legacyFenceComplete(target))) throw notConversion("the fence against older ORCA is incomplete");
    let bound: string | undefined;
    try {
      bound = boundStoreId(join(target, SQLITE_METADATA_FILE));
    } catch {
      bound = undefined;
    }
    if (bound !== marker.sqliteId) throw notConversion("its database is missing or bound to another store");
    if (!(await verifySqliteMetadata(target)).ok) throw notConversion("its database does not verify");
    if (storeSnapshotSignature(await snapshotStore(storeDir)) !== marker.convertedFrom.signature)
      throw new StoreFormatError(
        "SOURCE_CHANGED",
        `${target} was converted from this store, which has changed since, so it was not put in use. It was left as it is; move it out of the way to convert again. Nothing else was changed.`,
        storeDir,
      );
  });
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
