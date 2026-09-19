/**
 * A lock file: the cross-process mutual exclusion the JSONL logs append under.
 *
 * Holding the lock means owning `path`. It is taken the way `FileClaimStore` takes a claim -
 * the contents are written under a private name and `link()`ed into place - so the kernel
 * elects exactly one holder and a reader only ever sees a complete file. The contents name
 * the holder (`pid`, `at`) so a lock a dead process left behind can be recognised and
 * broken instead of blocking every later writer forever.
 *
 * A lock is stale when its holder's pid is gone, or when it is older than `staleMs`. The
 * age rule is the fallback for holders this process cannot probe (another pid namespace)
 * and for a live process that is wedged; it is deliberately generous, because breaking a
 * live holder's lock is the one thing that can put two writers on one file. Breaking is a
 * rename followed by an inode check, so two waiters that both find the same stale lock
 * cannot each remove a lock the other has just taken.
 *
 * Assumes one host, or a filesystem where `link()` is atomic - the same assumption the
 * claim store makes.
 */
import { link, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { OrcaError } from "@orca/core";

export interface FileLockOptions {
  /** A lock older than this is broken even if its holder still seems alive. Default 30 s. */
  staleMs?: number;
  /** Give up, with `STORE_LOCK_TIMEOUT`, after waiting this long. Default 60 s. */
  timeoutMs?: number;
  /** Told about every stale lock this waiter broke. */
  onBroken?: (holder: LockHolder) => void;
}

export interface LockHolder {
  pid: number;
  /** Epoch ms at which the holder took (or last tried to take) the lock. */
  at: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 32;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tag = () => `${process.pid}.${Math.random().toString(36).slice(2)}`;

/** Run `fn` while holding the lock at `path`; the parent directory must exist. */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const ino = await acquire(path, options);
  try {
    return await fn();
  } finally {
    await release(path, ino);
  }
}

/** Returns the inode of the lock file we now own, so release can tell it apart from a successor's. */
async function acquire(path: string, options: FileLockOptions): Promise<number> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tmp = `${path}.${tag()}.tmp`;
  const deadline = Date.now() + timeoutMs;
  let backoff = 1;
  try {
    for (;;) {
      // Rewritten on every attempt so a long wait does not age our own lock before we hold it.
      await writeFile(tmp, JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockHolder), "utf8");
      try {
        await link(tmp, path);
        return (await stat(tmp)).ino;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let broken: LockHolder | undefined;
      const verdict = await breakIfStale(path, (text, mtimeMs) => {
        broken = parseLockHolder(text);
        const age = Date.now() - (broken?.at ?? mtimeMs);
        return (broken !== undefined && !processAlive(broken.pid)) || age >= staleMs;
      });
      if (verdict !== "live") {
        if (verdict === "broken" && broken) options.onBroken?.(broken);
        continue;
      }
      if (Date.now() >= deadline)
        throw new OrcaError("STORE_LOCK_TIMEOUT", `lock ${path} still held after ${timeoutMs}ms`, { path, timeoutMs });
      await sleep(backoff + Math.random() * backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function release(path: string, ino: number): Promise<void> {
  try {
    // If the lock at `path` is no longer ours, a waiter broke ours as stale and took its own; leave it.
    if ((await stat(path)).ino !== ino) return;
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Remove the holder file at `path` when `stale(contents, mtimeMs)` says its holder is gone.
 * Shared with the lease store, which owns a longer-lived file with the same shape: a holder
 * record linked into place, broken only by a rename followed by an inode check so two waiters
 * that both find it stale cannot each remove a file the other has just taken.
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
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "gone";
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
