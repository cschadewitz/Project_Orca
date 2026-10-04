/** Applied-patch regression: invoke the real main IPC handlers with Electron at the boundary. */
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import type { DaemonClient } from "../src/client/daemon-client.js";
import type { Workspace } from "../src/main/workspace.js";
import { DaemonSubscription } from "../src/client/subscription.js";
import type { AlertsUpdate, BridgeResult, WorkspaceSnapshot } from "../src/bridge.js";
import type { DaemonTargetSnapshot } from "../src/daemon-connection.js";

const shell = vi.hoisted(() => ({
  userData: "",
  workspace: undefined as Workspace | undefined,
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  events: undefined as EventEmitter | undefined,
  webContents: undefined as { id: number; mainFrame: object } | undefined,
  ready: true,
  hasWindow: true,
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
  const webContents = {
    id: 1,
    mainFrame: {},
    on: vi.fn(),
    send: (channel: string, value: unknown) => {
      shell.sent(channel, value);
      if (channel === "orca:update.prepare" && typeof value === "string")
        events.emit(
          "orca:update.prepared",
          { sender: webContents, senderFrame: webContents.mainFrame },
          { nonce: value, ready: shell.ready },
        );
    },
  };
  shell.webContents = webContents;
  return {
    safeStorage: {
      isEncryptionAvailable: () => false,
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: shell.keyWrap,
      decryptStringAsync: shell.keyUnwrap,
    },
    app: {
      getPath: (name: string) => (name === "userData" ? shell.userData : "/launch-workspace"),
      requestSingleInstanceLock: () => true,
      getVersion: () => "0.6.0",
      setBadgeCount: shell.badge,
      // Test bootstrap explicitly; creating a real BrowserWindow is outside this IPC regression.
      whenReady: () => new Promise(() => {}),
      on: vi.fn(),
    },
    BrowserWindow: class {
      constructor() {
        shell.createWindow();
        shell.hasWindow = true;
      }
      static getAllWindows() {
        return shell.hasWindow ? [{ isDestroyed: () => false, isFocused: () => true, webContents }] : [];
      }
      static getFocusedWindow() {
        return this.getAllWindows()[0];
      }
      static fromWebContents(sender: unknown) {
        return sender === webContents ? this.getAllWindows()[0] : undefined;
      }
      webContents = webContents;
      on = vi.fn();
      once = vi.fn();
      loadFile = vi.fn();
    },
    ipcMain: Object.assign(events, {
      handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        shell.handlers.set(channel, handler);
      },
    }),
    nativeTheme: { on: vi.fn() },
    dialog: { showOpenDialog: shell.openDialog },
    Menu: {},
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
  shell.handlers.clear();
  shell.workspace = undefined;
  shell.ready = true;
  shell.hasWindow = true;
  shell.createWindow.mockClear();
  shell.stop.mockClear();
  shell.sent.mockClear();
  shell.badge.mockClear();
  shell.notificationShow.mockClear();
  shell.notificationClose.mockClear();
  shell.keyWrap.mockClear();
  shell.keyUnwrap.mockClear();
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

it("permits old-target preview disposal only from the current window document without initializing diagnostics", async () => {
  directory = await mkdtemp(join(tmpdir(), "orca-diagnostics-disposal-ipc-"));
  shell.userData = directory;
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  const { RecoveryController } = await import("../src/main/diagnostics/recovery-controller.js");
  const initialize = vi.spyOn(RecoveryController.prototype, "initialize");
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

  expect(await invoke("closePreview", { handle })).toMatchObject({
    ok: true,
    value: { enabled: false, productionEnabled: false },
  });
  for (const [method, params] of [
    ["status", undefined],
    ["preparePreview", { source: "current" }],
    ["save", { handle, destinationToken: token }],
  ] as const) {
    expect(await invoke(method, params)).toEqual({ ok: false, code: "stale_preview" });
  }
  expect(
    await invoke("closePreview", { handle }, currentEpoch, {
      sender: { id: sender.id, mainFrame: sender.mainFrame },
      senderFrame: sender.mainFrame,
    }),
  ).toEqual({ ok: false, code: "stale_preview" });
  expect(
    await invoke("closePreview", { handle }, currentEpoch, {
      sender,
      senderFrame: {},
    }),
  ).toEqual({ ok: false, code: "stale_preview" });
  expect(await invoke("closePreview", { handle: "invalid-handle" })).toEqual({ ok: false, code: "refused" });
  expect(initialize).not.toHaveBeenCalled();
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
    const publish = (atEpoch = workspace.connectionTarget.epoch) =>
      shell.events!.emit("orca:alerts.update", {}, update, atEpoch);
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
    expect(shell.notificationShow).toHaveBeenCalledTimes(2);

    // Switching targets also clears alerts, without the new target's seed clearing twice.
    const oldClient = workspace.client;
    await workspace.open("/another-archive");
    expect(shell.badge).toHaveBeenLastCalledWith(0);
    expect(shell.notificationClose).toHaveBeenCalledTimes(2);
    publish();
    workspace.observeHello(oldClient, hello);
    workspace.observeHello(workspace.client, hello);
    expect(shell.badge).toHaveBeenLastCalledWith(1);
    expect(shell.notificationClose).toHaveBeenCalledTimes(2);
    expect(shell.notificationShow).toHaveBeenCalledTimes(3);
    shell.events!.emit("orca:alerts.update", {}, { waiting: 0, items: [] }, workspace.connectionTarget.epoch);
    expect(shell.badge).toHaveBeenLastCalledWith(0);
    expect(shell.notificationClose).toHaveBeenCalledTimes(3);
  },
);

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
