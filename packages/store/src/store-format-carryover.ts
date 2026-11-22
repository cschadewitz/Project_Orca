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
 * Backups are directories under `format-backups/` that this code names and marks with
 * `format-backup.json`; retention removes only those, never anything else it finds there.
 *
 * The copies hold the execution key and private records, so they are only ever written where
 * a {@link PrivateCopyBackend} has verified they stay private to this user: on POSIX an
 * owner-only backups directory, which nobody else can traverse; on Windows, where traversal
 * is not a barrier, every directory is created with an owner-only protected DACL and every
 * directory and file copied is verified owner-only afterwards (#897).
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fileStores } from "./document-store.js";
import { FileLeaseStore, lapsed } from "./lease-store.js";

export const STORE_FORMAT_BACKUP_DIR = "format-backups";
export const STORE_FORMAT_BACKUP_RETENTION = 2;
export const STORE_FORMAT_BACKUP_MANIFEST = "format-backup.json";
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-from-[a-z0-9-]{1,64}(-\d{1,4})?$/;
const SCRATCH_NAME = /^\.(partial|validate)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
});

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

interface Entry {
  type: "dir" | "file";
  mode: number;
  /** Only what a writer changes: size, mtime and inode for files. */
  state: string;
}
type Snapshot = Map<string, Entry>;

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
      await copyFile(join(source, path), join(target, path));
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
    const manifest: z.infer<typeof ManifestSchema> = {
      format: 1,
      tool: "orca-store-format",
      from,
      to,
      createdAt: now.toISOString(),
      files: [...before.values()].filter((e) => e.type === "file").length,
      signature: signatureOf(before),
    };
    await writeFile(join(partial, STORE_FORMAT_BACKUP_MANIFEST), JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return {
      async commit() {
        try {
          fence();
        } catch (error) {
          await rm(partial, { recursive: true, force: true });
          throw error;
        }
        if (!sameSnapshot(before, await snapshot(storeDir))) {
          await rm(partial, { recursive: true, force: true });
          throw busy();
        }
        const name = `${now.toISOString().replace(/[:.]/g, "-")}-from-${from}`;
        let target = join(root, name);
        for (let n = 1; await present(target); n++) target = join(root, `${name}-${n}`);
        await rename(partial, target);
        return target;
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
