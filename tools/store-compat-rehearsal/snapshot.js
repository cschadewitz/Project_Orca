/**
 * Byte manifests, comparison and copy-to-new for disposable store-compatibility rehearsals.
 *
 * A manifest is classification-free byte evidence: every directory and regular file under
 * explicitly named roots, with its permission bits, size and SHA-256. Nothing here deletes,
 * overwrites, repairs or initializes anything, and nothing here follows a link. A copy only
 * ever creates a destination that did not exist. The store's own recovery inventory
 * (`packages/store/src/recovery-inventory.ts`) stays the authority on current-epoch component
 * coverage; this exists because it requires workspace identity and component
 * classification that a store written before those existed cannot satisfy.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const posix = process.platform !== "win32";

export class SnapshotRefusal extends Error {
  constructor(code, path) {
    super(path === undefined ? code : `${code}: ${path}`);
    this.name = "SnapshotRefusal";
    this.code = code;
  }
}

const inside = (base, path) => {
  const part = relative(base, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
const stamp = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

function assertRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === resolve("/"))
    throw new SnapshotRefusal("ROOT_INVALID", String(path));
}

async function hashFile(path, before) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 16 })) hash.update(chunk);
  const after = await lstat(path, { bigint: true });
  if (stamp(after) !== stamp(before)) throw new SnapshotRefusal("CHANGED_DURING_SNAPSHOT", path);
  return hash.digest("hex");
}

/**
 * Record every entry under each named root. Refuses links, special files, overlapping roots
 * and any entry that changes while it is read, so a manifest taken while a writer is still
 * running fails rather than describing a state that never existed.
 */
export async function snapshotRoots(roots) {
  const ids = Object.keys(roots ?? {});
  if (!ids.length) throw new SnapshotRefusal("ROOT_INVALID", "no roots");
  for (const id of ids) {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(id)) throw new SnapshotRefusal("ROOT_INVALID", id);
    assertRoot(roots[id]);
  }
  for (const [index, a] of ids.entries())
    for (const b of ids.slice(index + 1))
      if (inside(roots[a], roots[b]) || inside(roots[b], roots[a])) throw new SnapshotRefusal("ROOT_OVERLAP", b);
  const manifest = { version: 1, posixModes: posix, roots: {} };
  for (const id of ids) {
    const root = roots[id];
    const info = await lstat(root, { bigint: true });
    if (info.isSymbolicLink() || (await realpath(root)) !== root) throw new SnapshotRefusal("LINK_REFUSED", root);
    if (!info.isDirectory()) throw new SnapshotRefusal("ROOT_INVALID", root);
    const entries = [];
    const walk = async (directory, prefix) => {
      const before = await lstat(directory, { bigint: true });
      const names = [];
      for await (const child of await opendir(directory)) names.push(child.name);
      for (const name of names.sort()) {
        const path = prefix ? `${prefix}/${name}` : name;
        const absolute = join(directory, name);
        const entry = await lstat(absolute, { bigint: true });
        if (entry.isSymbolicLink()) throw new SnapshotRefusal("LINK_REFUSED", path);
        const mode = posix ? Number(entry.mode & 0o7777n) : null;
        if (entry.isDirectory()) {
          entries.push({ path, kind: "directory", mode });
          await walk(absolute, path);
        } else if (entry.isFile()) {
          entries.push({ path, kind: "file", mode, size: Number(entry.size), sha256: await hashFile(absolute, entry) });
        } else throw new SnapshotRefusal("SPECIAL_FILE_REFUSED", path);
      }
      if (stamp(await lstat(directory, { bigint: true })) !== stamp(before))
        throw new SnapshotRefusal("CHANGED_DURING_SNAPSHOT", prefix || root);
    };
    await walk(root, "");
    manifest.roots[id] = { mode: posix ? Number(info.mode & 0o7777n) : null, entries };
  }
  return manifest;
}

/**
 * What differs between an expected and an observed manifest, by root and relative path.
 * Paths, kinds, sizes and digests always count; permission bits count when both sides
 * recorded them. Physical identity (device, inode, times) never does, so a faithful copy
 * compares equal.
 */
export function compareSnapshots(expected, observed) {
  const result = { equal: true, missingRoots: [], extraRoots: [], added: [], removed: [], changed: [] };
  const modes = expected.posixModes && observed.posixModes;
  for (const id of Object.keys(expected.roots)) if (!observed.roots[id]) result.missingRoots.push(id);
  for (const id of Object.keys(observed.roots)) if (!expected.roots[id]) result.extraRoots.push(id);
  for (const id of Object.keys(expected.roots)) {
    if (!observed.roots[id]) continue;
    if (modes && expected.roots[id].mode !== observed.roots[id].mode)
      result.changed.push({ path: `${id}:`, fields: ["mode"] });
    const before = new Map(expected.roots[id].entries.map((entry) => [entry.path, entry]));
    const after = new Map(observed.roots[id].entries.map((entry) => [entry.path, entry]));
    for (const path of after.keys()) if (!before.has(path)) result.added.push(`${id}:${path}`);
    for (const [path, entry] of before) {
      const other = after.get(path);
      if (!other) {
        result.removed.push(`${id}:${path}`);
        continue;
      }
      const fields = ["kind", "size", "sha256", ...(modes ? ["mode"] : [])].filter((key) => entry[key] !== other[key]);
      if (fields.length) result.changed.push({ path: `${id}:${path}`, fields });
    }
  }
  result.equal = !(
    result.missingRoots.length ||
    result.extraRoots.length ||
    result.added.length ||
    result.removed.length ||
    result.changed.length
  );
  return result;
}

/**
 * Copy a whole tree to a destination that must not exist yet, keeping permission bits and
 * times. The destination may not be inside the source or contain it. Links are refused by
 * snapshotting the source first, which is also the evidence the copy is checked against.
 */
export async function copyToNew(source, destination) {
  assertRoot(source);
  assertRoot(destination);
  if (inside(source, destination) || inside(destination, source))
    throw new SnapshotRefusal("ROOT_OVERLAP", destination);
  try {
    await lstat(destination);
    throw new SnapshotRefusal("DESTINATION_EXISTS", destination);
  } catch (error) {
    if (error instanceof SnapshotRefusal) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  const expected = await snapshotRoots({ tree: source });
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const observed = await snapshotRoots({ tree: destination });
  const comparison = compareSnapshots(expected, observed);
  if (!comparison.equal) throw new SnapshotRefusal("COPY_MISMATCH", destination);
  return expected;
}
