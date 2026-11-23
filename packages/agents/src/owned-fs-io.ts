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
 * - A new file is bound only on Linux, and only when its parent directory exists: the parent
 *   is opened as a directory and checked by identity, and the file is created exclusively
 *   through `/proc/self/fd/N/name`, which the kernel resolves through that open directory, as
 *   `openat` would. Linux without a usable `/proc/self/fd` refuses a new file.
 * - Every other new file is best effort and outside the identity-bound guarantee (#1034): one
 *   whose directories must be made first, and any new file on macOS and Windows, where Node
 *   has no directory-bound creation. Each directory an effect happens in is checked just before
 *   it; a change found before the first effect refuses the operation, one after it (if found
 *   at all) is reported as an unknown effect. Nothing is removed afterwards.
 * - A write that fails once it may have changed something (a truncate, a write, a directory
 *   made) is not "failed": its effect is unknown, and it is not safe to retry as if nothing
 *   happened. Only `OwnedFsFailedWithoutEffect` and `OwnedFsNotDispatched` say nothing changed.
 *   A write is completed only when every byte of the content was written.
 * - Remote (SSH) hosts are outside this binding: their files are not on this machine. Their
 *   paths are compared as written, as `owned-fs-gate.ts` says; verifying them is tracked
 *   separately (#1032).
 */
import { constants, lstatSync, statSync } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
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
  // The guarantee: on Linux, a file created directly in its existing, checked parent, through
  // that parent's descriptor. Linux without a usable /proc/self/fd refuses rather than claim it.
  const parentExists = binding.anchor === dirname(binding.io);
  if (process.platform === "linux") {
    if (!procFdUsable())
      throw new OwnedFsNotDispatched(
        "creating a new file needs /proc/self/fd on Linux, so the creation can be bound to the checked directory",
      );
    if (parentExists) return createBound(binding, content);
  }
  return createBestEffort(binding, content);
}

/**
 * Linux, the guaranteed path: the new file's parent exists and was checked. It is opened as a
 * directory, checked by identity on the descriptor, and the file is created exclusively through
 * `/proc/self/fd/N/name`, which the kernel resolves through that open directory, as `openat`
 * would. The file cannot be created anywhere but in the checked directory.
 */
async function createBound(binding: OwnedFsBinding, content: string): Promise<void> {
  let dir: FileHandle;
  try {
    dir = await open(binding.anchor, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" || errorCode(error) === "ELOOP")
      throw new OwnedFsNotDispatched("the directory changed before the file was created");
    throw new OwnedFsFailedWithoutEffect(error);
  }
  try {
    const anchor = await dir.stat({ bigint: true });
    if (!anchor.isDirectory() || idOf(anchor) !== binding.identity)
      throw new OwnedFsNotDispatched("the directory changed before the file was created");
    // The descriptor must really be reachable as that directory through /proc: else nothing is made.
    if (identityNow(`/proc/self/fd/${dir.fd}`) !== binding.identity)
      throw new OwnedFsFailedWithoutEffect(new Error("the open directory cannot be reached through /proc/self/fd"));
    let handle: FileHandle;
    try {
      handle = await open(
        `/proc/self/fd/${dir.fd}/${basename(binding.io)}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | SAFE_OPEN,
        0o666,
      );
    } catch (error) {
      // An exclusive create that failed made nothing.
      if (errorCode(error) === "EEXIST" || errorCode(error) === "ELOOP")
        throw new OwnedFsNotDispatched("a file appeared before it was created");
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

/**
 * Best effort, outside the identity-bound guarantee (#1034): a new file whose directories must
 * be made first (any platform), or any new file on macOS and Windows, where Node offers no
 * directory-bound creation. Each directory an effect happens in is checked by identity and
 * physical path just before the effect. A change found before the first effect refuses the
 * operation; one in the instant between a check and its effect may be found only afterwards,
 * if at all, and is then reported as an unknown effect. Nothing is cleaned up.
 */
export async function createBestEffort(binding: OwnedFsBinding, content: string): Promise<void> {
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
    // Checked again after the create, as a best effort: a change found here means the file may
    // have been created somewhere else. Nothing is removed (that would be another unbound effect
    // by name); the outcome is reported as unknown and no content is written.
    const placed = created !== undefined && directoryIs(parent, expected) && identityNow(binding.io) === created;
    if (!placed)
      throw new Error(
        "the directory changed while the file was created: where the empty file was created is unknown, and nothing was written",
      );
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
