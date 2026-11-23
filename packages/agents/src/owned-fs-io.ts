/**
 * The I/O of ORCA's own file executor on a local host, bound to the file it was authorized
 * for (#703 review).
 *
 * A resolved path is a name, and a name can be pointed at another file between the decision
 * and the open. So the decision also captures an identity (`dev:ino`): the file's own when it
 * exists, else that of its nearest existing ancestor directory (the anchor). The I/O then
 * opens without following a final link and compares the opened file's identity with the
 * authorized one before reading or writing a byte; a new file is created exclusively and its
 * directory checked against the anchor before anything is written. A mismatch, or an identity
 * the file system will not give (a zero inode, a failed stat), refuses the operation:
 * `OwnedFsNotDispatched` when nothing was read or written, which the executor records as
 * `not-dispatched`.
 *
 * Limits, stated rather than papered over:
 * - Only the final component is opened without following links (`O_NOFOLLOW`, where the
 *   platform has it; elsewhere the identity comparison alone binds). An existing file is bound:
 *   whatever the name leads to at the open, its identity is compared on the open descriptor
 *   before a byte is read or written.
 * - A new file is verified, not bound. Node has no `openat`/`mkdirat`, so a directory cannot be
 *   held open and created in. Instead, before each effect (each directory made, the exclusive
 *   create) the directory it happens in is checked to be the authorized one by identity and
 *   physical path; a change found before the first effect refuses it as `not-dispatched`. A
 *   change in the instant between a check and its effect is caught only afterwards: the new
 *   file is taken away, and the outcome is unknown, never `not-dispatched`.
 * - A write that fails once it may have changed something (a truncate, a write, a directory
 *   made) is not "failed": its effect is unknown, and it is not safe to retry as if nothing
 *   happened. Only `OwnedFsFailedWithoutEffect` and `OwnedFsNotDispatched` say nothing changed.
 *   A write is completed only when every byte of the content was written.
 * - Remote (SSH) hosts are outside this binding: their files are not on this machine. Their
 *   paths are compared as written, as `owned-fs-gate.ts` says; verifying them is tracked
 *   separately (#1032).
 */
import { constants, lstatSync, statSync } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { markHostFileMissing } from "./host.js";
import { physicalPathOf } from "./permissions.js";

/** Refused before any byte was read or written. */
export class OwnedFsNotDispatched extends Error {}

/**
 * A write that failed before anything was changed: positive evidence of no effect (#703
 * review). Any other write failure leaves the effect unknown.
 */
export class OwnedFsFailedWithoutEffect extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
  }
}

/** What an `fs/*` operation is bound to: the file, or the directory it will be created under. */
export interface OwnedFsBinding {
  /** The resolved file the I/O goes to. */
  readonly io: string;
  /** Whether the file existed when it was authorized. */
  readonly exists: boolean;
  /** `io` when it existed, else its nearest existing ancestor directory. */
  readonly anchor: string;
  /** `dev:ino` of `anchor`. */
  readonly identity: string;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function idOf(stats: { dev: bigint; ino: bigint }): string | undefined {
  return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** The identity of `path` right now, following links, or undefined when it cannot be had. */
export function identityNow(path: string): string | undefined {
  try {
    return idOf(statSync(path, { bigint: true }));
  } catch {
    return undefined;
  }
}

/** Bind `io` (an already resolved path) for an operation; undefined when no identity can be had. */
export function bindOwnedFs(io: string): OwnedFsBinding | undefined {
  for (let anchor = io; ; anchor = dirname(anchor)) {
    try {
      const id = idOf(statSync(anchor, { bigint: true }));
      return id === undefined ? undefined : { io, exists: anchor === io, anchor, identity: id };
    } catch (error) {
      if (errorCode(error) !== "ENOENT" || dirname(anchor) === anchor) return undefined;
    }
  }
}

/**
 * Whether `path` still names exactly what `binding` was made for: it resolves to the same file,
 * the anchor has the same identity, and a file that did not exist still does not.
 */
export function stillBound(path: string, binding: OwnedFsBinding): boolean {
  if (physicalPathOf(path) !== binding.io) return false;
  if (identityNow(binding.anchor) !== binding.identity) return false;
  if (!binding.exists && identityNow(binding.io) !== undefined) return false;
  return true;
}

/** Read the bound file, refusing anything but the very file authorized. */
export async function readBound(binding: OwnedFsBinding): Promise<string> {
  let handle;
  try {
    handle = await open(binding.io, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    // Opening the path itself said there is nothing there.
    if (errorCode(error) === "ENOENT" && !binding.exists) throw markHostFileMissing(error as Error);
    if (errorCode(error) === "ELOOP") throw new OwnedFsNotDispatched("the file is now a link");
    throw error;
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!binding.exists || !stats.isFile() || idOf(stats) !== binding.identity)
      throw new OwnedFsNotDispatched("the file changed before it was read");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Write the bound file: the very file authorized, or a new one under the very directory authorized. */
export async function writeBound(binding: OwnedFsBinding, content: string): Promise<void> {
  if (binding.exists) {
    let handle;
    try {
      handle = await open(binding.io, constants.O_WRONLY | NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOENT")
        throw new OwnedFsNotDispatched("the file changed before it was written");
      // Opening for writing without truncating changes nothing.
      throw new OwnedFsFailedWithoutEffect(error);
    }
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile() || idOf(stats) !== binding.identity)
        throw new OwnedFsNotDispatched("the file changed before it was written");
      await handle.truncate(0);
      await writeAll(handle, content);
    } finally {
      await handle.close();
    }
    return;
  }
  const parent = dirname(binding.io);
  // Every directory between the anchor and the new file, nearest the anchor first.
  const missing: string[] = [];
  for (let dir = parent; dir !== binding.anchor; dir = dirname(dir)) {
    if (dirname(dir) === dir)
      throw new OwnedFsNotDispatched("the file is not under the directory it was authorized for");
    missing.unshift(dir);
  }
  // Nothing is changed until the directory it goes in is shown to be the authorized one, and
  // each directory made is checked the same way before anything is made in it. Once one is
  // made, no later failure is "no effect".
  let made = false;
  const refuse = (reason: string): never => {
    if (made) throw new Error(`${reason}, after a directory was made for it`);
    throw new OwnedFsNotDispatched(reason);
  };
  let expected = binding.identity;
  for (const dir of missing) {
    if (!directoryIs(dirname(dir), expected)) refuse("the directory changed before the file was created");
    try {
      await mkdir(dir);
    } catch (error) {
      if (errorCode(error) === "EEXIST") refuse("a directory appeared before the file was created");
      if (made) throw error;
      throw new OwnedFsFailedWithoutEffect(error);
    }
    made = true;
    const id = directoryIdentity(dir);
    if (id === undefined) throw new Error("a directory made for the file cannot be identified");
    expected = id;
  }
  if (!directoryIs(parent, expected)) refuse("the directory changed before the file was created");
  let handle;
  try {
    handle = await open(binding.io, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o666);
  } catch (error) {
    // An exclusive create that failed made nothing.
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ELOOP") refuse("a file appeared before it was created");
    if (made) throw error;
    throw new OwnedFsFailedWithoutEffect(error);
  }
  try {
    const created = idOf(await handle.stat({ bigint: true }));
    // The file was created where it was checked: the directory it is in is still that one.
    // Otherwise the new, empty file is taken away again; that is cleanup, not "not dispatched":
    // the outcome is unknown.
    const placed = created !== undefined && directoryIs(parent, expected) && identityNow(binding.io) === created;
    if (!placed) {
      await handle.close();
      handle = undefined;
      const now = await lstat(binding.io, { bigint: true }).catch(() => undefined);
      if (now && created !== undefined && idOf(now) === created) await unlink(binding.io).catch(() => undefined);
      throw new Error("the directory changed while the file was created; the new file was taken away");
    }
    await writeAll(handle, content);
  } finally {
    await handle?.close();
  }
}

/** The identity of the directory `dir` itself (a link is not one), or undefined. */
function directoryIdentity(dir: string): string | undefined {
  try {
    const stats = lstatSync(dir, { bigint: true });
    return stats.isDirectory() ? idOf(stats) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `dir` is, right now, the directory `identity` names, reached by its own physical path. */
function directoryIs(dir: string, identity: string): boolean {
  return directoryIdentity(dir) === identity && physicalPathOf(dir) === dir;
}

/** Write all of `content` from the start of the file: a short write is continued, never taken as done. */
export async function writeAll(handle: Pick<FileHandle, "write">, content: string): Promise<void> {
  const bytes = Buffer.from(content, "utf8");
  for (let at = 0; at < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at, at);
    if (bytesWritten <= 0) throw new Error("the write stopped before all of the content was written");
    at += bytesWritten;
  }
}
