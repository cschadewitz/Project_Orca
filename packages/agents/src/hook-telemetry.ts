/**
 * The channel a native pre-tool hook hands tool-call telemetry to ORCA through (#1000).
 *
 * The hook runs under the agent's runtime, so it gets no access to ORCA's store. Instead:
 *
 * 1. Before the agent starts, ORCA creates an empty spool file, owner-only and exclusively, in
 *    the private directory it already keeps the hook's context file in
 *    ({@link openHookTelemetrySpool}), and remembers which file it made (device and inode).
 *    That directory must be inside ORCA's agent-denied paths (`protectedPaths.noAccess`), so
 *    no agent tool the hook or ACP guards may touch it; owner-only modes alone would not keep
 *    out a process of the same user.
 *    The path goes to the hook in its context. The option is off by default
 *    (`agents[].diagnostics.toolCalls`); with it off there is no spool and no path.
 * 2. The hook appends one JSON line per decided call with {@link recordHookTelemetry}: after
 *    its answer is decided and written, one synchronous `O_APPEND` write to a file that must
 *    already exist, never creating one and never following a link. It never throws and prints
 *    nothing, and the hook ignores its result, so recording can never change an answer or turn
 *    a block into an allow.
 * 3. ORCA drains the spool ({@link HookTelemetrySpool.drain}) while the session runs and once
 *    more when it ends ({@link HookTelemetrySpool.finish}), and hands each line that passes
 *    validation to the consumer it attached. The engine's consumer redacts, stamps and stores
 *    them (`@orca/engine` `hook-telemetry-ingest.ts`).
 *
 * Every line is untrusted. The hook runs in the agent's process tree, so the agent can write
 * the spool too: a line is parsed strictly ({@link HookTelemetryLineSchema}), and one that is
 * too long, not JSON, or not a v1 line is dropped and counted. A spool replaced by another
 * file, a link, or something that is not a regular file is not read at all. Nothing in a line
 * says which run, session or step it belongs to; ORCA knows that from whose spool it is.
 * A spool must stay a regular, owner-only file of ORCA's user with one name; drains check that
 * every time, on the open handle.
 *
 * After a crash, spools are discarded, never ingested ({@link sweepHookTelemetrySpools}): only
 * the process that made a spool knew whose it was.
 * What a line says the hook decided is stored as reported by the hook, never as observed.
 *
 * This module has no side effects on import, because the hook program imports it and anything
 * a hook prints on stdout becomes its answer.
 */
import { closeSync, constants, fstatSync, openSync, writeSync, type BigIntStats } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HOOK_TELEMETRY_LINE_LIMIT, HookTelemetryLineSchema, OrcaError, type HookTelemetryLine } from "@orca/core";
import { protectedPathFor, type ProtectedPaths } from "./permissions.js";

/** The most bytes a spool may hold. The hook stops appending past it; ORCA stops reading. */
export const HOOK_TELEMETRY_SPOOL_LIMIT = 4 * 1024 * 1024;

/** The most lines ORCA accepts from one spool. Later lines are counted and dropped. */
export const HOOK_TELEMETRY_SESSION_LINES = 20_000;

/** How much of the spool one drain reads at most. */
const DRAIN_CHUNK = 256 * 1024;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** A FIFO or device put where a file should be opens without waiting, then fails the type check. */
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Which spool a hook may write: its path and the identity ORCA recorded when it made it
 * (device and inode, as decimal strings so no precision is lost). This is what goes into the
 * hook's context, as `telemetry`.
 */
export interface HookTelemetryTarget {
  file: string;
  dev: string;
  ino: string;
}

/**
 * Hook side: append one line to the spool. Synchronous, never throws, prints nothing.
 * Returns whether the line was written; a hook must not act on the answer.
 *
 * The spool must be exactly the file ORCA made: opened without following a link and without
 * blocking (a FIFO or device in its place cannot hold the hook), and on the open handle a
 * regular file with ORCA's recorded device and inode, this user's, owner-only, with one name.
 * A missing or different spool, one past {@link HOOK_TELEMETRY_SPOOL_LIMIT}, or a line over
 * {@link HOOK_TELEMETRY_LINE_LIMIT} skips the record. It never creates a file.
 */
export function recordHookTelemetry(target: HookTelemetryTarget, line: HookTelemetryLine): boolean {
  let fd: number | undefined;
  try {
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
    if (bytes.length > HOOK_TELEMETRY_LINE_LIMIT) return false;
    fd = openSync(target.file, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW | NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || String(stat.dev) !== target.dev || String(stat.ino) !== target.ino) return false;
    if (privateEnough(stat) || stat.nlink !== 1n) return false;
    if (Number(stat.size) + bytes.length > HOOK_TELEMETRY_SPOOL_LIMIT) return false;
    // One write: an O_APPEND write this small lands whole, after every earlier one.
    return writeSync(fd, bytes) === bytes.length;
  } catch {
    return false;
  } finally {
    if (fd !== undefined)
      try {
        closeSync(fd);
      } catch {
        // Nothing to report: the hook's answer is already out.
      }
  }
}

/** What one drain found, besides the lines it handed on. */
export interface HookTelemetryDrainReport {
  /** Lines that passed validation and were handed to the consumer. */
  accepted: number;
  /** Lines dropped as invalid: too long, not JSON, not a v1 line. */
  rejected: number;
  /** Valid lines dropped: past the session's line limit, or the consumer failed to keep them. */
  dropped: number;
  /** The spool is no longer the file ORCA made, or is not a regular file: it is not read again. */
  refused?: string | undefined;
}

/** Receives each drain's valid lines, in spool order. Its failure drops them; it is never retried. */
export type HookTelemetryConsumer = (lines: readonly HookTelemetryLine[]) => Promise<void>;

export interface HookTelemetrySpool {
  /** Absolute path of the spool: what goes into the hook's context. */
  readonly file: string;
  /** The path and the identity ORCA made it with: what the hook's context carries. */
  readonly target: HookTelemetryTarget;
  /** Set who receives validated lines. Lines drained before a consumer is attached are dropped. */
  attach(consumer: HookTelemetryConsumer): void;
  /** Read what the hook appended since the last drain. Serialized; never throws. */
  drain(): Promise<HookTelemetryDrainReport>;
  /**
   * The session is over: one last drain (a partial last line counts as rejected), then the
   * spool is removed if it is still the file ORCA made. Idempotent; never throws.
   */
  finish(): Promise<HookTelemetryDrainReport>;
}

export interface OpenHookTelemetrySpoolOptions {
  /**
   * ORCA's private directory for the session's hook files. It must be inside one of
   * `protectedPaths.noAccess` (the store's `private-execution`, say), where no agent tool may
   * read or write, and must be a real directory of this user, not open to group or others.
   */
  dir: string;
  /** ORCA's protected paths, as the session is given them (C4-01). */
  protectedPaths: ProtectedPaths;
  /** Called with each drain's report when anything was rejected, dropped or refused. */
  onReport?: ((report: HookTelemetryDrainReport) => void) | undefined;
}

/** Spools this process made and has not finished: never swept. */
const liveSpools = new Set<string>();

const SPOOL_NAME = /^tool-calls-(\d+)-[0-9a-f-]{36}\.spool$/;

const POSIX = process.platform !== "win32";

/** Owner-only, this user's, not a link: what ORCA's own private files and directories are. */
function privateEnough(stat: { uid: number | bigint; mode: number | bigint }): string | undefined {
  if (POSIX && typeof process.getuid === "function" && Number(stat.uid) !== process.getuid())
    return "is not owned by ORCA's user";
  if (POSIX && (Number(stat.mode) & 0o077) !== 0) return "is open to group or others";
  return undefined;
}

async function checkSpoolDir(dir: string, protectedPaths: ProtectedPaths): Promise<void> {
  if (protectedPathFor(dir, "read", { readOnly: [], noAccess: protectedPaths.noAccess }) === undefined)
    throw new OrcaError(
      "CONFIG_INVALID",
      `tool-call telemetry spools go only in a directory agents may not access; ${dir} is not one`,
      { dir },
    );
  const stat = await lstat(dir);
  const why = stat.isSymbolicLink() || !stat.isDirectory() ? "is not a directory" : privateEnough(stat);
  if (why) throw new OrcaError("CONFIG_INVALID", `tool-call telemetry spool directory ${dir} ${why}`, { dir });
}

const sameFile = (a: Pick<BigIntStats, "dev" | "ino">, b: Pick<BigIntStats, "dev" | "ino">) =>
  a.dev === b.dev && a.ino === b.ino;

/** Parse one spool line; `undefined` when it is not a valid line. */
export function parseHookTelemetryLine(line: string): HookTelemetryLine | undefined {
  if (Buffer.byteLength(line, "utf8") + 1 > HOOK_TELEMETRY_LINE_LIMIT) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = HookTelemetryLineSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * ORCA side: make a session's spool. Call it before the agent starts, and only when the
 * agent's `diagnostics.toolCalls` is `keep`.
 */
export async function openHookTelemetrySpool(options: OpenHookTelemetrySpoolOptions): Promise<HookTelemetrySpool> {
  await checkSpoolDir(options.dir, options.protectedPaths);
  // The pid names who may still be draining it, for the sweep after a crash.
  const file = join(options.dir, `tool-calls-${process.pid}-${randomUUID()}.spool`);
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  let made: BigIntStats;
  try {
    made = await handle.stat({ bigint: true });
  } finally {
    await handle.close();
  }
  liveSpools.add(file);

  let consumer: HookTelemetryConsumer | undefined;
  let offset = 0;
  let pending = Buffer.alloc(0);
  let skipping = false;
  let lines = 0;
  let refused: string | undefined;
  let finished: Promise<HookTelemetryDrainReport> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const report = (r: HookTelemetryDrainReport) => {
    if (r.rejected || r.dropped || r.refused)
      try {
        options.onReport?.(r);
      } catch {
        // A reporting failure is not the spool's.
      }
    return r;
  };

  const once = async (final: boolean): Promise<HookTelemetryDrainReport> => {
    const out: HookTelemetryDrainReport = { accepted: 0, rejected: 0, dropped: 0 };
    if (refused) return { ...out, refused };
    let fd;
    try {
      fd = await open(file, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    } catch (error) {
      refused = `spool could not be opened: ${(error as NodeJS.ErrnoException).code ?? "error"}`;
      return { ...out, refused };
    }
    const valid: HookTelemetryLine[] = [];
    try {
      const stat = await fd.stat({ bigint: true });
      if (!stat.isFile() || !sameFile(stat, made)) {
        refused = "spool is not the file ORCA made";
        return { ...out, refused };
      }
      const why = privateEnough(stat) ?? (stat.nlink !== 1n ? "has another name" : undefined);
      if (why) {
        refused = `spool ${why}`;
        return { ...out, refused };
      }
      const end = Math.min(Number(stat.size), HOOK_TELEMETRY_SPOOL_LIMIT);
      while (offset < end) {
        const want = Math.min(DRAIN_CHUNK, end - offset);
        const buffer = Buffer.alloc(want);
        const { bytesRead } = await fd.read(buffer, 0, want, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) {
          const bytes = pending.subarray(0, nl);
          pending = pending.subarray(nl + 1);
          // The rest of a line already rejected for its length.
          if (skipping) {
            skipping = false;
            continue;
          }
          const text = bytes.toString("utf8");
          if (!text.trim()) continue;
          const line = parseHookTelemetryLine(text);
          if (!line) out.rejected++;
          else if (lines >= HOOK_TELEMETRY_SESSION_LINES) out.dropped++;
          else {
            lines++;
            valid.push(line);
          }
        }
        // A line still unended past the line limit is not a line: reject it now and skip to
        // its end, without holding it.
        if (pending.length >= HOOK_TELEMETRY_LINE_LIMIT) {
          if (!skipping) out.rejected++;
          skipping = true;
          pending = Buffer.alloc(0);
        }
      }
      // Anything past HOOK_TELEMETRY_SPOOL_LIMIT is never read; the hook stops appending there.
    } catch (error) {
      refused = `spool could not be read: ${(error as NodeJS.ErrnoException).code ?? "error"}`;
      out.refused = refused;
    } finally {
      await fd.close().catch(() => undefined);
    }
    if (final && pending.length && !skipping) {
      out.rejected++;
      pending = Buffer.alloc(0);
    }
    if (valid.length) {
      if (!consumer) out.dropped += valid.length;
      else
        try {
          await consumer(valid);
          out.accepted += valid.length;
        } catch {
          out.dropped += valid.length;
        }
    }
    return out;
  };

  const serialized = (final: boolean) => {
    const next = queue.then(() => once(final)).then(report, () => report({ accepted: 0, rejected: 0, dropped: 0 }));
    queue = next;
    return next;
  };

  return {
    file,
    target: { file, dev: String(made.dev), ino: String(made.ino) },
    attach(next) {
      consumer = next;
    },
    drain() {
      if (finished) return finished;
      return serialized(false);
    },
    finish() {
      return (finished ??= (async () => {
        const last = await serialized(true);
        liveSpools.delete(file);
        try {
          const stat = await lstat(file, { bigint: true });
          if (stat.isFile() && sameFile(stat, made)) await unlink(file);
        } catch {
          // Already gone, or not ours to remove.
        }
        return last;
      })());
    },
  };
}

/**
 * Crash cleanup: remove the spools a process left behind when it stopped without finishing
 * them. Call it where the spool directory is set up (the session factory, at start), before
 * any session opens.
 *
 * A left-behind spool is discarded, never ingested: the run, session and step it belonged to
 * were known only to the process that made it, and nothing in the spool may say so (its lines
 * are untrusted). A spool is left behind when the process its name records has exited, or is
 * this process and no longer live here. Another live process's spools are not touched. Only
 * regular files of this user are removed; a link in their place is removed as a link, never
 * followed. Returns how many were removed. Never throws for one file it cannot remove.
 */
export async function sweepHookTelemetrySpools(options: {
  dir: string;
  protectedPaths: ProtectedPaths;
  /** Whether a process is running; injected for tests. */
  alive?: ((pid: number) => boolean) | undefined;
}): Promise<number> {
  await checkSpoolDir(options.dir, options.protectedPaths);
  const alive = options.alive ?? processAlive;
  let removed = 0;
  for (const name of await readdir(options.dir)) {
    const match = SPOOL_NAME.exec(name);
    if (!match) continue;
    const path = join(options.dir, name);
    const pid = Number(match[1]);
    if (liveSpools.has(path)) continue;
    if (pid !== process.pid && alive(pid)) continue;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (stat.isFile() && !privateEnough(stat))) {
        await unlink(path);
        removed++;
      }
    } catch {
      // Gone already, or not removable: the next sweep tries again.
    }
  }
  return removed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
