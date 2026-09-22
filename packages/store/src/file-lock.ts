/** Cross-process mutex directories. Only the remover of an exact owner token may rmdir. */
import { link, mkdir, open, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { OrcaError } from "@orca/core";

export interface FileLockOptions {
  /** Retained for compatibility; a live or unknown owner is never broken by age. */
  staleMs?: number;
  /** Give up, with STORE_LOCK_TIMEOUT, after this long. Default 60 s. */
  timeoutMs?: number;
  onBroken?: (holder: LockHolder) => void;
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
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
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
      await writeFile(join(path, token), JSON.stringify({ pid: process.pid, at: Date.now(), host: hostname() }), {
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
  try {
    return await fn();
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
    if (names.length !== 1 || !/^owner\.\d+\.[a-f0-9-]+\.json$/.test(names[0]!)) return false;
    const token = names[0]!;
    const raw = JSON.parse(await readFile(join(path, token), "utf8")) as Partial<LockHolder> & { host?: string };
    if (
      raw.host !== hostname() ||
      !Number.isInteger(raw.pid) ||
      raw.pid! <= 0 ||
      !Number.isFinite(raw.at) ||
      processAlive(raw.pid!)
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
