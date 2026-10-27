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

/** An ASAR archive with per-file SHA-256 integrity, in electron's header-pickle layout. */
export function makeAsar(files, { tamper } = {}) {
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
    const body = Buffer.from(value);
    node.files[last] = {
      size: body.length,
      offset: String(offset),
      integrity: { algorithm: "SHA256", hash: sha256(body), blockSize: 4 * 1024 * 1024, blocks: [sha256(body)] },
    };
    bodies.push(body);
    offset += body.length;
  }
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

export const daemon = (version) =>
  text(`// synthetic daemon\nvar ORCA_VERSION = true ? "${version}" : fallback();\nexport {};\n`);

function tarHeader(name, { type = "0", size = 0, mode = 0o644, linkName = "" }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write(type, 156, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0" + "00", 257, "ascii");
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

const pad = (body) => Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);

/** A gzip tar. Names over 100 bytes use a pax `path` record, as GNU tar and node-tar do. */
export function makeTarGz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = entry.body ? Buffer.from(entry.body) : Buffer.alloc(0);
    if (Buffer.byteLength(entry.name) > 99) {
      const record = (value) => {
        let length = value.length + 3;
        while (`${length} ${value}\n`.length !== length) length = `${length} ${value}\n`.length;
        return `${length} ${value}\n`;
      };
      const pax = Buffer.from(record(`path=${entry.name}`));
      blocks.push(tarHeader("PaxHeader", { type: "x", size: pax.length }), pad(pax));
    }
    const type = { file: "0", directory: "5", symlink: "2", hardlink: "1" }[entry.kind ?? "file"];
    blocks.push(
      tarHeader(entry.name.slice(0, 99), { type, size: body.length, mode: entry.mode, linkName: entry.linkName }),
    );
    if (body.length) blocks.push(pad(body));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** A classic ZIP with deflated members, as 7-Zip writes Windows archives. */
export function makeZip(entries, { corruptCrc } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.body ? Buffer.from(entry.body) : Buffer.alloc(0);
    const data = deflateRawSync(body);
    const crc = (crc32(body) ^ (corruptCrc === entry.name ? 1 : 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(record, name);
    offset += 30 + name.length + data.length;
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
export function appAsar(version, overrides = {}) {
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
  return makeAsar(files);
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

/** A Linux tar.gz tree: `<top>/orca`, Electron runtime placeholders, resources. */
export function linuxArchive(
  version,
  arch,
  { asar = appAsar(version), daemonBody = daemon(version), extra = [] } = {},
) {
  const top = `ORCA-${version}`;
  const runtime = ["resources.pak", "icudtl.dat", "v8_context_snapshot.bin", "libffmpeg.so", "locales/en-US.pak"];
  return makeTarGz([
    { name: `${top}/`, kind: "directory", mode: 0o755 },
    { name: `${top}/orca`, body: makeElf(arch), mode: 0o755 },
    { name: `${top}/chrome-sandbox`, body: makeElf(arch), mode: 0o755 },
    ...runtime.map((name) => ({ name: `${top}/${name}`, body: `placeholder ${name}` })),
    { name: `${top}/resources/app.asar`, body: asar },
    { name: `${top}/resources/daemon/orca-daemon.mjs`, body: daemonBody },
    ...extra,
  ]);
}

/** A Windows zip tree at the archive root, as electron-builder's win zip target lays it out. */
export function windowsArchive(
  version,
  arch,
  source,
  { asar = appAsar(version), daemonBody = daemon(version), native, extra = [] } = {},
) {
  const runtime = ["resources.pak", "icudtl.dat", "v8_context_snapshot.bin", "ffmpeg.dll", "locales/en-US.pak"];
  const addons = native ?? windowsNative(source, arch);
  return makeZip([
    { name: "ORCA.exe", body: makePe(arch) },
    ...runtime.map((name) => ({ name, body: `placeholder ${name}` })),
    { name: "resources/app.asar", body: asar },
    { name: "resources/app-update.yml", body: "provider: generic\nurl: https://updates.invalid/\nchannel: latest\n" },
    { name: "resources/daemon/orca-daemon.mjs", body: daemonBody },
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
