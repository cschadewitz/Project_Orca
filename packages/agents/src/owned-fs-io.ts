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
 *   platform has it; elsewhere the identity comparison alone binds). A directory above it
 *   swapped after the anchor check and before the open is caught for an existing file by the
 *   identity comparison, and for a new file by the directory check after creation, which
 *   removes the file it just created and reports `failed`.
 * - Remote hosts are not bound: their files are not on this machine. Their paths are
 *   compared as written, as `owned-fs-gate.ts` says.
 */
import { constants, statSync } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { markHostFileMissing } from "./host.js";
import { physicalPathOf } from "./permissions.js";

/** Refused before any byte was read or written. */
export class OwnedFsNotDispatched extends Error {}

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
      throw error;
    }
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile() || idOf(stats) !== binding.identity)
        throw new OwnedFsNotDispatched("the file changed before it was written");
      await handle.truncate(0);
      await handle.write(content, 0, "utf8");
    } finally {
      await handle.close();
    }
    return;
  }
  const parent = dirname(binding.io);
  if (identityNow(binding.anchor) !== binding.identity)
    throw new OwnedFsNotDispatched("the directory changed before the file was created");
  await mkdir(parent, { recursive: true });
  let handle;
  try {
    handle = await open(binding.io, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o666);
  } catch (error) {
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ELOOP")
      throw new OwnedFsNotDispatched("a file appeared before it was created");
    throw error;
  }
  try {
    const created = idOf(await handle.stat({ bigint: true }));
    // The file was created where it was authorized: the directory it is in is the one the name
    // resolves to, under the same anchor. Otherwise the new, empty file is taken away again.
    const placed =
      created !== undefined &&
      physicalPathOf(parent) === parent &&
      identityNow(binding.anchor) === binding.identity &&
      identityNow(binding.io) === created;
    if (!placed) {
      await handle.close();
      handle = undefined;
      const now = await lstat(binding.io, { bigint: true }).catch(() => undefined);
      if (now && created !== undefined && idOf(now) === created) await unlink(binding.io).catch(() => undefined);
      throw new Error("the directory changed while the file was created; nothing was written");
    }
    await handle.write(content, 0, "utf8");
  } finally {
    await handle?.close();
  }
}
