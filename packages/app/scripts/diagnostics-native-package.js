/** Explicit local native builds and fail-closed packaging checks. Never enables capture. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
export const NATIVE_ADDONS = Object.freeze(["diagnostics_clock.node", "diagnostics_storage.node"]);
const nativeSources = ["binding.gyp", "clock-math.h", "clock.c", "storage.c"];
const maxAddonBytes = 4 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(condition) {
  if (!condition) throw new Error("Diagnostics native package unavailable");
}
function target(arch, platform = "darwin") {
  requireValue((arch === "arm64" || arch === "x64") && ["darwin", "win32"].includes(platform));
  return `${platform}-${arch}`;
}
function sourceDigest(root, platform = "darwin") {
  const digest = createHash("sha256");
  for (const name of platform === "win32"
    ? ["binding.gyp", "clock.c", "storage-windows.c", "windows-delay-load.c"]
    : nativeSources) {
    digest.update(name + "\0");
    digest.update(readFileSync(join(root, "native/diagnostics", name)));
  }
  return digest.digest("hex");
}
function boundedFile(path, limit) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit);
  const bytes = readFileSync(path);
  requireValue(bytes.length === stat.size && bytes.length <= limit);
  return bytes;
}

/** Thin 64-bit Mach-O bundles only. Linux ELF, wrong arch and universal/stale inputs refuse. */
export function checkNativeMachO(bytes, arch) {
  target(arch);
  requireValue(
    bytes.length >= 32 &&
      bytes.readUInt32LE(0) === 0xfeedfacf &&
      bytes.readUInt32LE(4) === (arch === "arm64" ? 0x0100000c : 0x01000007) &&
      bytes.readUInt32LE(12) === 8,
  );
}

/** PE32+ DLL, exact architecture and bounded section table. No ELF/Mach-O fallback. */
export function checkNativePE(bytes, arch) {
  target(arch, "win32");
  requireValue(bytes.length >= 128 && bytes.readUInt16LE(0) === 0x5a4d);
  const pe = bytes.readUInt32LE(0x3c);
  requireValue(pe >= 64 && pe <= bytes.length - 24 && bytes.readUInt32LE(pe) === 0x00004550);
  const sections = bytes.readUInt16LE(pe + 6);
  const optional = bytes.readUInt16LE(pe + 20);
  requireValue(
    bytes.readUInt16LE(pe + 4) === (arch === "x64" ? 0x8664 : 0xaa64) &&
      (bytes.readUInt16LE(pe + 22) & 0x2000) !== 0 &&
      sections > 0 &&
      sections <= 96 &&
      optional >= 112 &&
      pe + 24 + optional + sections * 40 <= bytes.length &&
      bytes.readUInt16LE(pe + 24) === 0x20b,
  );
}

export function nativePackageManifest(directory, arch, root = appRoot, platform = "darwin") {
  target(arch, platform);
  const files = {};
  for (const name of NATIVE_ADDONS) {
    const bytes = boundedFile(join(directory, name), maxAddonBytes);
    if (platform === "win32") checkNativePE(bytes, arch);
    else checkNativeMachO(bytes, arch);
    files[name] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  return {
    format: 1,
    stage: "before-signing",
    platform,
    arch,
    nodeApi: 8,
    sourceSha256: sourceDigest(root, platform),
    files,
  };
}

export function verifyNativePackage(directory, arch, root = appRoot, platform = "darwin") {
  requireValue(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
  const manifest = JSON.parse(boundedFile(join(directory, "manifest.json"), 4096).toString("utf8"));
  const expected = nativePackageManifest(directory, arch, root, platform);
  // Deterministic closed manifest: no omitted/extra field or altered binary accepted.
  requireValue(JSON.stringify(manifest) === JSON.stringify(expected));
  return expected;
}

/** Node-API 8 uses local verified headers; xcrun builds each requested target explicitly. */
export function buildNativePackage({ arch, headers, root = appRoot }) {
  const platform = process.platform;
  requireValue(platform === "darwin" || platform === "win32");
  const identity = target(arch, platform);
  const sourceBefore = sourceDigest(root, platform);
  const include = join(resolve(headers), "include/node");
  boundedFile(join(include, "node_api.h"), 128 * 1024);
  const parent = join(root, "dist/diagnostics-native");
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, ".build-"));
  try {
    if (platform === "win32") {
      // Explicit installed toolchain and local headers/import library; no node-gyp download.
      boundedFile(join(resolve(headers), arch, "node.lib"), 16 * 1024 * 1024);
      const appRequire = createRequire(join(root, "package.json"));
      const builderRequire = createRequire(appRequire.resolve("electron-builder"));
      execFileSync(
        process.execPath,
        [
          builderRequire.resolve("node-gyp/bin/node-gyp.js"),
          "rebuild",
          `--arch=${arch}`,
          `--nodedir=${resolve(headers)}`,
        ],
        {
          cwd: join(root, "native/diagnostics"),
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
      );
      for (const name of NATIVE_ADDONS)
        copyFileSync(join(root, "native/diagnostics/build/Release", name), join(scratch, name));
    } else
      for (const name of NATIVE_ADDONS) {
        execFileSync(
          "/usr/bin/xcrun",
          [
            "clang",
            "-bundle",
            "-undefined",
            "dynamic_lookup",
            "-arch",
            arch === "x64" ? "x86_64" : "arm64",
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-DNAPI_VERSION=8",
            "-I",
            include,
            join(root, "native/diagnostics", name === NATIVE_ADDONS[0] ? "clock.c" : "storage.c"),
            "-o",
            join(scratch, name),
          ],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 64 * 1024 },
        );
      }
    const manifest = nativePackageManifest(scratch, arch, root, platform);
    requireValue(manifest.sourceSha256 === sourceBefore);
    writeFileSync(join(scratch, "manifest.json"), JSON.stringify(manifest) + "\n", { flag: "wx" });
    verifyNativePackage(scratch, arch, root, platform);
    const destination = join(parent, identity);
    // Only the explicit architecture's app-owned generated output is replaced.
    rmSync(destination, { recursive: true, force: true });
    renameSync(scratch, destination);
    return manifest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function contextArch(context) {
  const builder = createRequire(createRequire(join(appRoot, "package.json")).resolve("electron-builder"));
  const library = createRequire(builder.resolve("app-builder-lib"));
  return library("builder-util").Arch[context.arch];
}

/** electron-builder beforePack: reject missing/stale/wrong-target addons before packaging. */
export default function beforePack(context) {
  const platform = context.electronPlatformName;
  if (platform !== "darwin" && platform !== "win32") return;
  const arch = contextArch(context);
  verifyNativePackage(
    join(context.packager.projectDir, "dist/diagnostics-native", target(arch, platform)),
    arch,
    context.packager.projectDir,
    platform,
  );
}

/** Verify actual copied resources too; builder otherwise only warns about missing sources. */
export function verifyPackagedDiagnostics(context) {
  const platform = context.electronPlatformName;
  if (platform !== "darwin" && platform !== "win32") return;
  const arch = contextArch(context);
  verifyNativePackage(
    join(context.packager.getResourcesDir(context.appOutDir), "native/diagnostics", target(arch, platform)),
    arch,
    context.packager.projectDir,
    platform,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { arch: { type: "string" }, headers: { type: "string" } } });
    requireValue(values.arch && values.headers);
    const manifest = buildNativePackage(values);
    process.stdout.write(JSON.stringify(manifest) + "\n");
  } catch {
    process.stderr.write("Diagnostics native build refused; local platform toolchain and verified headers required\n");
    process.exitCode = 1;
  }
}
