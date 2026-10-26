/** Exercise locked builder APIs with synthetic paths; no native packaging or signing. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
// Load its public entry first: internal packager classes have circular imports.
builderRequire("app-builder-lib");
const { load, loadAll } = libRequire("js-yaml");
const { getConfig, doMergeConfigs, validateConfiguration } = libRequire("./util/config/config.js");
const { MacPackager } = libRequire("./macPackager.js");
const { PlatformPackager } = libRequire("./platformPackager.js");
const { MacTargetHelper } = libRequire("./mac/MacTargetHelper.js");
const { resolveFunction } = libRequire("./util/resolve.js");
const { Arch } = libRequire("builder-util");
const config = load(readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"));
const logger = { isEnabled: false };

it("resolves the selected lock and validates inert hook/version/entitlement interfaces", async () => {
  const lock = loadAll(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8")).find(
    (doc) => doc?.importers?.["packages/app"],
  );
  expect(builderRequire("app-builder-lib/package.json").version).toBe("26.18.0");
  expect(appRequire("electron-builder/package.json").version).toBe(
    lock.importers["packages/app"].devDependencies["electron-builder"].version.split("(")[0],
  );
  const effective = await getConfig(fileURLToPath(new URL("../../packages/app/", import.meta.url)), null, {
    afterPack: "./synthetic-after-pack.cjs",
    afterSign: "./synthetic-after-sign.cjs",
    mac: {
      identity: null,
      notarize: false,
      hardenedRuntime: true,
      entitlements: "synthetic-main.plist",
      entitlementsInherit: "synthetic-child.plist",
      bundleVersion: "0007.02",
      bundleShortVersion: "0.0.0",
    },
  });
  await expect(validateConfiguration(effective, logger)).resolves.toBeUndefined();
  expect(effective.mac.bundleVersion).toBe("0007.02");
  expect(effective.win.appId).toBe("dev.orca.desktop");
  expect(effective.electronFuses?.runAsNode).not.toBe(false);
  await expect(
    validateConfiguration({ ...effective, mac: { ...effective.mac, inventedSigningPolicy: true } }, logger),
  ).rejects.toThrow();
  // AJV ignores the schema's unknown `typeof` keyword (strict:false). That anyOf
  // branch accepts even numbers unchanged; schema acceptance is not hook proof.
  const invalidHook = { ...effective, afterPack: 42 };
  await expect(validateConfiguration(invalidHook, logger)).resolves.toBeUndefined();
  expect(invalidHook.afterPack).toBe(42);
  const hook = vi.fn(async (context) => context.arch);
  const resolved = await resolveFunction("module", hook, "afterPack", process.cwd());
  expect(await resolved({ arch: Arch.arm64 })).toBe(Arch.arm64);
  await expect(resolveFunction("module", "../outside-workspace.cjs", "afterPack", process.cwd())).rejects.toThrow(
    "outside the workspace root",
  );
});

it("shows overlay arrays concatenate: an arm64 overlay alone does not remove x64 targets", () => {
  const overlay = {
    mac: { target: [{ target: "dir", arch: ["arm64"] }] },
    extraResources: [{ from: "synthetic-identity", to: "orca-build.json" }],
  };
  const merged = doMergeConfigs([structuredClone(config), overlay]);
  expect(merged.extraResources).toEqual([...config.extraResources, ...overlay.extraResources]);
  expect(merged.mac.target).toEqual([...config.mac.target, ...overlay.mac.target]);
  expect(merged.mac.identity).toBeNull();
  expect(merged.mac.notarize).toBe(false);
  expect(merged.win.appId).toBe("dev.orca.desktop");
});

it("inspects effective main/inherited/login-helper entitlements without invoking codesign", async () => {
  const helper = new MacTargetHelper({
    resourceList: Promise.resolve([]),
    platformSpecificBuildOptions: {},
    info: { buildResourcesDir: "/synthetic/build" },
  });
  const options = await helper.getOptionsForFile("/synthetic/ORCA.app", false, {});
  const main = options("/synthetic/ORCA.app");
  const child = options("/synthetic/ORCA.app/Contents/Frameworks/ORCA Helper.app");
  expect(main.hardenedRuntime).toBe(true);
  expect(child.entitlements).toBe(main.entitlements);
  const plist = readFileSync(main.entitlements, "utf8");
  expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual([
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]);
  expect(options("/synthetic/ORCA.app/Contents/Library/LoginItems/Helper.app").entitlements).toBeUndefined();
  const explicit = await helper.getOptionsForFile("/synthetic/ORCA.app", false, {
    entitlements: "main.plist",
    entitlementsInherit: "child.plist",
    entitlementsLoginHelper: "login.plist",
  });
  expect(explicit("/synthetic/ORCA.app").entitlements).toBe("main.plist");
  expect(explicit("/synthetic/child").entitlements).toBe("child.plist");
  expect(new MacTargetHelper({ forceCodeSigning: false }).handleNullIdentity()).toBe(false);
  expect(() => new MacTargetHelper({ forceCodeSigning: true }).handleNullIdentity()).toThrow();
});

it.each([false, true])("afterSign runs only when signApp returns %s", async (signed) => {
  const emitAfterSign = vi.fn();
  const context = {
    computeAsarOptions: async () => ({}),
    signApp: vi.fn(async () => signed),
    info: { emitAfterSign, filterPackagerEventListeners: () => [] },
  };
  await PlatformPackager.prototype.doSignAfterPack.call(
    context,
    "/synthetic/out",
    "/synthetic/app",
    "darwin",
    Arch.arm64,
    {},
    [],
  );
  expect(emitAfterSign).toHaveBeenCalledTimes(signed ? 1 : 0);
});

it.each([undefined, "/synthetic/ORCA.app"])(
  "non-MAS prepackaged=%s controls whether doPack runs",
  async (prepackaged) => {
    const doPack = vi.fn(async () => {});
    const containers = vi.fn();
    const context = {
      appInfo: { productFilename: "ORCA" },
      computeAppOutDir: () => "/synthetic/mac-arm64",
      getPlatformConfig: () => ({ platformName: "darwin", config: {} }),
      doPack,
      packageInDistributableFormat: containers,
    };
    await MacPackager.prototype.packMacTargets.call(context, "/synthetic/out", Arch.arm64, [], prepackaged, {});
    expect(doPack).toHaveBeenCalledTimes(prepackaged ? 0 : 1);
    expect(containers.mock.calls[0][0]).toBe(prepackaged ?? "/synthetic/mac-arm64/ORCA.app");
  },
);
