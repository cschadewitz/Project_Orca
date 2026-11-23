/**
 * Tool-call telemetry records (#1000), kept per run and session beside the run's other data.
 *
 * Files, on either metadata backend, like claims and leases:
 *
 *   <store>/diagnostics/                          0700; agents may not touch it (C4-01 `noAccess`)
 *   <store>/diagnostics/tool-calls/<run>/<session>.jsonl   0600, one record per line
 *   <store>/diagnostics/tool-calls/<run>/<session>.deleted session deleted: refuse late records
 *   <store>/diagnostics/tool-calls/.deleted/<run>          run deleted: refuse late records
 *   <store>/diagnostics/tool-calls/.locks/<run>.lock       the run's lock, outside its directory
 *
 * This is a new directory, not a change to any file the store already has: the store's format
 * epoch is unchanged, an ORCA that predates it ignores the directory, and a store copy (backup,
 * carryover, SQLite conversion) copies it with the rest of the store.
 *
 * **Boundary.** Only ORCA writes here. The whole `diagnostics/` directory is in the store's
 * agent-denied set (`orcaProtectedPaths` in the CLI), so no agent tool may read or write it; a
 * hook hands its lines to ORCA through a spool in ORCA's private directory instead
 * (`@orca/agents` `hook-telemetry.ts`). Owner-only modes alone do not stop a process of the same
 * user, so every open here is also checked: directories are made owner-only and must be real
 * directories (not links), owned by this user and not open to group or others; files are
 * opened without following links and must be regular files of this user, owner-only, with one
 * name. Anything else is refused, never read or written through. (Windows has no POSIX modes:
 * there the store's protected directory and the link refusal are the boundary.)
 *
 * **Serialization.** Every change to a run (an append, a deletion, an expiry sweep of it) holds
 * the run's lock, which lives outside the run's directory so that removing the directory never
 * removes a lock somebody holds.
 *
 * **Deletion is final for the scope.** Deleting a run's (or a session's) records leaves a small
 * marker, and an append for that run (or session) afterwards is refused and dropped: a live
 * session's late records do not bring deleted diagnostics back. The marker is removed by the
 * expiry sweep after {@link TOOL_TELEMETRY_TOMBSTONE_DAYS}, longer than any record is kept.
 *
 * **Retention** is enforced when records are read as well as by the sweep: an expired record is
 * never listed or exported, whether or not {@link ToolTelemetryStore.prune} has run.
 *
 * Reads parse every line again and skip anything that is not a record, so a torn last line, or
 * a file edited by hand, costs that line and nothing else.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { OrcaError, ToolCallTelemetrySchema, type ToolCallTelemetry } from "@orca/core";
import { syncDirectory } from "./durable-file.js";
import { withFileLock } from "./file-lock.js";

/** The agent-denied diagnostics directory, under the store directory. */
export const DIAGNOSTICS_DIR = "diagnostics";

/** Where records live, under the store directory. */
export const TOOL_TELEMETRY_DIR = join(DIAGNOSTICS_DIR, "tool-calls");

/** Days a deletion marker refuses late records: longer than the longest retention (365). */
export const TOOL_TELEMETRY_TOMBSTONE_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const POSIX = process.platform !== "win32";

/** What to read or remove: one run, or one session of it. */
export interface ToolTelemetryScope {
  runId: string;
  sessionId?: string | undefined;
}

export interface ToolTelemetryStore {
  /**
   * Append records. Every record must belong to the same run and session. Returns how many
   * were kept: 0 when that run or session was deleted.
   */
  append(records: readonly ToolCallTelemetry[]): Promise<number>;
  /** The unexpired records of a run (or one session of it), in session then ingestion order. */
  list(scope: ToolTelemetryScope, options?: { now?: Date }): Promise<ToolCallTelemetry[]>;
  /** The runs that have any unexpired records. */
  runs(options?: { now?: Date }): Promise<string[]>;
  /**
   * Remove a run's records (or one session's), and refuse any that arrive for it later.
   * Returns how many were removed.
   */
  delete(scope: ToolTelemetryScope): Promise<number>;
  /** Remove every record whose `expiresAt` is at or before `now`. Returns how many. */
  prune(now: Date): Promise<number>;
}

function sameScope(records: readonly ToolCallTelemetry[]): { runId: string; sessionId: string } | undefined {
  const first = records[0];
  if (!first) return undefined;
  for (const r of records)
    if (r.runId !== first.runId || r.sessionId !== first.sessionId)
      throw new Error("tool telemetry: one append must hold records of one run and session");
  return { runId: first.runId, sessionId: first.sessionId };
}

const expired = (record: ToolCallTelemetry, now: Date) => {
  const at = Date.parse(record.expiresAt);
  // A record whose expiry cannot be read is not kept forever.
  return !Number.isFinite(at) || at <= now.getTime();
};

/** No dots: a segment can never end in `.jsonl`, `.deleted` or `.lock`, or start one. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A path segment for an id: the id itself when it is plainly safe (ORCA's own ids always are),
 * otherwise a digest of it, so no id can name a path outside its directory or collide with a
 * marker or lock.
 */
export function toolTelemetrySegment(id: string): string {
  if (SAFE_SEGMENT.test(id)) return id;
  return `x-${createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

function parseLines(text: string): ToolCallTelemetry[] {
  const out: ToolCallTelemetry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = ToolCallTelemetrySchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const notFound = (error: unknown) => codeOf(error) === "ENOENT";

function refused(path: string, why: string): OrcaError {
  return new OrcaError(
    "STORE_WRITE",
    `tool telemetry: ${path} ${why}; it is not ORCA's to read or write, so it is left alone`,
    { path },
  );
}

/** A directory ORCA made: real, this user's, owner-only. */
function checkDirStat(
  path: string,
  stat: { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number },
) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused(path, "is not a directory");
  if (POSIX && typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw refused(path, "is owned by another user");
  if (POSIX && (stat.mode & 0o077) !== 0) throw refused(path, "is open to group or others");
}

/** A file ORCA wrote: regular, this user's, owner-only, one name. */
function checkFileStat(path: string, stat: { isFile(): boolean; uid: number; mode: number; nlink: number }): void {
  if (!stat.isFile()) throw refused(path, "is not a regular file");
  if (POSIX && typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw refused(path, "is owned by another user");
  if (POSIX && (stat.mode & 0o077) !== 0) throw refused(path, "is open to group or others");
  if (stat.nlink !== 1) throw refused(path, "has another name");
}

/** Make `path` (owner-only) if it is missing, and check it either way. */
async function ensureDir(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
  }
  checkDirStat(path, await lstat(path));
}

/** Check `path` if it exists; false when it does not. */
async function existingDir(path: string): Promise<boolean> {
  try {
    checkDirStat(path, await lstat(path));
    return true;
  } catch (error) {
    if (notFound(error)) return false;
    throw error;
  }
}

async function openChecked(path: string, flags: number): Promise<FileHandle> {
  const handle = await open(path, flags | NOFOLLOW, 0o600);
  try {
    checkFileStat(path, await handle.stat());
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readChecked(path: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await openChecked(path, constants.O_RDONLY);
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (notFound(error)) return false;
    throw error;
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (notFound(error)) return [];
    throw error;
  }
}

/** Write a new owner-only file holding `text`, flushed. */
async function writeNew(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A deletion marker: present means refuse; refreshed by a later deletion of the same scope. */
async function writeMarker(path: string, at: Date): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeNew(temp, `${JSON.stringify({ deletedAt: at.toISOString() })}\n`);
  await rename(temp, path);
}

async function markerExpired(path: string, now: Date): Promise<boolean> {
  try {
    const raw = JSON.parse((await readChecked(path)) ?? "{}") as { deletedAt?: unknown };
    const at = typeof raw.deletedAt === "string" ? Date.parse(raw.deletedAt) : Number.NaN;
    return !Number.isFinite(at) || at + TOOL_TELEMETRY_TOMBSTONE_DAYS * DAY_MS <= now.getTime();
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    throw error;
  }
}

export class FileToolTelemetryStore implements ToolTelemetryStore {
  private readonly diagnostics: string;
  private readonly root: string;

  constructor(storeDir: string) {
    this.diagnostics = join(storeDir, DIAGNOSTICS_DIR);
    this.root = join(storeDir, TOOL_TELEMETRY_DIR);
  }

  private runDir(runId: string): string {
    return join(this.root, toolTelemetrySegment(runId));
  }

  private sessionFile(runId: string, sessionId: string): string {
    return join(this.runDir(runId), `${toolTelemetrySegment(sessionId)}.jsonl`);
  }

  private sessionMarker(runId: string, sessionId: string): string {
    return join(this.runDir(runId), `${toolTelemetrySegment(sessionId)}.deleted`);
  }

  private runMarker(runId: string): string {
    return join(this.root, ".deleted", toolTelemetrySegment(runId));
  }

  /** The root, checked; false when nothing was ever written. */
  private async rooted(): Promise<boolean> {
    return (await existingDir(this.diagnostics)) && (await existingDir(this.root));
  }

  /** Make (and check) the directories a write needs. */
  private async ensureRoot(): Promise<void> {
    await ensureDir(this.diagnostics);
    await ensureDir(this.root);
    await ensureDir(join(this.root, ".locks"));
    await ensureDir(join(this.root, ".deleted"));
  }

  /** Every change to one run holds this. */
  private async withRun<T>(segment: string, fn: () => Promise<T>): Promise<T> {
    await this.ensureRoot();
    return withFileLock(join(this.root, ".locks", `${segment}.lock`), fn);
  }

  async append(records: readonly ToolCallTelemetry[]): Promise<number> {
    const scope = sameScope(records);
    if (!scope) return 0;
    const text = records.map((r) => JSON.stringify(ToolCallTelemetrySchema.parse(r))).join("\n") + "\n";
    return this.withRun(toolTelemetrySegment(scope.runId), async () => {
      if (await exists(this.runMarker(scope.runId))) return 0;
      const dir = this.runDir(scope.runId);
      await ensureDir(dir);
      if (await exists(this.sessionMarker(scope.runId, scope.sessionId))) return 0;
      const handle = await openChecked(
        this.sessionFile(scope.runId, scope.sessionId),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      );
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return records.length;
    });
  }

  private async readRun(runId: string, sessionId: string | undefined): Promise<ToolCallTelemetry[]> {
    if (!(await this.rooted())) return [];
    const dir = this.runDir(runId);
    if (!(await existingDir(dir))) return [];
    const files =
      sessionId !== undefined
        ? [this.sessionFile(runId, sessionId)]
        : (await listDir(dir)).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
    const out: ToolCallTelemetry[] = [];
    for (const file of files) {
      const text = await readChecked(file);
      if (text === undefined) continue;
      // A digest-named file holds only its own ids; anything else in it is not this scope's.
      out.push(
        ...parseLines(text).filter((r) => r.runId === runId && (sessionId === undefined || r.sessionId === sessionId)),
      );
    }
    return out;
  }

  async list(scope: ToolTelemetryScope, options: { now?: Date } = {}): Promise<ToolCallTelemetry[]> {
    const now = options.now ?? new Date();
    return (await this.readRun(scope.runId, scope.sessionId)).filter((r) => !expired(r, now));
  }

  async runs(options: { now?: Date } = {}): Promise<string[]> {
    const now = options.now ?? new Date();
    if (!(await this.rooted())) return [];
    const ids = new Set<string>();
    for (const name of await listDir(this.root)) {
      if (name.startsWith(".")) continue;
      const dir = join(this.root, name);
      if (!(await existingDir(dir))) continue;
      for (const file of (await listDir(dir)).filter((n) => n.endsWith(".jsonl"))) {
        const live = parseLines((await readChecked(join(dir, file))) ?? "").find((r) => !expired(r, now));
        if (live) ids.add(live.runId);
      }
    }
    return [...ids].sort();
  }

  async delete(scope: ToolTelemetryScope): Promise<number> {
    const now = new Date();
    return this.withRun(toolTelemetrySegment(scope.runId), async () => {
      const removed = (await this.readRun(scope.runId, scope.sessionId)).length;
      const dir = this.runDir(scope.runId);
      if (scope.sessionId !== undefined) {
        await ensureDir(dir);
        // The marker first: a crash between the two still refuses what comes later.
        await writeMarker(this.sessionMarker(scope.runId, scope.sessionId), now);
        await unlinkIfPresent(this.sessionFile(scope.runId, scope.sessionId));
      } else {
        await writeMarker(this.runMarker(scope.runId), now);
        if (await existingDir(dir)) await rm(dir, { recursive: true, force: true });
      }
      return removed;
    });
  }

  async prune(now: Date): Promise<number> {
    if (!(await this.rooted())) return 0;
    let removed = 0;
    for (const name of await listDir(this.root)) {
      if (name.startsWith(".")) continue;
      removed += await this.withRun(name, () => this.pruneRun(join(this.root, name), now));
    }
    const markers = join(this.root, ".deleted");
    if (await existingDir(markers))
      for (const name of await listDir(markers)) {
        if (name.endsWith(".tmp")) continue;
        await this.withRun(name, async () => {
          const marker = join(markers, name);
          if ((await exists(marker)) && (await markerExpired(marker, now))) await unlinkIfPresent(marker);
        });
      }
    return removed;
  }

  /** Expire one run's records and old session markers; remove its directory once empty. */
  private async pruneRun(dir: string, now: Date): Promise<number> {
    if (!(await existingDir(dir))) return 0;
    let removed = 0;
    for (const name of await listDir(dir)) {
      const path = join(dir, name);
      if (name.endsWith(".deleted")) {
        if (await markerExpired(path, now)) await unlinkIfPresent(path);
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      const text = await readChecked(path);
      if (text === undefined) continue;
      const records = parseLines(text);
      const keep = records.filter((r) => !expired(r, now));
      if (!keep.length) {
        await unlinkIfPresent(path);
        removed += records.length;
        continue;
      }
      // Nothing expired and nothing unreadable: leave the file exactly as it is.
      const lines = text.split("\n").filter((l) => l.trim()).length;
      if (keep.length === records.length && lines === records.length) continue;
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeNew(temp, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
      await rename(temp, path);
      await syncDirectory(dir).catch(() => undefined);
      removed += records.length - keep.length;
    }
    if (!(await listDir(dir)).length) await rmdir(dir).catch(() => undefined);
    return removed;
  }
}

export class InMemoryToolTelemetryStore implements ToolTelemetryStore {
  private readonly byRun = new Map<string, Map<string, ToolCallTelemetry[]>>();
  private readonly deletedRuns = new Set<string>();
  private readonly deletedSessions = new Set<string>();

  async append(records: readonly ToolCallTelemetry[]): Promise<number> {
    const scope = sameScope(records);
    if (!scope) return 0;
    if (this.deletedRuns.has(scope.runId) || this.deletedSessions.has(JSON.stringify([scope.runId, scope.sessionId])))
      return 0;
    const parsed = records.map((r) => ToolCallTelemetrySchema.parse(structuredClone(r)));
    const sessions = this.byRun.get(scope.runId) ?? new Map<string, ToolCallTelemetry[]>();
    this.byRun.set(scope.runId, sessions);
    sessions.set(scope.sessionId, [...(sessions.get(scope.sessionId) ?? []), ...parsed]);
    return records.length;
  }

  private all(scope: ToolTelemetryScope): ToolCallTelemetry[] {
    const sessions = this.byRun.get(scope.runId);
    if (!sessions) return [];
    const lists =
      scope.sessionId !== undefined
        ? [sessions.get(scope.sessionId) ?? []]
        : [...sessions.keys()].sort().map((k) => sessions.get(k) ?? []);
    return lists.flat().map((r) => structuredClone(r));
  }

  list(scope: ToolTelemetryScope, options: { now?: Date } = {}): Promise<ToolCallTelemetry[]> {
    const now = options.now ?? new Date();
    return Promise.resolve(this.all(scope).filter((r) => !expired(r, now)));
  }

  runs(options: { now?: Date } = {}): Promise<string[]> {
    const now = options.now ?? new Date();
    return Promise.resolve(
      [...this.byRun.keys()].filter((runId) => this.all({ runId }).some((r) => !expired(r, now))).sort(),
    );
  }

  delete(scope: ToolTelemetryScope): Promise<number> {
    const removed = this.all(scope).length;
    if (scope.sessionId === undefined) {
      this.byRun.delete(scope.runId);
      this.deletedRuns.add(scope.runId);
    } else {
      const sessions = this.byRun.get(scope.runId);
      sessions?.delete(scope.sessionId);
      if (sessions && !sessions.size) this.byRun.delete(scope.runId);
      this.deletedSessions.add(JSON.stringify([scope.runId, scope.sessionId]));
    }
    return Promise.resolve(removed);
  }

  prune(now: Date): Promise<number> {
    let removed = 0;
    for (const [runId, sessions] of this.byRun) {
      for (const [sessionId, records] of sessions) {
        const keep = records.filter((r) => !expired(r, now));
        removed += records.length - keep.length;
        if (keep.length) sessions.set(sessionId, keep);
        else sessions.delete(sessionId);
      }
      if (!sessions.size) this.byRun.delete(runId);
    }
    return Promise.resolve(removed);
  }
}
