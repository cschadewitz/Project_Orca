/** Shared sidecar file mechanics. All policy writers use this lock and exact byte revision. */
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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
 * Serialise read-modify-write across processes, with the same `link()`-to-create idiom the
 * store's `withFileLock` uses. It is not reused: `@orca/agents` sits to the right of
 * `@orca/store` in the layering, so it cannot import it.
 *
 * Legacy locks retain the old mtime-based recovery behavior. Age cannot prove that a
 * paused owner died. Typed mode uses the same namespace with strict token ownership below.
 */
export async function withPolicyLock<T>(
  file: string,
  opts: { timeoutMs?: number; staleMs?: number; strictOwnership?: boolean } | undefined,
  fn: (checkOwnership: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (opts?.strictOwnership) return withStrictPolicyLock(file, fn, opts.timeoutMs ?? 10_000);
  const lock = `${file}.lock`;
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const staleMs = opts?.staleMs ?? 30_000;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
  const deadline = Date.now() + timeoutMs;
  try {
    for (let backoff = 1; ; backoff = Math.min(backoff * 2, 32)) {
      try {
        await link(tmp, lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        await breakIfStale(lock, staleMs);
        if (Date.now() >= deadline)
          throw new OrcaError("STORE_LOCK_TIMEOUT", `${lock} is held by another writer`, { file });
        await delay(backoff + Math.random() * backoff);
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
  try {
    return await fn(async () => {});
  } finally {
    await rm(lock, { force: true });
  }
}

async function breakIfStale(lock: string, staleMs: number): Promise<void> {
  try {
    const st = await stat(lock);
    if (Date.now() - st.mtimeMs > staleMs) await unlink(lock);
  } catch {
    // Gone already, or another waiter broke it first. Either way, retry the link.
  }
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
        throw new OrcaError("STORE_LOCK_TIMEOUT", "typed sidecar ownership unavailable; no takeover", { file });
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
        "typed sidecar ownership lost; publication refused",
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
