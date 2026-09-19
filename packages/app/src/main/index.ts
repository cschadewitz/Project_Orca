/**
 * Electron main process. Owns the daemon connection and the window; the renderer only
 * sees what the preload bridge exposes. The daemon URL comes from `ORCA_DAEMON_URL`
 * (default: the local `orca serve`); bundling and spawning a daemon inside the app is
 * the desktop-release step in docs/RELEASING.md.
 *
 * The window loads the built renderer from `dist/renderer` unless `ORCA_RENDERER_URL` is
 * set, which is what `pnpm --filter @orca/app dev` does to point it at the Vite dev
 * server for hot reload (scripts/dev.js).
 */
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { DEFAULT_DAEMON_URL, DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import type { BridgeResult } from "../bridge.js";
import type { HelloResult } from "@orca/protocol";

const client = new DaemonClient(process.env.ORCA_DAEMON_URL ?? DEFAULT_DAEMON_URL);

/** The dev server's URL when `scripts/dev.js` started one; undefined in a packaged app. */
const rendererUrl = process.env.ORCA_RENDERER_URL;

ipcMain.handle("orca:hello", async (): Promise<BridgeResult<HelloResult>> => {
  try {
    return { ok: true, result: await client.hello(`orca-app/${app.getVersion()}`) };
  } catch (e) {
    if (e instanceof DaemonClientError) return { ok: false, error: e.error };
    return { ok: false, error: { code: "AGENT_TRANSPORT", message: e instanceof Error ? e.message : String(e) } };
  }
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.js", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
}

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
