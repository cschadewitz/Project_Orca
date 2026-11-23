/**
 * The I/O of ORCA's own file executor on a local host, bound to the file it was authorized
 * for (#703 review).
 *
 * A resolved path is a name, and a name can be pointed at another file between the decision
 * and the open. So the decision also captures an identity (`dev:ino`): the file's own when it
 * exists, else that of its nearest existing ancestor directory (the anchor). Only an ordinary
 * file is bound for reading or writing; a directory, FIFO or device is refused.
 *
 * - An existing file is bound. Just before the open it must still be an ordinary file with the
 *   bound identity, so a FIFO or device put in its place is not opened in the usual case. The
 *   open follows no final link (`O_NOFOLLOW`), never waits (`O_NONBLOCK`) and never takes a
 *   terminal (`O_NOCTTY`), where the platform has them. The descriptor is then checked to be
 *   that same ordinary file before a byte is read or written.
 * - A new file on Linux is bound. The anchor is opened as a directory and checked by identity,
 *   and each directory and then the file are made through `/proc/self/fd/N/name`, which the
 *   kernel resolves through that open directory, as `openat`/`mkdirat` would. Nothing is made
 *   anywhere but under the checked directory.
 * - A new file on macOS and Windows is refused (`not-dispatched`, nothing made): Node offers
 *   neither `openat` nor `/proc/self/fd` there, and a creation by names alone could land
 *   outside the checked directory. A directory-bound way there is tracked in #1034.
 * - A write that fails once it may have changed something (a truncate, a write, a directory
 *   made) is not "failed": its effect is unknown, and it is not safe to retry as if nothing
 *   happened. Only `OwnedFsFailedWithoutEffect` and `OwnedFsNotDispatched` say nothing changed.
 *   A write is completed only when every byte of the content was written.
 * - Remote (SSH) hosts are outside this binding: their files are not on this machine. Their
 *   paths are compared as written, as `owned-fs-gate.ts` says; verifying them is tracked
 *   separately (#1032).
 */
import { constants, statSync } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
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
/** Opening a FIFO or a terminal neither waits nor takes it over; elsewhere (Windows) zero. */
const SAFE_OPEN = NOFOLLOW | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);
const DIRECTORY = constants.O_DIRECTORY ?? 0;

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

/**
 * Bind `io` (an already resolved path) for an operation; undefined when no identity can be had,
 * or when what is there is not an ordinary file (a directory, a FIFO, a device): only ordinary
 * files are read or written, and only directories are created in.
 */
export function bindOwnedFs(io: string): OwnedFsBinding | undefined {
  for (let anchor = io; ; anchor = dirname(anchor)) {
    try {
      const stats = statSync(anchor, { bigint: true });
      if (anchor === io ? !stats.isFile() : !stats.isDirectory()) return undefined;
      const id = idOf(stats);
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

/**
 * Open the bound, existing file safely: it is still an ordinary file with the bound identity
 * before the open (so a FIFO or device put in its place is never opened in the usual case),
 * the open follows no final link and neither waits nor takes a terminal, and the descriptor is
 * checked to be that same ordinary file before it is used.
 */
async function openBound(binding: OwnedFsBinding, flags: number, changed: string): Promise<FileHandle> {
  const before = await lstat(binding.io, { bigint: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") throw new OwnedFsNotDispatched(changed);
    throw new OwnedFsFailedWithoutEffect(error);
  });
  if (!before.isFile() || idOf(before) !== binding.identity) throw new OwnedFsNotDispatched(changed);
  let handle: FileHandle;
  try {
    handle = await open(binding.io, flags | SAFE_OPEN);
  } catch (error) {
    if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOENT" || errorCode(error) === "ENXIO")
      throw new OwnedFsNotDispatched(changed);
    // Opening an ordinary file without truncating or creating changes nothing.
    throw new OwnedFsFailedWithoutEffect(error);
  }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || idOf(stats) !== binding.identity) throw new OwnedFsNotDispatched(changed);
  } catch (error) {
    await handle.close();
    throw error instanceof OwnedFsNotDispatched ? error : new OwnedFsFailedWithoutEffect(error);
  }
  return handle;
}

/** Read the bound file, refusing anything but the very file authorized. */
export async function readBound(binding: OwnedFsBinding): Promise<string> {
  if (!binding.exists) {
    // Nothing was there when it was authorized: if nothing is there now, that is the answer.
    try {
      await lstat(binding.io);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw markHostFileMissing(error as Error);
      throw error;
    }
    throw new OwnedFsNotDispatched("a file appeared before it was read");
  }
  const handle = await openBound(binding, constants.O_RDONLY, "the file changed before it was read");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Write the bound file: the very file authorized, or a new one under the very directory authorized. */
export async function writeBound(binding: OwnedFsBinding, content: string): Promise<void> {
  if (binding.exists) {
    const handle = await openBound(binding, constants.O_WRONLY, "the file changed before it was written");
    try {
      await handle.truncate(0);
      await writeAll(handle, content);
    } finally {
      await handle.close();
    }
    return;
  }
  // No directory-bound creation here: refused, never done through names alone (#1034).
  if (!procFdUsable())
    throw new OwnedFsNotDispatched(
      "creating a new file is not supported on this platform: ORCA cannot bind the creation to the checked directory",
    );
  return createBound(binding, content);
}

/**
 * Linux: a new file and its directories are made through `/proc/self/fd/N/name`, where N is a
 * descriptor of the directory already checked to be the authorized one. The kernel resolves
 * that path through the open directory itself, so what is made cannot land anywhere else,
 * whatever happens to the names meanwhile: the creation is bound, as `openat` would bind it.
 */
async function createBound(binding: OwnedFsBinding, content: string): Promise<void> {
  const names = relative(binding.anchor, binding.io).split(sep);
  const file = names.pop()!;
  let dir: FileHandle;
  try {
    dir = await open(binding.anchor, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" || errorCode(error) === "ELOOP")
      throw new OwnedFsNotDispatched("the directory changed before the file was created");
    throw new OwnedFsFailedWithoutEffect(error);
  }
  let made = false;
  const changed = (reason: string): Error =>
    made ? new Error(`${reason}, after a directory was made for it`) : new OwnedFsNotDispatched(reason);
  try {
    const anchor = await dir.stat({ bigint: true });
    if (!anchor.isDirectory() || idOf(anchor) !== binding.identity)
      throw new OwnedFsNotDispatched("the directory changed before the file was created");
    // The descriptor must really be reachable as a directory through /proc: else nothing is made.
    if (identityNow(`/proc/self/fd/${dir.fd}`) !== binding.identity)
      throw new OwnedFsFailedWithoutEffect(new Error("the open directory cannot be reached through /proc/self/fd"));
    for (const name of names) {
      const at = `/proc/self/fd/${dir.fd}/${name}`;
      try {
        await mkdir(at);
      } catch (error) {
        if (errorCode(error) === "EEXIST") throw changed("a directory appeared before the file was created");
        if (made) throw error;
        throw new OwnedFsFailedWithoutEffect(error);
      }
      made = true;
      const next = await open(at, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      await dir.close();
      dir = next;
    }
    let handle: FileHandle;
    try {
      handle = await open(
        `/proc/self/fd/${dir.fd}/${file}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_OPEN,
        0o666,
      );
    } catch (error) {
      if (errorCode(error) === "EEXIST" || errorCode(error) === "ELOOP")
        throw changed("a file appeared before it was created");
      if (made) throw error;
      throw new OwnedFsFailedWithoutEffect(error);
    }
    try {
      await writeAll(handle, content);
    } finally {
      await handle.close();
    }
  } finally {
    await dir.close();
  }
}

/** Whether this process can create through `/proc/self/fd/N/name` (Linux with /proc mounted). */
function procFdUsable(): boolean {
  return process.platform === "linux" && identityNow("/proc/self/fd") !== undefined;
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
