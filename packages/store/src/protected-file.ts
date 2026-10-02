/** Authenticated, owner-only, write-once execution records. Public history never contains their plaintext. */
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { OrcaError } from "@orca/core";

const KEY_FILE = ".execution-key";
const syncedDirectories = new Set<string>();
// Immutable ciphertext/key bytes only; callers still authenticate and parse every record.
// Every hit revalidates the current path, owner-only mode and nanosecond change metadata.
const byteCache = new Map<string, { directory: string; file: string; bytes: Buffer }>();
const MAX_CACHED_BYTES = 8 * 1024 * 1024;
let cachedBytes = 0;
const directoryIdentity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.gid}`;
const fileIdentity = (info: BigIntStats) =>
  `${directoryIdentity(info)}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

function forgetBytes(path: string): void {
  const previous = byteCache.get(path);
  if (previous) cachedBytes -= previous.bytes.length;
  byteCache.delete(path);
}

function rememberBytes(path: string, directory: string, file: string, bytes: Buffer): void {
  forgetBytes(path);
  if (bytes.length > MAX_CACHED_BYTES) return;
  while (byteCache.size >= 256 || cachedBytes + bytes.length > MAX_CACHED_BYTES)
    forgetBytes(byteCache.keys().next().value!);
  byteCache.set(path, { directory, file, bytes });
  cachedBytes += bytes.length;
}
const EnvelopeSchema = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

const unreadable = () =>
  new OrcaError("RUN_STATE", "protected execution record or key is missing, invalid or unreadable");

/** Refuse unsafe existing directories rather than silently changing their access policy. */
export async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw unreadable();
  // A durable file inside a new directory is insufficient unless every newly created
  // ancestor entry is durable too. Sync the ancestry once per process before any key or
  // record can be published; this also covers a concurrent recursive mkdir winner.
  if (process.platform !== "win32" && !syncedDirectories.has(dir)) {
    let parent = dirname(dir);
    for (;;) {
      const handle = await open(parent, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    syncedDirectories.add(dir);
  }
}

async function privateBytes(dir: string, name: string): Promise<Buffer | undefined> {
  const path = join(dir, name);
  try {
    const directory = await lstat(dir, { bigint: true });
    if (!directory.isDirectory() || (process.platform !== "win32" && (directory.mode & 0o077n) !== 0n))
      throw unreadable();
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)) throw unreadable();
    const directoryStamp = directoryIdentity(directory);
    const fileStamp = fileIdentity(info);
    const cached = byteCache.get(path);
    if (cached?.directory === directoryStamp && cached.file === fileStamp) return cached.bytes;
    forgetBytes(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Never cache a record replaced between the path check/open, or changed while
      // reading. Publication can legitimately change nlink/ctime when its temporary
      // hard link is removed, so those reads use the open file but do not seed reuse.
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || (process.platform !== "win32" && (opened.mode & 0o077n) !== 0n)) throw unreadable();
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || (process.platform !== "win32" && (after.mode & 0o077n) !== 0n)) throw unreadable();
      if (fileIdentity(opened) === fileStamp && fileIdentity(after) === fileStamp)
        rememberBytes(path, directoryStamp, fileStamp, bytes);
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
    forgetBytes(path);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unreadable();
  }
}

/** Exclusive hard-link publication makes concurrent first-key creation choose one durable winner. */
async function publish(dir: string, name: string, bytes: Buffer): Promise<boolean> {
  const final = join(dir, name);
  const temporary = `${final}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, final);
      if (process.platform !== "win32") {
        const directory = await open(dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function keyFor(dir: string, create: boolean): Promise<Buffer> {
  let key = await privateBytes(dir, KEY_FILE);
  if (!key && create) {
    // Never manufacture a replacement key for ciphertext already in this directory.
    // Orphan temporary files have no public references and are not committed records.
    if ((await readdir(dir)).some((name) => name.endsWith(".json"))) {
      // A concurrent first writer may already have published both its key and record.
      key = await privateBytes(dir, KEY_FILE);
      if (!key) throw unreadable();
    } else {
      await publish(dir, KEY_FILE, randomBytes(32));
      key = await privateBytes(dir, KEY_FILE);
    }
  }
  if (!key || key.length !== 32) throw unreadable();
  if (create) {
    // A same-length but replaced key is corrupt too. Authenticate an existing record before
    // accepting any further writes, instead of creating a mixed-key, partially readable store.
    const existing = (await readdir(dir)).find((name) => name.endsWith(".json"));
    if (existing) {
      const bytes = await privateBytes(dir, existing);
      if (!bytes) throw unreadable();
      decodeRecord(dir, existing, bytes, key);
    }
  }
  return key;
}

/** Bind ciphertext to its record identity, while permitting a complete backup to move directories. */
const associatedData = (dir: string, name: string) =>
  Buffer.from(`orca:protected-execution:v1:${basename(dir)}:${name}`);

function decodeRecord(dir: string, name: string, bytes: Buffer, key: Buffer): unknown {
  const envelope = EnvelopeSchema.parse(JSON.parse(bytes.toString("utf8")));
  const nonce = Buffer.from(envelope.nonce, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (nonce.length !== 12 || tag.length !== 16) throw unreadable();
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(associatedData(dir, name));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}

export async function readPrivateJson(dir: string, name: string): Promise<unknown | undefined> {
  try {
    const bytes = await privateBytes(dir, name);
    if (!bytes) return undefined;
    return decodeRecord(dir, name, bytes, await keyFor(dir, false));
  } catch {
    // Parse and authentication failures must never include source bytes or underlying exceptions.
    throw unreadable();
  }
}

/** Persist key + ciphertext before publishing a public reference; failed appends may leave private orphans. */
export async function writePrivateJson(dir: string, name: string, value: unknown): Promise<boolean> {
  try {
    await privateDirectory(dir);
    const key = await keyFor(dir, true);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associatedData(dir, name));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const envelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    return await publish(dir, name, Buffer.from(JSON.stringify(envelope) + "\n"));
  } catch {
    throw new OrcaError("RUN_STATE", "protected execution record or key could not be written safely");
  }
}
