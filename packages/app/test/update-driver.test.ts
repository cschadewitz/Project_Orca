import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { acceptsVersion, feedTokenFiles, readFeedToken, updateDriver } from "../src/main/update-driver.js";
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
it.each([false, true])("removes only its progress listener after download failure=%s", async (fails) => {
  const dir = mkdtempSync(join(tmpdir(), "orca-download-listener-fixture-"));
  try {
    writeFileSync(join(dir, "token"), "synthetic");
    vi.stubEnv("ORCA_UPDATE_URL", "https://feed.example/");
    vi.stubEnv("ORCA_UPDATE_TOKEN_FILE", join(dir, "token"));
    const progress = vi.fn();
    let listener!: (value: { percent: number }) => void;
    fake.instance.on.mockImplementation((event, callback) => {
      if (event === "download-progress") listener = callback;
      return fake.instance;
    });
    fake.instance.downloadUpdate.mockImplementationOnce(async () => {
      listener({ percent: 37 });
      if (fails) throw new Error("synthetic failed download");
      return [];
    });
    const pending = updateDriver(true, "win32", "x64")!.download(progress);
    if (fails) await expect(pending).rejects.toThrow("synthetic failed download");
    else await pending;
    expect(progress).toHaveBeenCalledExactlyOnceWith(37);
    expect(fake.instance.off).toHaveBeenCalledExactlyOnceWith("download-progress", listener);
    expect(fake.instance.quitAndInstall).not.toHaveBeenCalled();
  } finally {
    fake.instance.on.mockReset();
    rmSync(dir, { recursive: true, force: true });
  }
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
      // Silent, then relaunch: an interactive per-user installer would stop on "who should
      // this be installed for", where "all users" elevates into a second, per-machine install.
      expect(fake.instance.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
      expect(fake.instance.off).toHaveBeenCalledExactlyOnceWith("error", failed);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  },
);

it("offers release candidates only to installs that opt in", async () => {
  expect(acceptsVersion("0.7.1", {})).toBe(true);
  expect(acceptsVersion("0.7.1-rc.1", {})).toBe(false);
  expect(acceptsVersion("0.7.1-rc.1", { ORCA_UPDATE_PRERELEASE: "1" })).toBe(true);
  for (const value of ["true", "yes", "0", ""])
    expect(acceptsVersion("0.7.1-rc.1", { ORCA_UPDATE_PRERELEASE: value })).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), "orca-feed-prerelease-"));
  try {
    writeFileSync(join(dir, "token"), "synthetic");
    vi.stubEnv("ORCA_UPDATE_URL", "https://feed.example/preview/");
    vi.stubEnv("ORCA_UPDATE_TOKEN_FILE", join(dir, "token"));
    fake.instance.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: "0.7.1-rc.1" } });
    const driver = updateDriver(true, "win32", "x64")!;
    expect(await driver.check()).toBeUndefined();
    vi.stubEnv("ORCA_UPDATE_PRERELEASE", "1");
    expect(await driver.check()).toBe("0.7.1-rc.1");
    expect(fake.instance.allowDowngrade).toBe(false);
  } finally {
    fake.instance.checkForUpdates.mockReset();
    fake.instance.checkForUpdates.mockImplementation(() =>
      Promise.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.6.1" } }),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reads the feed credential from the env file, else the app folder, else the pre-rename folder", async () => {
  const local = mkdtempSync(join(tmpdir(), "orca-feed-localappdata-"));
  try {
    const legacyDir = join(local, "ORCA"); // rename-keep: the folder before the rename
    const currentDir = join(local, "ORCA");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(legacyDir, "feed-token.txt"), "legacy-token\n");
    expect(feedTokenFiles({ LOCALAPPDATA: local }).at(-1)).toBe(join(legacyDir, "feed-token.txt"));
    expect(feedTokenFiles({ LOCALAPPDATA: local })[0]).toBe(join(currentDir, "feed-token.txt"));
    // Only the old folder has one: it is read.
    expect(readFeedToken(feedTokenFiles({ LOCALAPPDATA: local }))).toBe("legacy-token");
    // The app's own folder wins once it has one.
    writeFileSync(join(currentDir, "feed-token.txt"), "current-token\n");
    expect(readFeedToken(feedTokenFiles({ LOCALAPPDATA: local }))).toBe("current-token");
    // The environment's file, when named, is the only one read.
    const named = join(local, "named-token");
    expect(feedTokenFiles({ LOCALAPPDATA: local, ORCA_UPDATE_TOKEN_FILE: named })).toEqual([named]);
    expect(readFeedToken([named])).toBe("");
    expect(feedTokenFiles({})).toEqual([]);

    vi.stubEnv("ORCA_UPDATE_URL", "https://feed.example/");
    vi.stubEnv("ORCA_UPDATE_TOKEN_FILE", "");
    vi.stubEnv("LOCALAPPDATA", local);
    await updateDriver(true, "win32", "x64")!.check();
    expect(fake.options).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestHeaders: { Authorization: "Bearer current-token" } }),
    );
    rmSync(join(currentDir, "feed-token.txt"), { force: true });
    rmSync(join(legacyDir, "feed-token.txt"), { force: true });
    await expect(updateDriver(true, "win32", "x64")!.check()).rejects.toThrow("Missing feed credential");
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});
