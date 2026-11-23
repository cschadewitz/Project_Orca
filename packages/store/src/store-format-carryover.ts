/**
 * Carrying an older-format store forward (#566): a verified whole-store backup and a read
 * check under the new readers, both done before the current format is stamped.
 *
 * Two callers run this. The explicit `orca store carry-forward`, with the person stating every
 * other ORCA process is stopped; and the desktop app's bundled daemon on the first start after an
 * update, only while it holds the store's exclusive writer fence (`fence`, #897), which is checked
 * before the copy, after it, after the read check and just before the marker. Neither assumes
 * the store is quiet: pre-0.7.1 writers hold no lock this code can see, so quiescence is checked
 * as well: no live run lease (a lease lookup that fails refuses), and the store's complete
 * file signature (path, type, size, mtime, inode) unchanged from before the copy, after it, and
 * again just before the marker is written. Each copied file's bytes are compared with the
 * source. Any difference discards the staged copy and refuses startup with the prior format
 * still authoritative.
 *
 * On Linux and macOS, backups are directories under `format-backups/` that this code names and
 * marks with `format-backup.json`; retention removes only those, never anything else it finds
 * there. On Windows, a backup is one ZIP archive written in place into one of two backup slot
 * files under `format-backups/` that existed before Windows last started (backup-archive.ts,
 * #910): the two slots are the retention.
 *
 * The copies hold the execution key and private records, so they are only ever written where
 * a {@link PrivateCopyBackend} has verified they stay private to this user: on POSIX an
 * owner-only backups directory, which nobody else can traverse; on Windows, where traversal
 * is not a barrier, every directory is created with an owner-only protected DACL and every
 * directory and file copied is verified owner-only afterwards (#897).
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readArchive, writeArchiveSlot } from "./backup-archive.js";
import { fileStores } from "./document-store.js";
import { createCopy, createDurable, syncDirectory } from "./durable-file.js";
import { FileLeaseStore, lapsed } from "./lease-store.js";

export const STORE_FORMAT_BACKUP_DIR = "format-backups";
export const STORE_FORMAT_BACKUP_RETENTION = 2;
export const STORE_FORMAT_BACKUP_MANIFEST = "format-backup.json";
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-from-[a-z0-9-]{1,64}(-\d{1,4})?$/;
const SCRATCH_NAME = /^\.(partial|validate)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Windows backup slots (#910), under `format-backups/`. Created whenever a Windows ORCA opens the
 * store for writing, each holding its {@link SlotIdentity}; usable once Windows has restarted
 * since (the boot that created it is no longer the current one), which proves its directory
 * entry is on disk.
 */
export const STORE_FORMAT_BACKUP_SLOTS = ["store-backup-1.zip", "store-backup-2.zip"] as const;

/**
 * Which file a slot is and in which Windows session it was created. `volume` and `file` are the
 * NTFS volume serial and file ID, so a copied or replaced slot no longer matches; `createdBoot` is
 * the Windows `BootId`, which Windows increases on every start and which no clock can move.
 */
const SlotIdentitySchema = z.object({
  format: z.literal(1),
  tool: z.literal("orca-backup-slot"),
  slot: z.string().min(1).max(64),
  volume: z.string().regex(/^\d{1,24}$/),
  file: z.string().regex(/^\d{1,24}$/),
  createdBoot: z.number().int().nonnegative(),
});
export type SlotIdentity = z.infer<typeof SlotIdentitySchema>;

const BOOT_ID_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters";
/** Windows' boot counter (`BootId`), or `undefined` when it cannot be read: no slot is then usable. */
export function windowsBootId(): number | undefined {
  try {
    const text = execFileSync("reg", ["query", BOOT_ID_KEY, "/v", "BootId"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const match = /BootId\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(text);
    return match ? Number.parseInt(match[1]!, 16) : undefined;
  } catch {
    return undefined;
  }
}

/** The desktop updater's handoff record (`@orca/protocol/update-handoff`, #897). */
export const STORE_UPDATE_HANDOFF_FILE = "update-handoff.json";

/** Never copied or compared: the backups themselves, locks, update-window guards, the marker, the
 * updater's handoff (rewritten by the carrying daemon itself before it copies). */
const skipped = (name: string, top: boolean) =>
  name.endsWith(".lock") ||
  (top &&
    (name === STORE_FORMAT_BACKUP_DIR ||
      name.startsWith(".orca-update-window") ||
      name.startsWith("store-format.json") ||
      name.startsWith(STORE_UPDATE_HANDOFF_FILE)));

const ManifestSchema = z.object({
  format: z.literal(1),
  tool: z.literal("orca-store-format"),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  createdAt: z.string().min(1).max(64),
  files: z.number().int().nonnegative(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
  /** Windows (#910): the slot the backup was archived into, as the slot recorded itself. */
  slot: SlotIdentitySchema.optional(),
});
type Manifest = z.infer<typeof ManifestSchema>;

export type CarryoverFailure = "BUSY" | "UNREADABLE" | "BACKUPS_UNSAFE" | "FENCE_LOST";
export class CarryoverRefused extends Error {
  constructor(
    readonly failure: CarryoverFailure,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Where the private copies may be written. `mkdir` creates one new directory, private to this
 * user, and fails if anything is already there. `privateRoot` says whether an existing directory
 * is private to this user. `privateEntry` checks each directory and file after it is copied.
 */
export interface PrivateCopyBackend {
  mkdir(path: string): Promise<void>;
  privateRoot(path: string): Promise<boolean>;
  privateEntry(path: string, kind: "dir" | "file"): Promise<boolean>;
}

/** POSIX: the owner-only backups directory keeps everything under it from anyone else. */
export const posixPrivateCopy: PrivateCopyBackend = {
  async mkdir(path) {
    await mkdir(path, { mode: 0o700 });
  },
  async privateRoot(path) {
    const info = await lstat(path);
    return info.isDirectory() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.();
  },
  privateEntry: () => Promise.resolve(true),
};

const unsafeCopy = (path: string) =>
  new CarryoverRefused(
    "BACKUPS_UNSAFE",
    `${path} could not be verified as private to this user, so the store was not copied there. Nothing was changed.`,
  );

/** A new private directory, verified; any failure is a refusal, never a half-private copy. */
async function privateDirectory(privacy: PrivateCopyBackend, path: string): Promise<void> {
  try {
    await privacy.mkdir(path);
  } catch {
    throw unsafeCopy(path);
  }
  if (!(await privacy.privateEntry(path, "dir").catch(() => false))) throw unsafeCopy(path);
}

export interface StoreSnapshotEntry {
  type: "dir" | "file";
  mode: number;
  /** Only what a writer changes: size, mtime and inode for files. */
  state: string;
}
export type StoreSnapshot = Map<string, StoreSnapshotEntry>;
type Snapshot = StoreSnapshot;

/** Every file and directory under `root` (backups and lock files excluded), with what identifies its content. */
export async function snapshotStore(root: string): Promise<Snapshot> {
  return snapshot(root);
}

async function snapshot(root: string): Promise<Snapshot> {
  const out: Snapshot = new Map();
  const walk = async (dir: string, prefix: string) => {
    for (const name of (await readdir(dir)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (skipped(name, !prefix)) continue;
      const path = join(dir, name);
      const info = await lstat(path, { bigint: true });
      const mode = Number(info.mode & 0o7777n);
      // Links are refused: a backup must be self-contained and the throwaway read copy
      // isolated, and neither holds if a link can point outside them.
      if (info.isSymbolicLink())
        throw new CarryoverRefused(
          "UNREADABLE",
          `${path} is a link. This store cannot be carried forward automatically while it holds links; replace the link with what it points to, or restore a complete backup. Nothing was changed.`,
        );
      if (info.isDirectory()) {
        out.set(relative, { type: "dir", mode, state: "" });
        await walk(path, relative);
      } else if (info.isFile())
        out.set(relative, { type: "file", mode, state: `${info.size}:${info.mtimeNs}:${info.ino}` });
      // Sockets, FIFOs and devices are not store data and are not copied.
    }
  };
  await walk(root, "");
  return out;
}

export const sameStoreSnapshot = (a: Snapshot, b: Snapshot): boolean => sameSnapshot(a, b);

const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.size === b.size &&
  [...a].every(([path, entry]) => {
    const other = b.get(path);
    return other?.type === entry.type && other.mode === entry.mode && other.state === entry.state;
  });

const signatureOf = (s: Snapshot) =>
  createHash("sha256")
    .update(JSON.stringify([...s].map(([path, e]) => [path, e.type, e.mode])))
    .digest("hex");

function digest(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => done(hash.digest("hex")));
  });
}

/** `target` is a new private directory; `entries` lists parents before their children. */
async function copyTree(source: string, target: string, entries: Snapshot, privacy: PrivateCopyBackend): Promise<void> {
  // Directories first, private while filling; on POSIX their recorded modes are restored last.
  for (const [path, entry] of entries) if (entry.type === "dir") await privateDirectory(privacy, join(target, path));
  for (const [path, entry] of entries) {
    if (entry.type === "file") {
      await createCopy(join(source, path), join(target, path));
      if (!(await privacy.privateEntry(join(target, path), "file").catch(() => false)))
        throw unsafeCopy(join(target, path));
      if (process.platform !== "win32") await chmod(join(target, path), entry.mode);
      const info = await lstat(join(source, path));
      await utimes(join(target, path), info.atime, info.mtime);
    }
  }
  if (process.platform !== "win32")
    for (const [path, entry] of [...entries].reverse())
      if (entry.type === "dir") await chmod(join(target, path), entry.mode);
  // Every file is flushed already; flush each directory's entries, deepest first.
  for (const [path, entry] of [...entries].reverse()) if (entry.type === "dir") await syncDirectory(join(target, path));
  await syncDirectory(target);
}

async function verifyCopy(source: string, target: string, entries: Snapshot): Promise<boolean> {
  for (const [path, entry] of entries)
    if (entry.type === "file" && (await digest(join(source, path))) !== (await digest(join(target, path))))
      return false;
  return true;
}

/** Open everything the stores hold through the current readers, in a disposable copy. */
async function readsUnderCurrentFormat(copy: string): Promise<void> {
  const stores = fileStores(copy);
  for (const run of await stores.events.listRuns()) await stores.events.read(run);
  await stores.requests.list();
  await stores.workItems.list();
  await stores.artifacts.list();
  await stores.leases.list();
  await stores.plan.plans.list();
  await stores.plan.dependencies.list();
  await stores.plan.risks.list();
  await stores.plan.decisions.list();
  for (const plan of await stores.plan.journal.listPlans()) await stores.plan.journal.read(plan);
}

/** The backups directory, created private; refuses one that is not a private directory of ours. */
async function backupRoot(storeDir: string, privacy: PrivateCopyBackend): Promise<string> {
  const root = join(storeDir, STORE_FORMAT_BACKUP_DIR);
  if (!(await present(root)))
    try {
      await privacy.mkdir(root);
    } catch {
      // Another carryover may have created it meanwhile; it is verified below either way.
      if (!(await present(root))) throw unsafeCopy(root);
    }
  const info = await lstat(root);
  if (!info.isDirectory() || !(await privacy.privateRoot(root).catch(() => false)))
    throw new CarryoverRefused(
      "BACKUPS_UNSAFE",
      `${root} is not a private directory owned by this user, so no backup was written. Fix or move it aside, then start ORCA again.`,
    );
  return root;
}

const busy = () =>
  new CarryoverRefused(
    "BUSY",
    "Another ORCA process changed this store while it was being backed up before the format change. Nothing was carried forward. Stop every other ORCA app, daemon and command using this workspace, then start ORCA again.",
  );

/**
 * Back the store up whole, verify the copy and that the store did not move, and read the store
 * under the current format. Returns `commit`, to be called just before the marker is written:
 * it re-checks the store, then publishes the backup by rename. Throws {@link CarryoverRefused}.
 */
export async function stageCarryover(
  storeDir: string,
  from: string,
  to: string,
  now: Date,
  hooks: {
    afterCopy?: () => Promise<void>;
    /** Throws {@link CarryoverRefused} (FENCE_LOST) once the writer fence no longer holds. */
    fence?: () => void;
    privacy?: PrivateCopyBackend;
    /**
     * Windows (#910): the backup slot ({@link chooseBackupSlot}) the backup is archived into, in
     * place and flushed, instead of being published by rename. Its identity goes into the
     * manifest, so the archive itself records which slot it was written into.
     */
    slot?: BackupSlot;
  } = {},
): Promise<{ commit(): Promise<string> }> {
  const fence = hooks.fence ?? (() => undefined);
  const privacy = hooks.privacy ?? posixPrivateCopy;
  fence();
  let leases;
  try {
    leases = await new FileLeaseStore(storeDir).list();
  } catch (error) {
    throw new CarryoverRefused(
      "BUSY",
      `Run leases in this store could not be read, so it cannot be confirmed that no run is active: ${(error as Error).message}. Nothing was changed.`,
    );
  }
  const live = leases.filter((lease) => !lapsed(lease));
  if (live.length)
    throw new CarryoverRefused(
      "BUSY",
      `Run ${live[0]!.resource} is still being interpreted by pid ${live[0]!.pid} on ${live[0]!.host}. The store format changes only once no run is active. Let it finish or stop it, then start ORCA again.`,
    );
  const root = await backupRoot(storeDir, privacy);
  const partial = join(root, `.partial-${randomUUID()}`);
  const validate = join(root, `.validate-${randomUUID()}`);
  try {
    const before = await snapshot(storeDir);
    await privateDirectory(privacy, partial);
    await copyTree(storeDir, partial, before, privacy);
    await hooks.afterCopy?.();
    fence();
    if (!sameSnapshot(before, await snapshot(storeDir)) || !(await verifyCopy(storeDir, partial, before))) throw busy();
    // The readers may write (keys, generation records); they get a throwaway copy, never the backup.
    const staged = await snapshot(partial);
    await privateDirectory(privacy, validate);
    await copyTree(partial, validate, before, privacy);
    try {
      await readsUnderCurrentFormat(validate);
      // The readers may write, but only inside the throwaway copy: with links refused, every
      // store path resolves under the directory it was given. Prove that the backup and the
      // store itself were left exactly as they were.
      if (!sameSnapshot(staged, await snapshot(partial)) || !(await verifyCopy(storeDir, partial, before)))
        throw new Error("the read check changed the staged backup");
    } catch (error) {
      if (error instanceof CarryoverRefused) throw error;
      throw new CarryoverRefused(
        "UNREADABLE",
        `This store could not be read by this ORCA before its format was changed, so nothing was changed: ${(error as Error).message}. Open it with the ORCA version that last wrote it, or restore a complete backup.`,
      );
    } finally {
      await rm(validate, { recursive: true, force: true });
    }
    fence();
    const manifest: Manifest = {
      format: 1,
      tool: "orca-store-format",
      from,
      to,
      createdAt: now.toISOString(),
      files: [...before.values()].filter((e) => e.type === "file").length,
      signature: signatureOf(before),
      ...(hooks.slot ? { slot: hooks.slot.identity } : {}),
    };
    // The copy is durable (createCopy, copyTree) before its manifest, and the manifest before
    // the copy can be published.
    await createDurable(join(partial, STORE_FORMAT_BACKUP_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
    await syncDirectory(partial);
    return {
      async commit() {
        try {
          if (!sameSnapshot(before, await snapshot(storeDir))) throw busy();
          if (hooks.slot) {
            fence();
            await archiveInto(hooks.slot.path, partial, before);
            await rm(partial, { recursive: true, force: true });
            return hooks.slot.path;
          }
          const name = `${now.toISOString().replace(/[:.]/g, "-")}-from-${from}`;
          let target = join(root, name);
          for (let n = 1; await present(target); n++) target = join(root, `${name}-${n}`);
          // Checked with no await between it and the rename that publishes the backup.
          fence();
          await rename(partial, target);
          await syncDirectory(root);
          return target;
        } catch (error) {
          await rm(partial, { recursive: true, force: true });
          throw error;
        }
      },
    };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isOurBackup(root: string, name: string): Promise<boolean> {
  if (!BACKUP_NAME.test(name)) return false;
  const info = await lstat(join(root, name));
  if (!info.isDirectory()) return false;
  try {
    return ManifestSchema.safeParse(JSON.parse(await readFile(join(root, name, STORE_FORMAT_BACKUP_MANIFEST), "utf8")))
      .success;
  } catch {
    return false;
  }
}

/**
 * Keep the newest {@link STORE_FORMAT_BACKUP_RETENTION} verified backups and always `keep` (the
 * one the marker names). Remove scratch directories of interrupted carryovers. Leave anything
 * else, including entries that look like backups but carry no valid manifest.
 */
export async function pruneFormatBackups(
  storeDir: string,
  keep: string,
  privacy: PrivateCopyBackend = posixPrivateCopy,
): Promise<void> {
  const root = await backupRoot(storeDir, privacy);
  const names = await readdir(root);
  for (const name of names)
    if (SCRATCH_NAME.test(name) && (await lstat(join(root, name))).isDirectory())
      await rm(join(root, name), { recursive: true, force: true });
  const ours: string[] = [];
  for (const name of names) if (await isOurBackup(root, name)) ours.push(name);
  ours.sort();
  for (const name of ours.slice(0, Math.max(0, ours.length - STORE_FORMAT_BACKUP_RETENTION)))
    if (join(root, name) !== keep) await rm(join(root, name), { recursive: true, force: true });
}

/**
 * Archive the staged, verified copy into `slot` (flushed before this returns), then read the
 * archive back and compare every entry with the staged copy. Throws when they differ.
 */
async function archiveInto(slot: string, partial: string, entries: Snapshot): Promise<void> {
  const listed = [...entries].map(([path, entry]) => ({ path, type: entry.type }));
  listed.push({ path: STORE_FORMAT_BACKUP_MANIFEST, type: "file" });
  const withTimes = await Promise.all(
    listed.map(async (entry) => ({ ...entry, mtime: (await lstat(join(partial, entry.path))).mtime })),
  );
  await writeArchiveSlot(slot, partial, withTimes, []);
  const archived = await readArchive(slot);
  const expected = new Map<string, string>();
  for (const entry of listed)
    expected.set(
      entry.type === "dir" ? `${entry.path}/` : entry.path,
      entry.type === "dir" ? "" : await digest(join(partial, entry.path)),
    );
  if (
    archived.entries.size !== expected.size ||
    [...expected].some(([name, hash]) => archived.entries.get(name) !== hash)
  )
    throw new Error(`the backup archived into ${slot} does not match the staged copy`);
}

/** A Windows backup slot a carryover may archive into. */
export interface BackupSlot {
  path: string;
  identity: SlotIdentity;
}

/** What a slot holds now: its own identity only, a store backup archive, or anything else. */
type SlotContent =
  | { kind: "blank"; identity: SlotIdentity }
  | { kind: "archive"; identity: SlotIdentity; manifest: Manifest }
  | { kind: "other" };

const IDENTITY_LIMIT = 4096;

async function fileIdentity(path: string): Promise<{ volume: string; file: string }> {
  const info = await lstat(path, { bigint: true });
  return { volume: info.dev.toString(), file: info.ino.toString() };
}

/** Read a slot's content: its identity, and for an archive the backup's manifest (only). */
async function readSlot(path: string): Promise<SlotContent> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { kind: "other" };
    // An identity is a short JSON object; anything else is read as an archive.
    const head = info.size <= IDENTITY_LIMIT ? await readFile(path) : undefined;
    if (head && head[0] === 0x7b) {
      const parsed = SlotIdentitySchema.safeParse(JSON.parse(head.toString("utf8")));
      return parsed.success ? { kind: "blank", identity: parsed.data } : { kind: "other" };
    }
    const listing = await readArchive(path, {
      only: [STORE_FORMAT_BACKUP_MANIFEST],
      keep: [STORE_FORMAT_BACKUP_MANIFEST],
    });
    const text = listing.texts.get(STORE_FORMAT_BACKUP_MANIFEST);
    const manifest = text ? ManifestSchema.safeParse(JSON.parse(text.toString("utf8"))) : undefined;
    return manifest?.success && manifest.data.slot
      ? { kind: "archive", identity: manifest.data.slot, manifest: manifest.data }
      : { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

/** Whether `identity` is this very file (same volume and file ID) and this slot's name. */
async function isThisSlot(path: string, name: string, identity: SlotIdentity): Promise<boolean> {
  const actual = await fileIdentity(path).catch(() => undefined);
  return identity.slot === name && identity.volume === actual?.volume && identity.file === actual?.file;
}

/** Overwrite `path` in place with this file's identity, flushed. The file is never replaced. */
async function writeIdentity(path: string, name: string, boot: number): Promise<void> {
  const identity: SlotIdentity = {
    format: 1,
    tool: "orca-backup-slot",
    slot: name,
    ...(await fileIdentity(path)),
    createdBoot: boot,
  };
  const handle = await open(path, "r+");
  try {
    const bytes = Buffer.from(JSON.stringify(identity) + "\n", "utf8");
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Windows (#910): make sure the backups directory and both backup slots exist, each private to
 * this user and recording its own identity. A slot whose identity is missing or names another
 * file (copied or replaced) is stamped anew with the current boot, unless it holds a backup
 * archive, which is never overwritten here. A slot stamped now is usable only after Windows
 * restarts. With no `boot` (BootId unreadable), slots are created but not stamped.
 */
export async function ensureBackupSlots(
  storeDir: string,
  privacy: PrivateCopyBackend,
  boot: number | undefined,
): Promise<void> {
  const root = await backupRoot(storeDir, privacy);
  for (const name of STORE_FORMAT_BACKUP_SLOTS) {
    const path = join(root, name);
    if (!(await present(path)))
      try {
        await createDurable(path, "");
      } catch (error) {
        // Another ORCA may have created it meanwhile; it is checked below either way.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    const info = await lstat(path);
    if (!info.isFile() || !(await privacy.privateEntry(path, "file").catch(() => false))) throw unsafeCopy(path);
    if (boot === undefined) continue;
    const content = await readSlot(path);
    // A backup, or anything else not empty and not an identity (a damaged backup, say), is kept.
    if (content.kind === "archive" || (content.kind === "other" && info.size > 0)) continue;
    if (content.kind === "blank" && (await isThisSlot(path, name, content.identity))) continue;
    await writeIdentity(path, name, boot);
  }
}

/**
 * The epochs `manifest` converted between are both ones the store has already settled on: a
 * finished carryover's backup, safe to overwrite once it is not the marker's own backup.
 */
function settled(manifest: Manifest, markerEpoch: string | undefined, history: readonly string[]): boolean {
  if (!markerEpoch) return false;
  const to = history.indexOf(manifest.to);
  return to >= 0 && to <= history.indexOf(markerEpoch);
}

/**
 * Windows (#910): the backup slot a carryover may overwrite, or `undefined` when none may be yet.
 * A slot qualifies only if it is a private regular file whose recorded identity is this very
 * file, created in an earlier Windows session than the current one (`boot`), so its directory
 * entry survived a restart. It must not be `keep` (the backup the marker names), and if it holds
 * an archive, that archive must be a settled one (see {@link findRecoveryRecord}): a backup
 * whose conversion the marker does not yet reflect is never overwritten. A slot holding only its
 * identity is preferred, then the archive written longest ago.
 */
export async function chooseBackupSlot(
  storeDir: string,
  privacy: PrivateCopyBackend,
  options: {
    keep: string | undefined;
    boot: number | undefined;
    markerEpoch: string | undefined;
    history: readonly string[];
  },
): Promise<BackupSlot | undefined> {
  if (options.boot === undefined) return undefined;
  const root = join(storeDir, STORE_FORMAT_BACKUP_DIR);
  const eligible: (BackupSlot & { order: string })[] = [];
  for (const name of STORE_FORMAT_BACKUP_SLOTS) {
    const path = join(root, name);
    if (path === options.keep) continue;
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || !(await privacy.privateEntry(path, "file").catch(() => false))) continue;
    const content = await readSlot(path);
    if (content.kind === "other") continue;
    if (content.identity.createdBoot === options.boot) continue;
    if (!(await isThisSlot(path, name, content.identity))) continue;
    if (content.kind === "archive" && !settled(content.manifest, options.markerEpoch, options.history)) continue;
    eligible.push({
      path,
      identity: content.identity,
      order: content.kind === "blank" ? "" : content.manifest.createdAt,
    });
  }
  eligible.sort((a, b) => a.order.localeCompare(b.order));
  const chosen = eligible[0];
  return chosen ? { path: chosen.path, identity: chosen.identity } : undefined;
}

export interface RecoveryRecord {
  path: string;
  manifest: Manifest;
}

/**
 * Windows (#910): a slot archive is the durable record of a carryover across marker loss. It is
 * flushed before the marker is created, and names its conversion (`from`, `to`) and its own
 * slot. Every slot is examined before anything is returned:
 *
 * - `newer`: a record converting to an epoch outside `history` or after `current`, written by a
 *   newer ORCA. It takes precedence over everything else: the store must not be opened.
 * - `pending`: every record whose `from` is what the marker says now (or "unmarked" with no
 *   marker) and whose `to` is not: unfinished, as the marker may have been lost after it. More
 *   than one is ambiguous, and the caller refuses.
 */
export async function findRecoveryRecord(
  storeDir: string,
  markerEpoch: string | undefined,
  current: string,
  history: readonly string[],
): Promise<{ newer: RecoveryRecord | undefined; pending: RecoveryRecord[] }> {
  const root = join(storeDir, STORE_FORMAT_BACKUP_DIR);
  const mine = history.indexOf(current);
  let newer: RecoveryRecord | undefined;
  const pending: RecoveryRecord[] = [];
  for (const name of STORE_FORMAT_BACKUP_SLOTS) {
    const path = join(root, name);
    const content = await readSlot(path);
    if (content.kind !== "archive" || !(await isThisSlot(path, name, content.identity))) continue;
    const record = { path, manifest: content.manifest };
    const to = history.indexOf(content.manifest.to);
    if (to < 0 || to > mine) newer ??= record;
    else if (content.manifest.from === (markerEpoch ?? "unmarked") && content.manifest.to !== markerEpoch)
      pending.push(record);
  }
  return { newer, pending };
}

/** Whether the store's files are, byte for byte, the ones archived in `slot` (a full read). */
export async function storeMatchesArchive(storeDir: string, slot: string): Promise<boolean> {
  try {
    const archived = await readArchive(slot);
    const now = await snapshot(storeDir);
    const expected = new Map<string, string>();
    for (const [path, entry] of now)
      expected.set(
        entry.type === "dir" ? `${path}/` : path,
        entry.type === "dir" ? "" : await digest(join(storeDir, path)),
      );
    archived.entries.delete(STORE_FORMAT_BACKUP_MANIFEST);
    return (
      archived.entries.size === expected.size &&
      [...expected].every(([name, hash]) => archived.entries.get(name) === hash)
    );
  } catch {
    return false;
  }
}
