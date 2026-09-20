/**
 * Electron main process. Owns the daemon connection, the preferences file and the window;
 * the renderer only sees what the preload bridge exposes.
 *
 * Which daemon, in order: `ORCA_DAEMON_URL` if it is set, then the daemon bundled inside a
 * packaged app (`./daemon-process.ts`, spawned here and stopped on quit), then the default
 * local `orca serve` — which is the development case, where a developer is running one in
 * a terminal. This is the only file that knows all three; `daemon-process.ts` is Electron-
 * free so that it can be tested as a plain module.
 *
 * The window loads the built renderer from `dist/renderer` unless `ORCA_RENDERER_URL` is
 * set, which is what `pnpm --filter @orca/app dev` does to point it at the Vite dev
 * server for hot reload (scripts/dev.js).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme, Notification } from "electron";
import { rawTokens, type ThemeId } from "@orca/design";
import type { NotificationMessage } from "@orca/protocol";
import type { AlertItem, AlertsUpdate, BridgeResult, ConnectionSnapshot } from "../bridge.js";
import { DEFAULT_DAEMON_URL, DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import type { DaemonSubscription } from "../client/subscription.js";
import { PreferencesFile } from "../preferences/preferences-file.js";
import type { Preferences, ThemePreference } from "../preferences/schema.js";
import { createAlerts, type AlertTier } from "./alerts.js";
import { ConnectionMachine } from "./connection-state.js";
import { findBundledDaemon, startBundledDaemon, type BundledDaemon } from "./daemon-process.js";

/**
 * Reassigned once, by `connectToADaemon()`, when the app turns out to be talking to a
 * daemon it started itself. Every bridge handler reads it at call time and waits for
 * `daemonReady` first, so nothing below has to care which daemon it got.
 */
let client = new DaemonClient(process.env.ORCA_DAEMON_URL ?? DEFAULT_DAEMON_URL);
const preferences = new PreferencesFile(join(app.getPath("userData"), "preferences.json"));

/** The dev server's URL when `scripts/dev.js` started one; undefined in a packaged app. */
const rendererUrl = process.env.ORCA_RENDERER_URL;

/* ---------- the daemon ---------- */

/**
 * Resolves once the app knows which daemon it is talking to — which, for a packaged build,
 * means once the bundled daemon has answered `hello` on its port. The window is created
 * without waiting for it, so the shell paints while the daemon starts; a call that arrives
 * in that second or two waits here rather than going to the wrong URL and failing.
 *
 * It never rejects: `connectToADaemon` handles its own failure, because a daemon that would
 * not start is a disconnected status bar, not a desktop app that refuses to open.
 */
let daemonReady: Promise<void> = Promise.resolve();

/** The daemon this process started, if it started one. Undefined means nothing to stop. */
let bundled: BundledDaemon | undefined;

/**
 * Every bridge call answers rather than rejects: a rejection over the context bridge reaches
 * the renderer as a stringified `Error` with the main process's stack, which no screen can
 * render. See `../bridge.ts`.
 */
function handle<P, R>(channel: string, run: (params: P) => Promise<R>): void {
  ipcMain.handle(channel, async (_event, params: P): Promise<BridgeResult<R>> => {
    try {
      await daemonReady;
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
handle("orca:artifacts.list", (params: Parameters<DaemonClient["artifactsList"]>[0]) => client.artifactsList(params));
handle("orca:artifacts.get", (params: Parameters<DaemonClient["artifactsGet"]>[0]) => client.artifactsGet(params));
handle("orca:agents.list", (params: Parameters<DaemonClient["agentsList"]>[0]) => client.agentsList(params));
// The three that write (#160, #161). They reach the daemon the same way the reads do; what
// makes them different is on the other two sides — the daemon refuses them without the
// run's lease, and the renderer asks `useWritability()` before offering the control at all.
// `runs.start` is absent on purpose: it needs a workflow picker (#178, v0.5.0).
handle("orca:inputs.answer", (params: Parameters<DaemonClient["inputsAnswer"]>[0]) => client.inputsAnswer(params));
handle("orca:runs.cancel", (params: Parameters<DaemonClient["runsCancel"]>[0]) => client.runsCancel(params));
handle("orca:runs.resume", (params: Parameters<DaemonClient["runsResume"]>[0]) => client.runsResume(params));

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

/* ---------- the connection state ---------- */

/**
 * One connection state for the whole app, decided here because this is the only place that
 * can see the socket, the bundled daemon's exit and the handshake at once (see
 * `./connection-state.ts`). Built before `whenReady` so that a window opening at any moment
 * has a state to read rather than a hole; `client` is read at call time, so the machine
 * follows the reassignment `connectToADaemon` may make.
 */
const connection = new ConnectionMachine({
  hello: () => client.hello(`orca-app/${app.getVersion()}`),
  onChange: (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("orca:connection", snapshot);
    }
  },
});

// Synchronous, like `preferences.read`: the chrome draws the status bar on its first pass.
ipcMain.on("orca:connection.read", (event) => {
  event.returnValue = connection.current satisfies ConnectionSnapshot;
});

/* ---------- the bundled daemon ---------- */

/**
 * Settle on a daemon and open the push stream to it. Called once, from `whenReady`.
 *
 * `ORCA_DAEMON_URL` wins outright: someone who points the app at a daemon on another
 * machine, or at the one their terminal is running, has said what they want and starting a
 * second one beside it would only confuse the question of which store is on screen.
 *
 * The workspace the bundled daemon serves is `ORCA_WORKSPACE`, or the user's home
 * directory. Home is a placeholder with a known shape — `orca serve` reads `~/.orca` and
 * answers an empty run list rather than failing — and choosing a workspace in the app is
 * #164's. That issue changes the argument passed here, not the mechanism.
 */
async function connectToADaemon(): Promise<void> {
  const explicit = process.env.ORCA_DAEMON_URL;
  const entry = explicit
    ? undefined
    : findBundledDaemon([
        // A packaged app: electron-builder's `extraResources`, beside `app.asar`.
        process.resourcesPath,
        // A build run from the repository: `dist/`, one level up from `dist/main`.
        fileURLToPath(new URL("../", import.meta.url)),
      ]);
  if (entry) {
    try {
      bundled = await startBundledDaemon({
        entry,
        cwd: process.env.ORCA_WORKSPACE ?? app.getPath("home"),
        onLog: (line) => console.error(`[daemon] ${line}`),
        onExit: (exit) => {
          console.error(`the bundled daemon exited on its own (code ${exit.code}, signal ${exit.signal})`);
          // The socket will go on retrying, but a daemon this process started and then
          // watched exit is not coming back on its own: that is `disconnected`, not
          // `reconnecting`, and the difference is the whole of what the status bar says.
          connection.daemonExited();
        },
      });
      client = new DaemonClient(bundled.url);
    } catch (e) {
      // The window still opens, on a status bar that reads disconnected. A desktop app
      // that refuses to start because its daemon would not is a worse failure than one
      // that shows you it has no daemon.
      console.error(`the bundled daemon did not start; the app will look for one on ${client.url}`);
      console.error(e instanceof Error ? e.message : String(e));
    }
  }
  notifications = client.subscribe({
    params: {},
    onNotification: (n) => {
      broadcast({ kind: "notification", method: n.method, params: n.params });
      // The cursor the stream would resume from. A sequence number is per-run, so this
      // store-wide subscription has none and the status bar shows no event number — see
      // the note on `ConnectionMachine.sawCursor`.
      connection.sawCursor(notifications?.lastSeq);
    },
    onState: (state) => connection.linkChanged(state),
  });
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

/* ---------- OS notifications ---------- */

/**
 * The Electron half of `./alerts.ts` (#162). One `Notification` per tier, kept so a second
 * ask can update the one already showing instead of stacking a second behind it, and a
 * badge that carries the same one number the title bar and the sidebar show.
 *
 * Nothing here decides *whether* to post: the tier table, the 60-second gate delay and the
 * unfocused escalation are all in the module, which is Electron-free so that they can be
 * tested with fake timers.
 */
const liveAlerts = new Map<AlertTier, Notification>();

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.isFocused());
}

/** Tell every open window a person clicked a notification, or that Attention should come forward. */
function activate(item: AlertItem | undefined): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("orca:alerts.activate", item ? { item } : {});
  }
}

const alerts = createAlerts(
  {
    show: ({ tier, title, body, item }) => {
      if (!Notification.isSupported()) return;
      // Closed and replaced rather than mutated: `Notification.title` is writable but only
      // some platforms redraw a notification that is already on screen, and a stale count
      // is worse than a redraw.
      liveAlerts.get(tier)?.close();
      const notification = new Notification({ title, body });
      // Focus the window the person is coming back to, which is the one thing a click on a
      // notification is allowed to do — the *card* it opens is #165's route table, and
      // `activate` already carries the item a route will be built from.
      notification.on("click", () => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        win?.show();
        activate(item);
      });
      liveAlerts.set(tier, notification);
      notification.show();
    },
    dismiss: (tier) => {
      liveAlerts.get(tier)?.close();
      liveAlerts.delete(tier);
    },
    badge: (count) => {
      // `setBadgeCount` is the dock on macOS, the launcher badge on Linux, and a no-op on
      // Windows (where the taskbar wants an overlay icon there is no artwork for yet).
      if (typeof app.setBadgeCount === "function") app.setBadgeCount(count);
    },
    isFocused: () => focusedWindow() !== undefined,
    // Inside the focused window only, and never `show()`: a permission ask may take the
    // person's attention where they already are, and may not move a window at them
    // (docs/design/20-attention-and-gates.md).
    focusAttention: (item) => focusedWindow()?.webContents.send("orca:alerts.activate", { item }),
  },
  () => preferences.read().alerts,
);

ipcMain.on("orca:alerts.update", (_event, update: AlertsUpdate) => alerts.update(update));

app.on("browser-window-focus", () => alerts.focusChanged(true));
app.on("browser-window-blur", () => alerts.focusChanged(false));

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
  daemonReady = connectToADaemon();
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
  connection.close();
  alerts.close();
});

/**
 * A daemon this process started has to die with it: an orphan holding a port is the thing
 * a user notices the second time they launch the app. `will-quit` is the last event before
 * the process goes, and stopping is asynchronous, so the first pass defers the quit and the
 * second — after `bundled` is cleared — lets it through.
 */
app.on("will-quit", (event) => {
  const daemon = bundled;
  if (!daemon) return;
  bundled = undefined;
  event.preventDefault();
  void daemon.stop().finally(() => app.quit());
});
