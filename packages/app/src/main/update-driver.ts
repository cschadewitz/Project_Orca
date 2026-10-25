/** Private HTTPS feed credentials are read only in main, from an operator-provisioned file. */
import { readFileSync } from "node:fs";
import electronUpdater from "electron-updater";
import type { UpdateDriver } from "./updates.js";
export function updateDriver(packaged: boolean, platform: string, arch: string): UpdateDriver | undefined {
  if (!packaged || platform !== "win32" || !["x64", "arm64"].includes(arch)) return undefined;
  let updater: InstanceType<typeof electronUpdater.NsisUpdater> | undefined;
  const get = () => {
    if (updater) return updater;
    const url = new URL(process.env.ORCA_UPDATE_URL ?? "https://updates.invalid/");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("Invalid update feed");
    const token = readFileSync(process.env.ORCA_UPDATE_TOKEN_FILE ?? "", "utf8").trim();
    if (!token || /[\r\n]/.test(token)) throw new Error("Missing feed credential");
    updater = new electronUpdater.NsisUpdater({
      provider: "generic",
      url: url.href,
      channel: `latest-${arch}`,
      requestHeaders: { Authorization: `Bearer ${token}` },
    });
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = null;
    // Check/download promises carry errors into Updates; consume the EventEmitter error too.
    updater.on("error", () => undefined);
    return updater;
  };
  return {
    async check() {
      // Re-read rotated credentials on each retry/check.
      updater = undefined;
      const result = await get().checkForUpdates();
      if (!result || result.updateInfo.version.includes("-")) return undefined;
      return result.isUpdateAvailable ? result.updateInfo.version : undefined;
    },
    async download(progress) {
      const instance = get();
      const listener = (p: { percent: number }) => progress(p.percent);
      instance.on("download-progress", listener);
      try {
        await instance.downloadUpdate();
      } finally {
        instance.off("download-progress", listener);
      }
    },
    async install() {
      let instance: InstanceType<typeof electronUpdater.NsisUpdater>;
      try {
        instance = get();
      } catch {
        // Positive proof: quitAndInstall was never invoked.
        return "not-launched";
      }
      return new Promise<"launched">((_resolve, reject) => {
        let settled = false;
        const failed = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          instance.off("error", failed);
          reject(new Error("Installer outcome is unknown"));
        };
        // Electron-updater errors and timeout do not prove the installer never launched.
        const timer = setTimeout(failed, 10000);
        instance.once("error", failed);
        try {
          instance.quitAndInstall(false, true);
        } catch {
          failed();
        }
      });
    },
  };
}
