/**
 * Store format marker and cross-version carryover policy (#566).
 *
 * A store records the format (store epoch) and the ORCA version that last wrote it in
 * `store-format.json`. Every writer checks it before touching anything else:
 *
 * - Same format, or an unmarked store with positive evidence that a released build of this
 *   format wrote it (see {@link ADOPTABLE_UNMARKED_FORMAT}): open in place (and stamp). An app update that keeps the format, the automatic desktop path, needs nothing else.
 * - The previous supported format, or an unmarked store from before that line: ordinary startup
 *   refuses (CARRYOVER_REQUIRED). `orca store carry-forward`, run with every other ORCA process
 *   stopped, converts it explicitly (store-format-carryover.ts): a verified whole-store backup
 *   into `format-backups/`, a check that nothing else wrote meanwhile, a read of the store under
 *   the current format, and only then the marker. Any failure leaves the prior format in charge.
 *   The desktop app's bundled daemon does the same automatically on the first start after an
 *   update, and only then, when the caller hands {@link enterStoreFormat} a
 *   {@link CarryoverAuthority}: proof that this process holds the store's exclusive writer fence
 *   and that the updater handed it the store (#897). The fence must hold throughout.
 * - An older format this build no longer reads: refuse, naming the release to open it with first.
 * - A format this build does not know (in practice, one written by a newer ORCA): refuse for
 *   reads and writes alike. The store is never rewritten.
 *
 * `STORE_FORMAT_EPOCH` must equal `storeEpoch` in `release-compatibility.json`; a test holds
 * them together. Changing the epoch means appending to {@link STORE_FORMAT_HISTORY}.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { createDurable, syncDirectory, syncFile } from "./durable-file.js";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { OrcaError } from "@orca/core";
import { withFileLock } from "./file-lock.js";
import { boundStoreId, importFileMetadata, verifySqliteMetadata } from "./sqlite/maintenance.js";
import { SQLITE_METADATA_FILE } from "./sqlite/stores.js";
import { bindSqliteMetadata, SqliteDatabase } from "./sqlite/database.js";
import { beginStoreSwitch, clearDeadStoreSwitch, liveStoreWriters, type StoreWriterEntry } from "./store-writers.js";
import {
  beginSqliteSwitchJournal,
  endSqliteSwitchJournal,
  fenceLegacyMetadata,
  LEGACY_FENCES,
  legacyFenceComplete,
  prepareSqliteSwitchDir,
  recordSqliteSwitchJournal,
  restoreLegacyMetadata,
  SQLITE_LEGACY_WORKFLOWS_DIR,
  SQLITE_SWITCH_DIR,
  readSqliteSwitchJournal,
  stagedFilesDir,
  unfenceLegacyMetadata,
  unfencedPaths,
  type SqliteSwitchJournal,
} from "./sqlite/legacy-fence.js";
import {
  checkFileMetadata,
  readSqliteMetadataExport,
  writeFileMetadata,
  type SqliteMetadataExport,
} from "./sqlite/export.js";
import { SQLITE_KEY_FILE } from "./protected-file.js";
import { backendOfEpoch, SQLITE_STORE_FORMAT_EPOCH, STORE_FORMAT_FILE, type StoreBackend } from "./store-backend.js";
import {
  CarryoverRefused,
  chooseBackupSlot,
  sameStoreSnapshot,
  snapshotStore,
  type StoreSnapshot,
  ensureBackupSlots,
  findRecoveryRecord,
  posixPrivateCopy,
  pruneFormatBackups,
  stageCarryover,
  STORE_FORMAT_BACKUP_DIR,
  storeMatchesArchive,
  windowsBootId,
  type BackupSlot,
  type PrivateCopyBackend,
} from "./store-format-carryover.js";

export {
  CarryoverRefused,
  posixPrivateCopy,
  stageCarryover,
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_BACKUP_MANIFEST,
  STORE_FORMAT_BACKUP_RETENTION,
  STORE_FORMAT_BACKUP_SLOTS,
  STORE_UPDATE_HANDOFF_FILE,
  windowsBootId,
  type PrivateCopyBackend,
  type SlotIdentity,
} from "./store-format-carryover.js";

/**
 * Windows store format carryover (#910) stays refused (UNDURABLE) until an automated power-cut (#947)
 * test on NTFS proves the slot archive and the recovery record survive in every order Windows
 * may write them. The machinery below is complete and tested with this switched on; turning it
 * on for real is a one-line change made together with that proof.
 */
export const WINDOWS_STORE_CARRYOVER = false;

/** Oldest first. `release` is the first release line that wrote the format. */
export const STORE_FORMAT_HISTORY: readonly { epoch: string; release: string }[] = [
  { epoch: "ownership-fences-v1", release: "0.6" },
  { epoch: "operator-journals-v4", release: "0.7" },
];
export const STORE_FORMAT_EPOCH = STORE_FORMAT_HISTORY.at(-1)!.epoch;
/** This format and the one before it are read in place. */
export const SUPPORTED_STORE_FORMATS: readonly string[] = STORE_FORMAT_HISTORY.slice(-2).map((f) => f.epoch);
/** The format lock: opening, stamping, carrying forward and converting a store take it. */
export const STORE_FORMAT_LOCK = ".store-format.lock";
const LOCK = STORE_FORMAT_LOCK;

const MarkerSchema = z.object({
  format: z.literal(1),
  epoch: z.string().regex(/^[a-z0-9-]{1,64}$/),
  writtenBy: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  backup: z.string().min(1).max(256).optional(),
  /** On a store switched to SQLite: the id its database holds in `store_binding` (#339). */
  sqliteId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .optional(),
  /**
   * On a store converted from a file store into one of its own (store-convert.ts): that store,
   * left as it was, and the signature of its files when they were copied, so a write that
   * reached it afterwards (a released ORCA still running there) can be reported.
   */
  convertedFrom: z
    .object({
      store: z.string().min(1).max(4096),
      signature: z.string().regex(/^[0-9a-f]{64}$/),
      at: z.string().min(1).max(64),
    })
    .optional(),
});
export type StoreFormatMarker = z.infer<typeof MarkerSchema>;

/** NEWER, TOO_OLD and DAMAGED describe the marker; the rest are carryover refusals. */
export type StoreFormatReason =
  | "NEWER"
  | "SWITCH_REFUSED"
  | "TOO_OLD"
  | "DAMAGED"
  | "CARRYOVER_REQUIRED"
  | "BUSY"
  | "UNREADABLE"
  | "BACKUPS_UNSAFE"
  | "FENCE_LOST"
  | "APP_OWNED"
  | "UNDURABLE"
  | "INTERRUPTED"
  | "SOURCE_CHANGED";
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
  | { status: "fresh" | "current" | "adopted"; epoch: string; backend: StoreBackend }
  /** Carried forward explicitly by {@link carryStoreForward}, after a verified backup. */
  | { status: "carried"; epoch: string; from: string | "unmarked"; backup: string; backend: StoreBackend };

/** A writer fence this process holds over the store: `check()` is true only while it still does. */
export interface StoreWriteFence {
  check(): boolean;
}

/**
 * Permission to carry an older-format store forward during startup (#897). Only the desktop
 * app's bundled daemon gets one, on the first start after an update, from proof that it holds
 * the store's exclusive writer fence and that the updater handed it this exact store.
 */
export interface CarryoverAuthority {
  fence: StoreWriteFence;
  /** Where private copies may go; defaults to the POSIX owner-only backups directory. */
  privacy?: PrivateCopyBackend;
  /** Called once with how it ended; not called when the carryover was interrupted by an error. */
  settle: (outcome: "carried" | "refused") => void | Promise<void>;
  /** Injected for tests. */
  afterCopy?: () => Promise<void>;
}

export interface StoreFormatOptions {
  /** The ORCA version doing the open, recorded in the marker. */
  appVersion: string;
  /** "read" checks only and never writes (closed update validation). */
  mode: "write" | "read";
  /**
   * Asked only when the store needs carrying forward (CARRYOVER_REQUIRED) in write mode.
   * `undefined` keeps the refusal, exactly as without this option.
   */
  carryover?: () => Promise<CarryoverAuthority | undefined>;
  /**
   * Windows (#910): where private files may be created. With it, a Windows write-mode open of a
   * store this build may write also creates the store's two backup slots if they are missing, so
   * that a later format carryover finds slots older than the current boot.
   */
  privacy?: PrivateCopyBackend;
  /** Injected for tests. */
  now?: () => Date;
  /** Injected for tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /** Injected for tests: Windows' boot counter ({@link windowsBootId}). */
  bootId?: () => number | undefined;
  /** Tests and the NTFS probe only: carry forward on Windows despite {@link WINDOWS_STORE_CARRYOVER}. */
  windowsCarryover?: boolean;
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
  if (SUPPORTED_STORE_FORMATS.includes(marker.epoch) || marker.epoch === SQLITE_STORE_FORMAT_EPOCH) return;
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
 * The one format whose unmarked stores startup may stamp without converting: every released
 * ORCA that wrote it (0.7.0-rc.2, 0.7.0) predates the marker. Once the epoch moves on, no
 * unmarked store is adopted again.
 */
export const ADOPTABLE_UNMARKED_FORMAT = "operator-journals-v4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/i;

/** A regular, non-linked file or directory, private to this user where modes apply. */
async function ownedEntry(path: string, kind: "file" | "dir"): Promise<Stats | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (!info || (kind === "dir" ? !info.isDirectory() : !info.isFile())) return undefined;
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) return undefined;
  return info;
}

/**
 * Positive evidence that an unmarked store was written by a released 0.7 build, which is the
 * only line that writes either of these, and that both are intact (#566):
 *
 * - workspace identity: `.workspace-identified` holding exactly "1\n", and
 *   `workspace-identity/id` holding one v4 UUID (store/workspace-identity.ts);
 * - the private execution key: `private-execution/.execution-key`, exactly 32 bytes
 *   (store/protected-file.ts).
 *
 * v0.6.0 and every earlier release wrote neither. The 0.7 desktop app's daemon (`serve`,
 * including `serve --read-only`) and `submit` write both on first open; a store only ever
 * used through other 0.7 commands has no identity and goes through `orca store carry-forward`.
 * Anything partial, linked, foreign-owned or malformed is not evidence.
 */
async function writtenByAdoptableLine(storeDir: string): Promise<boolean> {
  if (STORE_FORMAT_EPOCH !== ADOPTABLE_UNMARKED_FORMAT) return false;
  const marker = await ownedEntry(join(storeDir, ".workspace-identified"), "file");
  const identityDir = await ownedEntry(join(storeDir, "workspace-identity"), "dir");
  const identity = await ownedEntry(join(storeDir, "workspace-identity", "id"), "file");
  const privateDir = await ownedEntry(join(storeDir, "private-execution"), "dir");
  const key = await ownedEntry(join(storeDir, "private-execution", ".execution-key"), "file");
  if (!marker || !identityDir || !identity || !privateDir || !key || key.size !== 32) return false;
  const [flag, id] = await Promise.all([
    readFile(join(storeDir, ".workspace-identified"), "utf8"),
    readFile(join(storeDir, "workspace-identity", "id"), "utf8"),
  ]);
  return flag === "1\n" && UUID.test(id);
}

const carryoverRequired = (storeDir: string, from: string) =>
  new StoreFormatError(
    "CARRYOVER_REQUIRED",
    `This store was written ${from === "unmarked" ? "by an ORCA release before 0.7" : `in store format ${from}`}, and this ORCA (store format ${STORE_FORMAT_EPOCH}) does not convert it during ordinary startup. Stop every ORCA app, daemon and command using it, then run \`orca store carry-forward\` once. Nothing was changed.`,
    storeDir,
  );

/**
 * Write the marker durably: flushed before the rename that makes it current, and the rename
 * flushed before this returns, so no writer is admitted on a marker a crash could still undo.
 * `guard` runs with no await between it and that rename; when it throws, nothing is changed.
 */
async function stamp(
  storeDir: string,
  appVersion: string,
  now: Date,
  fields: Pick<StoreFormatMarker, "backup" | "sqliteId" | "convertedFrom">,
  guard: () => void = () => undefined,
  epoch: string = STORE_FORMAT_EPOCH,
  afterRename?: () => Promise<void>,
): Promise<void> {
  const value: StoreFormatMarker = {
    format: 1,
    epoch,
    writtenBy: appVersion,
    updatedAt: now.toISOString(),
    ...(fields.backup ? { backup: fields.backup } : {}),
    ...(fields.sqliteId ? { sqliteId: fields.sqliteId } : {}),
    ...(fields.convertedFrom ? { convertedFrom: fields.convertedFrom } : {}),
  };
  const tmp = join(storeDir, `${STORE_FORMAT_FILE}.${randomUUID()}.tmp`);
  await createDurable(tmp, JSON.stringify(value, null, 2) + "\n");
  try {
    guard();
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await rename(tmp, join(storeDir, STORE_FORMAT_FILE));
  await afterRename?.();
  await syncMarker(storeDir);
}

/** Flush the marker and its directory entry. */
async function syncMarker(storeDir: string): Promise<void> {
  if (process.platform === "win32") await syncFile(join(storeDir, STORE_FORMAT_FILE));
  await syncDirectory(storeDir);
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
    // Windows (#910): a backup archive recording a conversion this ORCA cannot open outlives a
    // lost marker, so the marker alone is not trusted to say the store is not newer.
    if ((options.platform ?? process.platform) === "win32") await refuseNewerRecord(storeDir, marker, current);
    return marker;
  };
  const classify = async (marker: StoreFormatMarker | undefined) => {
    if (marker?.epoch === current || marker?.epoch === SQLITE_STORE_FORMAT_EPOCH) return "current" as const;
    if (marker) throw carryoverRequired(storeDir, marker.epoch);
    if (!(await holdsData(storeDir))) return "fresh" as const;
    if (await writtenByAdoptableLine(storeDir)) return "adopted" as const;
    throw carryoverRequired(storeDir, "unmarked");
  };
  // The format a current store stays in: files, or SQLite once switched (store-backend.ts).
  const kept = (marker: StoreFormatMarker | undefined) =>
    marker?.epoch === SQLITE_STORE_FORMAT_EPOCH ? SQLITE_STORE_FORMAT_EPOCH : current;
  if (options.mode === "read") {
    const marker = await check();
    if (await readSqliteSwitchJournal(storeDir)) throw switchInterrupted(storeDir);
    const status = await classify(marker);
    return { status, epoch: kept(marker), backend: backendOfEpoch(kept(marker)) };
  }
  await mkdir(storeDir, { recursive: true });
  return withFileLock(join(storeDir, LOCK), async (): Promise<StoreFormatOutcome> => {
    await settleSqliteSwitch(storeDir, await readStoreFormat(storeDir));
    const marker = await check();
    let status: Awaited<ReturnType<typeof classify>>;
    try {
      status = await classify(marker);
    } catch (error) {
      if (!(error instanceof StoreFormatError) || error.reason !== "CARRYOVER_REQUIRED" || !options.carryover)
        throw error;
      const authority = await options.carryover();
      if (!authority) throw error;
      let outcome: StoreFormatOutcome;
      try {
        outcome = await carryLocked(storeDir, marker, {
          appVersion: options.appVersion,
          fence: authority.fence,
          ...((authority.privacy ?? options.privacy) ? { privacy: authority.privacy ?? options.privacy! } : {}),
          ...(authority.afterCopy ? { afterCopy: authority.afterCopy } : {}),
          ...(options.now ? { now: options.now } : {}),
          ...(options.platform ? { platform: options.platform } : {}),
          ...(options.bootId ? { bootId: options.bootId } : {}),
          ...(options.windowsCarryover !== undefined ? { windowsCarryover: options.windowsCarryover } : {}),
        });
      } catch (refusal) {
        // UNDURABLE waits for Windows to restart, with nothing copied: the handoff stays bound to
        // this writer's claim, as after an interruption, so the next start retries under it.
        if (refusal instanceof StoreFormatError && refusal.reason !== "UNDURABLE") await authority.settle("refused");
        throw refusal;
      }
      await authority.settle("carried");
      return outcome;
    }
    const now = (options.now ?? (() => new Date()))();
    if (status !== "current" || marker?.writtenBy !== options.appVersion)
      await stamp(
        storeDir,
        options.appVersion,
        now,
        { backup: marker?.backup, sqliteId: marker?.sqliteId, convertedFrom: marker?.convertedFrom },
        undefined,
        kept(marker),
      );
    if ((options.platform ?? process.platform) === "win32" && options.privacy)
      // Best effort: without slots a later carryover only waits for a restart (UNDURABLE).
      await ensureBackupSlots(storeDir, options.privacy, (options.bootId ?? windowsBootId)()).catch(() => undefined);
    return { status, epoch: kept(marker), backend: backendOfEpoch(kept(marker)) };
  });
}

export interface CarryForwardOptions {
  appVersion: string;
  now?: () => Date;
  afterCopy?: () => Promise<void>;
  /**
   * The writer fence the caller holds (#897). Checked before the copy, after it, after the read
   * check and just before the marker; once it no longer holds, nothing is carried (FENCE_LOST).
   */
  fence?: StoreWriteFence;
  /** Where private copies may go; defaults to the POSIX owner-only backups directory. */
  privacy?: PrivateCopyBackend;
  /** Injected for tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /** Injected for tests: Windows' boot counter ({@link windowsBootId}). */
  bootId?: () => number | undefined;
  /** Tests and the NTFS probe only: carry forward on Windows despite {@link WINDOWS_STORE_CARRYOVER}. */
  windowsCarryover?: boolean;
}

/**
 * The explicit, offline carryover of an older-format store (`orca store carry-forward`). The
 * caller states that every other ORCA process using the store is stopped; this still refuses
 * when quiescence cannot be confirmed (store-format-carryover.ts), and stamps the current
 * format only after a verified backup and a read check. Throws {@link StoreFormatError}.
 */
export async function carryStoreForward(storeDir: string, options: CarryForwardOptions): Promise<StoreFormatOutcome> {
  return withFileLock(join(storeDir, LOCK), async () =>
    carryLocked(storeDir, await readStoreFormat(storeDir), options),
  );
}

const fenceLost = (storeDir: string) =>
  new CarryoverRefused(
    "FENCE_LOST",
    `This ORCA no longer provably holds the only write access to ${storeDir}, so the store was not carried forward and its prior format stays in charge. Close every ORCA app, daemon and command using this workspace, then start ORCA again.`,
  );

const HISTORY = STORE_FORMAT_HISTORY.map((f) => f.epoch);

/**
 * Restoring a Windows slot archive by hand is not supported: a ZIP round trip keeps the bytes but
 * not the access rules that keep the execution key and private records to this user.
 */
const NO_WINDOWS_RESTORE =
  "Do not extract that backup into a store by hand: extraction does not restore the access rules that keep the store's private records to you, and ORCA cannot restore it for you yet.";

async function refuseNewerRecord(storeDir: string, marker: StoreFormatMarker | undefined, current: string) {
  const { newer } = await findRecoveryRecord(storeDir, marker?.epoch, current, HISTORY);
  if (newer)
    throw new StoreFormatError(
      "NEWER",
      `The backup in ${newer.path} records that this store was converted to format ${newer.manifest.to}, which is newer than this ORCA can open. Nothing was changed. Install the ORCA version that converted it. ${NO_WINDOWS_RESTORE}`,
      storeDir,
    );
}

/** Under the format lock, with the marker read under it. */
async function carryLocked(
  storeDir: string,
  marker: StoreFormatMarker | undefined,
  options: CarryForwardOptions,
): Promise<StoreFormatOutcome> {
  const current = STORE_FORMAT_EPOCH;
  if (marker) judge(storeDir, marker, current);
  if (marker?.epoch === current || marker?.epoch === SQLITE_STORE_FORMAT_EPOCH)
    return { status: "current", epoch: marker.epoch, backend: backendOfEpoch(marker.epoch) };
  if (!marker && !(await holdsData(storeDir)))
    throw new StoreFormatError("UNREADABLE", `${storeDir} holds no ORCA store to carry forward.`, storeDir);
  const privacy = options.privacy ?? posixPrivateCopy;
  const fence = () => {
    if (options.fence && !options.fence.check()) throw fenceLost(storeDir);
  };
  // The marker may only become durable after the backup it names. POSIX orders the two with a
  // directory fsync after each rename. Windows documents no such barrier for a directory entry,
  // so there the backup goes into a slot file that already existed before Windows last started,
  // rewritten in place and flushed before the marker is created (#910). Until a slot is that
  // old, carryover fails closed: nothing is copied and the prior format stays in charge.
  let slot: BackupSlot | undefined;
  const from = marker?.epoch ?? "unmarked";
  if ((options.platform ?? process.platform) === "win32") {
    if (!(options.windowsCarryover ?? WINDOWS_STORE_CARRYOVER))
      throw new StoreFormatError(
        "UNDURABLE",
        "This ORCA does not yet change a store's format on Windows, because it cannot yet prove that the backup it takes first survives a power cut. Nothing was changed. Keep using the ORCA version that last opened this store until an update that can carry it forward.",
        storeDir,
      );
    const boot = (options.bootId ?? windowsBootId)();
    try {
      fence();
      await ensureBackupSlots(storeDir, privacy, boot);
    } catch (error) {
      if (error instanceof CarryoverRefused) throw new StoreFormatError(error.failure, error.message, storeDir);
      throw error;
    }
    // The marker is created by a rename, whose directory entry Windows does not promise to keep
    // across a power cut, so the marker may be older than the slot archive written before it.
    // That archive is the durable record: finish its conversion if the store is still exactly
    // what it archived, and otherwise refuse without touching it.
    const records = await findRecoveryRecord(storeDir, marker?.epoch, current, HISTORY);
    if (records.newer) await refuseNewerRecord(storeDir, marker, current);
    if (records.pending.length > 1)
      throw new StoreFormatError(
        "INTERRUPTED",
        `Both backups in ${join(storeDir, STORE_FORMAT_BACKUP_DIR)} record an unfinished change of this store's format, so which one applies cannot be decided. Nothing was changed, and both backups are kept. Open the store with the ORCA version that last wrote it. ${NO_WINDOWS_RESTORE}`,
        storeDir,
      );
    const record = records.pending[0];
    if (record) {
      fence();
      if (record.manifest.to !== current || !(await storeMatchesArchive(storeDir, record.path)))
        throw new StoreFormatError(
          "INTERRUPTED",
          `A change of this store's format to ${record.manifest.to} was interrupted, and the store has changed since the backup taken for it in ${record.path}. Nothing was changed, and that backup is kept. Open the store with the ORCA version that last wrote it. ${NO_WINDOWS_RESTORE}`,
          storeDir,
        );
      const now = (options.now ?? (() => new Date()))();
      await stamp(storeDir, options.appVersion, now, { backup: record.path }, fence);
      return { status: "carried", epoch: current, from, backup: record.path, backend: "file" };
    }
    slot = await chooseBackupSlot(storeDir, privacy, {
      keep: marker?.backup,
      boot,
      markerEpoch: marker?.epoch,
      history: HISTORY,
    });
    if (!slot)
      throw new StoreFormatError(
        "UNDURABLE",
        "This ORCA keeps the backup it takes before changing the store's format in a file that must already have been on disk when Windows last started, and none is yet, so the store was not carried forward. Nothing else was changed. Restart Windows, then start ORCA again.",
        storeDir,
      );
  }
  const now = (options.now ?? (() => new Date()))();
  let backup: string;
  try {
    const staged = await stageCarryover(storeDir, from, current, now, {
      ...(options.afterCopy ? { afterCopy: options.afterCopy } : {}),
      fence,
      privacy,
      ...(slot ? { slot } : {}),
    });
    backup = await staged.commit();
    // The backup is published and durable; the marker is what changes the format, and the fence
    // is checked once more with no await between that check and the marker's rename.
    await stamp(storeDir, options.appVersion, now, { backup }, fence);
  } catch (error) {
    if (error instanceof CarryoverRefused) throw new StoreFormatError(error.failure, error.message, storeDir);
    throw error;
  }
  await pruneFormatBackups(storeDir, backup, privacy);
  return { status: "carried", epoch: current, from, backup, backend: "file" };
}

export interface SwitchToSqliteOptions {
  appVersion: string;
  now?: () => Date;
  /** Where private copies may go; defaults to the POSIX owner-only backups directory. */
  privacy?: PrivateCopyBackend;
  /** Injected for tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /**
   * The store is a fresh copy of `storeDir` that nothing else has open (store-convert.ts): no
   * backup is taken (the original is left as it was), and the marker records where it came from.
   */
  copyOf?: { storeDir: string; signature: string };
  /**
   * The caller holds the store's exclusive writer fence (the desktop app's daemon, whose fence
   * every supported ORCA that may write the app's workspace must hold first): checked before
   * anything is changed, before the journal, before the marker is staged, and at the marker's
   * rename. Once it no longer holds, the switch is refused (`FENCE_LOST`) and undone.
   */
  fence?: StoreWriteFence;
  /** Injected for tests: runs after the import and its verify, before the last checks. */
  afterImport?: () => Promise<void>;
  /** Injected for tests: runs after each path of the legacy fence is in place. */
  afterFenceStep?: (path: string) => Promise<void>;
  /** Injected for tests: runs after the last checks, just before the marker is written. */
  beforeMarker?: () => Promise<void>;
  /** Injected for tests: runs after the marker, before the switch's journal is dropped. */
  afterMarker?: () => Promise<void>;
  /** Tests: runs between the marker's rename and its flush; a throw stands for a failed flush. */
  afterMarkerRename?: () => Promise<void>;
}

export type SwitchToSqliteOutcome =
  { status: "switched"; epoch: string; backup?: string } | { status: "current"; epoch: string };

const busyWriters = (storeDir: string, writers: StoreWriterEntry[]) =>
  new StoreFormatError(
    "BUSY",
    `This store is open in ${writers.length} other ORCA process${writers.length === 1 ? "" : "es"} (${writers
      .slice(0, 3)
      .map((w) => `${w.purpose} ${w.pid} on ${w.host}, ORCA ${w.appVersion}`)
      .join(
        "; ",
      )}), so it stays on files. Stop every ORCA app, daemon and command using it, then switch it again. Nothing was changed.`,
    storeDir,
  );

/**
 * Switch a store's metadata from files to SQLite (#339): `orca store sqlite switch`, run with
 * every other ORCA process using the store stopped. Under the format lock (an earlier switch
 * that was interrupted is first finished or undone by its journal, `settleSqliteSwitch`):
 *
 * 1. Only a store in this ORCA's current file format is switched (an older one is carried
 *    forward first; an unmarked one is opened once first). A store already on SQLite is left as
 *    it is.
 * 2. Not on Windows yet: changing a store's format there waits for proof that the backup taken
 *    first survives a power cut (#910, #947), exactly as carryover does.
 * 3. No other writer: the switch announces itself (store-writers.ts), so writers from this ORCA
 *    refuse to open the store until it is over, and is refused while any registered writer is
 *    alive, idle or not. Released ORCA versions do not register; the legacy fence of step 7
 *    keeps them out instead (sqlite/legacy-fence.ts).
 * 4. A verified whole-store backup into `format-backups/`, refused while a run is active or
 *    while anything writes (store-format-carryover.ts), and a read check of the copy.
 * 5. The import (`importFileMetadata`: read twice, decided and applied in one transaction), a
 *    full `verifySqliteMetadata`, which must find nothing wrong, and the database bound to this
 *    store with a new id (`store_binding`).
 * 6. The file metadata must still be exactly what the backup holds, and no writer registered:
 *    a write that landed after the backup would be missing from the database, so the switch is
 *    refused instead.
 * 7. A durable journal (`.sqlite-switch/journal.json`), then the legacy fence: the files a
 *    released ORCA reads first are replaced by markers it cannot open (the originals kept aside),
 *    and the file metadata is checked again. Only then the marker:
 *    {@link SQLITE_STORE_FORMAT_EPOCH}, naming the backup and the database's id. A crash before
 *    the marker is undone by the journal, one after it is finished. From here the store opens on SQLite only, on that database only, and an ORCA
 *    from before this one refuses it as newer. The announcement is withdrawn after the marker.
 *
 * Any refusal before step 7 leaves the store on files, in charge, exactly as before (a database
 * the import built is inert, as after `orca store sqlite import`). Throws {@link StoreFormatError}.
 */
export async function switchStoreToSqlite(
  storeDir: string,
  options: SwitchToSqliteOptions,
): Promise<SwitchToSqliteOutcome> {
  const current = STORE_FORMAT_EPOCH;
  return withFileLock(join(storeDir, LOCK), async (): Promise<SwitchToSqliteOutcome> => {
    // An earlier switch that was interrupted is finished or undone first, by its own journal.
    await settleSqliteSwitch(storeDir, await readStoreFormat(storeDir));
    const marker = await readStoreFormat(storeDir);
    if (marker) judge(storeDir, marker, current);
    if (marker?.epoch === SQLITE_STORE_FORMAT_EPOCH) return { status: "current", epoch: marker.epoch };
    if (!marker || marker.epoch !== current)
      throw new StoreFormatError(
        "SWITCH_REFUSED",
        marker
          ? `This store is in store format ${marker.epoch}, not this ORCA's ${current}. Carry it forward first (\`orca store carry-forward\`), then switch it. Nothing was changed.`
          : `This store has no format marker yet. Open it once with this ORCA (start it, or run any command against it), then switch it. Nothing was changed.`,
        storeDir,
      );
    if ((options.platform ?? process.platform) === "win32")
      throw new StoreFormatError(
        "UNDURABLE",
        "This ORCA does not yet change a store's format on Windows, because it cannot yet prove that the backup it takes first survives a power cut. Switching to SQLite is such a change, so nothing was changed and the store stays on files.",
        storeDir,
      );
    const privacy = options.privacy ?? posixPrivateCopy;
    const now = (options.now ?? (() => new Date()))();
    // Every file but the database's own and the registry's: opening the SQLite backend may
    // create empty directories (artifacts/blobs, plans), which hold nothing a write could have
    // changed, and a writer turned away by the announcement leaves nothing behind.
    const fileMetadata = async () => {
      const all = await snapshotStore(storeDir);
      for (const [path, entry] of [...all])
        if (entry.type !== "file" || path.startsWith(SQLITE_METADATA_FILE)) all.delete(path);
      return all;
    };
    const announcement = beginStoreSwitch(storeDir, options.appVersion);
    try {
      const writers = liveStoreWriters(storeDir);
      if (writers.length) throw busyWriters(storeDir, writers);
      return await switchLocked(storeDir, options, { current, now, privacy, fileMetadata });
    } finally {
      announcement.end();
    }
  });
}

async function switchLocked(
  storeDir: string,
  options: SwitchToSqliteOptions,
  context: {
    current: string;
    now: Date;
    privacy: PrivateCopyBackend;
    fileMetadata: () => Promise<StoreSnapshot>;
  },
): Promise<SwitchToSqliteOutcome> {
  const { current, now, privacy, fileMetadata } = context;
  let backup: string | undefined;
  const convertedFrom = options.copyOf
    ? { store: options.copyOf.storeDir, signature: options.copyOf.signature, at: now.toISOString() }
    : undefined;
  const holdsFence = () => {
    if (options.fence && !options.fence.check())
      throw new StoreFormatError(
        "FENCE_LOST",
        `This ORCA no longer provably holds the only write access to ${storeDir}, so it was not switched to SQLite and stays on files. Close every ORCA app, daemon and command using this workspace, then start ORCA again.`,
        storeDir,
      );
  };
  try {
    holdsFence();
    const before = await fileMetadata();
    if (!options.copyOf) {
      const staged = await stageCarryover(storeDir, current, SQLITE_STORE_FORMAT_EPOCH, now, { privacy });
      backup = await staged.commit();
    }
    await importFileMetadata(storeDir);
    const verified = await verifySqliteMetadata(storeDir);
    if (!verified.ok)
      throw new StoreFormatError(
        "UNREADABLE",
        `The SQLite metadata built from this store did not verify (${verified.problems
          .slice(0, 3)
          .map((p) => p.kind)
          .join(
            ", ",
          )}), so the store stays on files. Nothing else was changed; run \`orca store sqlite verify\` for the details.`,
        storeDir,
      );
    const sqliteId = randomUUID();
    const database = new SqliteDatabase(join(storeDir, SQLITE_METADATA_FILE));
    try {
      await bindSqliteMetadata(database, sqliteId, now);
    } finally {
      database.close();
    }
    await options.afterImport?.();
    if (!sameStoreSnapshot(before, await fileMetadata()))
      throw new StoreFormatError(
        "BUSY",
        "The store's files changed while it was being switched, so the database may not hold everything and the store stays on files. Stop every ORCA app, daemon and command using it, then switch it again.",
        storeDir,
      );
    const writers = liveStoreWriters(storeDir);
    if (writers.length) throw busyWriters(storeDir, writers);
    holdsFence();
    // The legacy fence (sqlite/legacy-fence.ts): from the journal on, an interruption is undone
    // (or, once the marker is written, finished) by the next start, and a released ORCA that
    // never reads the marker finds every path it would open first replaced by a marker.
    await beginSqliteSwitchJournal(storeDir, { format: 1, sqliteId, backup: backup ?? options.copyOf?.storeDir ?? "" });
    try {
      await fenceLegacyMetadata(storeDir, options.afterFenceStep);
      // A write that landed while the fence went in shows up in what was set aside.
      if (!sameStoreSnapshot(before, await fencedFileMetadata(storeDir)))
        throw new StoreFormatError(
          "BUSY",
          "The store's files changed while it was being switched, so the database may not hold everything and the store stays on files. Stop every ORCA app, daemon and command using it, then switch it again.",
          storeDir,
        );
      await options.beforeMarker?.();
      holdsFence();
      await stamp(
        storeDir,
        options.appVersion,
        now,
        { backup, sqliteId, convertedFrom },
        // Checked again at the rename itself, after the temporary marker is written and flushed.
        holdsFence,
        SQLITE_STORE_FORMAT_EPOCH,
        options.afterMarkerRename,
      );
    } catch (error) {
      // Refused or failed. Only a store whose marker provably still names files is rolled back
      // here: a failure after the marker's rename (its flush) may have published it, and one that
      // leaves the marker unreadable decides nothing. Either keeps the journal, so the next start
      // reconciles the marker that is actually there (settleSqliteSwitch). An interruption (a
      // crash) never gets here; the journal makes the next start do this instead.
      const marker = await readStoreFormat(storeDir).then(
        (value) => value ?? null,
        () => undefined,
      );
      if (marker !== undefined && marker?.epoch !== SQLITE_STORE_FORMAT_EPOCH) {
        await unfenceLegacyMetadata(storeDir);
        await endSqliteSwitchJournal(storeDir);
      }
      throw error;
    }
    await options.afterMarker?.();
    await endSqliteSwitchJournal(storeDir);
  } catch (error) {
    if (error instanceof CarryoverRefused) throw new StoreFormatError(error.failure, error.message, storeDir);
    throw error;
  }
  if (!backup) return { status: "switched", epoch: SQLITE_STORE_FORMAT_EPOCH };
  await pruneFormatBackups(storeDir, backup, privacy);
  return { status: "switched", epoch: SQLITE_STORE_FORMAT_EPOCH, backup };
}

/** The id the store's database is bound to; undefined when it has none or cannot be read. */
function sqliteDatabaseBinding(storeDir: string): string | undefined {
  try {
    return boundStoreId(join(storeDir, SQLITE_METADATA_FILE));
  } catch {
    return undefined;
  }
}

const switchInterrupted = (storeDir: string) =>
  new StoreFormatError(
    "INTERRUPTED",
    "A switch of this store between files and SQLite was interrupted. Start ORCA once to finish or undo it; nothing reads the store until then.",
    storeDir,
  );

/**
 * Finish or undo a switch to SQLite that was interrupted, from its journal (legacy-fence.ts),
 * under the format lock. The marker decides: written with the journal's database id, the switch
 * happened, and only the journal is left to drop (the fence went in before the marker);
 * otherwise the store is still on files, and every original goes back where it was.
 */
async function settleSqliteSwitch(storeDir: string, marker: StoreFormatMarker | undefined): Promise<void> {
  clearDeadStoreSwitch(storeDir);
  const journal = await readSqliteSwitchJournal(storeDir);
  if (!journal) {
    // What a switch left before its journal (the files a switch back wrote out) changed nothing.
    await rm(join(storeDir, SQLITE_SWITCH_DIR), { recursive: true, force: true });
    return;
  }
  if (journal.to === "files") return settleFilesSwitch(storeDir, marker, journal);
  if (marker?.epoch === SQLITE_STORE_FORMAT_EPOCH) {
    // Published: the marker and the database must both name the journal's switch, and the
    // marker is flushed again (its first flush may be what failed) before the journal goes.
    if (marker.sqliteId !== journal.sqliteId || sqliteDatabaseBinding(storeDir) !== journal.sqliteId)
      throw switchInterrupted(storeDir);
    if (!(await legacyFenceComplete(storeDir))) await fenceLegacyMetadata(storeDir);
    await syncMarker(storeDir);
  } else await unfenceLegacyMetadata(storeDir);
  await endSqliteSwitchJournal(storeDir);
}

/**
 * The store's files as the switch compares them, with the legacy fence in place: each original
 * read where it was set aside, the markers and the keys' links left out.
 */
async function fencedFileMetadata(storeDir: string): Promise<StoreSnapshot> {
  const out: StoreSnapshot = new Map();
  const fenced = LEGACY_FENCES.map((f) => f.path);
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  for (const [path, entry] of await snapshotStore(storeDir)) {
    if (entry.type !== "file" || path.startsWith(SQLITE_METADATA_FILE)) continue;
    if (fenced.some((root) => under(path, root)) || path.endsWith(`/${SQLITE_KEY_FILE}`)) continue;
    if (under(path, SQLITE_LEGACY_WORKFLOWS_DIR)) continue;
    out.set(path, entry);
  }
  for (const [path, actual] of await unfencedPaths(storeDir)) {
    const info = await lstat(actual, { bigint: true });
    if (info.isDirectory()) {
      for (const [inner, entry] of await snapshotStore(actual))
        if (entry.type === "file") out.set(`${path}/${inner}`, entry);
    } else
      out.set(path, {
        type: "file",
        mode: Number(info.mode & 0o7777n),
        state: `${info.size}:${info.mtimeNs}:${info.ino}`,
      });
  }
  return out;
}

export interface SwitchToFilesOptions {
  appVersion: string;
  now?: () => Date;
  /** Where private copies may go; defaults to the POSIX owner-only backups directory. */
  privacy?: PrivateCopyBackend;
  /** Injected for tests; defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /**
   * The caller holds the store's exclusive writer fence (the desktop app's daemon): checked
   * before anything is changed, before the journal, before the marker is staged, and at the
   * marker's rename. Once it no longer holds, the switch back is refused (`FENCE_LOST`) and undone.
   */
  fence?: StoreWriteFence;
  /** Injected for tests: runs after the file metadata is written and checked, before the journal. */
  afterExport?: () => Promise<void>;
  /** Injected for tests: runs after each path is restored. */
  afterRestoreStep?: (path: string) => Promise<void>;
  /** Injected for tests: runs after every path is restored, just before the marker is written. */
  beforeMarker?: () => Promise<void>;
  /** Tests: runs between the marker's rename and its flush; a throw stands for a failed flush. */
  afterMarkerRename?: () => Promise<void>;
  /** Injected for tests: runs after the marker, before the database and the journal are dropped. */
  afterMarker?: () => Promise<void>;
}

export type SwitchToFilesOutcome =
  { status: "switched"; epoch: string; backup: string } | { status: "current"; epoch: string };

/** The database's files: the database, and SQLite's own WAL, shared-memory and journal files. */
const SQLITE_DATABASE_FILES = ["", "-wal", "-shm", "-journal"].map((suffix) => `${SQLITE_METADATA_FILE}${suffix}`);

/** Remove a store's database once its marker records files again; the switch's backup keeps it. */
async function dropSqliteDatabase(storeDir: string): Promise<void> {
  for (const name of SQLITE_DATABASE_FILES) await rm(join(storeDir, name), { force: true });
  await syncDirectory(storeDir);
}

/**
 * The store's files as the switch back compares them: everything but the paths it restores (the
 * fenced paths, the relocated workflows, the keys' links), so the database and every file that
 * stays where it is must not change while the switch back runs.
 */
async function unrestoredFiles(storeDir: string): Promise<StoreSnapshot> {
  const fenced = [...LEGACY_FENCES.map((f) => f.path), SQLITE_LEGACY_WORKFLOWS_DIR];
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const out: StoreSnapshot = new Map();
  for (const [path, entry] of await snapshotStore(storeDir)) {
    if (fenced.some((root) => under(path, root)) || path.endsWith(`/${SQLITE_KEY_FILE}`)) continue;
    // Directories the restore may create (artifacts/) are compared through their files.
    if (entry.type !== "file") continue;
    out.set(path, entry);
  }
  return out;
}

/**
 * Switch a store's metadata back from SQLite to files (#339): the way back after
 * {@link switchStoreToSqlite}, run by the desktop app's daemon under its writer fence. Under the
 * format lock (an earlier switch either way that was interrupted is first finished or undone by
 * its journal):
 *
 * 1. Only a store on SQLite is switched back; one already on this ORCA's file format is left as it
 *    is. Not on Windows yet (#947), exactly as the switch to SQLite.
 * 2. No other writer: announced as the switch to SQLite is, and refused while any registered
 *    writer is alive.
 * 3. `verifySqliteMetadata` must find nothing wrong, and everything the database holds is read in
 *    one snapshot, every row parsed with its schema (`readSqliteMetadataExport`): a row or
 *    collection this ORCA cannot read refuses the switch back, rather than leave it behind.
 * 4. A verified whole-store backup into `format-backups/`, the database in it checked again.
 * 5. The file metadata written out into `.sqlite-switch/files/` and read back with the file
 *    backend's readers, which must return exactly what the database holds (`checkFileMetadata`).
 *    The store must not have changed since step 3.
 * 6. A durable journal (`to: "files"`), then every marker of the legacy fence replaced by what
 *    was written out (`restoreLegacyMetadata`), the keys last, and the store checked unchanged
 *    once more. Only then the marker: this ORCA's file format, naming the backup. That rename is
 *    the commit. Then the database is removed (the backup holds it) and the journal dropped.
 *
 * Any refusal before the marker leaves the store on SQLite exactly as it was: every marker back
 * (what was restored set aside and dropped), the database untouched. A crash before the marker is
 * undone the same way by the next start; one after it is finished. Throws {@link StoreFormatError}.
 */
export async function switchStoreToFiles(
  storeDir: string,
  options: SwitchToFilesOptions,
): Promise<SwitchToFilesOutcome> {
  const current = STORE_FORMAT_EPOCH;
  return withFileLock(join(storeDir, LOCK), async (): Promise<SwitchToFilesOutcome> => {
    await settleSqliteSwitch(storeDir, await readStoreFormat(storeDir));
    const marker = await readStoreFormat(storeDir);
    if (marker) judge(storeDir, marker, current);
    if (marker?.epoch === current) return { status: "current", epoch: current };
    if (marker?.epoch !== SQLITE_STORE_FORMAT_EPOCH)
      throw new StoreFormatError(
        "SWITCH_REFUSED",
        marker
          ? `This store is in store format ${marker.epoch}, not on SQLite, so there is nothing to switch back. Nothing was changed.`
          : "This store has no format marker, so it is not on SQLite. Nothing was changed.",
        storeDir,
      );
    if ((options.platform ?? process.platform) === "win32")
      throw new StoreFormatError(
        "UNDURABLE",
        "This ORCA does not yet change a store's format on Windows, because it cannot yet prove that the backup it takes first survives a power cut. Switching back to files is such a change, so nothing was changed and the store stays on SQLite.",
        storeDir,
      );
    const announcement = beginStoreSwitch(storeDir, options.appVersion);
    try {
      const writers = liveStoreWriters(storeDir);
      if (writers.length) throw busyWritersOnSqlite(storeDir, writers);
      return await switchToFilesLocked(storeDir, marker, options);
    } finally {
      announcement.end();
    }
  });
}

const busyWritersOnSqlite = (storeDir: string, writers: StoreWriterEntry[]) =>
  new StoreFormatError(
    "BUSY",
    busyWriters(storeDir, writers).message.replace("so it stays on files", "so it stays on SQLite"),
    storeDir,
  );

async function switchToFilesLocked(
  storeDir: string,
  marker: StoreFormatMarker,
  options: SwitchToFilesOptions,
): Promise<SwitchToFilesOutcome> {
  const current = STORE_FORMAT_EPOCH;
  const privacy = options.privacy ?? posixPrivateCopy;
  const now = (options.now ?? (() => new Date()))();
  const sqliteId = marker.sqliteId;
  const holdsFence = () => {
    if (options.fence && !options.fence.check())
      throw new StoreFormatError(
        "FENCE_LOST",
        `This ORCA no longer provably holds the only write access to ${storeDir}, so it was not switched back to files and stays on SQLite. Close every ORCA app, daemon and command using this workspace, then start ORCA again.`,
        storeDir,
      );
  };
  const unreadable = (error: unknown) =>
    error instanceof OrcaError && !(error instanceof StoreFormatError) && error.code === "STORE_FORMAT"
      ? new StoreFormatError("UNREADABLE", `${error.message} Nothing was changed.`, storeDir)
      : error;
  const changed = () =>
    new StoreFormatError(
      "BUSY",
      "The store changed while it was being switched back to files, so the files may not hold everything and the store stays on SQLite. Stop every ORCA app, daemon and command using it, then switch it again.",
      storeDir,
    );
  let journaled = false;
  let backup: string;
  try {
    holdsFence();
    const verified = await verifySqliteMetadata(storeDir).catch((error: unknown) => {
      throw unreadable(error);
    });
    if (!verified.ok)
      throw new StoreFormatError(
        "UNREADABLE",
        `This store's SQLite metadata did not verify (${verified.problems
          .slice(0, 3)
          .map((p) => p.kind)
          .join(
            ", ",
          )}), so it was not switched back to files and stays on SQLite. Run \`orca store sqlite verify\` for the details.`,
        storeDir,
      );
    let exported: SqliteMetadataExport;
    try {
      exported = readSqliteMetadataExport(storeDir, sqliteId);
    } catch (error) {
      throw unreadable(error);
    }
    const before = await unrestoredFiles(storeDir);
    const staged = await stageCarryover(storeDir, SQLITE_STORE_FORMAT_EPOCH, current, now, {
      privacy,
      reads: async (copy) => {
        const report = await verifySqliteMetadata(copy);
        if (!report.ok) throw new Error("the SQLite metadata in the copy did not verify");
        readSqliteMetadataExport(copy, sqliteId);
      },
    });
    backup = await staged.commit();
    holdsFence();
    await prepareSqliteSwitchDir(storeDir);
    const files = stagedFilesDir(storeDir);
    try {
      await writeFileMetadata(files, exported);
      await checkFileMetadata(files, exported);
    } catch (error) {
      throw unreadable(error);
    }
    await options.afterExport?.();
    if (!sameStoreSnapshot(before, await unrestoredFiles(storeDir))) throw changed();
    const writers = liveStoreWriters(storeDir);
    if (writers.length) throw busyWritersOnSqlite(storeDir, writers);
    holdsFence();
    const journal: SqliteSwitchJournal = { format: 1, sqliteId: sqliteId!, backup, to: "files" };
    await recordSqliteSwitchJournal(storeDir, journal);
    journaled = true;
    await restoreLegacyMetadata(storeDir, files, options.afterRestoreStep);
    if (!sameStoreSnapshot(before, await unrestoredFiles(storeDir))) throw changed();
    await options.beforeMarker?.();
    holdsFence();
    await stamp(storeDir, options.appVersion, now, { backup }, holdsFence, current, options.afterMarkerRename);
  } catch (error) {
    if (error instanceof CarryoverRefused) throw new StoreFormatError(error.failure, error.message, storeDir);
    if (!journaled) {
      await rm(join(storeDir, SQLITE_SWITCH_DIR), { recursive: true, force: true });
      throw error;
    }
    // As for the switch to SQLite: only a store whose marker provably still records SQLite is
    // put back here. A failure after the marker's rename may have published it, and an unreadable
    // marker decides nothing; either keeps the journal for the next start (settleFilesSwitch).
    const now = await readStoreFormat(storeDir).then(
      (value) => value ?? null,
      () => undefined,
    );
    if (now?.epoch === SQLITE_STORE_FORMAT_EPOCH && now.sqliteId === sqliteId) {
      await fenceLegacyMetadata(storeDir);
      await endSqliteSwitchJournal(storeDir);
    }
    throw error;
  }
  await options.afterMarker?.();
  await dropSqliteDatabase(storeDir);
  await endSqliteSwitchJournal(storeDir);
  await pruneFormatBackups(storeDir, backup, privacy);
  return { status: "switched", epoch: current, backup };
}

/**
 * Finish or undo a switch back to files that was interrupted, from its journal. The marker
 * decides: on this ORCA's file format with no database id, the switch back happened (every path
 * was restored before it), and only the database and the journal are left to drop; on SQLite,
 * naming the journal's database, which is still bound to it, every marker goes back (what was
 * restored is set aside and dropped). Anything else is refused (`INTERRUPTED`).
 */
async function settleFilesSwitch(
  storeDir: string,
  marker: StoreFormatMarker | undefined,
  journal: SqliteSwitchJournal,
): Promise<void> {
  if (marker?.epoch === STORE_FORMAT_EPOCH && !marker.sqliteId) {
    await syncMarker(storeDir);
    await dropSqliteDatabase(storeDir);
  } else if (
    marker?.epoch === SQLITE_STORE_FORMAT_EPOCH &&
    marker.sqliteId === journal.sqliteId &&
    sqliteDatabaseBinding(storeDir) === journal.sqliteId
  )
    await fenceLegacyMetadata(storeDir);
  else throw switchInterrupted(storeDir);
  await endSqliteSwitchJournal(storeDir);
}
