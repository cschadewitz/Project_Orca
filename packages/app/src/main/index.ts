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
import type { NotificationMessage } from "@orca/protocol";
import type { BridgeResult } from "../bridge.js";
import { DEFAULT_DAEMON_URL, DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import type { DaemonSubscription } from "../client/subscription.js";
import { PreferencesFile } from "../preferences/preferences-file.js";
import type { Preferences, ThemePreference } from "../preferences/schema.js";

const client = new DaemonClient(process.env.ORCA_DAEMON_URL ?? DEFAULT_DAEMON_URL);
const preferences = new PreferencesFile(join(app.getPath("userData"), "preferences.json"));

/** The dev server's URL when `scripts/dev.js` started one; undefined in a packaged app. */
const rendererUrl = process.env.ORCA_RENDERER_URL;

/* ---------- the daemon ---------- */

/**
 * Every bridge call answers rather than rejects: a rejection over the context bridge reaches
 * the renderer as a stringified `Error` with the main process's stack, which no screen can
 * render. See `../bridge.ts`.
 */
function handle<P, R>(channel: string, run: (params: P) => Promise<R>): void {
  ipcMain.handle(channel, async (_event, params: P): Promise<BridgeResult<R>> => {
    try {
      return { ok: true, result: await run(params) };
    } catch (e) {
      if (e instanceof DaemonClientError) return { ok: false, error: e.error };
      return { ok: false, error: { code: "AGENT_TRANSPORT", message: e instanceof Error ? e.message : String(e) } };
    }
  });
}

handle("orca:hello", () => client.hello(`orca-app/${app.getVersion()}`));
handle("orca:runs.list", (params: Parameters<DaemonClient["runsList"]>[0]) => client.runsList(params));
handle("orca:runs.get", (params: Parameters<DaemonClient["runsGet"]>[0]) => client.runsGet(params));
handle("orca:runs.events", (params: Parameters<DaemonClient["runsEvents"]>[0]) => client.runsEvents(params));
handle("orca:inputs.list", (params: Parameters<DaemonClient["inputsList"]>[0]) => client.inputsList(params));
handle("orca:claims.list", (params: Parameters<DaemonClient["claimsList"]>[0]) => client.claimsList(params));

/**
 * One socket for the whole app, store-wide, forwarded to every open window. A subscription
 * per window would mean one daemon connection per window showing the same runs, and the
 * renderer has no business choosing what the main process connects to — it says which
 * notifications interest it by what it does with them.
 *
 * The stream reconnects and resumes on its own (`../client/subscription.ts`), so nothing
 * here retries and nothing here notices a daemon restarting.
 */
let notifications: DaemonSubscription | undefined;

function broadcast(notification: NotificationMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("orca:notification", notification);
  }
}

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
      // `.cjs`, because a sandboxed preload is evaluated as a plain script and this package
      // is `"type": "module"` — an ESM preload is silently refused and `window.orca` never
      // exists. `tsconfig.preload.json` is what emits it; src/preload/index.cts has the why.
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
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
  notifications = client.subscribe({
    params: {},
    onNotification: (n) => broadcast({ kind: "notification", method: n.method, params: n.params }),
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Close the socket rather than leave the daemon fanning out to a process that is going.
app.on("before-quit", () => {
  notifications?.close();
  notifications = undefined;
});
