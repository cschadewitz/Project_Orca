/** Actual Windows PE addons + real builder copying, hosted by Node. No Electron/UI claim. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import beforePack, {
  NATIVE_ADDONS,
  nativePackageManifest,
  verifyNativePackage,
  verifyPackagedDiagnostics,
} from "../../scripts/diagnostics-native-package.js";
import { diagnosticsAddonPath, loadDiagnosticsAddon } from "../../src/main/diagnostics/native-addon.ts";
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const appRequire = createRequire(join(appRoot, "package.json"));
const builder = createRequire(appRequire.resolve("electron-builder"));
const lib = createRequire(builder.resolve("app-builder-lib"));
const { Arch } = lib("builder-util");
const { load } = lib("js-yaml");
const { getFileMatchers, copyFiles } = lib("./fileMatcher.js");
const config = load(readFileSync(join(appRoot, "electron-builder.yml"), "utf8"));
if (process.argv[2] !== "child") {
  const base = mkdtempSync(join(tmpdir(), "orca-win-package-task12-"));
  try {
    process.stdout.write(
      execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "child", base], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 32 * 1024,
      }),
    );
  } finally {
    // Loaded DLLs are only unmapped after the owned child exits; never bypass its lease.
    assert.equal(dirname(base), tmpdir());
    assert.ok(base.startsWith(join(tmpdir(), "orca-win-package-task12-")));
    rmSync(base, { recursive: true, force: true });
  }
} else {
  const base = process.argv[3];
  assert.ok(base);
  assert.equal(dirname(base), tmpdir());
  const directory = join(base, "dist/diagnostics-native/win32-x64");
  const resources = join(base, "image/resources");
  const context = {
    arch: Arch.x64,
    electronPlatformName: "win32",
    appOutDir: join(base, "image"),
    packager: { projectDir: base, getResourcesDir: () => resources },
  };
  const original = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const electron = Object.getOwnPropertyDescriptor(process.versions, "electron");
  try {
    mkdirSync(join(base, "native/diagnostics"), { recursive: true });
    mkdirSync(directory, { recursive: true });
    for (const name of ["binding.gyp", "clock.c", "storage-windows.c", "windows-delay-load.c"])
      copyFileSync(join(appRoot, "native/diagnostics", name), join(base, "native/diagnostics", name));
    for (const name of NATIVE_ADDONS)
      copyFileSync(join(appRoot, "native/diagnostics/build/Release", name), join(directory, name));
    const manifest = nativePackageManifest(directory, "x64", base, "win32");
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest) + "\n");
    beforePack(context);
    assert.throws(() => verifyPackagedDiagnostics(context));
    const native = getFileMatchers(config, "extraResources", resources, {
      defaultSrc: base,
      globalOutDir: join(base, "dist/release"),
      customBuildOptions: config.win,
      macroExpander: (value) => value.replaceAll("${arch}", "x64"),
    }).filter((matcher) => matcher.from.includes("diagnostics-native"));
    assert.equal(native.length, 1);
    await copyFiles(native, undefined, false);
    verifyPackagedDiagnostics(context);
    Object.defineProperty(process.versions, "electron", { value: "synthetic-location-only", configurable: true });
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
    for (const name of ["diagnostics_clock", "diagnostics_storage"]) {
      assert.equal(
        diagnosticsAddonPath(name, { platform: "win32", arch: "x64", electron: true, resourcesPath: resources }),
        join(resources, "native/diagnostics/win32-x64", `${name}.node`),
      );
      const addon = loadDiagnosticsAddon(name);
      assert.equal(addon.abi, 1);
      assert.equal(addon.platform, "win32");
    }
    assert.throws(() => verifyNativePackage(directory, "arm64", base, "win32"));
    // Require cache is bypassed by a fresh absent-resource directory; local builds still exist.
    Object.defineProperty(process, "resourcesPath", { value: join(base, "absent-resources"), configurable: true });
    assert.equal(loadDiagnosticsAddon("diagnostics_clock"), undefined);
    assert.throws(() =>
      verifyPackagedDiagnostics({
        ...context,
        packager: { ...context.packager, getResourcesDir: () => join(base, "absent-resources") },
      }),
    );
    process.stdout.write(
      JSON.stringify({
        schema: 1,
        platform: "win32",
        arch: "x64",
        runtime: process.versions.node,
        actualPEManifest: manifest,
        actualBuilderCopyAndHooks: true,
        fixedExternalNodeLoad: true,
        wrongArchitectureRefused: true,
        missingResourcesRefusedWithoutRepositoryFallback: true,
        electronRuntimeLoad:
          "unrun; GNU Node probe binaries have static node.exe imports; shipping node-gyp uses Windows delay-load hook",
        arm64NativeBuild: "unrun",
      }) + "\n",
    );
  } finally {
    if (original) Object.defineProperty(process, "resourcesPath", original);
    else Reflect.deleteProperty(process, "resourcesPath");
    if (electron) Object.defineProperty(process.versions, "electron", electron);
    else Reflect.deleteProperty(process.versions, "electron");
  }
}
