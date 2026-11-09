/** Verify the signing spike's build tarball completely, then unpack it into packages/<pkg>/dist only. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Parsed here rather than by piping `tar -t` into grep: a listing consumed by an early-exit
// filter under pipefail can fail open, and tar's own extraction follows its own rules about
// links and paths. Every entry is read and judged before a single byte is written.

const BLOCK = 512;
const ALLOWED = /^packages\/[a-z0-9][a-z0-9-]*\/dist(\/[^/]+)*\/?$/;

const field = (header, offset, length) => {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
};

function octal(header, offset, length, what) {
  if (header[offset] & 0x80) throw new Error(`${what}: base-256 numeric fields are not accepted`);
  const text = field(header, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`${what}: malformed numeric field`);
  return Number.parseInt(text, 8);
}

function checksumOk(header) {
  const stored = octal(header, 148, 8, "header checksum");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum === stored;
}

function paxPath(data) {
  let path;
  let rest = data.toString("utf8");
  while (rest.length) {
    const space = rest.indexOf(" ");
    const length = Number.parseInt(rest.slice(0, space), 10);
    if (!(space > 0 && length > space)) throw new Error("malformed pax header");
    const record = rest.slice(space + 1, length - 1);
    const eq = record.indexOf("=");
    const key = record.slice(0, eq);
    if (key === "path") path = record.slice(eq + 1);
    else if (key === "linkpath") throw new Error("pax linkpath is not accepted");
    rest = rest.slice(length);
  }
  return path;
}

/** Every entry of a tar archive, or an error naming the first one that is not acceptable. */
export function readEntries(archive) {
  const entries = [];
  let offset = 0;
  let longName;
  let paxName;
  for (;;) {
    if (offset + BLOCK > archive.length) throw new Error("archive ends without its end-of-archive blocks");
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new Error(`bad header checksum at byte ${offset}`);
    const type = String.fromCharCode(header[156] || 0x30);
    const size = octal(header, 124, 12, "entry size");
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error(`entry at byte ${offset} runs past the end of the archive`);
    const data = archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      paxName = paxPath(data);
      continue;
    }
    const magic = field(header, 257, 6);
    const prefix = magic.startsWith("ustar") && magic !== "ustar " ? field(header, 345, 155) : "";
    const name = paxName ?? longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = paxName = undefined;
    if (type !== "0" && type !== "5")
      throw new Error(`${JSON.stringify(name)}: entry type ${JSON.stringify(type)} is not a file or directory`);
    if (type === "5" && size !== 0) throw new Error(`${JSON.stringify(name)}: directory with data`);
    entries.push({ name, directory: type === "5", data });
  }
  if (longName !== undefined || paxName !== undefined) throw new Error("dangling long-name header");
  return entries;
}

/** The canonical destination for one entry, or an error if it is not under packages/<pkg>/dist. */
export function destinationFor(root, name) {
  const segments = name.replace(/\/$/, "").split("/");
  if (
    !ALLOWED.test(name) ||
    name.includes("\\") ||
    name.includes(":") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new Error(`${JSON.stringify(name)} is not a path under packages/<package>/dist`);
  const base = resolve(root);
  const target = resolve(base, ...segments);
  const rel = relative(base, target);
  if (
    isAbsolute(rel) ||
    rel.startsWith("..") ||
    rel.split(sep).slice(0, 3).join("/") !== segments.slice(0, 3).join("/")
  )
    throw new Error(`${JSON.stringify(name)} does not resolve inside its package's dist`);
  return target;
}

function refuseLinkedParents(root, target) {
  const base = resolve(root);
  let current = base;
  for (const segment of relative(base, dirname(target)).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${current} is not a plain directory`);
  }
}

/** Check digest and every entry first; write nothing unless the whole archive is acceptable. */
export function verifyAndExtract(archivePath, expectedSha256, root) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")) throw new Error("A 64-character lowercase SHA-256 is required");
  const archive = readFileSync(archivePath);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expectedSha256) throw new Error(`bundle sha256 ${actual} does not match ${expectedSha256}`);
  const entries = readEntries(archive);
  if (!entries.length) throw new Error("bundle is empty");
  const seen = new Set();
  const planned = entries.map((entry) => {
    const target = destinationFor(root, entry.name);
    const key = target.toLowerCase(); // Windows paths are case-insensitive.
    if (seen.has(key)) throw new Error(`${JSON.stringify(entry.name)} appears more than once`);
    seen.add(key);
    return { ...entry, target };
  });
  for (const { target, directory } of planned) {
    refuseLinkedParents(root, target);
    let exists = false;
    try {
      exists = Boolean(lstatSync(target));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (exists && !(directory && lstatSync(target).isDirectory()))
      throw new Error(`${target} already exists; the bundle only fills empty dist directories`);
  }
  for (const { target, directory, data } of planned) {
    if (directory) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      refuseLinkedParents(root, target);
      writeFileSync(target, data, { flag: "wx" });
    }
  }
  return planned.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { bundle: { type: "string" }, sha256: { type: "string" }, root: { type: "string" } },
  });
  if (!values.bundle || !values.root) throw new Error("--bundle and --root are required");
  const count = verifyAndExtract(values.bundle, values.sha256, values.root);
  console.log(`unpacked ${count} verified entries under packages/*/dist`);
}
