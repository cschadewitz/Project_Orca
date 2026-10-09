/** Fixed packaged locations and missing-resource refusal without touching diagnostics data. */
import { describe, expect, it, vi } from "vitest";
import { diagnosticsAddonPath, loadDiagnosticsAddon } from "../src/main/diagnostics/native-addon.js";
import { loadNativeDiagnosticsClock } from "../src/main/diagnostics/native-clock.js";
import { loadNativeDiagnosticsStorage } from "../src/main/diagnostics/native-storage.js";

describe("native diagnostics resource loading", () => {
  it("refuses a runtime filename outside the closed addon inventory", () => {
    expect(
      diagnosticsAddonPath("../../other" as never, {
        platform: "darwin",
        arch: "arm64",
        electron: true,
        resourcesPath: "/tmp/resources",
      }),
    ).toBeUndefined();
  });
  it.each(["arm64", "x64"])("selects one fixed external directory for Mac %s", (arch) => {
    const runtime = {
      platform: "darwin",
      arch,
      electron: true,
      resourcesPath: "/Applications/ORCA.app/Contents/Resources",
    };
    for (const addon of ["diagnostics_clock", "diagnostics_storage"] as const) {
      expect(diagnosticsAddonPath(addon, runtime)).toBe(
        `${runtime.resourcesPath}/native/diagnostics/darwin-${arch}/${addon}.node`,
      );
    }
  });

  it.each([undefined, "relative", "/Applications/../tmp/resources", "/tmp/resources/"])(
    "never substitutes a repository path for invalid Electron resources (%#)",
    (resourcesPath) => {
      expect(
        diagnosticsAddonPath("diagnostics_clock", {
          platform: "darwin",
          arch: "arm64",
          electron: true,
          ...(resourcesPath === undefined ? {} : { resourcesPath }),
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    ["win32", "x64"],
    ["linux", "arm64"],
    ["darwin", "ia32"],
    ["unknown", "arm64"],
  ])("refuses unsupported platform/architecture %s/%s", (platform, arch) => {
    expect(
      diagnosticsAddonPath("diagnostics_storage", { platform, arch, electron: true, resourcesPath: "/tmp/resources" }),
    ).toBeUndefined();
  });

  it("keeps the explicit Node source build path separate", () => {
    expect(diagnosticsAddonPath("diagnostics_storage", { platform: "darwin", arch: "arm64", electron: false })).toMatch(
      /\/packages\/app\/native\/diagnostics\/build\/Release\/diagnostics_storage\.node$/,
    );
  });

  it("missing Electron addons leave clock/files unavailable without a repository fallback", async () => {
    // Force the production loader path on Linux. Its fixed absent resource is never a data root.
    const original = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    const electron = Object.getOwnPropertyDescriptor(process.versions, "electron");
    try {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      Object.defineProperty(process.versions, "electron", { value: "44.4.5", configurable: true });
      Object.defineProperty(process, "resourcesPath", {
        value: "/orca-missing-diagnostics-resources",
        configurable: true,
      });
      expect(loadDiagnosticsAddon("diagnostics_clock")).toBeUndefined();
      expect(loadNativeDiagnosticsClock().read()).toBeUndefined();
      const storage = loadNativeDiagnosticsStorage("/orca-unused-diagnostics-data");
      expect(await storage.native.verifyRoot("/orca-unused-diagnostics-data")).toBe(false);
      await expect(storage.files.readdir("/orca-unused-diagnostics-data")).rejects.toThrow("unavailable");
      await storage.close();
    } finally {
      vi.restoreAllMocks();
      if (original) Object.defineProperty(process, "resourcesPath", original);
      else Reflect.deleteProperty(process, "resourcesPath");
      if (electron) Object.defineProperty(process.versions, "electron", electron);
      else Reflect.deleteProperty(process.versions, "electron");
    }
  });
});
