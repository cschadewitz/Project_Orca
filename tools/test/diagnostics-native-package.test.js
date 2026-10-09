/** Real builder resource copying/hooks with synthetic Mach-O headers; no native Mac claim. */
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import beforePack, {
  NATIVE_ADDONS,
  checkNativeMachO,
  nativePackageManifest,
  verifyNativePackage,
} from "../../packages/app/scripts/diagnostics-native-package.js";
import afterPack from "../../packages/app/scripts/verify-diagnostics-native.js";

const appRoot = fileURLToPath(new URL("../../packages/app/", import.meta.url));
const appRequire = createRequire(join(appRoot, "package.json"));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { Arch, DebugLogger } = libRequire("builder-util");
const { load } = libRequire("js-yaml");
const { validateConfiguration } = libRequire("./util/config/config.js");
const { getFileMatchers, copyFiles } = libRequire("./fileMatcher.js");
const config = load(readFileSync(join(appRoot, "electron-builder.yml"), "utf8"));
const scratch = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture(arch = "arm64") {
  const root = mkdtempSync(join(tmpdir(), "orca-native-package-"));
  scratch.push(root);
  mkdirSync(join(root, "native/diagnostics"), { recursive: true });
  for (const name of ["binding.gyp", "clock-math.h", "clock.c", "storage.c"]) {
    copyFileSync(join(appRoot, "native/diagnostics", name), join(root, "native/diagnostics", name));
  }
  const directory = join(root, "dist/diagnostics-native", `darwin-${arch}`);
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(8, 12);
  for (const name of NATIVE_ADDONS) writeFileSync(join(directory, name), bytes);
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(nativePackageManifest(directory, arch, root)) + "\n");
  const resources = join(root, "image/ORCA.app/Contents/Resources");
  const context = {
    arch: Arch[arch],
    electronPlatformName: "darwin",
    appOutDir: join(root, "image"),
    packager: { projectDir: root, getResourcesDir: () => resources },
  };
  return { root, directory, resources, context, bytes };
}

it("the actual builder validates the hooks/config and keeps native output out of asar", async () => {
  await validateConfiguration(config, new DebugLogger(false));
  expect(config.files).toContain("!dist/diagnostics-native");
  expect(config.beforePack).toBe("./scripts/diagnostics-native-package.js");
  expect(config.afterPack).toBe("./scripts/verify-diagnostics-native.js");
});

it.each(["arm64", "x64"])("the actual builder copies only %s resources and both hooks verify", async (arch) => {
  const { root, directory, resources, context } = fixture(arch);
  beforePack(context);
  expect(() => afterPack(context)).toThrow();
  writeFileSync(join(directory, "excluded.tmp"), "excluded");
  const matchers = getFileMatchers(config, "extraResources", resources, {
    defaultSrc: root,
    globalOutDir: join(root, "dist/release"),
    customBuildOptions: config.mac,
    macroExpander: (value) => value.replaceAll("${arch}", arch),
  });
  // Global daemon resources are unrelated to this slice; copy the real native matcher.
  const native = matchers.filter((matcher) => matcher.from.includes("diagnostics-native"));
  expect(native).toHaveLength(1);
  await copyFiles(native, undefined, false);
  afterPack(context);
  expect(() => readFileSync(join(resources, "native/diagnostics", `darwin-${arch}`, "excluded.tmp"))).toThrow();
  writeFileSync(join(resources, "native/diagnostics", `darwin-${arch}`, NATIVE_ADDONS[0]), "altered");
  expect(() => afterPack(context)).toThrow();
});

it("refuses missing/stale source, changed bytes, symlinks and wrong architecture", () => {
  const { root, directory, context, bytes } = fixture();
  const check = () => beforePack(context);
  check();
  writeFileSync(join(root, "native/diagnostics/clock.c"), "changed source");
  expect(check).toThrow();
  copyFileSync(join(appRoot, "native/diagnostics/clock.c"), join(root, "native/diagnostics/clock.c"));
  expect(() => verifyNativePackage(directory, "x64", root)).toThrow();
  bytes[31] = 1;
  writeFileSync(join(directory, NATIVE_ADDONS[0]), bytes);
  expect(check).toThrow();
  rmSync(join(directory, NATIVE_ADDONS[0]));
  symlinkSync(join(directory, NATIVE_ADDONS[1]), join(directory, NATIVE_ADDONS[0]));
  expect(check).toThrow();
  rmSync(directory, { recursive: true });
  expect(check).toThrow();
});

it.each([Buffer.from("ELF linux fixture"), Buffer.alloc(32), Buffer.from([0xca, 0xfe, 0xba, 0xbe])])(
  "refuses non-Mac, malformed and universal fixtures (%#)",
  (bytes) => {
    expect(() => checkNativeMachO(bytes, "arm64")).toThrow();
  },
);

it.each(["win32", "linux"])("does not require or package a diagnostics backend on %s", (platform) => {
  beforePack({ electronPlatformName: platform });
  afterPack({ electronPlatformName: platform });
  expect(config[platform === "win32" ? "win" : platform].extraResources).toBeUndefined();
});
