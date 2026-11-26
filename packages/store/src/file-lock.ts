/** Cross-process mutex directories. Only the remover of an exact owner token may rmdir. */
import { readFileSync, readlinkSync } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname, uptime } from "node:os";
import { join } from "node:path";
import { OrcaError } from "@orca/core";

export interface FileLockOptions {
  /** Retained for compatibility; a live or unknown owner is never broken by age. */
  staleMs?: number;
  /** Give up, with STORE_LOCK_TIMEOUT, after this long. Default 60 s. */
  timeoutMs?: number | undefined;
  onBroken?: (holder: LockHolder) => void;
  /**
   * When a lock left by a holder that is gone may be cleared automatically.
   *
   * - `"host"` (the default): the holder named this host name and its pid is not running here.
   * - `"provable"`: only when the holder recorded the same liveness domain as this process (on
   *   Linux, this kernel boot and this pid namespace) and its pid is not running. A host name does
   *   not prove that pids are comparable (two containers, two machines on one share), so anything
   *   less is left for a person to clear, and writers time out with `STORE_LOCK_TIMEOUT` meanwhile.
   *   Every writer sharing a lock must use the same mode (#701 review: the config file's lock).
   */
  recovery?: "host" | "provable";
}

/** The lock options every writer of `orca.config.yaml` passes: provable owner recovery only. */
export const CONFIG_FILE_LOCK: FileLockOptions = Object.freeze({ recovery: "provable" });

let domainCache: string | null | undefined;
/**
 * The domain a pid is meaningful in, positively established, or null: on Linux, this kernel
 * boot (`/proc/sys/kernel/random/boot_id`) and this process's pid namespace (`/proc/self/ns/pid`).
 * The same rule the permission sidecar's lock uses (#1040). Elsewhere there is none.
 */
export function livenessDomain(): string | null {
  if (domainCache !== undefined) return domainCache;
  if (process.platform !== "linux") return (domainCache = null);
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const ns = readlinkSync("/proc/self/ns/pid");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boot) || !/^pid:\[[0-9]+\]$/.test(ns))
      return (domainCache = null);
    return (domainCache = `linux:${boot}:${ns}`);
  } catch {
    return (domainCache = null);
  }
}
/** The kernel boot a liveness domain names, or null when it is not one `livenessDomain` wrote. */
function bootOf(domain: unknown): string | null {
  if (typeof domain !== "string") return null;
  const match = /^linux:([0-9a-f-]{36}):pid:\[[0-9]+\]$/i.exec(domain);
  return match ? match[1]!.toLowerCase() : null;
}

/** Slack for uptime's whole-second rounding and filesystem timestamp granularity. */
const BOOT_MARGIN_MS = 5_000;
/** When this machine booted, by its wall clock now. */
const bootTimeMs = () => Date.now() - uptime() * 1000;

/**
 * Whether a lock left on this host was taken before this machine last booted (#1197). Every
 * process of an earlier boot is gone, so such a holder is dead whatever its pid now names: after
 * a power loss the pid is often reused, by an unrelated process or by the restarted daemon itself.
 * On Linux, when both sides recorded a liveness domain, the kernel boot ids decide exactly.
 * Otherwise the holder's own `at` (or, for a lock with no readable owner, the directory's mtime)
 * must be older than the boot time, with a margin for rounding.
 */
function fromEarlierBoot(recorded: { domain?: unknown; at?: number | undefined }): boolean {
  const theirs = bootOf(recorded.domain);
  const ours = bootOf(livenessDomain());
  if (theirs && ours) return theirs !== ours;
  return Number.isFinite(recorded.at) && recorded.at! < bootTimeMs() - BOOT_MARGIN_MS;
}

export interface LockHolder {
  pid: number;
  at: number;
}
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 32;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tag = () => `${process.pid}.${randomUUID()}`;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const sharing = (error: unknown) => process.platform === "win32" && ["EPERM", "EACCES"].includes(codeOf(error) ?? "");

/** Legacy files, empty directories and unknown owners fail closed until explicitly recovered. */
/**
 * Run `fn` holding the lock. `fn` is given `stillHeld`, which throws `STORE_LOCK_LOST` unless this
 * holder's own token is still in the lock directory: a writer calls it immediately before it
 * commits, so a holder whose lock was recovered by another process fails closed rather than
 * overwriting what that process wrote.
 */
export async function withFileLock<T>(
  path: string,
  fn: (stillHeld: () => Promise<void>) => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const token = `owner.${tag()}.json`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let backoff = 1;
  for (;;) {
    let created = false;
    try {
      await mkdir(path);
      created = true;
    } catch (error) {
      if (codeOf(error) !== "EEXIST" && !sharing(error)) throw error;
    }
    if (created) {
      // No callback runs before publication. A crash here leaves an empty directory,
      // which is deliberately not automatically removed by another contender.
      const domain = livenessDomain();
      const holder = { pid: process.pid, at: Date.now(), host: hostname(), ...(domain ? { domain } : {}) };
      await writeFile(join(path, token), JSON.stringify(holder), {
        flag: "wx",
      });
      break;
    }
    if (await removeDeadOwner(path, options)) continue;
    if (Date.now() >= deadline)
      throw new OrcaError("STORE_LOCK_TIMEOUT", `lock ${path} still held after ${timeoutMs}ms`, { path, timeoutMs });
    await sleep(backoff + Math.random() * backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  const stillHeld = async (): Promise<void> => {
    try {
      await stat(join(path, token));
    } catch (error) {
      if (codeOf(error) !== "ENOENT" && codeOf(error) !== "ENOTDIR") throw error;
      throw new OrcaError("STORE_LOCK_LOST", `lock ${path} is no longer held by this writer`, { path });
    }
  };
  try {
    return await fn(stillHeld);
  } finally {
    await removeToken(path, token);
  }
}

async function removeToken(path: string, token: string): Promise<boolean> {
  try {
    await unlink(join(path, token));
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
  // Crucially, only the successful unlink winner gets here. A delayed contender
  // cannot remove a successor's directory after its old token disappeared.
  await rmdir(path);
  return true;
}

async function removeDeadOwner(path: string, options: FileLockOptions): Promise<boolean> {
  try {
    const names = await readdir(path);
    if (names.length === 0) return await removeEmptyFromEarlierBoot(path, options);
    if (names.length !== 1 || !/^owner\.\d+\.[a-f0-9-]+\.json$/.test(names[0]!)) return false;
    const token = names[0]!;
    let raw: Partial<LockHolder> & { host?: string; domain?: unknown };
    try {
      raw = JSON.parse(await readFile(join(path, token), "utf8")) as typeof raw;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A token torn by a power loss (often zero bytes: its data never reached the disk) names
      // no holder. Only a token from before this boot is provably dead; any other stays closed.
      if (options.recovery === "provable" || !fromEarlierBoot({ at: (await stat(join(path, token))).mtimeMs }))
        return false;
      return await removeToken(path, token);
    }
    if (options.recovery === "provable") {
      const domain = livenessDomain();
      if (domain === null || raw.domain !== domain) return false;
    }
    if (
      raw.host !== hostname() ||
      !Number.isInteger(raw.pid) ||
      raw.pid! <= 0 ||
      !Number.isFinite(raw.at) ||
      // A pid from an earlier boot names nobody we can probe: it is dead, whatever runs under it now.
      ((options.recovery === "provable" || !fromEarlierBoot(raw)) && processAlive(raw.pid!))
    )
      return false;
    const removed = await removeToken(path, token);
    if (removed) options.onBroken?.({ pid: raw.pid!, at: raw.at! });
    return removed;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return true;
    if (["ENOTDIR", "EISDIR"].includes(codeOf(error) ?? "") || sharing(error) || error instanceof SyntaxError)
      return false;
    throw error;
  }
}

/**
 * An empty lock directory is a holder that crashed between `mkdir` and publishing its token.
 * Under host recovery, one that predates this boot is removed; anything newer stays closed.
 */
async function removeEmptyFromEarlierBoot(path: string, options: FileLockOptions): Promise<boolean> {
  if (options.recovery === "provable" || !fromEarlierBoot({ at: (await stat(path)).mtimeMs })) return false;
  try {
    await rmdir(path);
  } catch (error) {
    // A contender published a token meanwhile: that is a live holder, not ours to remove.
    if (["ENOTEMPTY", "EEXIST"].includes(codeOf(error) ?? "")) return false;
    throw error;
  }
  return true;
}

/**
 * Remove the holder file at `path` when `stale(contents, mtimeMs)` says its holder is gone.
 * Lease-record helper only: callers MUST serialize every mutation with withFileLock.
 * The rename/inode check alone does not exclude a delayed competing remover.
 *
 * `"broken"` - it was stale and is now gone; `"gone"` - there was nothing to break (or the
 * file we moved turned out to belong to a live successor and was put back); `"live"` - the
 * holder is still good and the caller should wait. Only `"live"` means "do not retry yet".
 */
export async function breakIfStale(
  path: string,
  stale: (contents: string, mtimeMs: number) => boolean,
): Promise<"broken" | "gone" | "live"> {
  let ino: number;
  let mtimeMs: number;
  let text: string;
  try {
    // One handle for both, so the holder we judge is the inode we later compare against.
    const fh = await open(path, "r");
    try {
      ({ ino, mtimeMs } = await fh.stat());
      text = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "gone";
    // Windows can deny an open while another handle's delete is still pending.
    // An unreadable lock is not evidence of a dead owner: keep waiting under
    // acquire's existing bounded backoff instead of failing a healthy contender.
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return "live";
    throw e;
  }
  if (!stale(text, mtimeMs)) return "live";

  const doomed = `${path}.stale.${tag()}`;
  try {
    await rename(path, doomed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw e;
  }
  const moved = (await stat(doomed)).ino;
  if (moved !== ino) {
    // Another waiter broke the stale lock first and a new holder linked its own before our
    // rename: the file we moved is live. Put it back; if a third party has taken the path in
    // the meantime there is nothing left to restore to.
    await link(doomed, path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    await unlink(doomed).catch(() => undefined);
    return "gone";
  }
  await unlink(doomed).catch(() => undefined);
  return "broken";
}

/** The `{ pid, at }` a lock file names, or undefined when the contents are not ours to read. */
export function parseLockHolder(text: string): LockHolder | undefined {
  try {
    const raw = JSON.parse(text) as Partial<LockHolder>;
    if (typeof raw.pid === "number" && typeof raw.at === "number") return { pid: raw.pid, at: raw.at };
  } catch {
    /* not ours to interpret; the file's age decides */
  }
  return undefined;
}

/**
 * Whether `pid` names a live process *on this host*. Signal 0 probes without sending; EPERM
 * means the pid exists but belongs to another user. Meaningless across pid namespaces, which
 * is why every caller pairs it with an age or heartbeat rule (#103).
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
