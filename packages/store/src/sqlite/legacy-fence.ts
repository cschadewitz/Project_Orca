/**
 * Keeping released ORCA versions that never read the format marker out of a store switched to
 * SQLite (#339).
 *
 * v0.7.0 and v0.6.0 open a standalone store without looking at `store-format.json`, so the
 * SQLite epoch alone does not stop them: they would open the file metadata the switch leaves
 * behind, which no longer keeps up, and write to it. The switch therefore takes every path they
 * read before they write and puts a *marker* there that is not what they expect:
 *
 * - `private-execution/.execution-key` and `private-workflows/.execution-key`: the key is
 *   hard-linked to `.execution-key.sqlite` (protected-file.ts, where this ORCA looks for it) and a
 *   marker file that is not a 32-byte key takes its place. v0.7.0 reads these keys while it
 *   starts, finds them unreadable, and refuses (`RUN_STATE`) before its first write.
 * - the collection files (`requests.json`, `work-items.json`, `plans.json`, `dependencies.json`,
 *   `risks.json`, `decisions.json`): a marker file that is not a JSON array, which their reads
 *   reject; the writes are read-modify-write under a lock, so they fail before writing.
 * - the log directories (`runs`, `plans`): a marker *file*, so creating or reading anything in
 *   them fails (`EEXIST`, `ENOTDIR`); v0.6.0 opens one of these, or a collection, before its
 *   first write.
 * - `workflows` (pinned workflow versions written before 0.7, still read by this ORCA): moved to
 *   `workflows.sqlite` ({@link SQLITE_LEGACY_WORKFLOWS_DIR}, workflow-store.ts reads it there),
 *   with a marker file in its place.
 * - the artifact index `artifacts/index.jsonl`: a marker *directory* (`EISDIR`). The blobs beside
 *   it stay where they are; this ORCA's SQLite backend uses them.
 *
 * The other originals go to `<store>/.sqlite-switch/aside/` (keys stay as the hard link), with a
 * journal naming the switch, until the marker publishes the switch; then they are dropped, since
 * the database and the switch's backup hold them. Every step is reversible until then:
 * {@link unfenceLegacyMetadata} puts each original back and removes each marker, which is how a
 * refused or interrupted switch leaves the store on files exactly as it was.
 *
 * The keys and the collection files are replaced by one rename each, so there is never a moment
 * when they are missing. A log directory or the artifact index is renamed aside before its
 * marker goes in; for that instant the path is absent, which matters only to a released ORCA
 * started inside that instant whose earlier reads (keys, collections) did not already stop it.
 */
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { OrcaError } from "@orca/core";
import { createDurable, syncDirectory } from "../durable-file.js";
import { SQLITE_KEY_FILE } from "../protected-file.js";

export const SQLITE_SWITCH_DIR = ".sqlite-switch";
const JOURNAL = "journal.json";
const ASIDE = "aside";
// rename-keep-start: a fence marker is compared byte for byte with what existing stores hold
/** What a marker says, for a person who finds one. */
export const LEGACY_FENCE_NOTE =
  "This ORCA store keeps its metadata in SQLite (metadata.sqlite); this file only keeps ORCA versions from before 0.7.1 out of it.";
const MARKER = `${JSON.stringify({ orcaStore: "sqlite", note: LEGACY_FENCE_NOTE })}\n`;
const MARKER_README = "ORCA-SQLITE-STORE.json";
// rename-keep-end

type FenceKind = "key" | "file" | "dir" | "relocate" | "index";

/** Where a SQLite store keeps the pinned workflow versions an ORCA before 0.7 wrote to `workflows/`. */
export const SQLITE_LEGACY_WORKFLOWS_DIR = "workflows.sqlite";
interface Fence {
  path: string;
  kind: FenceKind;
}

/** In the order they are put in place: the keys first, since they stop v0.7.0 earliest. */
export const LEGACY_FENCES: readonly Fence[] = [
  { path: "private-execution/.execution-key", kind: "key" },
  { path: "private-workflows/.execution-key", kind: "key" },
  ...["requests.json", "work-items.json", "plans.json", "dependencies.json", "risks.json", "decisions.json"].map(
    (path) => ({ path, kind: "file" as const }),
  ),
  { path: "runs", kind: "dir" },
  { path: "plans", kind: "dir" },
  { path: "workflows", kind: "relocate" },
  { path: "artifacts/index.jsonl", kind: "index" },
];

export interface SqliteSwitchJournal {
  format: 1;
  sqliteId: string;
  backup: string;
  /**
   * `"files"`: the switch back from SQLite to files (`switchStoreToFiles`), whose metadata was
   * written out to {@link stagedFilesDir} before this journal. Absent: a switch to SQLite.
   */
  to?: "files";
  /**
   * The database file this switch started from or built (`<dev>:<ino>` of `metadata.sqlite` when
   * the journal was written): recovery keeps, fences or drops only that file, never a replacement
   * that happens to be bound to the same store. Always written; a switch to SQLite journaled by an
   * earlier build has none and is judged by its binding alone.
   */
  database?: string;
}

/** Where the switch back to files writes the file metadata before it restores it into place. */
export function stagedFilesDir(storeDir: string): string {
  return join(sqliteSwitchDir(storeDir), "files");
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const asideName = (path: string) => encodeURIComponent(path);

async function kindOf(path: string): Promise<"file" | "dir" | undefined> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new OrcaError("STORE_FORMAT", `${path} is a link`, { reason: "UNREADABLE" });
    return info.isDirectory() ? "dir" : "file";
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Whether `path` is a marker this module put there. */
async function isMarker(path: string): Promise<boolean> {
  const kind = await kindOf(path);
  const file = kind === "dir" ? join(path, MARKER_README) : kind === "file" ? path : undefined;
  if (!file) return false;
  try {
    return (await readFile(file, "utf8")) === MARKER;
  } catch {
    return false;
  }
}

async function writeMarkerFile(path: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.fence`;
  await createDurable(tmp, MARKER);
  await rename(tmp, path);
}

async function writeMarkerDir(path: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.fence`;
  await mkdir(tmp, { mode: 0o700 });
  await createDurable(join(tmp, MARKER_README), MARKER);
  await rename(tmp, path);
}

export function sqliteSwitchDir(storeDir: string): string {
  return join(storeDir, SQLITE_SWITCH_DIR);
}

export async function readSqliteSwitchJournal(storeDir: string): Promise<SqliteSwitchJournal | undefined> {
  let text: string;
  try {
    text = await readFile(join(sqliteSwitchDir(storeDir), JOURNAL), "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<SqliteSwitchJournal>;
    if (
      value.format === 1 &&
      typeof value.sqliteId === "string" &&
      typeof value.backup === "string" &&
      (value.to === undefined || value.to === "files") &&
      (value.database === undefined ? value.to === undefined : typeof value.database === "string")
    )
      return value as SqliteSwitchJournal;
  } catch {
    // Unreadable: reported below.
  }
  throw new OrcaError(
    "STORE_FORMAT",
    `${join(sqliteSwitchDir(storeDir), JOURNAL)} is damaged; restore the store from its format backup.`,
    { reason: "DAMAGED", storeDir },
  );
}

/** Record, durably, that a switch is about to fence the store; before the first marker. */
export async function beginSqliteSwitchJournal(storeDir: string, journal: SqliteSwitchJournal): Promise<void> {
  await prepareSqliteSwitchDir(storeDir);
  await recordSqliteSwitchJournal(storeDir, journal);
}

/**
 * A fresh, empty switch directory (with its `aside/`), before anything is written into it. Only
 * under the format lock, with no journal: what an earlier switch left without one never fenced
 * or restored anything.
 */
export async function prepareSqliteSwitchDir(storeDir: string): Promise<void> {
  const dir = sqliteSwitchDir(storeDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, ASIDE), { recursive: true, mode: 0o700 });
}

/** Write the journal into the prepared switch directory, durably. */
export async function recordSqliteSwitchJournal(storeDir: string, journal: SqliteSwitchJournal): Promise<void> {
  const dir = sqliteSwitchDir(storeDir);
  await createDurable(join(dir, JOURNAL), JSON.stringify(journal) + "\n");
  await syncDirectory(dir);
  await syncDirectory(storeDir);
}

/** Drop the journal and the originals set aside: the switch is published, or rolled back. */
export async function endSqliteSwitchJournal(storeDir: string): Promise<void> {
  await rm(sqliteSwitchDir(storeDir), { recursive: true, force: true });
  await syncDirectory(storeDir);
}

/**
 * Put every marker in place, setting the originals aside. Idempotent: a path that already holds
 * its marker is left as it is. `afterStep` runs after each path (tests: interruption points).
 */
export async function fenceLegacyMetadata(
  storeDir: string,
  afterStep?: (path: string) => Promise<void>,
): Promise<void> {
  const aside = join(sqliteSwitchDir(storeDir), ASIDE);
  for (const fence of LEGACY_FENCES) {
    const path = join(storeDir, fence.path);
    if (!(await isMarker(path))) {
      const kind = await kindOf(path);
      if (fence.kind === "key") {
        // The directory exists only once a record was written; nothing to keep a key for then.
        if (kind === "dir") throw unexpected(path);
        const keyDir = join(path, "..");
        if (kind === "file") {
          const sqliteKey = join(keyDir, SQLITE_KEY_FILE);
          if ((await kindOf(sqliteKey)) === undefined) await link(path, sqliteKey);
          await writeMarkerFile(path);
          await syncDirectory(keyDir);
        }
      } else if (fence.kind === "file") {
        if (kind === "dir") throw unexpected(path);
        if (kind === "file") {
          const kept = join(aside, asideName(fence.path));
          if ((await kindOf(kept)) === undefined) await link(path, kept);
        }
        await writeMarkerFile(path);
        await syncDirectory(join(path, ".."));
      } else {
        const kept = keptPath(storeDir, fence);
        if (kind !== undefined) {
          if (fence.kind === "index" ? kind !== "file" : kind !== "dir") throw unexpected(path);
          if ((await kindOf(kept)) !== undefined) throw unexpected(kept);
          await rename(path, kept);
        } else if (fence.kind === "relocate" && (await kindOf(kept)) === undefined)
          // Always there on a switched store, so this ORCA never reads the marker in its place.
          await mkdir(kept, { mode: 0o700 });
        if (fence.kind === "index") await writeMarkerDir(path);
        else await writeMarkerFile(path);
        await syncDirectory(join(path, ".."));
      }
    }
    await afterStep?.(fence.path);
  }
  await syncDirectory(aside);
}

/**
 * Undo {@link fenceLegacyMetadata}, path by path in reverse: each original back where it was,
 * each marker gone. Refuses (`INTERRUPTED`) where something other than a marker now stands at a
 * path whose original was set aside, rather than choose between them.
 */
export async function unfenceLegacyMetadata(storeDir: string): Promise<void> {
  for (const fence of [...LEGACY_FENCES].reverse()) {
    const path = join(storeDir, fence.path);
    const marked = await isMarker(path);
    if (fence.kind === "key") {
      const sqliteKey = join(path, "..", SQLITE_KEY_FILE);
      const kept = await kindOf(sqliteKey);
      if (marked) {
        if (kept !== "file") throw conflict(storeDir, path);
        await rename(sqliteKey, path);
      } else if (kept === "file") {
        // The marker never went in: the key is still there, and the link to it goes.
        if ((await lstat(sqliteKey)).ino !== (await lstat(path).catch(() => undefined))?.ino)
          throw conflict(storeDir, path);
        await unlink(sqliteKey);
      }
      continue;
    }
    const kept = keptPath(storeDir, fence);
    const original = await kindOf(kept);
    if (marked) {
      if (fence.kind === "index") await rm(path, { recursive: true });
      else if (fence.kind === "dir" || fence.kind === "relocate") await unlink(path);
      if (original !== undefined) await rename(kept, path);
      else if (fence.kind === "file") await unlink(path);
    } else if (original !== undefined) {
      const now = await kindOf(path);
      if (fence.kind === "file" && now === "file") {
        // Never replaced: the aside copy is a link to it.
        if ((await lstat(kept)).ino !== (await lstat(path)).ino) throw conflict(storeDir, path);
        await unlink(kept);
      } else if (now === undefined) await rename(kept, path);
      else throw conflict(storeDir, path);
    }
  }
  // Every directory a rename or unlink above touched, so the rollback is durable before the
  // caller drops the journal that would otherwise redo it.
  const touched = new Set([
    storeDir,
    join(sqliteSwitchDir(storeDir), ASIDE),
    ...LEGACY_FENCES.map((fence) => join(storeDir, fence.path, "..")),
  ]);
  for (const dir of touched)
    try {
      await syncDirectory(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

/**
 * The switch back to files (#339): every marker replaced by the file metadata written out to
 * `staged` ({@link stagedFilesDir}), in the reverse of the fence's order, so the keys, which stop
 * v0.7.0 earliest, come back last. Each step is idempotent, and
 * {@link fenceLegacyMetadata} undoes any prefix of them (setting what was restored aside):
 *
 * - a key: its link `.execution-key.sqlite` renamed over the marker (one rename, never missing);
 * - a collection file: the staged file renamed over the marker, or the marker removed when the
 *   collection is empty;
 * - `runs`, `plans`: the marker file removed, then the staged directory renamed into place;
 * - `workflows`: the marker removed, then `workflows.sqlite` renamed back;
 * - the artifact index: the marker directory removed, then the staged index renamed into place.
 *
 * Refuses (`INTERRUPTED`) where neither a marker nor what this restores stands at a path.
 */
export async function restoreLegacyMetadata(
  storeDir: string,
  staged: string,
  afterStep?: (path: string) => Promise<void>,
): Promise<void> {
  for (const fence of [...LEGACY_FENCES].reverse()) {
    const path = join(storeDir, fence.path);
    const parent = join(path, "..");
    const marked = await isMarker(path);
    if (fence.kind === "key") {
      const sqliteKey = join(parent, SQLITE_KEY_FILE);
      if (marked) {
        if ((await kindOf(sqliteKey)) !== "file") throw conflict(storeDir, path);
        await rename(sqliteKey, path);
        await syncDirectory(parent);
      } else if ((await kindOf(sqliteKey)) !== undefined) throw conflict(storeDir, path);
    } else if (fence.kind === "file") {
      const source = join(staged, fence.path);
      if (marked) {
        if ((await kindOf(source)) === "file") await rename(source, path);
        else await unlink(path);
        await syncDirectory(parent);
      }
    } else {
      const source =
        fence.kind === "relocate"
          ? join(storeDir, SQLITE_LEGACY_WORKFLOWS_DIR)
          : fence.kind === "index"
            ? join(staged, "artifacts", "index.jsonl")
            : join(staged, fence.path);
      if (marked) {
        if (fence.kind === "index") await rm(path, { recursive: true });
        else await unlink(path);
      }
      const now = await kindOf(path);
      const from = await kindOf(source);
      const want = fence.kind === "index" ? "file" : "dir";
      if (now === undefined && from === want) await rename(source, path);
      else if (now !== undefined && now !== want) throw conflict(storeDir, path);
      await syncDirectory(parent);
    }
    await afterStep?.(fence.path);
  }
}

/** Every path holds its marker (or, for a key directory that has none, has nothing). */
export async function legacyFenceComplete(storeDir: string): Promise<boolean> {
  for (const fence of LEGACY_FENCES) {
    const path = join(storeDir, fence.path);
    if (await isMarker(path)) continue;
    if (fence.kind === "key" && (await kindOf(path)) === undefined) continue;
    return false;
  }
  return true;
}

/**
 * The store's files as they were before the fence went in, for comparing with a snapshot taken
 * before it: each original read where it was set aside, each key from its link, markers left
 * out. A write that landed during the fence shows up as a difference.
 */
export async function unfencedPaths(storeDir: string): Promise<Map<string, string>> {
  const aside = join(sqliteSwitchDir(storeDir), ASIDE);
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = await readdir(aside);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  for (const name of names) out.set(decodeURIComponent(name), join(aside, name));
  const relocated = join(storeDir, SQLITE_LEGACY_WORKFLOWS_DIR);
  if ((await kindOf(relocated)) === "dir") out.set("workflows", relocated);
  for (const fence of LEGACY_FENCES)
    if (fence.kind === "key") {
      const sqliteKey = join(storeDir, fence.path, "..", SQLITE_KEY_FILE);
      if ((await kindOf(sqliteKey)) === "file") out.set(fence.path, sqliteKey);
    }
  return out;
}

/** Where an original is kept while the fence stands: set aside, or (workflows) moved for good. */
function keptPath(storeDir: string, fence: Fence): string {
  return fence.kind === "relocate"
    ? join(storeDir, SQLITE_LEGACY_WORKFLOWS_DIR)
    : join(sqliteSwitchDir(storeDir), ASIDE, asideName(fence.path));
}

function unexpected(path: string): OrcaError {
  return new OrcaError(
    "STORE_FORMAT",
    `${path} is not what an ORCA store keeps there, so the store was not switched. Nothing else was changed.`,
    { reason: "UNREADABLE", path },
  );
}

function conflict(storeDir: string, path: string): OrcaError {
  return new OrcaError(
    "STORE_FORMAT",
    `An interrupted switch between files and SQLite left ${path} changed since it began, so it cannot be undone automatically. Restore the store from the backup its switch took (see ${join(sqliteSwitchDir(storeDir), JOURNAL)}).`,
    { reason: "INTERRUPTED", storeDir, path },
  );
}

/** What a marker file holds, for tests that look for one. */
export const LEGACY_FENCE_MARKER = MARKER;
