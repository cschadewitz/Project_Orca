/**
 * Electron main process. Owns the daemon connection, the preferences file and the window;
 * the renderer only sees what the preload bridge exposes. The daemon URL comes from
 * `ORCA_DAEMON_URL` (default: the local `orca serve`); bundling and spawning a daemon inside
 * the app is the desktop-release step in docs/RELEASING.md.
 *
 * The window loads the built renderer from `dist/renderer` unless `ORCA_RENDERER_URL` is
 * set, which is what `pnpm --filter @orca/app dev` does to point it at the Vite dev
 * server for hot reload (scripts/dev.js).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { rawTokens, type ThemeId } from "@orca/design";
import type { HelloResult } from "@orca/protocol";
import type { BridgeResult } from "../bridge.js";
import { DEFAULT_DAEMON_URL, DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import { PreferencesFile } from "../preferences/preferences-file.js";
import type { Preferences, ThemePreference } from "../preferences/schema.js";

const client = new DaemonClient(process.env.ORCA_DAEMON_URL ?? DEFAULT_DAEMON_URL);
const preferences = new PreferencesFile(join(app.getPath("userData"), "preferences.json"));

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

ipcMain.on("orca:preferences.read", (event) => {
  event.returnValue = preferences.read();
});
ipcMain.handle("orca:preferences.write", (_event, patch: unknown): BridgeResult<Preferences> => {
  try {
    const next = preferences.write(patch);
    applyTheme(next.theme);
    return { ok: true, result: next };
  } catch (e) {
    return { ok: false, error: { code: "PREFERENCES", message: e instanceof Error ? e.message : String(e) } };
  }
});

/* ---------- theme ---------- */

/** The theme the window is actually showing: the preference, or the OS when it is `system`. */
function resolveTheme(pref: ThemePreference): ThemeId {
  return pref === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : pref;
}

/**
 * The window's own background, painted before the renderer has loaded a byte of CSS. It is
 * `surface-canvas` from the resolved theme via `rawTokens`, the one place in the app a token
 * is read as a literal — a CSS variable cannot reach a native window.
 */
function canvasColor(theme: ThemeId): string {
  const color = rawTokens[theme]["surface-canvas"];
  if (!color) throw new Error(`@orca/design has no surface-canvas for theme ${theme}`);
  return color;
}

function applyTheme(pref: ThemePreference): void {
  // Chromium's `prefers-color-scheme` and the OS-drawn chrome (title bar, menus, dialogs)
  // follow themeSource, so an explicit choice reaches everything the renderer's attribute
  // cannot. The renderer sets `data-theme` for the same choice; the two never disagree.
  nativeTheme.themeSource = pref;
  const color = canvasColor(resolveTheme(pref));
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(color);
}

nativeTheme.on("updated", () => applyTheme(preferences.read().theme));

/* ---------- window ---------- */

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // No white flash on open in dark: the native background is the theme's canvas, and the
    // window stays hidden until the renderer has painted once.
    backgroundColor: canvasColor(resolveTheme(preferences.read().theme)),
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.js", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  if (rendererUrl) {
    void win.loadURL(rendererUrl);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
}

void app.whenReady().then(() => {
  applyTheme(preferences.read().theme);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
