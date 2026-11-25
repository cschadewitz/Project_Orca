/**
 * Benign synthetic stand-ins for release artifacts (#772). Every executable here is a
 * header-only byte pattern that cannot run; every archive is built in memory from
 * placeholder bytes. Nothing is downloaded, signed, installed or launched.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync, gzipSync } from "node:zlib";
import { nativePackageManifest } from "../../../packages/app/scripts/diagnostics-native-package.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (value) => Buffer.from(value, "utf8");

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";
export const FONTS = {
  "Synthetic-Regular.woff2": text("wOF2 synthetic regular"),
  "Synthetic-Bold.woff2": text("wOF2 synthetic bold"),
};
const WINDOWS_NATIVE_SOURCES = [
  "binding.gyp",
  "clock.c",
  "storage-windows.c",
  "storage-windows-common.h",
  "first-run-windows.c",
  "keys-windows.c",
  "windows-delay-load.c",
];

const html = (csp = CSP, extra = "") =>
  `<!doctype html>\n<html lang="en">\n  <head>\n    <meta\n      http-equiv="Content-Security-Policy"\n      content="${csp}"\n    />\n${extra}    <script type="module" src="./assets/index.js"></script>\n  </head>\n  <body class="orca"><div id="root"></div></body>\n</html>\n`;

/** A git checkout shaped like the parts of the repository the inspector compares against. */
export function makeSource(version) {
  const root = mkdtempSync(join(tmpdir(), "orca-package-validation-source-"));
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  write("package.json", JSON.stringify({ name: "synthetic-root", version }) + "\n");
  write(
    "packages/app/package.json",
    JSON.stringify({
      name: "@orca/app",
      version: "0.1.0",
      main: "./dist/main/index.js",
      dependencies: { "dep-a": "^1.0.0" },
    }) + "\n",
  );
  write("packages/app/renderer/index.html", html());
  write("packages/agents/src/bin/claude-pre-tool-hook.ts", "// synthetic hook entry\n");
  write(
    "packages/app/scripts/build-daemon.js",
    'await build({ entryPoints: [fileURLToPath(new URL("../../agents/dist/bin/claude-pre-tool-hook.js", import.meta.url))] });\n',
  );
  for (const [name, body] of Object.entries(FONTS)) write(`packages/design/fonts/${name}`, body);
  for (const name of WINDOWS_NATIVE_SOURCES)
    write(`packages/app/native/diagnostics/${name}`, `/* synthetic ${name} */\n`);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", ...args],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "synthetic source");
  return { root, commit: git("rev-parse", "HEAD").trim(), write };
}

const ASAR_BLOCK = 4 * 1024 * 1024;

/**
 * Per-file integrity as @electron/asar 3.4.1 `getFileIntegrity` writes it: a hash per full
 * 4 MiB block, then always one final block, so a file of exactly N blocks records N + 1.
 */
export function asarIntegrity(body) {
  const blocks = [];
  let start = 0;
  for (; start + ASAR_BLOCK <= body.length; start += ASAR_BLOCK)
    blocks.push(sha256(body.subarray(start, start + ASAR_BLOCK)));
  blocks.push(sha256(body.subarray(start)));
  return { algorithm: "SHA256", hash: sha256(body), blockSize: ASAR_BLOCK, blocks };
}

/**
 * An ASAR archive with per-file SHA-256 integrity, in electron's header-pickle layout.
 * `edit(tree)` may change the header JSON just before it is written.
 */
export function makeAsar(files, { tamper, integrity = {}, edit } = {}) {
  const tree = { files: {} };
  const bodies = [];
  let offset = 0;
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split("/");
    let node = tree;
    for (const part of parts.slice(0, -1)) node = node.files[part] ??= { files: {} };
    const last = parts.at(-1);
    if (value && typeof value === "object" && "link" in value) {
      node.files[last] = { link: value.link };
      continue;
    }
    if (value && typeof value === "object" && "unpacked" in value) {
      node.files[last] = { size: value.size ?? 0, unpacked: value.unpacked };
      continue;
    }
    const body = Buffer.from(value);
    node.files[last] = {
      size: body.length,
      offset: String(offset),
      integrity: asarIntegrity(body),
    };
    // Test hook: `integrity: { [path]: null | {...} }` drops or replaces a file's record.
    if (path in integrity) {
      if (integrity[path] === null) delete node.files[last].integrity;
      else node.files[last].integrity = integrity[path];
    }
    bodies.push(body);
    offset += body.length;
  }
  edit?.(tree);
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  const asar = Buffer.concat([header, ...bodies]);
  if (tamper) asar[asar.length - 1] ^= 0xff;
  return asar;
}

/** A header-only PE image: enough structure to parse, nothing that can execute. */
export function makePe(machine, { dll = false, certificate = false } = {}) {
  const machines = { x86: 0x14c, x64: 0x8664, arm64: 0xaa64 };
  const pe = 0x40;
  const optional = pe + 24;
  const optionalSize = 240;
  const end = optional + optionalSize + 40;
  const bytes = Buffer.alloc(end + (certificate ? 64 : 64));
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(machines[machine], pe + 4);
  bytes.writeUInt16LE(1, pe + 6);
  bytes.writeUInt16LE(optionalSize, pe + 20);
  bytes.writeUInt16LE(0x0022 | (dll ? 0x2000 : 0), pe + 22);
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(16, optional + 108);
  if (certificate) {
    bytes.writeUInt32LE(end, optional + 112 + 4 * 8);
    bytes.writeUInt32LE(64, optional + 112 + 4 * 8 + 4);
  }
  return bytes;
}

export function makeElf(machine) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(machine === "arm64" ? 0xb7 : 0x3e, 18);
  return bytes;
}

/** A daemon bundle stamped as build-daemon.js stamps it since #896 (`readOrcaVersion()`). */
export const daemon = (version) =>
  text(
    `// synthetic daemon\nfunction readOrcaVersion() {\n  return true ? "${version}" : createRequire(import.meta.url)("../../../package.json").version;\n}\nexport {};\n`,
  );

/** The stamp's form before #896, which older packages still carry. */
export const legacyDaemon = (version) =>
  text(`// synthetic daemon\nvar ORCA_VERSION = true ? "${version}" : fallback();\nexport {};\n`);

/** Claude's tool-call hook as build-daemon.js bundles it beside the daemon (#704). */
export const claudeHookBody = () =>
  text(
    "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\n\n// packages/agents/dist/bin/claude-pre-tool-hook.js\nexport {};\n",
  );

const TAR_MAGIC = { posix: "ustar\x0000", gnu: "ustar  \x00", v7: "\0\0\0\0\0\0\0\0" };

/** One 512-byte tar header. `format` picks the magic; `prefix` fills bytes 345-499. */
export function tarHeader(
  name,
  { type = "0", size = 0, mode = 0o644, linkName = "", format = "posix", prefix = "" } = {},
) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write(type, 156, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write(TAR_MAGIC[format], 257, "latin1");
  header.write(prefix, 345, 155, "utf8");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

const pad = (body) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);

export const paxRecord = (value) => {
  let length = Buffer.byteLength(value) + 3;
  while (Buffer.byteLength(`${length} ${value}\n`) !== length) length = Buffer.byteLength(`${length} ${value}\n`);
  return `${length} ${value}\n`;
};

/** A header plus its padded body, for hand-built tar streams. */
export function tarBlock(name, body = "", options = {}) {
  const bytes = Buffer.from(body);
  return Buffer.concat([tarHeader(name, { ...options, size: bytes.length }), pad(bytes)]);
}

/** A PAX `x` header whose body is the given records (`[key, value]` pairs or raw text). */
export const paxBlock = (records) =>
  tarBlock(
    "PaxHeader",
    typeof records === "string" ? records : records.map(([key, value]) => paxRecord(`${key}=${value}`)).join(""),
    { type: "x" },
  );

/** A GNU `L`/`K` header carrying `value` plus its terminating NUL, on GNU magic. */
export const gnuLongBlock = (type, value) => tarBlock("././@LongLink", `${value}\0`, { type, format: "gnu" });

/** Gzip hand-built blocks; `end` is what follows them (default: two zero blocks). */
export const tarGz = (blocks, { end = Buffer.alloc(1024) } = {}) => gzipSync(Buffer.concat([...blocks, end]));

/**
 * A gzip tar. Names or link targets over 99 bytes use a pax `path`/`linkpath` record, as
 * node-tar and GNU tar's posix format do.
 */
export function makeTarGz(entries, { globalPax } = {}) {
  const blocks = [];
  if (globalPax) {
    const body = Object.entries(globalPax)
      .map(([key, value]) => paxRecord(`${key}=${value}`))
      .join("");
    blocks.push(tarBlock("GlobalPaxHeader", body, { type: "g" }));
  }
  for (const entry of entries) {
    const body = entry.body ? Buffer.from(entry.body) : Buffer.alloc(0);
    const records = [];
    if (Buffer.byteLength(entry.name) > 99) records.push(["path", entry.name]);
    if (entry.linkName && Buffer.byteLength(entry.linkName) > 99) records.push(["linkpath", entry.linkName]);
    // Test hook: extra per-member PAX records, e.g. keys outside the contract.
    if (entry.pax) records.push(...entry.pax);
    if (records.length) blocks.push(paxBlock(records));
    const type = { file: "0", directory: "5", symlink: "2", hardlink: "1" }[entry.kind ?? "file"];
    blocks.push(
      tarHeader(entry.name.slice(0, 99), {
        type,
        size: body.length,
        mode: entry.mode,
        // Test hook: `rawLinkName` replaces the truncated copy in the ustar linkname field.
        linkName: entry.rawLinkName ?? (entry.linkName ?? "").slice(0, 99),
      }),
    );
    if (body.length) blocks.push(pad(body));
  }
  return tarGz(blocks);
}

/** ZIP extra fields, including a valid Info-ZIP alternate Unicode pathname. */
export function zipExtra(id, payload) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
}

export function unicodePathExtra(storedName, effectiveName) {
  const prefix = Buffer.alloc(5);
  prefix[0] = 1;
  prefix.writeUInt32LE(crc32(Buffer.from(storedName)), 1);
  return zipExtra(0x7075, Buffer.concat([prefix, Buffer.from(effectiveName)]));
}

/** A classic ZIP with deflated members, as 7-Zip writes Windows archives. */
export function makeZip(entries, { corruptCrc } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const body = Buffer.from(entry.kind === "symlink" ? entry.linkName : (entry.body ?? ""));
    const data = deflateRawSync(body);
    const crc = (crc32(body) ^ (corruptCrc === entry.name ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(3 * 256 + 20, 4);
    if (entry.kind === "symlink") record.writeUInt32LE(0o120777 * 65536, 38);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE(offset, 42);
    locals.push(local, localName, localExtra, data);
    central.push(record, name, centralExtra);
    offset += 30 + localName.length + localExtra.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The ASAR contents of a packaged app at `version`, with optional deliberate defects. */
export function appAsar(version, overrides = {}, asarOptions = {}) {
  const files = {
    "package.json": JSON.stringify({
      name: "@orca/app",
      version,
      main: "./dist/main/index.js",
      dependencies: { "dep-a": "^1.0.0" },
    }),
    "dist/main/index.js": "const webPreferences = {\n  contextIsolation: true,\n  sandbox: true,\n};\n",
    "dist/preload/index.cjs": "'use strict';\n",
    "dist/bridge.js": "export {};\n",
    "dist/renderer/index.html": html(),
    "dist/renderer/assets/index.js": "export {};\n",
    "node_modules/dep-a/package.json": JSON.stringify({ name: "dep-a", version: "1.0.0" }),
    "node_modules/dep-a/index.js": "module.exports = 1;\n",
  };
  for (const [name, body] of Object.entries(FONTS))
    files[`dist/renderer/assets/${name.replace(".woff2", "-h4sh.woff2")}`] = body;
  for (const [path, body] of Object.entries(overrides)) {
    if (body === undefined) delete files[path];
    else files[path] = body;
  }
  return makeAsar(files, asarOptions);
}

export { html as rendererHtml };

/** Windows native diagnostics resources exactly as the packaging hook stages them. */
export function windowsNative(source, arch, { addonArch = arch } = {}) {
  const staging = mkdtempSync(join(tmpdir(), "orca-package-validation-native-"));
  const names = ["diagnostics_clock.node", "diagnostics_storage.node", "first_run_windows.node"];
  for (const name of names) writeFileSync(join(staging, name), makePe(addonArch, { dll: true }));
  // Manifest computed with the real hook from the fixture's own native sources.
  const manifest = nativePackageManifest(staging, addonArch, join(source.root, "packages/app"), "win32");
  if (addonArch !== arch) manifest.arch = arch;
  const files = Object.fromEntries(names.map((name) => [name, makePe(addonArch, { dll: true })]));
  files["manifest.json"] = JSON.stringify(manifest) + "\n";
  return files;
}

/** A Linux tar.gz tree: `<top>/orca-desktop`, Electron runtime placeholders, resources. */
export function linuxArchive(
  version,
  arch,
  { asar = appAsar(version), daemonBody = daemon(version), hookBody = claudeHookBody(), extra = [], globalPax } = {},
) {
  const top = `ORCA-${version}`;
  const runtime = ["resources.pak", "icudtl.dat", "v8_context_snapshot.bin", "libffmpeg.so", "locales/en-US.pak"];
  return makeTarGz(
    [
      { name: `${top}/`, kind: "directory", mode: 0o755 },
      { name: `${top}/orca-desktop`, body: makeElf(arch), mode: 0o755 },
      { name: `${top}/chrome-sandbox`, body: makeElf(arch), mode: 0o755 },
      ...runtime.map((name) => ({ name: `${top}/${name}`, body: `placeholder ${name}` })),
      { name: `${top}/resources/app.asar`, body: asar },
      { name: `${top}/resources/daemon/orca-daemon.mjs`, body: daemonBody },
      ...(hookBody ? [{ name: `${top}/resources/daemon/claude-pre-tool-hook.mjs`, body: hookBody }] : []),
      ...extra,
    ],
    { globalPax },
  );
}

/** A Windows zip tree at the archive root, as electron-builder's win zip target lays it out. */
export function windowsArchive(
  version,
  arch,
  source,
  { asar = appAsar(version), daemonBody = daemon(version), hookBody = claudeHookBody(), native, extra = [] } = {},
) {
  const runtime = ["resources.pak", "icudtl.dat", "v8_context_snapshot.bin", "ffmpeg.dll", "locales/en-US.pak"];
  const addons = native ?? windowsNative(source, arch);
  return makeZip([
    { name: "ORCA.exe", body: makePe(arch) },
    ...runtime.map((name) => ({ name, body: `placeholder ${name}` })),
    { name: "resources/app.asar", body: asar },
    { name: "resources/app-update.yml", body: "provider: generic\nurl: https://updates.invalid/\nchannel: latest\n" },
    { name: "resources/daemon/orca-daemon.mjs", body: daemonBody },
    ...(hookBody ? [{ name: "resources/daemon/claude-pre-tool-hook.mjs", body: hookBody }] : []),
    ...Object.entries(addons).map(([name, body]) => ({
      name: `resources/native/diagnostics/win32-${arch}/${name}`,
      body,
    })),
    ...extra,
  ]);
}

export function blockmap(size, chunk = 64) {
  const sizes = [];
  for (let left = size; left > 0; left -= chunk) sizes.push(Math.min(chunk, left));
  return gzipSync(
    JSON.stringify({
      version: "2",
      files: [{ name: "file", offset: 0, checksums: sizes.map((_, i) => `c${i}`), sizes }],
    }),
  );
}

export function updateMetadata(version, arch, installer, { sha512 } = {}) {
  const digest = sha512 ?? createHash("sha512").update(installer).digest("base64");
  const name = `ORCA-${version}-win-${arch}.exe`;
  return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${digest}\n    size: ${installer.length}\npath: ${name}\nsha512: ${digest}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`;
}

export const appImage = () => Buffer.concat([makeElf("x64"), Buffer.alloc(64), Buffer.from("hsqs"), Buffer.alloc(32)]);

/** A Debian package's outer `ar` archive with placeholder control and data members. */
export function debPackage(
  members = [
    ["debian-binary", "2.0\n"],
    ["control.tar.xz", "c"],
    ["data.tar.xz", "data"],
  ],
) {
  const parts = [Buffer.from("!<arch>\n", "latin1")];
  for (const [name, text] of members) {
    const body = Buffer.from(text, "latin1");
    const header = `${`${name}/`.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(body.length).padEnd(10)}\x60\n`;
    parts.push(Buffer.from(header, "latin1"), body);
    if (body.length % 2) parts.push(Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

/** Write artifacts and a candidate manifest naming exactly their SHA-256 values. */
export function writeCandidate(dir, commit, version, artifacts, { manifestOverride } = {}) {
  const paths = [];
  const digests = {};
  for (const [name, bytes] of Object.entries(artifacts)) {
    writeFileSync(join(dir, name), bytes);
    paths.push(join(dir, name));
    digests[name] = sha256(bytes);
  }
  const manifest = { format: 1, commit, version, artifacts: digests, ...manifestOverride };
  const manifestPath = join(dir, "candidate.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifestPath, paths };
}
