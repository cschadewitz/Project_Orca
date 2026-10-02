/** Applied-patch regression: invoke the real main IPC handlers with Electron at the boundary. */
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { DaemonClient, DaemonClientError } from "../src/client/daemon-client.js";
import type { Workspace } from "../src/main/workspace.js";
import { DaemonSubscription } from "../src/client/subscription.js";
import type { BridgeResult, WorkspaceSnapshot } from "../src/bridge.js";
import type { DaemonTargetSnapshot } from "../src/daemon-connection.js";

const shell = vi.hoisted(() => ({
  userData: "",
  workspace: undefined as Workspace | undefined,
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  events: undefined as EventEmitter | undefined,
  ready: true,
  sent: vi.fn(),
  stop: vi.fn(async () => {}),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const events = new EventEmitter();
  shell.events = events;
  const webContents = {
    id: 1,
    mainFrame: {},
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
  return {
    app: {
      getPath: (name: string) => (name === "userData" ? shell.userData : "/launch-workspace"),
      requestSingleInstanceLock: () => true,
      getVersion: () => "0.6.0",
      // Test bootstrap explicitly; creating a real BrowserWindow is outside this IPC regression.
      whenReady: () => new Promise(() => {}),
      on: vi.fn(),
    },
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, isFocused: () => true, webContents }],
    },
    ipcMain: Object.assign(events, {
      handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        shell.handlers.set(channel, handler);
      },
    }),
    nativeTheme: { on: vi.fn() },
    dialog: {},
    Menu: {},
    Notification: {},
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
afterEach(async () => {
  await shell.workspace?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("returns env → read-only store → env through IPC, honoring drafts and preserving the saved endpoint", async () => {
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
