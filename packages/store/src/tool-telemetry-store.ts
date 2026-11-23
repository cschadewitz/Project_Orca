/**
 * Tool-call telemetry records (#1000), kept per run and session beside the run's other data.
 *
 * Files, on either metadata backend, like claims and leases:
 *
 *   <store>/diagnostics/tool-calls/<run>/<session>.jsonl
 *
 * one {@link ToolCallTelemetry} per line. This is a new directory, not a change to any file
 * the store already has: the store's format epoch is unchanged, an ORCA that predates it
 * ignores the directory, and a store copy (backup, carryover, SQLite conversion) copies it with
 * the rest of the store.
 *
 * Only ORCA writes here. A hook hands its lines to ORCA through a spool in ORCA's private
 * directory (`@orca/agents` `hook-telemetry.ts`), and ORCA validates, redacts and stamps them
 * before they reach this store. Reads parse every line again and skip anything that is not a
 * record, so a torn last line, or a file edited by hand, costs that line and nothing else.
 *
 * Lifecycle: records are exported with {@link ToolTelemetryStore.list}, removed per run or per
 * session with {@link ToolTelemetryStore.delete}, and expired by
 * {@link ToolTelemetryStore.prune}, which removes every record whose `expiresAt` has passed.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ToolCallTelemetrySchema, type ToolCallTelemetry } from "@orca/core";
import { syncDirectory } from "./durable-file.js";
import { withFileLock } from "./file-lock.js";

/** Where records live, under the store directory. */
export const TOOL_TELEMETRY_DIR = join("diagnostics", "tool-calls");

/** What to read or remove: one run, or one session of it. */
export interface ToolTelemetryScope {
  runId: string;
  sessionId?: string | undefined;
}

export interface ToolTelemetryStore {
  /** Append records. Every record must belong to the same run and session. */
  append(records: readonly ToolCallTelemetry[]): Promise<void>;
  /** The records of a run (or one session of it), in session then ingestion order. */
  list(scope: ToolTelemetryScope): Promise<ToolCallTelemetry[]>;
  /** The runs that have any records. */
  runs(): Promise<string[]>;
  /** Remove a run's records (or one session's). Returns how many were removed. */
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

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;

/**
 * A path segment for an id: the id itself when it is plainly safe (ORCA's own ids always are),
 * otherwise a digest of it, so no id can name a path outside its directory.
 */
export function toolTelemetrySegment(id: string): string {
  if (SAFE_SEGMENT.test(id) && !id.includes("..")) return id;
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

const notFound = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (!notFound(error)) throw error;
  }
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
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

export class FileToolTelemetryStore implements ToolTelemetryStore {
  private readonly root: string;

  constructor(storeDir: string) {
    this.root = join(storeDir, TOOL_TELEMETRY_DIR);
  }

  private runDir(runId: string): string {
    return join(this.root, toolTelemetrySegment(runId));
  }

  private sessionFile(runId: string, sessionId: string): string {
    return join(this.runDir(runId), `${toolTelemetrySegment(sessionId)}.jsonl`);
  }

  private sessionFiles(dir: string, names: readonly string[]): string[] {
    return names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
  }

  async append(records: readonly ToolCallTelemetry[]): Promise<void> {
    const scope = sameScope(records);
    if (!scope) return;
    const text = records.map((r) => JSON.stringify(ToolCallTelemetrySchema.parse(r))).join("\n") + "\n";
    const dir = this.runDir(scope.runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(scope.runId, scope.sessionId);
    await withFileLock(`${file}.lock`, async () => {
      const handle = await open(file, "a", 0o600);
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  async list(scope: ToolTelemetryScope): Promise<ToolCallTelemetry[]> {
    const files =
      scope.sessionId !== undefined
        ? [this.sessionFile(scope.runId, scope.sessionId)]
        : this.sessionFiles(this.runDir(scope.runId), await listDir(this.runDir(scope.runId)));
    const out: ToolCallTelemetry[] = [];
    for (const file of files) {
      const text = await readIfPresent(file);
      if (text === undefined) continue;
      // A digest-named file holds only its own ids; anything else in it is not this scope's.
      out.push(
        ...parseLines(text).filter(
          (r) => r.runId === scope.runId && (scope.sessionId === undefined || r.sessionId === scope.sessionId),
        ),
      );
    }
    return out;
  }

  async runs(): Promise<string[]> {
    const ids = new Set<string>();
    for (const name of await listDir(this.root)) {
      const dir = join(this.root, name);
      for (const file of this.sessionFiles(dir, await listDir(dir).catch(() => []))) {
        const first = parseLines((await readIfPresent(file)) ?? "")[0];
        if (first) ids.add(first.runId);
      }
    }
    return [...ids].sort();
  }

  async delete(scope: ToolTelemetryScope): Promise<number> {
    const removed = (await this.list(scope)).length;
    if (scope.sessionId !== undefined) {
      const file = this.sessionFile(scope.runId, scope.sessionId);
      await withFileLock(`${file}.lock`, () => unlinkIfPresent(file));
      await this.removeIfEmpty(this.runDir(scope.runId));
    } else {
      await rm(this.runDir(scope.runId), { recursive: true, force: true });
    }
    return removed;
  }

  async prune(now: Date): Promise<number> {
    let removed = 0;
    for (const name of await listDir(this.root)) {
      const dir = join(this.root, name);
      for (const file of this.sessionFiles(dir, await listDir(dir).catch(() => []))) {
        removed += await withFileLock(`${file}.lock`, async () => {
          const text = await readIfPresent(file);
          if (text === undefined) return 0;
          const records = parseLines(text);
          const keep = records.filter((r) => !expired(r, now));
          if (!keep.length) {
            await unlinkIfPresent(file);
            return records.length;
          }
          // Nothing expired and nothing unreadable: leave the file exactly as it is.
          const lines = text.split("\n").filter((l) => l.trim()).length;
          if (keep.length === records.length && lines === records.length) return 0;
          const temp = `${file}.${randomUUID()}.tmp`;
          const handle = await open(temp, "wx", 0o600);
          try {
            await handle.writeFile(keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temp, file);
          await syncDirectory(dir).catch(() => undefined);
          return records.length - keep.length;
        });
      }
      await this.removeIfEmpty(dir);
    }
    return removed;
  }

  private async removeIfEmpty(dir: string): Promise<void> {
    const left = await listDir(dir);
    if (left.some((n) => n.endsWith(".jsonl"))) return;
    // Lock directories of files that are gone; nothing else is ours to remove.
    for (const n of left) if (n.endsWith(".jsonl.lock")) await rm(join(dir, n), { recursive: true, force: true });
    await rmdir(dir).catch(() => undefined);
  }
}

export class InMemoryToolTelemetryStore implements ToolTelemetryStore {
  private readonly byRun = new Map<string, Map<string, ToolCallTelemetry[]>>();

  async append(records: readonly ToolCallTelemetry[]): Promise<void> {
    const scope = sameScope(records);
    if (!scope) return;
    const parsed = records.map((r) => ToolCallTelemetrySchema.parse(structuredClone(r)));
    const sessions = this.byRun.get(scope.runId) ?? new Map<string, ToolCallTelemetry[]>();
    this.byRun.set(scope.runId, sessions);
    sessions.set(scope.sessionId, [...(sessions.get(scope.sessionId) ?? []), ...parsed]);
  }

  list(scope: ToolTelemetryScope): Promise<ToolCallTelemetry[]> {
    const sessions = this.byRun.get(scope.runId);
    if (!sessions) return Promise.resolve([]);
    const lists =
      scope.sessionId !== undefined
        ? [sessions.get(scope.sessionId) ?? []]
        : [...sessions.keys()].sort().map((k) => sessions.get(k) ?? []);
    return Promise.resolve(lists.flat().map((r) => structuredClone(r)));
  }

  runs(): Promise<string[]> {
    return Promise.resolve([...this.byRun.keys()].sort());
  }

  async delete(scope: ToolTelemetryScope): Promise<number> {
    const removed = (await this.list(scope)).length;
    if (scope.sessionId === undefined) this.byRun.delete(scope.runId);
    else {
      const sessions = this.byRun.get(scope.runId);
      sessions?.delete(scope.sessionId);
      if (sessions && !sessions.size) this.byRun.delete(scope.runId);
    }
    return removed;
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
