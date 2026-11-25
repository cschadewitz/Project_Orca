/** Authenticated, owner-only, write-once execution records. Public history never contains their plaintext. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, type BigIntStats } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OrcaError } from "@orca/core";

const KEY_FILE = ".execution-key";
/**
 * The key of a private directory in a store switched to SQLite (#339). The switch hard-links the
 * key here, then puts a marker that is not a key at {@link KEY_FILE}, so a released ORCA that
 * never reads the store's format marker (v0.7.0) finds its key unreadable and refuses the store
 * before writing anything, rather than writing records beside a database it does not know.
 * Where this file exists it is the directory's key; it is never created.
 */
export const SQLITE_KEY_FILE = ".execution-key.sqlite";
const isKey = (name: string) => name === KEY_FILE || name === SQLITE_KEY_FILE;

/** The name of `dir`'s key: {@link SQLITE_KEY_FILE} once the store was switched, else {@link KEY_FILE}. */
async function keyFileOf(dir: string): Promise<string> {
  try {
    await lstat(join(dir, SQLITE_KEY_FILE));
    return SQLITE_KEY_FILE;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return KEY_FILE;
    throw unreadable();
  }
}
const syncedDirectories = new Set<string>();
// Protected reads never reuse bytes from an earlier call: metadata (inode, size,
// nanosecond mtime/ctime) cannot prove a same-size in-place rewrite did not happen,
// so every integrity decision authenticates the current on-disk contents.
const directoryIdentity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.gid}`;
const fileIdentity = (info: BigIntStats) =>
  `${directoryIdentity(info)}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

const EnvelopeSchema = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});

const unreadable = () =>
  new OrcaError(
    "RUN_STATE",
    "protected execution record or key is missing, invalid or unreadable",
    protectedDiagnostic,
  );
// Explicit owner projection on an already authorized failed operation. Generic
// RUN_STATE remains ambiguous; this tag contains no cause, path, key or record.
const protectedDiagnostic = Object.freeze({ diagnostics: Object.freeze({ protectedState: "unavailable" }) });

// Identity, not an error code/message or caller-supplied data, selects a fixed diagnostic.
// Reconstruct at the boundary so even a mutated internal error cannot carry plaintext.
const safeFailures = new WeakMap<object, "record" | "limit">();
export function protectedRecordInvalid(): OrcaError {
  const error = new OrcaError("RUN_STATE", "protected execution record is missing or invalid", protectedDiagnostic);
  safeFailures.set(error, "record");
  return error;
}

/** Internal single-record validator boundary; no arbitrary exceptions may escape replay. */
export async function validatePrivateJson<T>(
  read: () => Promise<unknown[]>,
  validate: (records: unknown[]) => Promise<T>,
): Promise<T> {
  try {
    const records = await read();
    if (records.includes(undefined)) throw unreadable();
    return await validate(records);
  } catch (error) {
    throw observationError(error);
  }
}

interface FileObservation {
  dir: string;
  name: string;
  aad: string;
  directory?: string;
  file?: string;
  digest?: string;
}
interface NamesObservation {
  dir: string;
  prefix: string;
  directory?: string;
  names: string[];
}
interface PrivateObservation {
  files: Map<string, FileObservation>;
  enumerations: Map<string, NamesObservation>;
  count: number;
  maxRecords: number;
  active: boolean;
  failure?: OrcaError;
}
// Async context owns capture. No module state nor a store instance holds
// observations, plaintext, keys, or an authority reusable by another request.
const privateObservation = new AsyncLocalStorage<PrivateObservation>();
class ObservationLimitError extends OrcaError {
  constructor() {
    super("RUN_STATE", "protected execution observation exceeds record limit");
    safeFailures.set(this, "limit");
  }
}
function observationError(error: unknown): OrcaError {
  const diagnostic = safeFailures.get(error as object);
  const failure =
    diagnostic === "record"
      ? protectedRecordInvalid()
      : diagnostic === "limit"
        ? new ObservationLimitError()
        : unreadable();
  const scope = privateObservation.getStore();
  if (scope) scope.failure ??= failure;
  return failure;
}
function reserveObservation(scope: PrivateObservation, count: number): void {
  if (!scope.active || scope.failure) throw scope.failure ?? unreadable();
  if (count > scope.maxRecords - scope.count) throw observationError(new ObservationLimitError());
  scope.count += count;
}
function captureFile(scope: PrivateObservation, record: FileObservation): void {
  const id = JSON.stringify([record.dir, record.name]);
  const previous = scope.files.get(id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw observationError(unreadable());
  reserveObservation(scope, previous ? 0 : 1);
  scope.files.set(id, record);
}
async function optionalStat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function safeDirectory(info: BigIntStats): string {
  if (!info.isDirectory() || (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)) throw unreadable();
  return directoryIdentity(info);
}
function safeFile(info: BigIntStats): string {
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)) throw unreadable();
  return fileIdentity(info);
}

/** Fresh reads only. Verification hashes bounded chunks, without parsing or decrypting. */
async function inspectPrivateFile(
  directory: string,
  name: string,
  readBytes: boolean,
): Promise<{ record: FileObservation; bytes?: Buffer }> {
  const dir = resolve(directory);
  const path = join(dir, name);
  const record: FileObservation = { dir, name, aad: associatedData(dir, name).toString("utf8") };
  const directoryInfo = await optionalStat(dir);
  if (!directoryInfo) return { record };
  record.directory = safeDirectory(directoryInfo);
  const info = await optionalStat(path);
  if (!info) {
    if (safeDirectory(await lstat(dir, { bigint: true })) !== record.directory) throw unreadable();
    return { record };
  }
  record.file = safeFile(info);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (safeFile(await handle.stat({ bigint: true })) !== record.file) throw unreadable();
    let bytes: Buffer | undefined;
    let length = 0;
    const hash = createHash("sha256");
    if (readBytes) {
      bytes = await handle.readFile();
      length = bytes.length;
      hash.update(bytes);
    } else {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        length += bytesRead;
        hash.update(chunk.subarray(0, bytesRead));
      }
      // A key also travels through this path. Do not keep its bytes in the scratch buffer.
      chunk.fill(0);
    }
    if (
      (isKey(name) && length !== 32) ||
      safeFile(await handle.stat({ bigint: true })) !== record.file ||
      safeFile(await lstat(path, { bigint: true })) !== record.file ||
      safeDirectory(await lstat(dir, { bigint: true })) !== record.directory
    ) {
      if (isKey(name)) bytes?.fill(0);
      throw unreadable();
    }
    record.digest = hash.digest("hex");
    return bytes ? { record, bytes } : { record };
  } finally {
    await handle.close();
  }
}

async function inspectPrivateNames(directory: string, prefix: string, maxNames: number): Promise<NamesObservation> {
  const dir = resolve(directory);
  const info = await optionalStat(dir);
  if (!info) return { dir, prefix, names: [] };
  const directoryStamp = safeDirectory(info);
  const names: string[] = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith(prefix) && name.endsWith(".json")) {
      if (names.length >= maxNames) throw new ObservationLimitError();
      names.push(name);
    }
  }
  if (safeDirectory(await lstat(dir, { bigint: true })) !== directoryStamp) throw unreadable();
  return { dir, prefix, directory: directoryStamp, names: names.sort() };
}

/** Filter membership, including an empty/missing directory, belongs to the observation. */
export async function privateJsonNames(dir: string, prefix: string): Promise<string[]> {
  const scope = privateObservation.getStore();
  if (!scope) {
    try {
      return (await readdir(dir)).filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw unreadable();
    }
  }
  try {
    reserveObservation(scope, 0);
    const id = JSON.stringify([resolve(dir), prefix]);
    const previous = scope.enumerations.get(id);
    const record = await inspectPrivateNames(dir, prefix, previous?.names.length ?? scope.maxRecords - scope.count);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw unreadable();
    reserveObservation(scope, previous ? 0 : 1 + record.names.length);
    scope.enumerations.set(id, record);
    return [...record.names];
  } catch (error) {
    throw observationError(error);
  }
}

/** The returned capability contains digests and identities only, and never serializes them. */
export async function observePrivateReads<T>(
  work: () => Promise<T>,
  limits: { maxRecords: number },
): Promise<{ value: T; verifyUnchanged(): Promise<void>; assertUnchanged(): undefined }> {
  if (privateObservation.getStore()) throw observationError(unreadable());
  if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 0) throw new ObservationLimitError();
  const scope: PrivateObservation = {
    files: new Map(),
    enumerations: new Map(),
    count: 0,
    maxRecords: limits.maxRecords,
    active: true,
  };
  let value: T;
  try {
    value = await privateObservation.run(scope, work);
    if (scope.failure) throw observationError(scope.failure);
  } finally {
    scope.active = false;
  }
  const files = [...scope.files.values()];
  const enumerations = [...scope.enumerations.values()];
  return {
    value,
    assertUnchanged() {
      // Final publication check: bounded chunks, digests/identities only. Re-read key,
      // inputs, payloads and sensitivity membership; never cache authority or plaintext.
      try {
        for (const expected of files) assertPrivateFileUnchanged(expected);
        for (const expected of enumerations) {
          let current: NamesObservation = { dir: expected.dir, prefix: expected.prefix, names: [] };
          try {
            const stamp = safeDirectory(lstatSync(expected.dir, { bigint: true }));
            const names = readdirSync(expected.dir)
              .filter((name) => name.startsWith(expected.prefix) && name.endsWith(".json"))
              .sort();
            if (
              names.length > expected.names.length ||
              safeDirectory(lstatSync(expected.dir, { bigint: true })) !== stamp
            )
              throw unreadable();
            current = { dir: expected.dir, prefix: expected.prefix, directory: stamp, names };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (JSON.stringify(current) !== JSON.stringify(expected)) throw unreadable();
        }
        return undefined;
      } catch {
        throw unreadable();
      }
    },
    async verifyUnchanged() {
      try {
        for (const expected of files) {
          const { record } = await inspectPrivateFile(expected.dir, expected.name, false);
          if (JSON.stringify(record) !== JSON.stringify(expected)) throw unreadable();
        }
        for (const expected of enumerations) {
          const current = await inspectPrivateNames(expected.dir, expected.prefix, expected.names.length);
          if (JSON.stringify(current) !== JSON.stringify(expected)) throw unreadable();
        }
      } catch {
        throw unreadable();
      }
    },
  };
}

function assertPrivateFileUnchanged(expected: FileObservation): void {
  const path = join(expected.dir, expected.name);
  const optional = (name: string) => {
    try {
      return lstatSync(name, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const directory = optional(expected.dir);
  if (!directory) {
    if (expected.directory !== undefined) throw unreadable();
    return;
  }
  if (safeDirectory(directory) !== expected.directory) throw unreadable();
  const info = optional(path);
  if (!info) {
    if (expected.file !== undefined) throw unreadable();
    return;
  }
  if (safeFile(info) !== expected.file) throw unreadable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    if (safeFile(fstatSync(fd, { bigint: true })) !== expected.file) throw unreadable();
    let length = 0n;
    const hash = createHash("sha256");
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      length += BigInt(count);
      if (length > info.size) throw unreadable();
      hash.update(chunk.subarray(0, count));
    }
    if (
      length !== info.size ||
      (isKey(expected.name) && length !== 32n) ||
      safeFile(fstatSync(fd, { bigint: true })) !== expected.file ||
      safeFile(lstatSync(path, { bigint: true })) !== expected.file ||
      safeDirectory(lstatSync(expected.dir, { bigint: true })) !== expected.directory ||
      hash.digest("hex") !== expected.digest
    )
      throw unreadable();
  } finally {
    chunk.fill(0);
    closeSync(fd);
  }
}

/** Refuse unsafe existing directories rather than silently changing their access policy. */
export async function privateDirectory(dir: string): Promise<void> {
  if (privateObservation.getStore()) throw observationError(unreadable());
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
  const scope = privateObservation.getStore();
  if (scope) {
    try {
      reserveObservation(scope, 0);
      const { record, bytes } = await inspectPrivateFile(dir, name, true);
      captureFile(scope, record);
      return bytes;
    } catch (error) {
      throw observationError(error);
    }
  }
  const path = join(dir, name);
  try {
    const directory = await lstat(dir, { bigint: true });
    if (!directory.isDirectory() || (process.platform !== "win32" && (directory.mode & 0o077n) !== 0n))
      throw unreadable();
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)) throw unreadable();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || (process.platform !== "win32" && (opened.mode & 0o077n) !== 0n)) throw unreadable();
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || (process.platform !== "win32" && (after.mode & 0o077n) !== 0n)) throw unreadable();
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (error) {
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
  const keyFile = await keyFileOf(dir);
  let key = await privateBytes(dir, keyFile);
  // A switched store's key is never manufactured: it was the store's key before the switch.
  if (!key && create && keyFile === KEY_FILE) {
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
  Buffer.from(`orca:protected-execution:v1:${basename(dir)}:${name}`); // rename-keep: AEAD associated data of stored ciphertext

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
    const key = await keyFor(dir, false);
    try {
      return decodeRecord(dir, name, bytes, key);
    } finally {
      if (privateObservation.getStore()) key.fill(0);
    }
  } catch (error) {
    // Parse and authentication failures must never include source bytes or underlying exceptions.
    throw observationError(error);
  }
}

/** A fresh, stable key observation for one replay call. */
async function replayKey(dir: string): Promise<{ bytes: Buffer; directory: string; file: string }> {
  const scope = privateObservation.getStore();
  if (scope) {
    reserveObservation(scope, 0);
    const { record, bytes } = await inspectPrivateFile(dir, await keyFileOf(dir), true);
    captureFile(scope, record);
    if (!bytes || !record.directory || !record.file) throw unreadable();
    return { bytes, directory: record.directory, file: record.file };
  }
  const path = join(dir, await keyFileOf(dir));
  const directory = await lstat(dir, { bigint: true });
  const info = await lstat(path, { bigint: true });
  if (
    !directory.isDirectory() ||
    !info.isFile() ||
    (process.platform !== "win32" && ((directory.mode | info.mode) & 0o077n) !== 0n)
  )
    throw unreadable();
  const directoryStamp = directoryIdentity(directory);
  const fileStamp = fileIdentity(info);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (fileIdentity(opened) !== fileStamp) throw unreadable();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    const currentDirectory = await lstat(dir, { bigint: true });
    if (
      bytes.length !== 32 ||
      fileIdentity(after) !== fileStamp ||
      fileIdentity(current) !== fileStamp ||
      directoryIdentity(currentDirectory) !== directoryStamp
    )
      throw unreadable();
    return { bytes, directory: directoryStamp, file: fileStamp };
  } finally {
    await handle.close();
  }
}

/**
 * Internal multi-record replay boundary. Authenticate every record with the entry key,
 * validate current inputs/sensitivity, then require the same fresh key bytes and identities
 * before returning any plaintext. No authority survives this call or authorizes a write.
 * These are entry/terminal observations, not proof against every transient A -> B -> A edit.
 */
export async function readPrivateJsonBatch<T>(
  dir: string,
  names: readonly string[],
  validate: (records: unknown[]) => Promise<T>,
): Promise<T> {
  let entry: Awaited<ReturnType<typeof replayKey>> | undefined;
  let terminal: Awaited<ReturnType<typeof replayKey>> | undefined;
  try {
    entry = await replayKey(dir);
    const key = entry.bytes;
    const records = await Promise.all(
      names.map(async (name) => {
        const bytes = await privateBytes(dir, name);
        if (!bytes) throw unreadable();
        return decodeRecord(dir, name, bytes, key);
      }),
    );
    let result: T | undefined;
    let failure: OrcaError | undefined;
    try {
      result = await validate(records);
    } catch (error) {
      // Delay poisoning until after terminal verification. A validator refusal does
      // not excuse a changed key/identity, which must take precedence over diagnostics.
      const diagnostic = safeFailures.get(error as object);
      failure = diagnostic === "record" ? protectedRecordInvalid() : unreadable();
    }
    terminal = await replayKey(dir);
    if (
      entry.directory !== terminal.directory ||
      entry.file !== terminal.file ||
      !timingSafeEqual(entry.bytes, terminal.bytes)
    )
      throw unreadable();
    if (failure) throw failure;
    return result as T;
  } catch (error) {
    throw observationError(error);
  } finally {
    if (privateObservation.getStore()) {
      entry?.bytes.fill(0);
      terminal?.bytes.fill(0);
    }
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
