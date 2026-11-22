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
import {
  CarryoverRefused,
  chooseBackupSlot,
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
  | "NEWER"
  | "TOO_OLD"
  | "DAMAGED"
  | "CARRYOVER_REQUIRED"
  | "BUSY"
  | "UNREADABLE"
  | "BACKUPS_UNSAFE"
  | "FENCE_LOST"
  | "APP_OWNED"
  | "UNDURABLE"
  | "INTERRUPTED";
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
  backup: string | undefined,
  guard: () => void = () => undefined,
): Promise<void> {
  const value: StoreFormatMarker = {
    format: 1,
    epoch: STORE_FORMAT_EPOCH,
    writtenBy: appVersion,
    updatedAt: now.toISOString(),
    ...(backup ? { backup } : {}),
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
    if (marker?.epoch === current) return "current" as const;
    if (marker) throw carryoverRequired(storeDir, marker.epoch);
    if (!(await holdsData(storeDir))) return "fresh" as const;
    if (await writtenByAdoptableLine(storeDir)) return "adopted" as const;
    throw carryoverRequired(storeDir, "unmarked");
  };
  if (options.mode === "read") return { status: await classify(await check()), epoch: current };
  await mkdir(storeDir, { recursive: true });
  return withFileLock(join(storeDir, LOCK), async (): Promise<StoreFormatOutcome> => {
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
      await stamp(storeDir, options.appVersion, now, marker?.backup);
    if ((options.platform ?? process.platform) === "win32" && options.privacy)
      // Best effort: without slots a later carryover only waits for a restart (UNDURABLE).
      await ensureBackupSlots(storeDir, options.privacy, (options.bootId ?? windowsBootId)()).catch(() => undefined);
    return { status, epoch: current };
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
  if (marker?.epoch === current) return { status: "current", epoch: current };
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
      await stamp(storeDir, options.appVersion, now, record.path, fence);
      return { status: "carried", epoch: current, from, backup: record.path };
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
    await stamp(storeDir, options.appVersion, now, backup, fence);
  } catch (error) {
    if (error instanceof CarryoverRefused) throw new StoreFormatError(error.failure, error.message, storeDir);
    throw error;
  }
  await pruneFormatBackups(storeDir, backup, privacy);
  return { status: "carried", epoch: current, from, backup };
}
