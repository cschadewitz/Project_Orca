/** Applied-patch regression: invoke the real main IPC handlers with Electron at the boundary. */
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import type { DaemonClient } from "../src/client/daemon-client.js";
import type { Workspace } from "../src/main/workspace.js";
import { DaemonSubscription } from "../src/client/subscription.js";
import type { AlertsUpdate, BridgeResult, ConnectionSnapshot, WorkspaceSnapshot } from "../src/bridge.js";
import type { DaemonTargetSnapshot } from "../src/daemon-connection.js";
import type { OwnedDiagnosticObserver } from "../src/main/diagnostics/source-producers.js";

const shell = vi.hoisted(() => ({
  userData: "",
  home: "",
  workspace: undefined as Workspace | undefined,
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  rendererEvents: new Map<string, () => void>(),
  events: undefined as EventEmitter | undefined,
  appEvents: undefined as EventEmitter | undefined,
  powerEvents: undefined as EventEmitter | undefined,
  windowEvents: undefined as EventEmitter | undefined,
  contentEvents: undefined as EventEmitter | undefined,
  webContents: undefined as { id: number; mainFrame: object } | undefined,
  ready: true,
  startReady: false,
  replacementBootstrap: undefined as
    { ordinaryAllowed: boolean; existingWorkAllowed?: boolean; inspect: () => Promise<unknown> } | undefined,
  replacementMounted: vi.fn(),
  replacementReleased: vi.fn(async () => {}),
  replacementClosed: vi.fn(async () => {}),
  quit: vi.fn(),
  relaunch: vi.fn(),
  packaged: false,
  replacementResettable: false,
  replacementReset: vi.fn(async () => true),
  resetChoice: vi.fn(async () => ({ response: 0 })),
  recoveryMessage: vi.fn(),
  hasWindow: true,
  nativeEnabled: true,
  createWindow: vi.fn(),
  openDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/archive/.orca"] })),
  sent: vi.fn(),
  stop: vi.fn(async () => {}),
  badge: vi.fn(),
  notificationShow: vi.fn(),
  notificationClose: vi.fn(),
  keyWrap: vi.fn(async () => Buffer.alloc(0)),
  keyUnwrap: vi.fn(async () => ""),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const events = new EventEmitter();
  shell.events = events;
  const appEvents = new EventEmitter();
  shell.appEvents = appEvents;
  const powerEvents = new EventEmitter();
  shell.powerEvents = powerEvents;
  const contentEvents = new EventEmitter();
  shell.contentEvents = contentEvents;
  const webContents = {
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    setWindowOpenHandler: vi.fn(),
    id: 1,
    mainFrame: {},
    on: (event: string, listener: () => void) => {
      contentEvents.on(event, listener);
      shell.rendererEvents.set(event, () => {
        contentEvents.emit(event);
      });
    },
    once: (event: string, listener: () => void) => contentEvents.once(event, listener),
    off: (event: string, listener: () => void) => contentEvents.off(event, listener),
    send: (channel: string, value: unknown) => {
      shell.sent(channel, value);
      if (channel === "orca:macUpdate.prepare")
        events.emit(
          "orca:macUpdate.prepared",
          { sender: webContents, senderFrame: webContents.mainFrame },
          { ...(value as object), ready: shell.ready },
        );
      if (channel === "orca:update.prepare" && typeof value === "string")
        events.emit(
          "orca:update.prepared",
          { sender: webContents, senderFrame: webContents.mainFrame },
          { nonce: value, ready: shell.ready },
        );
    },
  };
  shell.webContents = webContents;
  const window = Object.assign(new EventEmitter(), {
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => false,
    show: vi.fn(),
    webContents,
    isEnabled: () => shell.nativeEnabled,
    setEnabled: (value: boolean) => {
      shell.nativeEnabled = value;
    },
    once: vi.fn(),
    loadFile: vi.fn(),
  });
  shell.windowEvents = window;
  return {
    safeStorage: {
      isEncryptionAvailable: () => false,
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: shell.keyWrap,
      decryptStringAsync: shell.keyUnwrap,
    },
    app: {
      getPath: (name: string) => (name === "userData" ? shell.userData : shell.home || "/launch-workspace"),
      requestSingleInstanceLock: () => true,
      getVersion: () => "0.6.0",
      getName: () => "ORCA",
      get isPackaged() {
        return shell.packaged;
      },
      relaunch: shell.relaunch,
      setAsDefaultProtocolClient: vi.fn(),
      setBadgeCount: shell.badge,
      // Test bootstrap explicitly; creating a real BrowserWindow is outside this IPC regression.
      whenReady: () => (shell.startReady ? Promise.resolve() : new Promise(() => {})),
      on: (event: string, listener: (...args: unknown[]) => void) => appEvents.on(event, listener),
      quit: shell.quit,
    },
    BrowserWindow: class {
      constructor() {
        shell.createWindow();
        shell.hasWindow = true;
        return window;
      }
      static getAllWindows() {
        return shell.hasWindow ? [window] : [];
      }
      static getFocusedWindow() {
        return this.getAllWindows()[0];
      }
      static fromWebContents(sender: unknown) {
        return sender === webContents ? this.getAllWindows()[0] : undefined;
      }
    },
    ipcMain: Object.assign(events, {
      handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        shell.handlers.set(channel, handler);
      },
    }),
    nativeTheme: { on: vi.fn() },
    dialog: {
      showOpenDialog: shell.openDialog,
      showErrorBox: shell.recoveryMessage,
      showMessageBox: shell.resetChoice,
    },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: vi.fn() },
    powerMonitor: powerEvents,
    Notification: class {
      static isSupported() {
        return true;
      }
      on = vi.fn();
      show = shell.notificationShow;
      close = shell.notificationClose;
    },
  };
});
vi.mock("../src/main/mac-managed-replacement-startup.js", () => ({
  createManagedMacReplacementStartup: (options: unknown) => {
    shell.replacementMounted(options);
    if (!shell.replacementBootstrap) throw new Error("Synthetic bootstrap fixture missing");
    return {
      bootstrap: shell.replacementBootstrap,
      initialize: () => shell.replacementBootstrap!.inspect(),
      get resettable() {
        return shell.replacementResettable;
      },
      reset: shell.replacementReset,
      releasePausedAppWriter: shell.replacementReleased,
      close: shell.replacementClosed,
    };
  },
}));
vi.mock("../src/main/workspace.js", async (original) => {
  const actual = await original<typeof import("../src/main/workspace.js")>();
  return {
    ...actual,
    Workspace: class extends actual.Workspace {
      constructor(deps: ConstructorParameters<typeof actual.Workspace>[0]) {
        super(deps);
        shell.workspace = this;
      }
    },
  };
});
vi.mock("../src/main/daemon-process.js", () => ({
  findBundledDaemon: () => "daemon.mjs",
  startBundledDaemon: async () => ({ url: "http://localhost:8888", pid: 1, stop: shell.stop }),
}));
vi.mock("../src/main/update-driver.js", () => ({ updateDriver: () => undefined }));

let directory: string;
beforeEach(() => {
  vi.resetModules();
  shell.events?.removeAllListeners();
  shell.appEvents?.removeAllListeners();
  shell.powerEvents?.removeAllListeners();
  shell.windowEvents?.removeAllListeners();
  shell.contentEvents?.removeAllListeners();
  shell.handlers.clear();
  shell.rendererEvents.clear();
  shell.workspace = undefined;
  shell.home = "";
  shell.ready = true;
  shell.startReady = false;
  shell.replacementBootstrap = undefined;
  shell.replacementMounted.mockClear();
  shell.replacementReleased.mockClear();
  shell.replacementClosed.mockClear();
  shell.quit.mockClear();
  shell.relaunch.mockClear();
  shell.packaged = false;
  shell.replacementResettable = false;
  shell.replacementReset.mockClear();
  shell.resetChoice.mockReset();
  shell.resetChoice.mockResolvedValue({ response: 0 });
  shell.recoveryMessage.mockClear();
  shell.hasWindow = true;
  shell.nativeEnabled = true;
  shell.createWindow.mockClear();
  shell.stop.mockClear();
  shell.sent.mockClear();
  shell.badge.mockClear();
  shell.notificationShow.mockClear();
  shell.notificationClose.mockClear();
  shell.keyWrap.mockClear();
  shell.keyUnwrap.mockClear();
});

it("mounts closed template commands and gates same-boot setup throughout an updater reservation", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-composed-authoring-ipc-"));
  shell.userData = directory;
  const { FirstRunSetup } = await import("../src/main/first-run/setup.js");
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  const operations = [
    "prepareRecovery",
    "reconcileRecovery",
    "endPreviousSession",
    "reviewConfiguration",
    "cancelConfigurationReview",
    "bindConfiguration",
  ] as const;
  const calls = operations.map((method) =>
    vi.spyOn(FirstRunSetup.prototype, method).mockResolvedValue({ state: "selection-required", reason: "fixture" }),
  );
  const rpc = vi.spyOn(DaemonClient.prototype, "call").mockResolvedValue({});
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  const sender = shell.webContents!;
  const event = { sender, senderFrame: sender.mainFrame };
  const epoch = workspace.connectionTarget.epoch;
  const reserved = vi.spyOn(workspace, "macUpdateReserved", "get").mockReturnValue(true);
  const review = "11111111-1111-4111-8111-111111111111";
  const inputs = [undefined, review, review, undefined, undefined, review];
  for (const [index, method] of operations.entries()) {
    expect(await shell.handlers.get(`orca:workspace.firstRun.${method}`)!(event, inputs[index], epoch)).toMatchObject({
      ok: false,
    });
    expect(calls[index]).not.toHaveBeenCalled();
  }
  reserved.mockReturnValue(false);
  for (const [index, method] of operations.entries()) {
    expect(await shell.handlers.get(`orca:workspace.firstRun.${method}`)!(event, inputs[index], epoch)).toMatchObject({
      ok: true,
    });
    expect(calls[index]).toHaveBeenCalledOnce();
  }
  const templates = shell.handlers.get("orca:templates")!;
  expect(await templates(event, { method: "runs.start", params: {} }, epoch)).toMatchObject({ ok: false });
  expect(rpc).not.toHaveBeenCalled();
  expect(await templates(event, { method: "templates.get", params: {} }, epoch + 1)).toMatchObject({ ok: false });
  expect(rpc).not.toHaveBeenCalled();
  expect(await templates(event, { method: "templates.get", params: {} }, epoch)).toMatchObject({ ok: true });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("templates.get", {}, expect.anything());
});

it("dispatches verified opt-out before diagnostics initialization while opt-in waits", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-diagnostics-revocation-ipc-"));
  shell.userData = directory;
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const initialize = vi.spyOn(RecoveryController.prototype, "initialize").mockReturnValue(waiting);
  const revoked = vi.spyOn(RecoveryController.prototype, "revokeAuthority");
  const choices = vi.spyOn(RecoveryController.prototype, "setEnabled");
  await import("../src/main/index.js");
  const sender = shell.webContents!;
  const event = { sender, senderFrame: sender.mainFrame };
  const epoch = shell.workspace!.connectionTarget.epoch;
  const invoke = (enabled: boolean) =>
    shell.handlers.get("orca:diagnostics.setEnabled")!(event, { enabled, scopeVersion: 1 }, epoch);
  const off = invoke(false);
  expect(revoked).toHaveBeenCalledOnce();
  expect(initialize).not.toHaveBeenCalled();
  // The shipping native adapter refuses persistence; logical revocation still
  // occurs immediately and the cleanup failure remains visible.
  expect(await off).toMatchObject({ ok: false, code: "cleanup_pending" });
  const on = invoke(true);
  expect(initialize).toHaveBeenCalledOnce();
  expect(choices).toHaveBeenCalledTimes(1);
  release();
  await on;
  expect(choices).toHaveBeenCalledTimes(2);
  expect(await readdir(directory)).toEqual([]);
});

it("a verified newer Off fences an older Enable waiting at the main initialization boundary", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-diagnostics-consent-ipc-"));
  shell.userData = directory;
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(RecoveryController.prototype, "initialize").mockReturnValue(waiting);
  const choices = vi.spyOn(RecoveryController.prototype, "setEnabled");
  await import("../src/main/index.js");
  const sender = shell.webContents!;
  const event = { sender, senderFrame: sender.mainFrame };
  const epoch = shell.workspace!.connectionTarget.epoch;
  const invoke = (enabled: boolean) =>
    shell.handlers.get("orca:diagnostics.setEnabled")!(event, { enabled, scopeVersion: 1 }, epoch);
  const enabling = invoke(true);
  expect(choices).not.toHaveBeenCalled();
  await invoke(false);
  release();
  expect(await enabling).toEqual({ ok: false, code: "stale_export" });
  expect(choices).toHaveBeenCalledTimes(1);
  expect(choices).toHaveBeenCalledWith(false, 1);
  expect(await readdir(directory)).toEqual([]);
});

it("renderer-process-gone fences a preview waiting at main initialization without a reload", async () => {
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  directory = await mkdtemp(join(tmpdir(), "orca-renderer-loss-ipc-"));
  shell.userData = directory;
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  vi.spyOn(DaemonClient.prototype, "subscribe").mockReturnValue({ close: vi.fn() } as unknown as DaemonSubscription);
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  await workspace.connect();
  shell.hasWindow = false;
  await shell.handlers.get("orca:workspace.open")!({}, {}, workspace.connectionTarget.epoch);
  expect(shell.createWindow).toHaveBeenCalledOnce();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(RecoveryController.prototype, "initialize").mockReturnValue(waiting);
  const prepare = vi.spyOn(RecoveryController.prototype, "prepareExport");
  const disposed = vi.spyOn(RecoveryController.prototype, "rendererDisposed");
  const sender = shell.webContents!;
  const preparing = shell.handlers.get("orca:diagnostics.prepareExport")!(
    { sender, senderFrame: sender.mainFrame },
    { source: "previous" },
    workspace.connectionTarget.epoch,
  );
  shell.rendererEvents.get("render-process-gone")!();
  expect(disposed).toHaveBeenCalledOnce();
  release();
  expect(await preparing).toEqual({ ok: false, code: "stale_export" });
  expect(prepare).not.toHaveBeenCalled();
});

it("permits old-target preview disposal only from the current window document without initializing diagnostics", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-diagnostics-disposal-ipc-"));
  shell.userData = directory;
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  const initialize = vi.spyOn(RecoveryController.prototype, "initialize");
  const choices = vi.spyOn(RecoveryController.prototype, "setEnabled");
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  const oldEpoch = workspace.connectionTarget.epoch;
  const hello: Awaited<ReturnType<DaemonClient["hello"]>> = {
    protocol: PROTOCOL_VERSION,
    orcaVersion: "test",
    capabilities: [],
    identity: { workspaceId: "synthetic-workspace", instanceId: "synthetic-boot-a" },
  };
  workspace.observeHello(workspace.client, hello);
  workspace.observeHello(workspace.client, {
    ...hello,
    identity: { ...hello.identity!, instanceId: "synthetic-boot-b" },
  });
  const currentEpoch = workspace.connectionTarget.epoch;
  expect(currentEpoch).toBeGreaterThan(oldEpoch);
  const sender = shell.webContents!;
  const event = { sender, senderFrame: sender.mainFrame };
  const handle = "00000000-0000-4000-8000-000000000001";
  const token = "00000000-0000-4000-8000-000000000002";
  const invoke = (method: string, params: unknown, epoch = oldEpoch, caller: unknown = event) =>
    shell.handlers.get(`orca:diagnostics.${method}`)!(caller, params, epoch);

  expect(await invoke("cancelExport", { handle })).toMatchObject({
    ok: true,
    value: { enabled: false, productionEnabled: false },
  });
  for (const [method, params] of [
    ["status", undefined],
    ["setEnabled", { enabled: false, scopeVersion: 1 }],
    ["prepareExport", { source: "current" }],
    ["save", { handle, destinationToken: token }],
  ] as const) {
    expect(await invoke(method, params)).toEqual({ ok: false, code: "stale_export" });
  }
  expect(
    await invoke("cancelExport", { handle }, currentEpoch, {
      sender: { id: sender.id, mainFrame: sender.mainFrame },
      senderFrame: sender.mainFrame,
    }),
  ).toEqual({ ok: false, code: "stale_export" });
  expect(
    await invoke("cancelExport", { handle }, currentEpoch, {
      sender,
      senderFrame: {},
    }),
  ).toEqual({ ok: false, code: "stale_export" });
  expect(await invoke("cancelExport", { handle: "invalid-handle" })).toEqual({ ok: false, code: "refused" });
  // Cancellation crosses a stale target only for the same verified document.
  for (const removed of ["preparePreview", "readPreviewBlock", "releasePreviewBlock", "closePreview"])
    expect(shell.handlers.has("orca:diagnostics." + removed)).toBe(false);
  expect(initialize).not.toHaveBeenCalled();
  expect(choices).not.toHaveBeenCalled();
  expect(shell.keyWrap).not.toHaveBeenCalled();
  expect(shell.keyUnwrap).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);

  // Exercise normal default-off status too; shipping adapters must create no key or capture files.
  expect(await invoke("status", undefined, currentEpoch)).toMatchObject({
    ok: true,
    value: { enabled: false, productionEnabled: false },
  });
  expect(initialize).toHaveBeenCalledOnce();
  expect(shell.keyWrap).not.toHaveBeenCalled();
  expect(shell.keyUnwrap).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});
afterEach(async () => {
  await shell.workspace?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("returns env → read-only store → env through IPC, honoring drafts and preserving the saved endpoint", async () => {
  const { DaemonClient, DaemonClientError } = await import("../src/client/daemon-client.js");
  directory = await mkdtemp(join(tmpdir(), "orca-connection-integration-"));
  shell.userData = directory;
  const preferences = join(directory, "preferences.json");
  const saved = JSON.stringify({ daemonUrl: "http://localhost:7777" });
  await writeFile(preferences, saved);
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  vi.stubEnv("ORCA_WORKSPACE", "/launch-workspace");
  // Preserve the real Workspace and client creation; no sockets are needed to verify routing.
  vi.spyOn(DaemonClient.prototype, "subscribe").mockImplementation(
    () =>
      new DaemonSubscription({
        url: "ws://localhost",
        params: {},
        onNotification: () => {},
        socket: () => ({ send: () => {}, close: () => {} }),
      }),
  );
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  await workspace.connect();
  const readTarget = () => {
    const event = { returnValue: undefined as DaemonTargetSnapshot | undefined };
    shell.events!.emit("orca:daemon.read", event);
    return event.returnValue!;
  };
  const invoke = async (channel: string, params?: unknown) =>
    (await shell.handlers.get(channel)!({}, params, readTarget().epoch)) as BridgeResult<WorkspaceSnapshot>;
  expect(readTarget()).toMatchObject({ source: "env", url: "http://localhost:9999", environmentOverride: true });
  expect(await invoke("orca:workspace.open", { path: "/archive/.orca" })).toMatchObject({
    ok: true,
    result: { path: "/archive", readOnly: true, source: "chosen" },
  });
  const store = readTarget();
  expect(store).toMatchObject({ source: "store", environmentOverride: true });

  const oldClient = workspace.client;
  const oldStream = workspace.subscription;
  const closeStream = vi.spyOn(oldStream!, "close");
  const hello: Awaited<ReturnType<DaemonClient["hello"]>> = {
    protocol: PROTOCOL_VERSION,
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.subscribe"],
  };
  const probe = vi.spyOn(DaemonClient.prototype, "hello").mockResolvedValue(hello);
  const expectStorePreserved = async () => {
    expect(workspace.client).toBe(oldClient);
    expect(workspace.subscription).toBe(oldStream);
    expect(readTarget()).toEqual(store);
    expect(workspace.snapshot).toMatchObject({ path: "/archive", readOnly: true });
    expect(closeStream).not.toHaveBeenCalled();
    expect(shell.stop).not.toHaveBeenCalled();
    expect(await readFile(preferences, "utf8")).toBe(saved);
  };
  for (const code of ["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN"] as const) {
    probe.mockRejectedValueOnce(new DaemonClientError({ code, message: "private credential detail" }));
    const result = await invoke("orca:workspace.connectLive");
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private credential detail");
    await expectStorePreserved();
  }
  probe.mockResolvedValueOnce({ ...hello, protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 } });
  expect(await invoke("orca:workspace.connectLive")).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("protocol mismatch") },
  });
  await expectStorePreserved();
  probe.mockResolvedValueOnce({ ...hello, capabilities: [] });
  expect(await invoke("orca:workspace.connectLive")).toMatchObject({ ok: false });
  await expectStorePreserved();

  let finish!: (value: typeof hello) => void;
  probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const cancelled = invoke("orca:workspace.connectLive");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  shell.events!.emit("orca:daemon.cancel");
  finish(hello);
  expect(await cancelled).toMatchObject({ ok: false, error: { message: "Connection cancelled." } });
  await expectStorePreserved();

  shell.ready = false;
  expect(await invoke("orca:workspace.connectLive")).toMatchObject({
    ok: false,
    error: { message: "Save or discard pending edits before changing daemons." },
  });
  await expectStorePreserved();
  expect(shell.sent).toHaveBeenLastCalledWith("orca:update.prepare", null);

  // Environment precedence still rejects both arbitrary targets and bundled return.
  for (const url of ["http://localhost:1234", null])
    expect(await shell.handlers.get("orca:daemon.connect")!({}, url)).toMatchObject({ ok: false });
  expect(readTarget()).toEqual(store);

  shell.ready = true;
  expect(await invoke("orca:workspace.connectLive")).toMatchObject({
    ok: true,
    result: { path: "/launch-workspace", readOnly: false, source: "env" },
  });
  expect(readTarget()).toMatchObject({ source: "env", url: "http://localhost:9999", environmentOverride: true });
  expect(readTarget().epoch).toBeGreaterThan(store.epoch);
  expect(shell.stop).toHaveBeenCalledTimes(1);
  expect(closeStream).toHaveBeenCalledTimes(1);
  expect(
    probe.mock.contexts.every((client) => client instanceof DaemonClient && client.url === "http://localhost:9999"),
  ).toBe(true);
  expect(shell.sent).toHaveBeenLastCalledWith("orca:update.prepare", null);
  expect(shell.sent.mock.calls.some(([channel]) => channel === "orca:daemon.show")).toBe(false);
  expect(await readFile(preferences, "utf8")).toBe(saved);
});

it("opens a store with no windows and still refuses drafts when a window exists", async () => {
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  directory = await mkdtemp(join(tmpdir(), "orca-no-window-"));
  shell.userData = directory;
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  vi.spyOn(DaemonClient.prototype, "subscribe").mockReturnValue({ close: vi.fn() } as unknown as DaemonSubscription);
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  await workspace.connect();
  shell.hasWindow = false;
  const invoke = () => shell.handlers.get("orca:workspace.open")!({}, {}, workspace.connectionTarget.epoch);
  const initial = workspace.connectionTarget;
  shell.openDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await invoke()).toMatchObject({ ok: true });
  expect(workspace.connectionTarget).toEqual(initial);
  expect(shell.createWindow).not.toHaveBeenCalled();
  expect(await invoke()).toMatchObject({ ok: true, result: { path: "/archive", readOnly: true } });
  expect(shell.openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Open a store" }));
  expect(shell.createWindow).toHaveBeenCalledOnce();
  expect(shell.sent.mock.calls.some(([channel]) => channel === "orca:update.prepare")).toBe(true);
  shell.ready = false;
  const old = workspace.connectionTarget;
  expect(await invoke()).toMatchObject({
    ok: false,
    error: { message: "Save or discard pending edits before opening a store" },
  });
  expect(workspace.connectionTarget).toEqual(old);
  expect(shell.createWindow).toHaveBeenCalledOnce();
});

it.each(["env", "bundled", "store"] as const)(
  "preserves %s permission alerts when first hello arrives after the renderer update",
  async (source) => {
    const { DaemonClient } = await import("../src/client/daemon-client.js");
    directory = await mkdtemp(join(tmpdir(), "orca-alert-epoch-"));
    shell.userData = directory;
    vi.stubEnv("ORCA_DAEMON_URL", source === "env" ? "http://localhost:9999" : "");
    vi.stubEnv("ORCA_WORKSPACE", "/launch-workspace");
    vi.spyOn(DaemonClient.prototype, "subscribe").mockReturnValue({ close: vi.fn() } as unknown as DaemonSubscription);
    await import("../src/main/index.js");
    const workspace = shell.workspace!;
    await workspace.connect();
    if (source === "store") await workspace.open("/archive");
    expect(workspace.connectionTarget.source).toBe(source);
    const epoch = workspace.connectionTarget.epoch;
    const update: AlertsUpdate = {
      waiting: 1,
      items: [
        {
          id: "permission-1",
          tier: "permission",
          title: "Permission needed",
          body: "A run is waiting",
          runId: "run-1",
          inputId: "permission-1",
          since: new Date().toISOString(),
        },
      ],
    };
    const grant = () => {
      const event = { returnValue: undefined as unknown };
      shell.events!.emit("orca:connection.read", event);
      return (event.returnValue as ConnectionSnapshot).authority;
    };
    const publish = (atEpoch = workspace.connectionTarget.epoch) =>
      shell.events!.emit("orca:alerts.update", {}, update, atEpoch, grant());
    // Model inputs.list finishing while the subscription's verify hello is pending.
    publish();
    expect(shell.badge).toHaveBeenLastCalledWith(1);
    expect(shell.notificationShow).toHaveBeenCalledOnce();
    const badgeCalls = shell.badge.mock.calls.length;
    const hello: Awaited<ReturnType<DaemonClient["hello"]>> = {
      protocol: PROTOCOL_VERSION,
      orcaVersion: "test",
      capabilities: ["runs.read", "runs.subscribe"],
      identity: { workspaceId: "workspace-1", instanceId: "boot-1" },
    };
    workspace.observeHello(workspace.client, hello);
    expect(workspace.connectionTarget.epoch).toBe(epoch);
    expect(shell.sent).toHaveBeenLastCalledWith(
      "orca:daemon.target",
      expect.objectContaining({ epoch, identity: hello.identity }),
    );
    expect(shell.badge).toHaveBeenCalledTimes(badgeCalls);
    expect(shell.notificationClose).not.toHaveBeenCalled();
    workspace.observeHello(workspace.client, hello);
    publish();
    expect(shell.notificationShow).toHaveBeenCalledOnce();
    expect(shell.notificationClose).not.toHaveBeenCalled();

    // A real daemon boot change still clears the old scope and ignores late IPC.
    workspace.observeHello(workspace.client, { ...hello, identity: { ...hello.identity!, instanceId: "boot-2" } });
    expect(workspace.connectionTarget.epoch).toBe(epoch + 1);
    expect(shell.badge).toHaveBeenLastCalledWith(0);
    expect(shell.notificationClose).toHaveBeenCalledOnce();
    publish(epoch);
    expect(shell.badge).toHaveBeenLastCalledWith(0);
    expect(shell.notificationShow).toHaveBeenCalledOnce();
    publish();
    expect(shell.badge).toHaveBeenLastCalledWith(1);
    // The same ask on the same workspace, back after the restart: already put in front of
    // the person once, so it is not posted again (#882).
    expect(shell.notificationShow).toHaveBeenCalledOnce();

    // Switching targets also clears alerts, without the new target's seed clearing twice.
    const oldClient = workspace.client;
    await workspace.open("/another-archive");
    expect(shell.badge).toHaveBeenLastCalledWith(0);
    publish();
    workspace.observeHello(oldClient, hello);
    workspace.observeHello(workspace.client, hello);
    expect(shell.badge).toHaveBeenLastCalledWith(1);
    expect(shell.notificationShow).toHaveBeenCalledOnce();
    // A different ask on the new target is new.
    shell.events!.emit(
      "orca:alerts.update",
      {},
      { waiting: 1, items: [{ ...update.items[0]!, id: "permission-2", inputId: "permission-2" }] },
      workspace.connectionTarget.epoch,
      grant(),
    );
    expect(shell.notificationShow).toHaveBeenCalledTimes(2);
    const closed = shell.notificationClose.mock.calls.length;
    shell.events!.emit("orca:alerts.update", {}, { waiting: 0, items: [] }, workspace.connectionTarget.epoch, grant());
    expect(shell.badge).toHaveBeenLastCalledWith(0);
    expect(shell.notificationClose).toHaveBeenCalledTimes(closed + 1);
  },
);

it("drops a report read under a grant a refusal ended, even after a same-store hello grants a new one (#882)", async () => {
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  directory = await mkdtemp(join(tmpdir(), "orca-alert-grant-"));
  shell.userData = directory;
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  vi.spyOn(DaemonClient.prototype, "subscribe").mockReturnValue({ close: vi.fn() } as unknown as DaemonSubscription);
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  await workspace.connect();
  const client = workspace.client as unknown as {
    options: { onAuthFailure: () => void; onHello: (hello: Awaited<ReturnType<DaemonClient["hello"]>>) => void };
  };
  const hello: Awaited<ReturnType<DaemonClient["hello"]>> = {
    protocol: PROTOCOL_VERSION,
    orcaVersion: "test",
    capabilities: ["runs.read", "runs.subscribe"],
    identity: { workspaceId: "workspace-1", instanceId: "boot-1" },
  };
  client.options.onHello(hello);
  const read = () => {
    const event = { returnValue: undefined as unknown };
    shell.events!.emit("orca:connection.read", event);
    return event.returnValue as ConnectionSnapshot;
  };
  const epoch = workspace.connectionTarget.epoch;
  const old = read().authority;
  expect(old).toBeDefined();
  const ask = (id: string): AlertsUpdate => ({
    waiting: 1,
    items: [
      {
        id,
        tier: "permission",
        title: "Permission needed",
        body: "A run is waiting",
        runId: "run-1",
        inputId: id,
        since: new Date().toISOString(),
      },
    ],
  });
  // Refused, then answered again by the same store: same epoch, a new grant.
  client.options.onAuthFailure();
  expect(read().authority).toBeUndefined();
  client.options.onHello(hello);
  expect(workspace.connectionTarget.epoch).toBe(epoch);
  const fresh = read().authority;
  expect(fresh).toBeDefined();
  expect(fresh).not.toBe(old);
  // A late report from a read that ran under the old grant: not posted, no badge.
  shell.events!.emit("orca:alerts.update", {}, ask("stale"), epoch, old);
  // An unstamped one is not either.
  shell.events!.emit("orca:alerts.update", {}, ask("stale"), epoch, undefined);
  expect(shell.notificationShow).not.toHaveBeenCalled();
  expect(shell.badge).not.toHaveBeenLastCalledWith(1);
  // Read under the new grant: posted.
  shell.events!.emit("orca:alerts.update", {}, ask("fresh"), epoch, fresh);
  expect(shell.notificationShow).toHaveBeenCalledOnce();
  expect(shell.badge).toHaveBeenLastCalledWith(1);
});

it.each(["localhost:6722", "not-a-url-private-token", "https://owner:private-token@host"])(
  "installs synchronous IPC and disconnects safely for malformed configuration %s",
  async (url) => {
    const { DaemonClient } = await import("../src/client/daemon-client.js");
    directory = await mkdtemp(join(tmpdir(), "orca-invalid-url-"));
    shell.userData = directory;
    vi.stubEnv("ORCA_DAEMON_URL", url);
    const subscribe = vi.spyOn(DaemonClient.prototype, "subscribe");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../src/main/index.js");
    const read = (channel: string) => {
      const event = { returnValue: undefined as unknown };
      shell.events!.emit(channel, event);
      return event.returnValue;
    };
    expect(read("orca:daemon.read")).toMatchObject({ source: "env", url: "", environmentOverride: true });
    await shell.workspace!.connect();
    expect(read("orca:connection.read")).toMatchObject({ state: "disconnected" });
    expect(read("orca:daemon.read")).toMatchObject({ source: "env", url: "" });
    expect(subscribe).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private-token");
    expect(
      await shell.handlers.get("orca:workspace.connectLive")!({}, {}, shell.workspace!.connectionTarget.epoch),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining("HTTP or HTTPS") } });
  },
);

it("composes the Mac window lease with main IPC while installation stays unavailable", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-main-mac-window-"));
  shell.userData = directory;
  const main = await import("../src/main/index.js");
  const prepared = await main.macUpdateGuards.prepareDrafts();
  if (prepared.outcome !== "ready") throw new Error("Expected ready");
  expect(shell.nativeEnabled).toBe(false);
  const workspace = shell.workspace!;
  const read = await shell.handlers.get("orca:runs.list")!({}, {}, workspace.connectionTarget.epoch);
  expect(read).toMatchObject({ ok: false, error: { message: "Update window preparation is in progress" } });
  const connect = await shell.handlers.get("orca:daemon.connect")!({}, "http://localhost:7890");
  expect(connect).toMatchObject({ ok: false });
  expect(shell.stop).not.toHaveBeenCalled();
  const open = await shell.handlers.get("orca:workspace.open")!(
    {},
    { path: "/other" },
    workspace.connectionTarget.epoch,
  );
  expect(open).toMatchObject({ ok: false });
  expect(shell.openDialog).not.toHaveBeenCalled();
  expect(await prepared.lease.release()).toBe("released");
  expect(shell.nativeEnabled).toBe(true);
  expect(main.macUpdateGuards.draftsValid()).toBe(false);
});

it.skipIf(typeof process.getuid !== "function")(
  "mounts first-run selection/preparation before hello and rejects paths, stale frames, epochs and pending drafts",
  async () => {
    directory = await mkdtemp(join(tmpdir(), "orca-main-first-run-ipc-"));
    shell.userData = directory;
    shell.home = join(directory, "home");
    const project = join(directory, "project"),
      selected = join(directory, "selected");
    for (const path of [shell.home, project, selected]) await mkdir(path);
    execFileSync("git", ["init", "-b", "prepared", project], { stdio: "pipe" });
    execFileSync(
      "git",
      [
        "-C",
        project,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "synthetic",
      ],
      { stdio: "pipe" },
    );
    const main = await import("../src/main/index.js");
    const { DaemonClient } = await import("../src/client/daemon-client.js");
    const probe = vi.spyOn(DaemonClient.prototype, "hello");
    const sender = shell.webContents!;
    const event = { sender, senderFrame: sender.mainFrame };
    const epoch = shell.workspace!.connectionTarget.epoch;
    const invoke = (method: string, input?: unknown, caller = event, callerEpoch = epoch) =>
      shell.handlers.get(`orca:workspace.firstRun.${method}`)!(caller, input, callerEpoch);
    expect(await invoke("status")).toMatchObject({ ok: true, result: { state: "selection-required" } });
    expect(probe).not.toHaveBeenCalled();
    expect(await invoke("choose", { path: project })).toMatchObject({ ok: false });
    expect(await invoke("status", undefined, { sender, senderFrame: {} })).toMatchObject({ ok: false });
    expect(await invoke("status", undefined, event, epoch + 1)).toMatchObject({ ok: false });
    shell.openDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [project] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [selected] });
    const review = (await invoke("choose")) as BridgeResult<{ state: "review"; review: { id: string } }>;
    expect(review).toMatchObject({ ok: true, result: { state: "review" } });
    if (!review.ok) throw new Error("Expected review");
    expect(await readdir(selected)).toEqual([]);
    expect(await invoke("prepare", review.result.review.id)).toMatchObject({ ok: true, result: { state: "prepared" } });
    expect(await invoke("prepare", review.result.review.id)).toMatchObject({ ok: false });
    shell.ready = false;
    expect(await invoke("connect")).toMatchObject({ ok: false });
    expect(shell.stop).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    shell.ready = true;
    // The exact caller frame is rechecked after an outstanding native picker.
    let complete!: (value: { canceled: boolean; filePaths: string[] }) => void;
    shell.openDialog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const choosing = invoke("choose");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(await main.macUpdateGuards.prepareDrafts()).toMatchObject({ outcome: "blocked" });
    expect(shell.nativeEnabled).toBe(true);
    const update = await main.macUpdateGuards.prepareAdmission(
      {
        ...{ workspaceId: "11111111-1111-4111-8111-111111111111", instanceId: "22222222-2222-4222-8222-222222222222" },
        epoch,
      },
      "synthetic",
    );
    expect(update.outcome).toBe("blocked");
    sender.mainFrame = {};
    complete({ canceled: false, filePaths: [project] });
    expect(await choosing).toMatchObject({ ok: false });
    expect(await readdir(selected)).toEqual(["first-run", "orca.config.yaml"]);
  },
);

it("native replacement bootstrap blocks protected main IPC before its journal inspection", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-native-bootstrap-ipc-"));
  shell.userData = directory;
  shell.replacementBootstrap = { ordinaryAllowed: false, inspect: vi.fn(async () => ({ outcome: "unknown" })) };
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  shell.packaged = true;
  await import("../src/main/index.js");
  expect(shell.replacementMounted).toHaveBeenCalledOnce();
  expect(shell.replacementMounted).toHaveBeenCalledWith(
    expect.objectContaining({
      control: join(dirname(directory), basename(directory) + "-native-replacement"),
      appRoot: directory,
    }),
  );
  const sender = shell.webContents!;
  const event = { sender, senderFrame: sender.mainFrame };
  const epoch = shell.workspace!.connectionTarget.epoch;
  const invoke = (channel: string, value?: unknown) => shell.handlers.get(channel)!(event, value, epoch);
  expect(await invoke("orca:preferences.write", { theme: "dark" })).toMatchObject({ ok: false });
  expect(await invoke("orca:guidedLaunch.submit", {})).toMatchObject({ ok: false });
  expect(await invoke("orca:workspace.firstRun.prepare", "11111111-1111-4111-8111-111111111111")).toMatchObject({
    ok: false,
  });
  expect(await invoke("orca:diagnostics.setEnabled", { enabled: true, scopeVersion: 1 })).toMatchObject({ ok: false });
  await expect(shell.workspace!.prepareConnection(null)).rejects.toThrow("closed");
  expect(shell.keyWrap).not.toHaveBeenCalled();
  expect(shell.stop).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it("native replacement unknown startup paints recovery without normal diagnostics or child bootstrap", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-native-bootstrap-ready-"));
  shell.userData = directory;
  shell.startReady = true;
  const inspect = vi.fn(async () => ({ outcome: "unknown" }));
  shell.replacementBootstrap = { ordinaryAllowed: false, inspect };
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  shell.packaged = true;
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  const initialize = vi.spyOn(RecoveryController.prototype, "initialize");
  await import("../src/main/index.js");
  await vi.waitFor(() => expect(shell.recoveryMessage).toHaveBeenCalledOnce());
  expect(inspect).toHaveBeenCalledOnce();
  expect(shell.createWindow).toHaveBeenCalledOnce();
  expect(initialize).not.toHaveBeenCalled();
  expect(shell.keyWrap).not.toHaveBeenCalled();
  expect(shell.stop).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it("unpackaged macOS Electron never constructs or waits on the native replacement bootstrap", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-unpackaged-mac-startup-"));
  shell.userData = directory;
  shell.startReady = true;
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  const { FirstRunSetup } = await import("../src/main/first-run/setup.js");
  const { Workspace } = await import("../src/main/workspace.js");
  vi.spyOn(FirstRunSetup.prototype, "status").mockResolvedValue({ state: "selection-required", reason: "fixture" });
  vi.spyOn(Workspace.prototype, "connect").mockResolvedValue();
  const record = vi.spyOn(RecoveryController.prototype, "record");
  await import("../src/main/index.js");
  await vi.waitFor(() => expect(record).toHaveBeenCalledWith("lifecycle", "app_started"));
  expect(shell.replacementMounted).not.toHaveBeenCalled();
  expect(shell.recoveryMessage).not.toHaveBeenCalled();
  const sender = shell.webContents!;
  const event = { sender, senderFrame: sender.mainFrame };
  expect(await shell.handlers.get("orca:preferences.write")!(event, { theme: "dark" })).toMatchObject({ ok: true });
});

it.each([
  ["keeps startup closed", 0],
  ["resets and relaunches", 1],
] as const)("a resettable recovery shell %s on the person's choice", async (_, response) => {
  directory = await mkdtemp(join(tmpdir(), "orca-native-bootstrap-reset-"));
  shell.userData = directory;
  shell.startReady = true;
  shell.replacementBootstrap = { ordinaryAllowed: false, inspect: vi.fn(async () => ({ outcome: "unknown" })) };
  shell.replacementResettable = true;
  shell.resetChoice.mockResolvedValue({ response });
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  shell.packaged = true;
  await import("../src/main/index.js");
  await vi.waitFor(() => expect(shell.resetChoice).toHaveBeenCalledOnce());
  expect(shell.resetChoice).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0 }));
  if (response === 1) {
    await vi.waitFor(() => expect(shell.quit).toHaveBeenCalledOnce());
    expect(shell.replacementReset).toHaveBeenCalledOnce();
    expect(shell.relaunch).toHaveBeenCalledOnce();
  } else {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shell.replacementReset).not.toHaveBeenCalled();
    expect(shell.relaunch).not.toHaveBeenCalled();
  }
  expect(shell.recoveryMessage).not.toHaveBeenCalled();
  expect(shell.stop).not.toHaveBeenCalled();
});

it("main pause refuses new writes and retains its app writer until a dispatched RPC settles", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-native-pause-ipc-"));
  shell.userData = directory;
  shell.replacementBootstrap = { ordinaryAllowed: true, inspect: vi.fn(async () => "ordinary") };
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  shell.packaged = true;
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  vi.spyOn(RecoveryController.prototype, "cleanExit").mockResolvedValue();
  let finish!: (value: unknown) => void;
  const rpc = vi.spyOn(DaemonClient.prototype, "call").mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const main = await import("../src/main/index.js");
  const sender = shell.webContents!,
    event = { sender, senderFrame: sender.mainFrame };
  const epoch = shell.workspace!.connectionTarget.epoch;
  const dispatched = shell.handlers.get("orca:templates")!(event, { method: "templates.get", params: {} }, epoch);
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  const paused = main.pauseMacUpdateAppWriters(new AbortController().signal);
  expect(await shell.handlers.get("orca:preferences.write")!(event, { theme: "dark" })).toMatchObject({ ok: false });
  expect(shell.replacementReleased).not.toHaveBeenCalled();
  finish({});
  // The actual RPC settled; Workspace deliberately discards its now-closed projection.
  expect(await dispatched).toMatchObject({ ok: false });
  expect(await paused).toBe(true);
  expect(shell.replacementReleased).toHaveBeenCalledOnce();
  expect(shell.keyWrap).not.toHaveBeenCalled();
  expect(shell.stop).not.toHaveBeenCalled();
});

it("durable admission closure retains completion only for the reserved live drain", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-native-completion-ipc-"));
  shell.userData = directory;
  shell.replacementBootstrap = {
    ordinaryAllowed: false,
    existingWorkAllowed: true,
    inspect: vi.fn(async () => "ordinary"),
  };
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  shell.packaged = true;
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  const rpc = vi.spyOn(DaemonClient.prototype, "call").mockResolvedValue({});
  await import("../src/main/index.js");
  const workspace = shell.workspace!,
    sender = shell.webContents!;
  const event = { sender, senderFrame: sender.mainFrame };
  const invoke = (channel: string) => shell.handlers.get(channel)!(event, {}, workspace.connectionTarget.epoch);
  expect(await invoke("orca:inputs.answer")).toMatchObject({ ok: false });
  Reflect.set(workspace, "macUpdateHold", Symbol("held-runtime"));
  expect(await invoke("orca:inputs.answer")).toMatchObject({ ok: true });
  expect(await invoke("orca:runs.get")).toMatchObject({ ok: true });
  expect(rpc).toHaveBeenCalledTimes(2);
  for (const channel of ["orca:runs.start", "orca:templates", "orca:config.apply", "orca:guidedLaunch.submit"])
    expect(await invoke(channel)).toMatchObject({ ok: false });
  expect(await shell.handlers.get("orca:preferences.write")!(event, { theme: "dark" })).toMatchObject({ ok: false });
  shell.replacementBootstrap.existingWorkAllowed = false;
  expect(await invoke("orca:inputs.answer")).toMatchObject({ ok: false });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("quit retains app ownership until dispatch and background storage both settle", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-native-quit-ipc-"));
  shell.userData = directory;
  shell.replacementBootstrap = { ordinaryAllowed: true, inspect: vi.fn(async () => "ordinary") };
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  shell.packaged = true;
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  let finish!: (value: unknown) => void, settled!: () => void;
  const rpc = vi.spyOn(DaemonClient.prototype, "call").mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const background = vi
    .spyOn(RecoveryController.prototype, "cleanExit")
    .mockReturnValue(new Promise<void>((resolve) => (settled = resolve)));
  await import("../src/main/index.js");
  const sender = shell.webContents!,
    event = { sender, senderFrame: sender.mainFrame };
  const dispatched = shell.handlers.get("orca:runs.get")!(event, {}, shell.workspace!.connectionTarget.epoch);
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
  const closeWorkspace = vi.spyOn(shell.workspace!, "close");
  shell.appEvents!.emit("will-quit", { preventDefault: vi.fn() });
  expect(closeWorkspace).toHaveBeenCalledOnce();
  expect(background).not.toHaveBeenCalled();
  expect(shell.replacementClosed).not.toHaveBeenCalled();
  finish({});
  expect(await dispatched).toMatchObject({ ok: false });
  await vi.waitFor(() => expect(background).toHaveBeenCalledOnce());
  expect(shell.replacementClosed).not.toHaveBeenCalled();
  settled();
  await vi.waitFor(() => expect(shell.replacementClosed).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(shell.quit).toHaveBeenCalledOnce());
});

it("main pause tracks first-run receipt work before releasing its app writer", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-native-first-run-pause-"));
  shell.userData = directory;
  shell.replacementBootstrap = { ordinaryAllowed: true, inspect: vi.fn(async () => "ordinary") };
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  shell.packaged = true;
  const { FirstRunSetup } = await import("../src/main/first-run/setup.js");
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  vi.spyOn(RecoveryController.prototype, "cleanExit").mockResolvedValue();
  let finish!: (value: { state: "selection-required"; reason: string }) => void;
  const prepare = vi
    .spyOn(FirstRunSetup.prototype, "prepareRecovery")
    .mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const main = await import("../src/main/index.js");
  const sender = shell.webContents!,
    event = { sender, senderFrame: sender.mainFrame };
  const dispatched = shell.handlers.get("orca:workspace.firstRun.prepareRecovery")!(
    event,
    undefined,
    shell.workspace!.connectionTarget.epoch,
  );
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  const paused = main.pauseMacUpdateAppWriters(new AbortController().signal);
  expect(shell.replacementReleased).not.toHaveBeenCalled();
  finish({ state: "selection-required", reason: "fixture" });
  expect(await dispatched).toMatchObject({ ok: false });
  expect(await paused).toBe(true);
  expect(shell.replacementReleased).toHaveBeenCalledOnce();
});

it("main forwards only current-client and current-subscription diagnostic facts", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-owner-facts-ipc-"));
  shell.userData = directory;
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  const { DaemonClient } = await import("../src/client/daemon-client.js");
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  const record = vi.spyOn(RecoveryController.prototype, "record");
  const notifications: NonNullable<Parameters<DaemonClient["subscribe"]>[0]>["onNotification"][] = [];
  vi.spyOn(DaemonClient.prototype, "subscribe").mockImplementation((options) => {
    notifications.push(options.onNotification);
    return { close: vi.fn() } as unknown as DaemonSubscription;
  });
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  await workspace.connect();
  const oldClient = workspace.client;
  const oldObserver = (Reflect.get(oldClient, "options") as { onDiagnostic: OwnedDiagnosticObserver }).onDiagnostic;
  const failure = {
    kind: "notification" as const,
    method: "run.changed" as const,
    params: {
      subscriptionId: "private-subscription",
      at: "2026-10-09T00:00:00Z",
      runId: "private-run",
      seq: 1,
      event: "run.failed" as const,
      status: "failed" as const,
    },
  };
  oldObserver("admission", "admission_uncertain");
  notifications[0]!(failure);
  expect(record.mock.calls).toEqual([
    ["admission", "admission_uncertain"],
    ["run", "run_failed"],
  ]);
  await workspace.open("/archive/.orca");
  record.mockClear();
  oldObserver("connection", "authentication_invalid");
  notifications[0]!(failure);
  expect(record).not.toHaveBeenCalled();
  const currentObserver = (Reflect.get(workspace.client, "options") as { onDiagnostic: OwnedDiagnosticObserver })
    .onDiagnostic;
  currentObserver("resume", "resume_failed");
  notifications[1]!(failure);
  expect(record.mock.calls).toEqual([
    ["resume", "resume_failed"],
    ["run", "run_failed"],
  ]);
  shell.appEvents!.emit("before-quit");
  record.mockClear();
  currentObserver("admission", "admission_uncertain");
  notifications[1]!(failure);
  expect(record).not.toHaveBeenCalled();
  expect(shell.keyWrap).not.toHaveBeenCalled();
});

it.each(["quit", "updater pause"] as const)(
  "main removes power observation on %s and suppresses later facts",
  async (stop) => {
    directory = await mkdtemp(join(tmpdir(), "orca-power-facts-ipc-"));
    shell.userData = directory;
    shell.startReady = true;
    vi.stubGlobal("process", { ...process, platform: stop === "quit" ? "win32" : "darwin" });
    shell.packaged = true;
    if (stop === "updater pause")
      shell.replacementBootstrap = {
        ordinaryAllowed: true,
        existingWorkAllowed: true,
        inspect: vi.fn(async () => "ordinary"),
      };
    const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
    const { FirstRunSetup } = await import("../src/main/first-run/setup.js");
    const { Workspace } = await import("../src/main/workspace.js");
    vi.spyOn(FirstRunSetup.prototype, "status").mockResolvedValue({ state: "selection-required", reason: "fixture" });
    vi.spyOn(Workspace.prototype, "connect").mockResolvedValue();
    const record = vi.spyOn(RecoveryController.prototype, "record");
    const main = await import("../src/main/index.js");
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith("lifecycle", "app_started"));
    shell.powerEvents!.emit("suspend");
    shell.powerEvents!.emit("resume");
    if (stop === "quit") shell.appEvents!.emit("before-quit");
    else expect(await main.pauseMacUpdateAppWriters(new AbortController().signal)).toBe(true);
    expect(record.mock.calls).toEqual([
      ["lifecycle", "app_started"],
      ["lifecycle", "sleep_observed"],
      ["lifecycle", "wake_observed"],
      ["lifecycle", "app_stopping"],
    ]);
    expect(shell.powerEvents!.listenerCount("suspend")).toBe(0);
    expect(shell.powerEvents!.listenerCount("resume")).toBe(0);
    record.mockClear();
    shell.powerEvents!.emit("resume");
    shell.appEvents!.emit("before-quit");
    expect(record).not.toHaveBeenCalled();
    expect(shell.keyWrap).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  },
);

it("late diagnostic initialization cannot publish app_started after quit", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-late-start-facts-ipc-"));
  shell.userData = directory;
  shell.startReady = true;
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  const { FirstRunSetup } = await import("../src/main/first-run/setup.js");
  const { Workspace } = await import("../src/main/workspace.js");
  vi.spyOn(FirstRunSetup.prototype, "status").mockResolvedValue({ state: "selection-required", reason: "fixture" });
  vi.spyOn(Workspace.prototype, "connect").mockResolvedValue();
  let finish!: () => void;
  const initialize = vi
    .spyOn(RecoveryController.prototype, "initialize")
    .mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const record = vi.spyOn(RecoveryController.prototype, "record");
  await import("../src/main/index.js");
  await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
  shell.appEvents!.emit("before-quit");
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(record).not.toHaveBeenCalledWith("lifecycle", "app_started");
  expect(shell.powerEvents!.listenerCount("resume")).toBe(0);
});

it("writes no watched-machine choice while an update holds the app (#882)", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-fleet-watch-ipc-"));
  shell.userData = directory;
  const { PreferencesFile } = await import("../src/preferences/preferences-file.js");
  const { RemoteProfiles } = await import("../src/main/remote-profiles.js");
  const saved = vi.spyOn(PreferencesFile.prototype, "saveWatchedProfiles");
  vi.spyOn(RemoteProfiles.prototype, "get").mockReturnValue({ id: "lab", name: "Lab", destination: "lab" } as never);
  const observe = vi.spyOn(RemoteProfiles.prototype, "observe").mockRejectedValue(new Error("offline"));
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  const watch = shell.handlers.get("orca:fleet.watch")!;
  const reserved = vi.spyOn(workspace, "macUpdateReserved", "get").mockReturnValue(true);
  expect(await watch({}, "lab", true)).toMatchObject({ ok: false });
  expect(saved).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  reserved.mockReturnValue(false);
  expect(await watch({}, "lab", true)).toMatchObject({ ok: true });
  expect(saved).toHaveBeenCalledExactlyOnceWith(["lab"]);
});
