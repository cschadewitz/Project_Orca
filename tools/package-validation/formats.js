/**
 * Bounded, read-only parsers for the Windows/Linux release artifacts (#772).
 *
 * Nothing here extracts to disk, executes, installs or contacts a network. Every reader
 * works on bytes already in memory, refuses what it does not understand rather than
 * guessing, and reports names exactly as stored so the caller can check containment.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { crc32, gunzipSync, inflateRawSync } from "node:zlib";

/** Uncompressed-size ceiling for one artifact or one member: a packaged Electron tree fits. */
export const MAX_EXPANDED_BYTES = 1536 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_ASAR_HEADER = 64 * 1024 * 1024;

export class ValidationError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export const fail = (code, detail) => {
  throw new ValidationError(code, detail);
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha512Base64 = (bytes) => createHash("sha512").update(bytes).digest("base64");

/**
 * A member path that stays inside the archive root: relative, no `..`, no backslash, no
 * empty or `.` segment, no drive letter. Directory entries may end in one `/`.
 */
export function containedPath(name) {
  if (typeof name !== "string" || !name || name.length > 4096 || name.includes("\0")) return false;
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || /^[A-Za-z]:/.test(trimmed)) return false;
  return trimmed.split("/").every((part) => part && part !== "." && part !== "..");
}

/** Tar/ZIP links are member-relative; ASAR links are root-relative. Ancestors need a separate check. */
export function containedLink(member, target, { rootRelative = false } = {}) {
  if (
    !containedPath(member) ||
    typeof target !== "string" ||
    !target ||
    target.length > 4096 ||
    target.includes("\0") ||
    target.startsWith("/") ||
    target.includes("\\") ||
    target.split("/").some((part) => /^[A-Za-z]:/.test(part))
  )
    return false;
  const resolved = posix.normalize(posix.join(rootRelative ? "." : posix.dirname(member), target));
  return resolved !== ".." && !resolved.startsWith("../") && !posix.isAbsolute(resolved);
}

function cString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

// Header name fields must be valid UTF-8, like PAX values and GNU long names: a lossy
// decode would report a name that is not the one stored, and could make two names equal.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function nameField(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  try {
    return strictUtf8.decode(slice.subarray(0, end === -1 ? slice.length : end));
  } catch {
    return fail("tar_header_invalid", "name field is not UTF-8");
  }
}

function octal(block, start, length) {
  const text = cString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) fail("tar_header_invalid", "non-octal numeric field");
  return text ? Number.parseInt(text, 8) : 0;
}

/**
 * The tar/PAX subset this reader accepts. Anything outside it is refused with a named code,
 * never ignored. The contract and its support matrix are in
 * docs/preparation/windows-linux-release-artifacts/README.md ("Tar/PAX contract").
 */
// Per-member PAX keys that are honored. Every other key (`size`, `GNU.sparse.*`, `mtime`,
// `hdrcharset`, vendor keys...) is refused rather than silently dropped.
const PAX_KEYS = new Set(["path", "linkpath"]);
const MAX_PAX_BYTES = 64 * 1024;
const MAX_LONG_NAME_BYTES = 4096 + 1;
const POSIX_MAGIC = Buffer.from("ustar\x0000", "latin1");
const GNU_MAGIC = Buffer.from("ustar  \x00", "latin1");
const MEMBER_KINDS = { 0: "file", 5: "directory", 2: "symlink", 1: "hardlink" };

/** Strict PAX extended-header framing: `<decimal length> <key>=<value>\n`, exactly. */
function paxRecords(bytes) {
  if (bytes.length > MAX_PAX_BYTES) fail("tar_pax_invalid", "extended header too large");
  const records = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const digits = space === -1 ? "" : bytes.subarray(offset, space).toString("latin1");
    if (!/^[1-9][0-9]{0,5}$/.test(digits)) fail("tar_pax_invalid", "record length");
    const length = Number(digits);
    const end = offset + length;
    if (end > bytes.length || space + 1 >= end - 1 || bytes[end - 1] !== 0x0a)
      fail("tar_pax_invalid", "record framing");
    const raw = bytes.subarray(space + 1, end - 1);
    const record = raw.toString("utf8");
    if (!Buffer.from(record, "utf8").equals(raw) || record.includes("\0") || record.includes("\n"))
      fail("tar_pax_invalid", "record encoding");
    const equals = record.indexOf("=");
    if (equals <= 0) fail("tar_pax_invalid", "record key");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (!PAX_KEYS.has(key)) fail("tar_pax_key_unsupported", JSON.stringify(key));
    if (key in records) fail("tar_pax_invalid", `duplicate ${key}`);
    // An empty value means "delete the default" in POSIX; nothing here has a default to delete.
    if (!value) fail("tar_pax_invalid", `empty ${key}`);
    records[key] = value;
    offset = end;
  }
  if (!Object.keys(records).length) fail("tar_pax_invalid", "empty extended header");
  return records;
}

/** A GNU `L`/`K` body: the name followed by exactly one terminating NUL. */
function gnuLongValue(body, type) {
  if (
    body.length < 2 ||
    body.length > MAX_LONG_NAME_BYTES ||
    body[body.length - 1] !== 0 ||
    body.indexOf(0) !== body.length - 1
  )
    fail("tar_gnu_long_invalid", type);
  const value = body.subarray(0, body.length - 1).toString("utf8");
  if (!Buffer.from(value, "utf8").equals(body.subarray(0, body.length - 1))) fail("tar_gnu_long_invalid", type);
  return value;
}

/**
 * The members of a gzip-compressed tar, in order, within the contract above. File bodies
 * are views into the decompressed buffer.
 */
export function readTarGz(compressed) {
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    fail("tar_gzip_invalid");
  }
  const members = [];
  let offset = 0;
  // Extended headers waiting for the member they describe; at most one of each.
  let pending = {};
  let ended = false;
  // Effective member names read so far, to their kinds: the hardlink-target index.
  const earlier = new Map();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== octal(header, 148, 8)) fail("tar_header_invalid", "checksum mismatch");
    const magic = header.subarray(257, 265);
    const format = magic.equals(POSIX_MAGIC) ? "posix" : magic.equals(GNU_MAGIC) ? "gnu" : undefined;
    if (!format) fail("tar_header_unsupported", "neither POSIX ustar nor GNU magic");
    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header, 124, 12);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > tar.length) fail("tar_truncated");
    const body = tar.subarray(bodyStart, bodyEnd);
    offset = bodyStart + Math.ceil(size / 512) * 512;
    if (offset > tar.length) fail("tar_truncated");
    // Global PAX changes the meaning of every later member, even when it looks benign.
    if (type === "g") fail("tar_global_pax_unsupported");
    if (type === "x" || type === "L" || type === "K") {
      // PAX headers belong to POSIX ustar members, GNU long names to GNU members. A mixed
      // archive would need a precedence rule between them; this reader has none, so it refuses.
      if ((type === "x") !== (format === "posix")) fail("tar_extended_header_mixed", type);
      if (type in pending) fail("tar_extended_header_repeated", type);
      pending[type] = type === "x" ? paxRecords(body) : gnuLongValue(body, type);
      continue;
    }
    const kind = MEMBER_KINDS[type];
    if (!kind) fail("tar_member_unsupported", `type ${JSON.stringify(type)}`);
    if (pending.x && format !== "posix") fail("tar_extended_header_mixed", "x before a GNU member");
    if ((pending.L !== undefined || pending.K !== undefined) && format !== "gnu")
      fail("tar_extended_header_mixed", "GNU long name before a POSIX member");
    // The ustar prefix (345-499) exists only in POSIX headers; in GNU headers those bytes
    // are atime/ctime/offset fields and are never part of the name.
    const prefix = format === "posix" ? nameField(header, 345, 155) : "";
    const stored = nameField(header, 0, 100);
    const rawName = prefix ? `${prefix}/${stored}` : stored;
    const rawLink = nameField(header, 157, 100);
    const name = pending.x?.path ?? pending.L ?? rawName;
    const isLink = kind === "symlink" || kind === "hardlink";
    if (!isLink && (pending.x?.linkpath !== undefined || pending.K !== undefined))
      fail("tar_extended_header_invalid", `link target on a ${kind}`);
    if (!isLink && rawLink) fail("tar_header_invalid", `link target on a ${kind}`);
    if (kind !== "file" && size !== 0) fail("tar_header_invalid", `${kind} with a body`);
    // GNU tar extracts a regular file named `x/` as a directory, Python's tarfile as a file.
    if (kind !== "directory" && name.endsWith("/")) fail("tar_header_invalid", `${kind} name ends in /`);
    const linkName = pending.x?.linkpath ?? pending.K ?? rawLink;
    // A reader that ignores the extended header sees the ustar fields instead, so a shadowed
    // name or link target must be as safe as the effective one. Writers put a truncated
    // copy of the long value there, which passes.
    if ((pending.x?.path !== undefined || pending.L !== undefined) && !containedPath(rawName))
      fail("tar_shadowed_field_unsafe", `name ${JSON.stringify(rawName)}`);
    if (
      (pending.x?.linkpath !== undefined || pending.K !== undefined) &&
      !(kind === "hardlink" ? containedPath(rawLink) : containedLink(name, rawLink))
    )
      fail("tar_shadowed_field_unsafe", `link target ${JSON.stringify(rawLink)}`);
    // A hardlink must name an earlier regular-file member: never a directory, itself, a
    // later member or a file outside the archive (which extraction could otherwise link).
    if (kind === "hardlink" && earlier.get(linkName) !== "file") fail("tar_hardlink_invalid", `${name} -> ${linkName}`);
    pending = {};
    if (members.length >= MAX_ENTRIES) fail("tar_too_many_entries");
    earlier.set(name, kind);
    members.push({
      name,
      kind,
      mode: octal(header, 100, 8),
      size,
      linkName: isLink ? linkName : undefined,
      body,
    });
  }
  if (Object.keys(pending).length) fail("tar_extended_header_dangling", Object.keys(pending).join(""));
  // End of archive: two zero blocks, then nothing but zero padding to the end of the stream.
  if (!ended || offset + 1024 > tar.length) fail("tar_end_invalid", "missing end-of-archive blocks");
  if (tar.length % 512 !== 0 || !tar.subarray(offset).every((byte) => byte === 0))
    fail("tar_end_invalid", "data after the end-of-archive marker");
  if (!members.length) fail("tar_empty");
  return members;
}

/** Only inert timestamp/owner ZIP extensions are supported; alternate filenames are not. */
function checkZipExtra(extra, name) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) fail("zip_extra_invalid", name);
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    if (offset + 4 + size > extra.length) fail("zip_extra_invalid", name);
    // Extended timestamps, NTFS timestamps, Unix uid/gid. In particular 0x7075
    // (Unicode path) and ZIP64 must not silently override the fields we inspect.
    if (![0x5455, 0x000a, 0x7875].includes(id)) fail("zip_extra_unsupported", `0x${id.toString(16)} at ${name}`);
    offset += 4 + size;
  }
}

/** Stored and deflated entries of a classic (non-Zip64, unencrypted) ZIP, CRC-checked. */
export function readZip(bytes) {
  const floor = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) fail("zip_directory_missing");
  const count = bytes.readUInt16LE(eocd + 10);
  const diskCount = bytes.readUInt16LE(eocd + 8);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  const directoryEnd = directoryOffset + directorySize;
  if (count === 0xffff || diskCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff)
    fail("zip64_unsupported");
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) fail("zip_multidisk_unsupported");
  if (diskCount !== count || directoryEnd !== eocd) fail("zip_directory_invalid");
  if (count > MAX_ENTRIES) fail("zip_too_many_entries");
  const entries = [];
  let offset = directoryOffset;
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) fail("zip_directory_invalid");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const madeBy = bytes.readUInt16LE(offset + 4) >> 8;
    const external = bytes.readUInt32LE(offset + 38);
    const local = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > directoryEnd) fail("zip_directory_invalid");
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString("utf8");
    checkZipExtra(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength), name);
    offset += 46 + nameLength + extraLength + commentLength;
    if ([compressedSize, size, local].includes(0xffffffff)) fail("zip64_unsupported");
    if (flags & 0x1) fail("zip_encrypted_unsupported", name);
    if (method !== 0 && method !== 8) fail("zip_method_unsupported", `${method} at ${JSON.stringify(name)}`);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) fail("zip_local_header_invalid", name);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (
      dataStart > directoryOffset ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes) ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      fail("zip_local_header_mismatch", name);
    checkZipExtra(bytes.subarray(local + 30 + localNameLength, dataStart), name);
    if (dataStart + compressedSize > directoryOffset) fail("zip_truncated", name);
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) fail("zip_too_large");
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    let body;
    try {
      body = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    } catch {
      fail("zip_inflate_failed", name);
    }
    if (body.length !== size || crc32(body) >>> 0 !== crc) fail("zip_crc_mismatch", name);
    // Unix symlinks are recorded in the high mode bits when the creator is Unix (3).
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    const kind = name.endsWith("/") ? "directory" : (unixMode & 0o170000) === 0o120000 ? "symlink" : "file";
    entries.push({ name, kind, size, linkName: kind === "symlink" ? body.toString("utf8") : undefined, body });
  }
  if (offset !== directoryEnd) fail("zip_directory_invalid", "record count does not consume the directory");
  return entries;
}

/**
 * The header of an Electron ASAR archive and a reader over its packed bodies. Unpacked
 * entries (`app.asar.unpacked`) are refused: the producer emits none, and an `unpacked` flag
 * would otherwise take a file out of integrity coverage with nothing checking the other side.
 */
export function readAsar(bytes) {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) fail("asar_header_invalid");
  const headerSize = bytes.readUInt32LE(4);
  if (headerSize < 8 || headerSize > MAX_ASAR_HEADER || 8 + headerSize > bytes.length) fail("asar_header_invalid");
  const payload = bytes.readUInt32LE(8);
  const length = bytes.readUInt32LE(12);
  if (payload + 4 > headerSize || length + 4 > payload) fail("asar_header_invalid");
  let header;
  try {
    header = JSON.parse(bytes.subarray(16, 16 + length).toString("utf8"));
  } catch {
    fail("asar_header_invalid", "header is not JSON");
  }
  const base = 8 + headerSize;
  const files = new Map();
  const walk = (node, prefix, depth) => {
    if (depth > 64 || !node || typeof node.files !== "object" || node.files === null) fail("asar_header_invalid");
    for (const [segment, child] of Object.entries(node.files)) {
      if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))
        fail("asar_entry_name_invalid", JSON.stringify(segment));
      const path = prefix ? `${prefix}/${segment}` : segment;
      if (files.size >= MAX_ENTRIES) fail("asar_too_many_entries");
      if (child && typeof child === "object" && Object.hasOwn(child, "unpacked"))
        fail("asar_unpacked_unsupported", path);
      if (child && typeof child.files === "object") {
        files.set(path, { kind: "directory" });
        walk(child, path, depth + 1);
      } else if (child && typeof child.link === "string") {
        if (!containedLink(path, child.link, { rootRelative: true })) fail("asar_link_escapes", path);
        files.set(path, { kind: "symlink", link: child.link });
      } else if (child && Number.isSafeInteger(child.size) && child.size >= 0) {
        // A plain decimal string, as @electron/asar writes it: no hex, sign, exponent or spaces.
        if (typeof child.offset !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(child.offset))
          fail("asar_offset_invalid", path);
        const offset = Number(child.offset);
        if (!Number.isSafeInteger(offset)) fail("asar_offset_invalid", path);
        if (base + offset + child.size > bytes.length) fail("asar_truncated", path);
        files.set(path, {
          kind: "file",
          size: child.size,
          offset,
          integrity: child.integrity,
          executable: !!child.executable,
        });
      } else fail("asar_header_invalid", path);
    }
  };
  walk(header, "", 0);
  const read = (path) => {
    const entry = files.get(path);
    if (!entry || entry.kind !== "file") return undefined;
    return bytes.subarray(base + entry.offset, base + entry.offset + entry.size);
  };
  return { files, read, headerSha256: sha256(bytes.subarray(16, 16 + length)) };
}

/**
 * ASAR per-file integrity: whole-file and per-block SHA-256. Every file (all are packed;
 * see `readAsar`) must carry a complete record; a missing or partial record is refused, not
 * skipped. Returns the number of files checked, which is then every file.
 */
export function checkAsarIntegrity(asar) {
  let checked = 0;
  for (const [path, entry] of asar.files) {
    if (entry.kind !== "file") continue;
    if (!entry.integrity) fail("asar_integrity_missing", path);
    const { algorithm, hash, blockSize, blocks } = entry.integrity;
    if (
      algorithm !== "SHA256" ||
      typeof hash !== "string" ||
      !Number.isSafeInteger(blockSize) ||
      blockSize <= 0 ||
      !Array.isArray(blocks)
    )
      fail("asar_integrity_invalid", path);
    const body = asar.read(path);
    if (hash !== sha256(body)) fail("asar_integrity_mismatch", path);
    // @electron/asar 3.4.1 (`getFileIntegrity`) hashes each full block, then always one final
    // block in `flush`: floor(len / blockSize) + 1 blocks, the last empty at exact multiples.
    const expected = Math.floor(body.length / blockSize) + 1;
    if (blocks.length !== expected) fail("asar_integrity_mismatch", path);
    for (let i = 0; i < blocks.length; i++)
      if (blocks[i] !== sha256(body.subarray(i * blockSize, (i + 1) * blockSize)))
        fail("asar_integrity_mismatch", path);
    checked++;
  }
  return checked;
}

const PE_MACHINES = { 0x14c: "x86", 0x8664: "x64", 0xaa64: "arm64" };

/**
 * PE identity: machine, image kind and the Authenticode certificate-table directory. A
 * present directory only means bytes are embedded; this never verifies a signature.
 */
export function readPe(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) fail("pe_invalid", "no MZ header");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) fail("pe_invalid", "no PE header");
  const machineCode = bytes.readUInt16LE(pe + 4);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const characteristics = bytes.readUInt16LE(pe + 22);
  const optional = pe + 24;
  if (optional + optionalSize > bytes.length || optionalSize < 2) fail("pe_invalid", "optional header truncated");
  const magic = bytes.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) fail("pe_invalid", "unknown optional header");
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const countAt = optional + (magic === 0x20b ? 108 : 92);
  const count = countAt + 4 <= optional + optionalSize ? bytes.readUInt32LE(countAt) : 0;
  let certificate = { present: false };
  if (count > 4 && directories + 5 * 8 <= optional + optionalSize) {
    const offset = bytes.readUInt32LE(directories + 4 * 8);
    const size = bytes.readUInt32LE(directories + 4 * 8 + 4);
    if (size) {
      if (offset + size > bytes.length || offset < optional) fail("pe_certificate_table_invalid");
      certificate = { present: true, offset, size };
    }
  }
  return {
    machine: PE_MACHINES[machineCode] ?? `0x${machineCode.toString(16)}`,
    pe32Plus: magic === 0x20b,
    dll: (characteristics & 0x2000) !== 0,
    certificate,
  };
}

const ELF_MACHINES = { 0x3e: "x64", 0xb7: "arm64" };

export function readElf(bytes) {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) fail("elf_invalid");
  if (bytes[4] !== 2 || bytes[5] !== 1) fail("elf_invalid", "not 64-bit little-endian");
  const code = bytes.readUInt16LE(18);
  return { machine: ELF_MACHINES[code] ?? `0x${code.toString(16)}` };
}

/**
 * The fields of an electron-builder `latest-ARCH.yml` that the updater acts on. Only the
 * flat shape electron-builder 26 writes is accepted; anything else is refused, not guessed.
 */
export function readUpdateMetadata(text) {
  if (typeof text !== "string" || text.length > 64 * 1024 || text.includes("\r")) fail("update_metadata_invalid");
  const unquote = (raw) => {
    if (typeof raw !== "string" || !raw || raw !== raw.trim()) fail("update_metadata_invalid", "scalar");
    const quoted = /^(['"])(.*)\1$/.exec(raw);
    const value = quoted ? quoted[2] : raw;
    // A token, optionally enclosed in matching simple quotes. No YAML collections,
    // tags, aliases, comments, escapes or multiline scalars.
    if (!/^[A-Za-z0-9_./:+-]+={0,2}$/.test(value) || (!quoted && (value === "-" || value.endsWith(":"))))
      fail("update_metadata_invalid", "unsupported scalar");
    return value;
  };
  const top = (key) => {
    const matches = [...text.matchAll(new RegExp(`^${key}: (.+)$`, "gm"))];
    if (matches.length !== 1) fail("update_metadata_invalid", `${key} must appear once`);
    return unquote(matches[0][1]);
  };
  // `files:` is a list of flat maps: `  - url: …` then `    key: …`, ending at the next
  // unindented key. Each entry is parsed from its own lines only.
  const files = [];
  const keys = new Set();
  let current;
  let inFiles = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      // This is a flat, deliberately limited YAML subset. Refuse quoted/flow/merge
      // keys or unknown structure rather than disagree with the updater's parser.
      const key = /^(version|path|sha512|files|releaseDate):(?: |$)/.exec(line)?.[1];
      if (!key) fail("update_metadata_invalid", "unsupported top-level mapping");
      if (keys.has(key)) fail("update_metadata_invalid", `${key} must appear once (duplicate ${key})`);
      keys.add(key);
      inFiles = key === "files";
      if (inFiles && line !== "files:") fail("update_metadata_invalid", "files must be a block list");
      if (!inFiles) {
        const value = unquote(line.slice(key.length + 2));
        if (
          key === "releaseDate" &&
          (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString() !== value)
        )
          fail("update_metadata_invalid", "releaseDate must be a canonical UTC timestamp");
      }
      current = undefined;
      continue;
    }
    if (!inFiles) {
      if (line.trim()) fail("update_metadata_invalid", "unexpected indented line");
      continue;
    }
    const start = /^ {2}- (\w+): (.*)$/.exec(line);
    const more = /^ {4}(\w+): (.*)$/.exec(line);
    const field = start ?? more;
    if (field && !["url", "sha512", "size", "blockMapSize"].includes(field[1]))
      fail("update_metadata_invalid", `unsupported files[] field ${field[1]}`);
    if (start) files.push((current = { [start[1]]: unquote(start[2]) }));
    else if (more && current) {
      if (more[1] in current) fail("update_metadata_invalid", `duplicate ${more[1]}`);
      current[more[1]] = unquote(more[2]);
    } else if (line.trim()) fail("update_metadata_invalid", "unexpected files[] line");
  }
  if (!keys.has("files")) fail("update_metadata_invalid", "files must appear once");
  for (const file of files) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(file.size ?? "")) fail("update_metadata_invalid", "files[] entry");
    file.size = Number(file.size);
    if (!file.url || !file.sha512 || !Number.isSafeInteger(file.size)) fail("update_metadata_invalid", "files[] entry");
    if (
      file.blockMapSize !== undefined &&
      (!/^(?:0|[1-9][0-9]*)$/.test(file.blockMapSize) || !Number.isSafeInteger(Number(file.blockMapSize)))
    )
      fail("update_metadata_invalid", "blockMapSize must be a safe unsigned integer");
  }
  return {
    version: top("version"),
    path: top("path"),
    sha512: top("sha512"),
    files: files.map(({ url, sha512, size }) => ({ url, sha512, size })),
  };
}

/** An electron-builder blockmap: gzip JSON whose chunk sizes must cover the whole file. */
export function readBlockmap(compressed) {
  let map;
  try {
    map = JSON.parse(gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
  } catch {
    fail("blockmap_invalid");
  }
  if (!map || !Array.isArray(map.files) || map.files.length !== 1) fail("blockmap_invalid");
  const [file] = map.files;
  if (!Array.isArray(file.sizes) || !Array.isArray(file.checksums) || file.sizes.length !== file.checksums.length)
    fail("blockmap_invalid");
  if (file.offset !== 0 || !file.sizes.every((n) => Number.isSafeInteger(n) && n > 0)) fail("blockmap_invalid");
  return { version: map.version, chunks: file.sizes.length, coveredBytes: file.sizes.reduce((a, b) => a + b, 0) };
}
