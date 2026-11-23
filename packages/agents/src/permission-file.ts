/** Shared sidecar file mechanics. All policy writers use this lock and exact byte revision. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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
  opts: { timeoutMs?: number; staleMs?: number; strictOwnership?: boolean } | undefined,
  fn: (checkOwnership: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return withStrictPolicyLock(file, fn, opts?.timeoutMs ?? 10_000);
}

/** Same .lock namespace, using the store's exact-owner-token idiom without automatic
 * recovery. No participating path can unlink a directory by mtime; even a legacy waiter
 * paused between stat/unlink cannot remove a successor typed directory. Unknown/dead
 * ownership stays closed. Managed enrollment must exclude pre-existing legacy holders. */
async function withStrictPolicyLock<T>(
  file: string,
  fn: (checkOwnership: () => Promise<void>) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const lock = `${file}.lock`;
  const token = `${lock}/owner.${process.pid}.${randomUUID()}.json`;
  const contents = JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() });
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (let backoff = 1; ; backoff = Math.min(backoff * 2, 32)) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
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
