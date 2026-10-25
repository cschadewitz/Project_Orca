import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  options: vi.fn(),
  instance: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    logger: null,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.6.1" } })),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    quitAndInstall: vi.fn(),
  },
}));
vi.mock("electron-updater", () => ({
  default: {
    NsisUpdater: class {
      constructor(options: unknown) {
        fake.options(options);
        return fake.instance;
      }
    },
  },
}));
import { updateDriver } from "../src/main/update-driver.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("configures private HTTPS requests only in main and disables implicit install/prereleases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-feed-"));
  try {
    const file = join(dir, "token");
    writeFileSync(file, "private-read-token\n");
    vi.stubEnv("ORCA_UPDATE_URL", "https://feed.example/stable/");
    vi.stubEnv("ORCA_UPDATE_TOKEN_FILE", file);
    const driver = updateDriver(true, "win32", "arm64")!;
    expect(await driver.check()).toBe("0.6.1");
    expect(fake.options).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://feed.example/stable/",
      channel: "latest-arm64",
      requestHeaders: { Authorization: "Bearer private-read-token" },
    });
    expect(fake.instance).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
    });
    expect(fake.instance.downloadUpdate).not.toHaveBeenCalled();
    writeFileSync(file, "rotated");
    await driver.check();
    expect(fake.options).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestHeaders: { Authorization: "Bearer rotated" } }),
    );
    fake.instance.checkForUpdates.mockRejectedValueOnce(new Error("401"));
    await expect(driver.check()).rejects.toThrow("401");
    expect(await driver.check()).toBe("0.6.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("refuses unsupported installs and non-HTTPS or credential-bearing URLs", async () => {
  expect(updateDriver(false, "win32", "x64")).toBeUndefined();
  expect(updateDriver(true, "linux", "x64")).toBeUndefined();
  for (const url of ["http://feed.example/", "https://user:secret@feed.example/", "https://feed.example/?secret=x"]) {
    vi.stubEnv("ORCA_UPDATE_URL", url);
    await expect(updateDriver(true, "win32", "x64")!.check()).rejects.toThrow("Invalid update feed");
  }
  expect(fake.options).not.toHaveBeenCalled();
});

it("reports positive non-launch only before quitAndInstall is invoked", async () => {
  vi.stubEnv("ORCA_UPDATE_URL", "http://invalid.example/");
  expect(await updateDriver(true, "win32", "x64")!.install()).toBe("not-launched");
  expect(fake.instance.quitAndInstall).not.toHaveBeenCalled();
});
it.each(["timeout", "error", "throw"] as const)(
  "treats post-invocation %s as unknown and removes the exact listener",
  async (kind) => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "orca-installer-fixture-"));
    try {
      writeFileSync(join(dir, "token"), "synthetic");
      vi.stubEnv("ORCA_UPDATE_URL", "https://feed.example/");
      vi.stubEnv("ORCA_UPDATE_TOKEN_FILE", join(dir, "token"));
      let failed!: () => void;
      fake.instance.once.mockImplementationOnce((_event, callback) => {
        failed = callback;
        return fake.instance;
      });
      if (kind === "throw")
        fake.instance.quitAndInstall.mockImplementationOnce(() => {
          throw new Error("raw secret");
        });
      const pending = updateDriver(true, "win32", "x64")!.install();
      const assertion = expect(pending).rejects.toThrow("Installer outcome is unknown");
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(10000);
      if (kind === "error") failed();
      await assertion;
      failed(); // Duplicate/late callbacks cannot change the already classified outcome.
      expect(fake.instance.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
      expect(fake.instance.off).toHaveBeenCalledExactlyOnceWith("error", failed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  },
);
