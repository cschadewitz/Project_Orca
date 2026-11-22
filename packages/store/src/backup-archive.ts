/**
 * The Windows store-format backup (#910): a whole-store copy written as one ZIP archive (stored,
 * not compressed) INTO a backup slot file that already existed before Windows last started.
 *
 * Why a slot: Windows offers no documented way for an unelevated process to make a new
 * directory entry (a created or renamed file) durable before a later one. What it does document
 * is that FlushFileBuffers writes a file's buffered data to the device before returning, and
 * Node's `FileHandle.sync()` is FlushFileBuffers there. A file that survived a restart has a
 * directory entry that is on disk already; each slot records its own file ID and the Windows
 * BootId it was created in, so that is checked, not assumed. The backup goes into such a file,
 * rewritten in place and flushed, and its manifest names the conversion and the slot. The marker
 * that changes the store's format is not even created until that flush has returned. The marker
 * itself is a new directory entry and may still be lost to a power cut; the archive is then the
 * durable record of the conversion (store-format-carryover.ts).
 *
 * ZIP, a format Windows itself can read and check (`Expand-Archive`). Extracting one by hand is
 * not a supported restore: it keeps the bytes but not the access rules that keep the store's
 * private records to the user (#947). ZIP64 fields are
 * written only when a size, offset or count needs them.
 */
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";

export interface ArchiveEntry {
  /** Relative path inside the store, `/`-separated. */
  path: string;
  type: "dir" | "file";
  mtime?: Date;
}

interface Written {
  name: Buffer;
  dir: boolean;
  crc: number;
  size: bigint;
  offset: bigint;
  time: number;
  date: number;
}

const MAX32 = 0xffffffffn;
const MAX16 = 0xffff;

function dosTime(date: Date | undefined): { time: number; date: number } {
  const d = date && date.getFullYear() >= 1980 ? date : new Date(1980, 0, 1);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function crcOf(path: string): Promise<{ crc: number; size: bigint }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1 << 16);
    let crc = 0;
    let size = 0n;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      crc = crc32(buffer.subarray(0, bytesRead), crc);
      size += BigInt(bytesRead);
    }
    return { crc, size };
  } finally {
    await handle.close();
  }
}

class Writer {
  position = 0n;
  constructor(private readonly handle: FileHandle) {}
  async write(buffer: Buffer): Promise<void> {
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await this.handle.write(buffer, done, buffer.length - done, Number(this.position));
      done += bytesWritten;
      this.position += BigInt(bytesWritten);
    }
  }
}

function zip64Extra(values: bigint[]): Buffer {
  if (!values.length) return Buffer.alloc(0);
  const extra = Buffer.alloc(4 + 8 * values.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + 8 * i));
  return extra;
}

/**
 * Write `entries` (taken from `sourceRoot`) plus `extra` files given as text, as a stored ZIP
 * archive over the existing file at `slot`, from offset 0, truncated to its new length and
 * flushed before this returns. The slot is never created or renamed here.
 */
export async function writeArchiveSlot(
  slot: string,
  sourceRoot: string,
  entries: readonly ArchiveEntry[],
  extra: readonly { path: string; text: string }[],
): Promise<void> {
  // "r+": the slot must already exist; it is rewritten in place, never replaced.
  const handle = await open(slot, "r+");
  try {
    const out = new Writer(handle);
    const written: Written[] = [];
    const add = async (entry: ArchiveEntry, source: { file?: string; text?: Buffer }) => {
      const dir = entry.type === "dir";
      const name = Buffer.from(dir ? `${entry.path}/` : entry.path, "utf8");
      const { time, date } = dosTime(entry.mtime);
      let crc = 0;
      let size = 0n;
      if (source.file) ({ crc, size } = await crcOf(source.file));
      else if (source.text) {
        crc = crc32(source.text);
        size = BigInt(source.text.length);
      }
      const offset = out.position;
      const big = size >= MAX32;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(big ? 45 : 20, 4);
      local.writeUInt16LE(0x0800, 6); // UTF-8 names
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(big ? 0xffffffff : Number(size), 18);
      local.writeUInt32LE(big ? 0xffffffff : Number(size), 22);
      local.writeUInt16LE(name.length, 26);
      const localExtra = big ? zip64Extra([size, size]) : Buffer.alloc(0);
      local.writeUInt16LE(localExtra.length, 28);
      await out.write(Buffer.concat([local, name, localExtra]));
      if (source.file) {
        const input = await open(source.file, "r");
        try {
          const buffer = Buffer.allocUnsafe(1 << 16);
          let copied = 0n;
          let check = 0;
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
            if (!bytesRead) break;
            const chunk = buffer.subarray(0, bytesRead);
            check = crc32(chunk, check);
            copied += BigInt(bytesRead);
            await out.write(chunk);
          }
          if (copied !== size || check !== crc) throw new Error(`${source.file} changed while it was archived`);
        } finally {
          await input.close();
        }
      } else if (source.text) await out.write(source.text);
      written.push({ name, dir, crc, size, offset, time, date });
    };
    for (const entry of entries)
      await add(entry, entry.type === "file" ? { file: join(sourceRoot, ...entry.path.split("/")) } : {});
    for (const file of extra) await add({ path: file.path, type: "file" }, { text: Buffer.from(file.text, "utf8") });

    const centralStart = out.position;
    for (const w of written) {
      const values: bigint[] = [];
      if (w.size >= MAX32) values.push(w.size, w.size);
      if (w.offset >= MAX32) values.push(w.offset);
      const extraField = zip64Extra(values);
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE((0 << 8) | 45, 4); // made by: MS-DOS attributes, spec 4.5
      head.writeUInt16LE(values.length ? 45 : 20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(0, 10);
      head.writeUInt16LE(w.time, 12);
      head.writeUInt16LE(w.date, 14);
      head.writeUInt32LE(w.crc >>> 0, 16);
      head.writeUInt32LE(w.size >= MAX32 ? 0xffffffff : Number(w.size), 20);
      head.writeUInt32LE(w.size >= MAX32 ? 0xffffffff : Number(w.size), 24);
      head.writeUInt16LE(w.name.length, 28);
      head.writeUInt16LE(extraField.length, 30);
      head.writeUInt16LE(0, 32);
      head.writeUInt16LE(0, 34);
      head.writeUInt16LE(0, 36);
      head.writeUInt32LE(w.dir ? 0x10 : 0x20, 38);
      head.writeUInt32LE(w.offset >= MAX32 ? 0xffffffff : Number(w.offset), 42);
      await out.write(Buffer.concat([head, w.name, extraField]));
    }
    const centralSize = out.position - centralStart;
    const count = written.length;
    if (count >= MAX16 || centralStart >= MAX32 || centralSize >= MAX32) {
      const zip64End = out.position;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(centralSize, 40);
      record.writeBigUInt64LE(centralStart, 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(zip64End, 8);
      locator.writeUInt32LE(1, 16);
      await out.write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(centralSize >= MAX32 ? 0xffffffff : Number(centralSize), 12);
    end.writeUInt32LE(centralStart >= MAX32 ? 0xffffffff : Number(centralStart), 16);
    await out.write(end);
    await handle.truncate(Number(out.position));
    // FlushFileBuffers on Windows: the archive's data and the file's new length are on the
    // device when this returns.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface ArchiveListing {
  /** path → sha256 of the stored bytes ("" for directories, named with a trailing `/`). */
  entries: Map<string, string>;
  /** The bytes of the entries named in `keep` (each at most 64 KiB). */
  texts: Map<string, Buffer>;
}

const KEPT_LIMIT = 1 << 16;

/**
 * Read an archive this module wrote and hash every entry's bytes, checking each CRC; throws if
 * it is malformed. With `only`, just those entries are read and listed, so a small record can be
 * found without reading a whole store's backup.
 */
export async function readArchive(
  path: string,
  options: { keep?: readonly string[]; only?: readonly string[] } = {},
): Promise<ArchiveListing> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const read = async (position: bigint | number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
      if (bytesRead !== length) throw new Error("truncated archive");
      return buffer;
    };
    if (size < 22) throw new Error("not an archive");
    const end = await read(size - 22, 22);
    if (end.readUInt32LE(0) !== 0x06054b50) throw new Error("archive has no end record");
    let count = BigInt(end.readUInt16LE(10));
    let centralSize = BigInt(end.readUInt32LE(12));
    let centralStart = BigInt(end.readUInt32LE(16));
    if (count === 0xffffn || centralSize === MAX32 || centralStart === MAX32) {
      const locator = await read(size - 42, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error("archive has no ZIP64 locator");
      const record = await read(locator.readBigUInt64LE(8), 56);
      if (record.readUInt32LE(0) !== 0x06064b50) throw new Error("archive has no ZIP64 end record");
      count = record.readBigUInt64LE(32);
      centralSize = record.readBigUInt64LE(40);
      centralStart = record.readBigUInt64LE(48);
    }
    const central = await read(centralStart, Number(centralSize));
    const entries = new Map<string, string>();
    const texts = new Map<string, Buffer>();
    const keep = new Set(options.keep ?? []);
    const only = options.only ? new Set(options.only) : undefined;
    let at = 0;
    for (let i = 0n; i < count; i++) {
      if (central.readUInt32LE(at) !== 0x02014b50) throw new Error("archive central directory is damaged");
      const crc = central.readUInt32LE(at + 16);
      let size = BigInt(central.readUInt32LE(at + 24));
      const nameLength = central.readUInt16LE(at + 28);
      const extraLength = central.readUInt16LE(at + 30);
      const commentLength = central.readUInt16LE(at + 32);
      let offset = BigInt(central.readUInt32LE(at + 42));
      const name = central.toString("utf8", at + 46, at + 46 + nameLength);
      const extraField = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      if (extraField.length >= 4 && extraField.readUInt16LE(0) === 0x0001) {
        let p = 4;
        if (size === MAX32) {
          size = extraField.readBigUInt64LE(p);
          p += 16; // uncompressed, then compressed
        }
        if (offset === MAX32) offset = extraField.readBigUInt64LE(p);
      }
      at += 46 + nameLength + extraLength + commentLength;
      if (only && !only.has(name)) continue;
      const kept: Buffer[] | undefined = keep.has(name) && size <= BigInt(KEPT_LIMIT) ? [] : undefined;
      const local = await read(offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`archive entry ${name} is damaged`);
      if (local.readUInt16LE(8) !== 0) throw new Error(`archive entry ${name} is compressed`);
      let position = offset + 30n + BigInt(local.readUInt16LE(26)) + BigInt(local.readUInt16LE(28));
      const hash = createHash("sha256");
      let check = 0;
      const buffer = Buffer.allocUnsafe(1 << 16);
      for (let left = size; left > 0n;) {
        const length = Number(left < BigInt(buffer.length) ? left : BigInt(buffer.length));
        const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
        if (bytesRead !== length) throw new Error(`archive entry ${name} is truncated`);
        const chunk = buffer.subarray(0, length);
        hash.update(chunk);
        kept?.push(Buffer.from(chunk));
        check = crc32(chunk, check);
        position += BigInt(length);
        left -= BigInt(length);
      }
      if (check >>> 0 !== crc >>> 0) throw new Error(`archive entry ${name} fails its checksum`);
      entries.set(name, name.endsWith("/") ? "" : hash.digest("hex"));
      if (kept) texts.set(name, Buffer.concat(kept));
    }
    return { entries, texts };
  } finally {
    await handle.close();
  }
}
