/** Shared sidecar file mechanics. All policy writers use this lock and exact byte revision. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
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
  /** The machine, as `machineIdentity()` names it. */
  machine: string;
  nonce: string;
}

let machineCache: string | undefined;
/**
 * This machine's identity: `/etc/machine-id` (or the D-Bus copy) where there is one, which two
 * machines do not share, else the host name. A lock is only ever judged by a writer on the
 * machine that took it; a config directory reached from two machines with the same host name
 * and no machine id is outside what this can tell apart.
 */
function machineIdentity(): string {
  if (machineCache !== undefined) return machineCache;
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(path, "utf8").trim();
      if (id !== "") return (machineCache = `machine-id:${id}`);
    } catch {
      // Not on this platform; try the next.
    }
  }
  return (machineCache = `host:${hostname()}`);
}

/** Whether a process with this pid is running here. A pid we may not signal is running. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Remove a sidecar lock whose owner is provably gone, so a crash in the middle of a write does
 * not need a person (#701 follow-up). This is not a takeover by age: a writer that is paused,
 * however long, is a running process and keeps its lock. The lock is removed only when all of
 * these hold:
 *
 * - it holds exactly one owner token, and that token is a plain sidecar writer's
 *   (`kind: "sidecar"`); a typed or budget owner, an empty directory (a crash between `mkdir`
 *   and the token) and a legacy lock file are never touched;
 * - the token names this machine; a lock taken on another machine is never judged here;
 * - no process with its pid is running. A pid reused since is running, so the lock stays: that
 *   errs toward refusing.
 *
 * Only that exact token is unlinked, and the directory is removed only if it is then empty, so a
 * writer that took the lock meanwhile keeps it, and one that made the directory but had not yet
 * written its token fails its own token write and ownership check rather than proceed.
 */
async function removeDeadSidecarLock(lock: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(lock);
  } catch {
    return false;
  }
  if (names.length !== 1 || !/^owner\.[0-9]+\.[0-9a-f-]+\.json$/.test(names[0]!)) return false;
  const token = `${lock}/${names[0]!}`;
  let owner: Partial<SidecarOwner>;
  try {
    owner = JSON.parse(await readFile(token, "utf8")) as Partial<SidecarOwner>;
  } catch {
    return false;
  }
  if (
    owner.version !== 1 ||
    owner.kind !== "sidecar" ||
    typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    owner.machine !== machineIdentity() ||
    owner.pid === process.pid ||
    processAlive(owner.pid)
  )
    return false;
  try {
    await unlink(token);
  } catch {
    return false;
  }
  try {
    await rmdir(lock);
  } catch {
    // Not empty: somebody else's lock now. Leave it.
  }
  return true;
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
  const token = `${lock}/owner.${process.pid}.${randomUUID()}.json`;
  const contents = JSON.stringify(
    recoverDeadOwner
      ? ({
          version: 1,
          kind: "sidecar",
          pid: process.pid,
          machine: machineIdentity(),
          nonce: randomUUID(),
        } satisfies SidecarOwner)
      : { version: 1, pid: process.pid, nonce: randomUUID() },
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
