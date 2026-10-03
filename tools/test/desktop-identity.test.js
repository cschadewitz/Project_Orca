/** Resolve packaging identity with the locked builder, preserving existing install names. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const appRequire = createRequire(new URL("../../packages/app/package.json", import.meta.url));
const builderRequire = createRequire(appRequire.resolve("electron-builder"));
const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const { load } = packagerRequire("js-yaml");
const { AppInfo } = packagerRequire("./appInfo.js");
const { LinuxTargetHelper } = packagerRequire("./targets/LinuxTargetHelper.js");
const { getWindowsInstallationDirName } = packagerRequire("./targets/targetUtil.js");
const config = load(readFileSync(new URL("../../packages/app/electron-builder.yml", import.meta.url), "utf8"));
const metadata = JSON.parse(readFileSync(new URL("../../packages/app/package.json", import.meta.url), "utf8"));
const appInfo = (platform, buildConfig = config) =>
  new AppInfo({ config: buildConfig, metadata }, undefined, buildConfig[platform]);

it("uses the approved macOS bundle identity without activating signing", () => {
  expect(config.appId).toBe("com.schadewitz.orca");
  expect(appInfo("mac").macBundleIdentifier).toBe("com.schadewitz.orca");
  expect(appInfo("mac").productFilename).toBe("ORCA");
  expect(config.mac.identity).toBeNull();
  expect(config.mac.notarize).toBe(false);
});

it("preserves Windows NSIS identity, installation name and updater cache", () => {
  const info = appInfo("win");
  // NSIS derives its GUID from this effective ID and uses it for shortcut AppUserModelID.
  expect(info.id).toBe("dev.orca.desktop");
  expect(config.nsis.guid).toBeUndefined();
  expect(getWindowsInstallationDirName(info, true)).toBe("ORCA");
  expect(info.productFilename).toBe("ORCA");
  expect(metadata.name).toBe("@orca/app");
  expect(info.updaterCacheDirName).toBe(
    appInfo("win", { ...config, appId: "dev.orca.desktop", win: {} }).updaterCacheDirName,
  );
});

it("keeps Linux desktop entries and package names stable across the ID change", () => {
  const oldConfig = { ...config, appId: "dev.orca.desktop" };
  const desktop = (buildConfig) => {
    const helper = new LinuxTargetHelper({
      appInfo: appInfo("linux", buildConfig),
      executableName: buildConfig.linux.executableName,
      platformSpecificBuildOptions: buildConfig.linux,
      config: buildConfig,
      info: { metadata },
      fileAssociations: [],
    });
    return {
      name: helper.getDesktopFileName(),
      entry: helper.computeDesktopEntry(buildConfig.linux),
    };
  };
  expect(appInfo("linux").id).toBe("com.schadewitz.orca");
  expect(appInfo("linux").linuxPackageName).toBe("ORCA");
  expect(appInfo("linux").productFilename).toBe("orca");
  expect(desktop(config)).toEqual(desktop(oldConfig));
  expect(desktop(config).name).toBe("orca");
});
