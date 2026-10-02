/**
 * Electron main process. Owns the daemon connection, the preferences file, the application
 * menu and the window; the renderer only sees what the preload bridge exposes.
 *
 * Which daemon, in order: `ORCA_DAEMON_URL` if it is set, then the daemon bundled inside a
 * packaged app (`./daemon-process.ts`, spawned here and stopped on quit), then the default
 * local `orca serve` — which is the development case, where a developer is running one in
 * a terminal. This is the only file that knows all three; `daemon-process.ts` is Electron-
 * free so that it can be tested as a plain module. **Which store that daemon serves is
 * `./workspace.ts`'s**, because it can change while the app is running (#164), and every
 * bridge call waits on the switch rather than on a promise that resolved once at startup.
 *
 * The other thing that arrives from outside is an `orca://` URL (#165). The three ways an
 * operating system delivers one — a cold start's `argv`, `open-url`, `second-instance` —
 * are folded into `./deep-link.ts` here and resolved by one route table in the renderer.
 *
 * The window loads the built renderer from `dist/renderer` unless `ORCA_RENDERER_URL` is
 * set, which is what `pnpm --filter @orca/app dev` does to point it at the Vite dev
 * server for hot reload (scripts/dev.js).
 */
import { isUpdateAction, prepareDrafts } from "./update-ipc.js";
import { Updates } from "./updates.js";
import { updateDriver } from "./update-driver.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification } from "electron";
import { rawTokens, type ThemeId } from "@orca/design";
import type { NotificationMessage } from "@orca/protocol";
import type { AlertItem, AlertsUpdate, BridgeResult, ConnectionSnapshot, WorkspaceSnapshot } from "../bridge.js";
import { DEFAULT_DAEMON_URL, DaemonClient, DaemonClientError } from "../client/daemon-client.js";
import { LocalDaemonToken } from "../client/auth.js";
import { PreferencesFile } from "../preferences/preferences-file.js";
import type { Preferences, ThemePreference } from "../preferences/schema.js";
import { appMenuTemplate } from "./app-menu.js";
import { createAlerts, type AlertTier } from "./alerts.js";
import { ConnectionMachine } from "./connection-state.js";
import { DeepLinkQueue, ORCA_SCHEME, protocolClientArgs, urlFromArgv } from "./deep-link.js";
import { findBundledDaemon, startBundledDaemon } from "./daemon-process.js";
import { storeRoot, Workspace } from "./workspace.js";

const preferences = new PreferencesFile(join(app.getPath("userData"), "preferences.json"));

/** The dev server's URL when `scripts/dev.js` started one; undefined in a packaged app. */
const rendererUrl = process.env.ORCA_RENDERER_URL;

/* ---------- one app, one window onto a store ---------- */

/**
 * A second launch is not a second app. Without the lock, following an `orca://` link on
 * Windows or Linux starts another process with another window onto the same store — two
 * copies of one run tree, and the link opening in the one nobody was looking at. With it,
 * the second process exits and hands its command line to this one as `second-instance`
 * (#165); macOS never starts a second process and sends `open-url` instead.
 */
const primary = app.requestSingleInstanceLock();

const deepLinks = new DeepLinkQueue();

/** The URL this process was started for, on the platforms that put it in the command line. */
deepLinks.offer(urlFromArgv(process.argv));

/* ---------- the daemon ---------- */

/**
 * Every bridge call answers rather than rejects: a rejection over the context bridge reaches
 * the renderer as a stringified `Error` with the main process's stack, which no screen can
 * render. See `../bridge.ts`.
 *
 * `workspace.ready()` is what the old `daemonReady` promise was, awaited on every call
 * rather than only on the first ones: the app can be re-pointed at another store while it
 * runs, so "which daemon" has a new answer each time rather than a settled one.
 */
function handle<P, R>(channel: string, run: (params: P) => Promise<R>): void {
  ipcMain.handle(channel, async (_event, params: P): Promise<BridgeResult<R>> => {
    try {
      await workspace.ready();
      return { ok: true, result: await run(params) };
    } catch (e) {
      if (e instanceof DaemonClientError) return { ok: false, error: e.error };
      return { ok: false, error: { code: "AGENT_TRANSPORT", message: e instanceof Error ? e.message : String(e) } };
    }
  });
}

/** The client of the moment, read at call time and never captured. */
const client = (): DaemonClient => workspace.client;

handle("orca:hello", () => client().hello(`orca-app/${app.getVersion()}`));
handle("orca:runs.list", (params: Parameters<DaemonClient["runsList"]>[0]) => client().runsList(params));
handle("orca:runs.get", (params: Parameters<DaemonClient["runsGet"]>[0]) => client().runsGet(params));
handle("orca:runs.events", (params: Parameters<DaemonClient["runsEvents"]>[0]) => client().runsEvents(params));
handle("orca:inputs.list", (params: Parameters<DaemonClient["inputsList"]>[0]) => client().inputsList(params));
handle("orca:claims.list", (params: Parameters<DaemonClient["claimsList"]>[0]) => client().claimsList(params));
handle("orca:artifacts.list", (params: Parameters<DaemonClient["artifactsList"]>[0]) => client().artifactsList(params));
handle("orca:artifacts.get", (params: Parameters<DaemonClient["artifactsGet"]>[0]) => client().artifactsGet(params));
handle("orca:agents.list", (params: Parameters<DaemonClient["agentsList"]>[0]) => client().agentsList(params));
// The workflow viewer's two reads (#174, for #177). Reads like the ones above: a
// `--read-only` daemon answers both, because a workflow is a file and not a run.
handle("orca:workflows.list", (params: Parameters<DaemonClient["workflowsList"]>[0]) => client().workflowsList(params));
handle("orca:workflows.get", (params: Parameters<DaemonClient["workflowsGet"]>[0]) => client().workflowsGet(params));
handle("orca:config.get", (params: Parameters<DaemonClient["configGet"]>[0]) => client().configGet(params));

// The plan reads (#169). Same channel shape as the run reads; the daemon omits all nine when
// it serves no plan, so a surface checks `hello.methods` rather than calling and failing.
handle("orca:plans.list", (params: Parameters<DaemonClient["plansList"]>[0]) => client().plansList(params));
handle("orca:plan.get", (params: Parameters<DaemonClient["planGet"]>[0]) => client().planGet(params));
handle("orca:items.list", (params: Parameters<DaemonClient["itemsList"]>[0]) => client().itemsList(params));
handle("orca:schedule.get", (params: Parameters<DaemonClient["scheduleGet"]>[0]) => client().scheduleGet(params));
handle("orca:schedule.explain", (params: Parameters<DaemonClient["scheduleExplain"]>[0]) =>
  client().scheduleExplain(params),
);
handle("orca:dependencies.list", (params: Parameters<DaemonClient["dependenciesList"]>[0]) =>
  client().dependenciesList(params),
);
handle("orca:risks.list", (params: Parameters<DaemonClient["risksList"]>[0]) => client().risksList(params));
handle("orca:decisions.list", (params: Parameters<DaemonClient["decisionsList"]>[0]) => client().decisionsList(params));
handle("orca:journal.list", (params: Parameters<DaemonClient["journalList"]>[0]) => client().journalList(params));

// The four that write a run (#160, #161, #178). They reach the daemon the same way the
// reads do; what makes them different is on the other two sides - the daemon refuses them
// without the run's lease, and the renderer asks `useWritability()` before offering the
// control at all. `runs.start` needs no lease: there is no run to hold one yet.
handle("orca:inputs.answer", (params: Parameters<DaemonClient["inputsAnswer"]>[0]) => client().inputsAnswer(params));
handle("orca:runs.cancel", (params: Parameters<DaemonClient["runsCancel"]>[0]) => client().runsCancel(params));
handle("orca:runs.resume", (params: Parameters<DaemonClient["runsResume"]>[0]) => client().runsResume(params));
handle("orca:runs.start", (params: Parameters<DaemonClient["runsStart"]>[0]) => client().runsStart(params));
// The fourth (#174, #266). It writes a file rather than a run, so no lease is involved, but
// it is still absent from a `--read-only` daemon and `useWritability()` still governs it.
handle("orca:config.set", (params: Parameters<DaemonClient["configSet"]>[0]) => client().configSet(params));

// The plan writes and `claims.release` (#169, #88). `--read-only` omits them exactly as it
// omits the three above, so the same `useWritability()` answer covers all of them.
handle("orca:dependencies.waive", (params: Parameters<DaemonClient["dependenciesWaive"]>[0]) =>
  client().dependenciesWaive(params),
);
handle("orca:decisions.decide", (params: Parameters<DaemonClient["decisionsDecide"]>[0]) =>
  client().decisionsDecide(params),
);
handle("orca:decisions.reopen", (params: Parameters<DaemonClient["decisionsReopen"]>[0]) =>
  client().decisionsReopen(params),
);
handle("orca:risks.update", (params: Parameters<DaemonClient["risksUpdate"]>[0]) => client().risksUpdate(params));
handle("orca:claims.release", (params: Parameters<DaemonClient["claimsRelease"]>[0]) => client().claimsRelease(params));

/** Everything the main process pushes goes out the same way: every window, none destroyed. */
function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * One socket for the whole app, store-wide, forwarded to every open window. A subscription
 * per window would mean one daemon connection per window showing the same runs, and the
 * renderer has no business choosing what the main process connects to — it says which
 * notifications interest it by what it does with them.
 *
 * The stream reconnects and resumes on its own (`../client/subscription.ts`), so nothing
 * here retries and nothing here notices a daemon restarting. A daemon *swap* is a different
 * thing and belongs to the workspace, which closes this stream and opens another.
 */
function broadcast(notification: NotificationMessage): void {
  send("orca:notification", notification);
}

/* ---------- the connection state ---------- */

/**
 * One connection state for the whole app, decided here because this is the only place that
 * can see the socket, the bundled daemon's exit and the handshake at once (see
 * `./connection-state.ts`). Built before `whenReady` so that a window opening at any moment
 * has a state to read rather than a hole; the client is read at call time, so the machine
 * follows every switch the workspace makes.
 */
const connection = new ConnectionMachine({
  hello: () => client().hello(`orca-app/${app.getVersion()}`),
  onChange: (snapshot) => send("orca:connection", snapshot),
});

// Synchronous, like `preferences.read`: the chrome draws the status bar on its first pass.
ipcMain.on("orca:connection.read", (event) => {
  event.returnValue = connection.current satisfies ConnectionSnapshot;
});

/* ---------- the workspace ---------- */

/**
 * The store on screen, and the daemon serving it. Everything Electron knows and the module
 * must not — where the resources are, what the home directory is, what the environment
 * said — arrives here as a dependency, which is what keeps the switch itself a plain test.
 */
const workspace = new Workspace({
  findEntry: () =>
    findBundledDaemon([
      // A packaged app: electron-builder's `extraResources`, beside `app.asar`.
      process.resourcesPath,
      // A build run from the repository: `dist/`, one level up from `dist/main`.
      fileURLToPath(new URL("../", import.meta.url)),
    ]),
  start: ({ entry, cwd, readOnly, onExit }) =>
    startBundledDaemon({
      entry,
      cwd,
      // The one flag the app passes, through the seam `daemon-process.ts` left for it:
      // file mode *is* a read-only daemon, because ADR 0008 forbids a second store path
      // in the renderer (#164).
      ...(readOnly ? { args: ["--read-only"] } : {}),
      onLog: (line) => console.error(`[daemon] ${line}`),
      onExit: (exit) => {
        console.error(`the bundled daemon exited on its own (code ${exit.code}, signal ${exit.signal})`);
        // The socket will go on retrying, but a daemon this process started and then
        // watched exit is not coming back on its own: that is `disconnected`, not
        // `reconnecting`, and the difference is the whole of what the status bar says.
        connection.daemonExited();
        onExit(exit);
      },
    }),
  client: (url, options) =>
    new DaemonClient(url, fetch, {
      auth: new LocalDaemonToken({
        url,
        workspace: options.workspace,
        ...(options.tokenFile ? { tokenFile: options.tokenFile } : {}),
        // A spawned daemon issues its own token. A remote override in the app's environment
        // belongs to the explicitly connected daemon, never to a newly opened local store.
        ...(options.bundled ? { env: {} } : {}),
      }),
      onAuthFailure: () => connection.authenticationFailed(),
    }),
  subscribe: (daemonClient) =>
    daemonClient.subscribe({
      params: {},
      onNotification: (n) => {
        broadcast({ kind: "notification", method: n.method, params: n.params });
        // The cursor the stream would resume from. A sequence number is per-run, so this
        // store-wide subscription has none and the status bar shows no event number — see
        // the note on `ConnectionMachine.sawCursor`.
        connection.sawCursor(workspace.subscription?.lastSeq);
      },
      // The retry count comes with the word because `reconnecting` alone cannot say how
      // long it has been failing, which is what decides `disconnected` now (#239).
      onState: (state, retries) => connection.linkChanged(state, retries),
    }),
  onSwitch: (fileMode) => connection.reset(fileMode),
  onSnapshot: (snapshot) => send("orca:workspace", snapshot),
  // A chosen store whose daemon would not start is not connected to anything (#269). The
  // machine's own input for "there is no daemon" is the one to use, so the status bar reads
  // `disconnected` through the same path as a daemon that exited, and the reason is on the
  // console beside it rather than in a field the renderer has no rendering for.
  onDaemonGone: () => connection.daemonExited(),
  onError: (message, cause) => {
    // The window still opens, on a status bar that reads disconnected. A desktop app that
    // refuses to start because its daemon would not is a worse failure than one that shows
    // you it has no daemon.
    console.error(message);
    console.error(cause instanceof Error ? cause.message : String(cause));
  },
  explicitUrl: process.env.ORCA_DAEMON_URL,
  defaultUrl: DEFAULT_DAEMON_URL,
  defaultPath: () => process.env.ORCA_WORKSPACE ?? app.getPath("home"),
});

ipcMain.on("orca:workspace.read", (event) => {
  event.returnValue = workspace.snapshot satisfies WorkspaceSnapshot;
});

/** The dialog behind File ▸ Open a store…, and behind the file-mode banner's own button. */
const OPEN_STORE_DIALOG = {
  title: "Open a store",
  // A workspace directory rather than a file: a store is `<workspace>/.orca`, and the
  // daemon is pointed at the workspace above it.
  properties: ["openDirectory" as const],
  buttonLabel: "Open read-only",
};

/**
 * Open a store read-only. A path from the renderer is used as given; without one the
 * directory is asked for here, because a dialog belongs to the process that owns the
 * window. Cancelling answers the workspace unchanged — a cancelled dialog is not an error
 * and must not be rendered as one.
 */
async function openStore(path?: string): Promise<WorkspaceSnapshot> {
  let chosen = path;
  if (chosen === undefined) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await (window
      ? dialog.showOpenDialog(window, OPEN_STORE_DIALOG)
      : dialog.showOpenDialog(OPEN_STORE_DIALOG));
    if (result.canceled) return workspace.snapshot;
    chosen = result.filePaths[0];
    if (chosen === undefined) return workspace.snapshot;
  }
  return workspace.open(storeRoot(chosen));
}

handle("orca:workspace.open", (params: { path?: string }) => openStore(params.path));
handle("orca:workspace.connectLive", () => workspace.connectLive());

/* Updates use their own IPC and never wait on daemon readiness to check/download. */
const updates = new Updates(
  updateDriver(app.isPackaged, process.platform, process.arch),
  app.getVersion(),
  {
    prepareDrafts: () =>
      prepareDrafts({
        ids: BrowserWindow.getAllWindows().map((win) => win.webContents.id),
        send: (nonce) => send("orca:update.prepare", nonce),
        listen: (callback) => {
          const listener = (event: Electron.IpcMainEvent, value: unknown) => {
            if (event.senderFrame === event.sender.mainFrame) callback(event.sender.id, value);
          };
          ipcMain.on("orca:update.prepared", listener);
          return () => {
            ipcMain.off("orca:update.prepared", listener);
          };
        },
      }),
    prepareDaemon: (token) => workspace.prepareUpdate(token),
    stopDaemon: () => workspace.stopForUpdate(),
    resume: (token) => workspace.cancelUpdate(token),
    releaseDrafts: () => send("orca:update.prepare", null),
  },
  (state) => send("orca:update", state),
);
ipcMain.on("orca:update.read", (event) => {
  event.returnValue = updates.state;
});
ipcMain.handle("orca:update.act", async (event, action: unknown) => {
  if (
    !BrowserWindow.getAllWindows().some((win) => win.webContents === event.sender) ||
    event.senderFrame !== event.sender.mainFrame ||
    !isUpdateAction(action)
  ) {
    return { ok: false, error: { code: "UPDATE", message: "Invalid update request" } };
  }
  return { ok: true, result: await updates.act(action) };
});

/* ---------- deep links ---------- */

// Synchronous and draining: a link is delivered to one reader once (`./deep-link.ts`).
ipcMain.on("orca:deepLink.take", (event) => {
  event.returnValue = deepLinks.take();
});

/** Bring the window forward. A link that opens behind the browser is a link that was lost. */
function focusWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

deepLinks.subscribe((url) => {
  focusWindow();
  send("orca:deepLink", url);
});

/**
 * macOS, for a running app — and for one that is still starting, which is why the queue
 * holds a URL rather than requiring a window. `preventDefault` is required, or Electron
 * logs the event as unhandled.
 */
app.on("open-url", (event, url) => {
  event.preventDefault();
  deepLinks.offer(url);
});

/** Windows and Linux: the second launch's command line, courtesy of the single-instance lock. */
app.on("second-instance", (_event, argv) => {
  focusWindow();
  deepLinks.offer(urlFromArgv(argv));
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

if (!primary) {
  // Another copy holds the lock and has already been handed this process's command line,
  // so quitting here is what makes the link open over there.
  app.quit();
} else {
  void app.whenReady().then(() => {
    applyTheme(preferences.read().theme);
    /* Registering the scheme is what makes `orca://` reach this app at all. In development
       the executable is Electron itself and the app is an argument to it, which is what
       `protocolClientArgs` supplies; a packaged app is its own executable and needs none. */
    app.setAsDefaultProtocolClient(ORCA_SCHEME, process.execPath, [
      ...(protocolClientArgs(app.isPackaged, process.argv) ?? []),
    ]);
    /* The app had no menu at all until there was something to put in one. Replacing the
       default menu also replaces the Edit menu, which on macOS is where ⌘C lives — so
       `appMenuTemplate` restates the standard roles rather than dropping them. */
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        appMenuTemplate(
          process.platform,
          app.getName(),
          { openStore: () => void openStore(), connectLive: () => void workspace.connectLive() },
          rendererUrl !== undefined,
        ),
      ),
    );
    // Not awaited: the shell paints while the daemon starts, and a call that arrives in
    // that second or two waits on `workspace.ready()` rather than going to the wrong URL.
    void workspace.connect();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Stop pushing at a process that is going.
app.on("before-quit", () => {
  connection.close();
  alerts.close();
});

/**
 * A daemon this process started has to die with it: an orphan holding a port is the thing
 * a user notices the second time they launch the app. `will-quit` is the last event before
 * the process goes, and closing the workspace is asynchronous, so the first pass defers the
 * quit and the second — after `quitting` is set — lets it through.
 *
 * Two things here are deliberate, and both are about a quit that must not be able to hang:
 *
 * - **The re-quit is on the next tick.** Calling `app.quit()` from a continuation of the
 *   very dispatch that cancelled the quit is asking Electron to start a sequence it still
 *   believes it is in; `setImmediate` puts it after that sequence has unwound.
 * - **Closing is bounded.** A daemon that will not answer `stop()` already gets a SIGKILL
 *   with its own deadline, but nothing else in this path is allowed to hold the window
 *   open either: after `SHUTDOWN_DEADLINE_MS` the app leaves anyway. An app that will not
 *   close is a worse thing to ship than a stray child process, which the OS reaps.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;
let quitting = false;
app.on("will-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref?.());
  void Promise.race([workspace.close(), deadline]).finally(() => setImmediate(() => app.quit()));
});
