/** Shared sidecar file mechanics. All policy writers use this lock and exact byte revision. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync, type Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OrcaError } from "@orca/core";

/**
 * The content hash of a file as it is right now, `""` when it is not there - the same
 * "revision" `config.get` reports, computed the same way, so the two can be compared at all.
 */
export async function revisionOf(file: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/**
 * Serialise read-modify-write of a sidecar across processes. **Every writer takes it the same
 * way, with no automatic takeover** (#701 review): the lock is a directory created with
 * `mkdir` holding one owner token, nothing ever breaks it by age, and the holder can check it
 * still owns it (`checkOwnership`) before it publishes. Age cannot prove that a paused owner
 * died, and a lock that can be taken over by time lets a paused writer, once it resumes,
 * overwrite whatever its successor wrote; so a lock left by a writer that crashed stays, and
 * later writes refuse (`STORE_LOCK_TIMEOUT`) until a person removes `<file>.lock` after
 * making sure no writer is running. Reading the file never takes the lock.
 *
 * The plain sidecar writers (`recoverDeadOwner`) recover one case without a person: a lock
 * their own kind left on this machine whose process is no longer running is removed
 * (`removeDeadSidecarLock`). That is not a takeover by age; a paused writer is still running.
 *
 * Releases before this one created the lock as a file with `link()` and broke one older than
 * 30 seconds. Such a writer cannot take this lock either: its `link()` finds the directory,
 * and its stale-lock `unlink` cannot remove a directory. A lock *file* one of them left is
 * waited on here, never removed.
 *
 * `strictOwnership` is accepted for callers written when this was one of two modes; it is now
 * the only mode. `staleMs` is ignored.
 */
export async function withPolicyLock<T>(
  file: string,
  opts:
    | {
        timeoutMs?: number;
        staleMs?: number;
        strictOwnership?: boolean;
        /**
         * The plain sidecar writers (`permissions.ts`): their lock is marked as theirs, and a
         * lock one of them left is removed once its process is provably gone
         * (`removeDeadSidecarLock`). Never set by the typed sidecar or the judge budget, whose
         * dead owners stay closed for a person to reconcile.
         */
        recoverDeadOwner?: boolean;
      }
    | undefined,
  fn: (checkOwnership: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return withStrictPolicyLock(file, fn, opts?.timeoutMs ?? 10_000, opts?.recoverDeadOwner === true);
}

/** Who a sidecar lock token says took it; written only by a writer that recovers dead owners. */
interface SidecarOwner {
  version: 1;
  kind: "sidecar";
  pid: number;
  /** The process namespace `pid` belongs to (`livenessDomain()`), or null where none is known. */
  domain: string | null;
  nonce: string;
}
const SIDECAR_OWNER_KEYS = ["domain", "kind", "nonce", "pid", "version"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_NAME = /^owner\.([1-9][0-9]{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

let domainCache: string | null | undefined;
/**
 * The domain a pid is meaningful in, positively established, or null (#1040 review): on Linux,
 * this kernel boot (`/proc/sys/kernel/random/boot_id`) and this process's pid namespace
 * (`/proc/self/ns/pid`, an inode unique within the boot). Two processes with the same domain
 * see the same pids, so `kill(pid, 0)` in one says whether the other's pid is running. A
 * machine id or host name does not establish that: two containers on one machine, or two
 * machines sharing a workspace, see different pids under the same name. Anywhere this cannot
 * be read (macOS, Windows, a Linux without `/proc`), there is no domain, and a lock left there
 * is recovered by a person, as before.
 */
function livenessDomain(): string | null {
  if (domainCache !== undefined) return domainCache;
  if (process.platform !== "linux") return (domainCache = null);
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const ns = readlinkSync("/proc/self/ns/pid");
    if (!UUID.test(boot) || !/^pid:\[[0-9]+\]$/.test(ns)) return (domainCache = null);
    return (domainCache = `linux:${boot}:${ns}`);
  } catch {
    return (domainCache = null);
  }
}

/** Whether a process with this pid is running in this domain. A pid we may not signal is running. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The token as written by a plain sidecar writer, exactly, or undefined for anything else. */
function sidecarOwner(name: string, text: string): SidecarOwner | undefined {
  const m = TOKEN_NAME.exec(name);
  if (!m) return undefined;
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== SIDECAR_OWNER_KEYS.join()) return undefined;
  if (o["version"] !== 1 || o["kind"] !== "sidecar") return undefined;
  if (typeof o["pid"] !== "number" || !Number.isSafeInteger(o["pid"]) || o["pid"] <= 0) return undefined;
  // The filename and the token must agree on who wrote them.
  if (String(o["pid"]) !== m[1]) return undefined;
  if (typeof o["nonce"] !== "string" || !UUID.test(o["nonce"])) return undefined;
  // One nonce names the token and is written in it, so the two identify the same writer.
  if (o["nonce"] !== m[2]) return undefined;
  if (o["domain"] !== null && typeof o["domain"] !== "string") return undefined;
  return o as unknown as SidecarOwner;
}

/**
 * Remove a sidecar lock whose owner is provably gone, so a crash in the middle of a write does
 * not need a person (#701 follow-up). This is not a takeover by age: a writer that is paused,
 * however long, is a running process and keeps its lock. The lock is removed only when all of
 * these hold, and is otherwise left for a person (the wait goes on, then `STORE_LOCK_TIMEOUT`):
 *
 * - the lock is a plain directory (`lstat`: not a link or anything else), holding exactly one
 *   entry, a regular file with no other link, named `owner.<pid>.<nonce>.json`, whose content is
 *   exactly a plain sidecar writer's token (`sidecarOwner`), with the pid and nonce of its name;
 *   a typed or budget owner, an empty directory (a crash between `mkdir` and the token), a
 *   legacy lock file and anything malformed or of another version are never touched;
 * - this process has a liveness domain (`livenessDomain`) and the token names the same one, so
 *   its pid means the same process here; a lock from another machine, container or boot, or
 *   from a platform with no domain, is never judged;
 * - no process with that pid is running. A pid reused since is running, so the lock stays: that
 *   errs toward refusing.
 *
 * Just before unlinking, the directory and the token are checked to be the very entries inspected
 * (same device and inode), and the directory again before it is removed. Only that exact token
 * is unlinked, and the directory is removed only if it is then empty, so a
 * writer that took the lock meanwhile keeps it, and one that made the directory but had not yet
 * written its token fails its own token write and ownership check rather than proceed. Nothing
 * here throws: any failure leaves the lock as it is.
 */
async function removeDeadSidecarLock(lock: string): Promise<boolean> {
  let dir: Stats;
  try {
    const domain = livenessDomain();
    if (domain === null) return false;
    // The lock itself must be a plain directory, not a link or anything else, and every later
    // step is bound to this exact directory (device and inode) and this exact token file.
    dir = await lstat(lock);
    if (!dir.isDirectory()) return false;
    const names = await readdir(lock);
    if (names.length !== 1) return false;
    const token = `${lock}/${names[0]!}`;
    const info = await lstat(token);
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096) return false;
    const owner = sidecarOwner(names[0]!, await readFile(token, "utf8"));
    if (owner === undefined || owner.domain !== domain) return false;
    if (owner.pid === process.pid || processAlive(owner.pid)) return false;
    if (!(await same(lock, dir, "dir")) || !(await same(token, info, "file"))) return false;
    await unlink(token);
  } catch {
    return false;
  }
  try {
    // Not ours to remove unless it is still the directory inspected above.
    if (await same(lock, dir, "dir")) await rmdir(lock);
  } catch {
    // Not empty, or gone: somebody else's lock now, or nothing. Leave it.
  }
  return true;
}

/** Whether `path` is still the very entry inspected earlier (same kind, device and inode). */
async function same(path: string, seen: { dev: number; ino: number }, kind: "dir" | "file"): Promise<boolean> {
  const now = await lstat(path);
  if (kind === "dir" ? !now.isDirectory() : !now.isFile()) return false;
  return now.dev === seen.dev && now.ino === seen.ino;
}

/** Same .lock namespace, using the store's exact-owner-token idiom without automatic
 * recovery. No participating path can unlink a directory by mtime; even a legacy waiter
 * paused between stat/unlink cannot remove a successor typed directory. Unknown/dead
 * ownership stays closed. Managed enrollment must exclude pre-existing legacy holders. */
async function withStrictPolicyLock<T>(
  file: string,
  fn: (checkOwnership: () => Promise<void>) => Promise<T>,
  timeoutMs: number,
  recoverDeadOwner = false,
): Promise<T> {
  const lock = `${file}.lock`;
  const nonce = randomUUID();
  const token = `${lock}/owner.${process.pid}.${nonce}.json`;
  const contents = JSON.stringify(
    recoverDeadOwner
      ? ({
          version: 1,
          kind: "sidecar",
          pid: process.pid,
          domain: livenessDomain(),
          nonce,
        } satisfies SidecarOwner)
      : { version: 1, pid: process.pid, nonce },
  );
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (let backoff = 1; ; backoff = Math.min(backoff * 2, 32)) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // A lock left by a plain sidecar writer that is provably gone is removed, and the mkdir
      // tried again straight away (#701 follow-up).
      if (recoverDeadOwner && (await removeDeadSidecarLock(lock))) continue;
      if (Date.now() >= deadline)
        throw new OrcaError(
          "STORE_LOCK_TIMEOUT",
          "the permission sidecar is locked by another writer, or by one that stopped; no takeover",
          { file },
        );
      await delay(backoff + Math.random() * backoff);
    }
  }
  // A crash before token publication leaves an empty directory, which also refuses takeover.
  await writeFile(token, contents, { flag: "wx" });
  const identity = await stat(lock);
  const check = async () => {
    try {
      const current = await stat(lock);
      if (
        !current.isDirectory() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        (await readFile(token, "utf8")) !== contents
      )
        throw new Error("ownership changed");
    } catch (error) {
      throw new OrcaError(
        "STORE_LOCK_TIMEOUT",
        "permission sidecar ownership lost; nothing was written",
        { file },
        { cause: error },
      );
    }
  };
  let callbackFailed = false;
  let callbackError: unknown;
  let value!: T;
  try {
    await check();
    value = await fn(check);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  try {
    // Only the unlink winner for OUR exact unique token may remove the empty directory.
    let removed = false;
    try {
      await unlink(token);
      removed = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (removed) await rmdir(lock);
  } catch (error) {
    if (!callbackFailed) {
      const revision =
        typeof value === "object" && value !== null && "revision" in value && typeof value.revision === "string"
          ? value.revision
          : undefined;
      throw new OrcaError(
        "INTERNAL",
        "typed transaction ownership release uncertain; inspect without replay",
        { publication: "uncertain", intendedRevision: revision, ownershipRelease: "uncertain" },
        { cause: error },
      );
    }
  }
  if (callbackFailed)
    throw callbackError instanceof Error
      ? callbackError
      : new Error("typed transaction failed", { cause: callbackError });
  return value;
}
