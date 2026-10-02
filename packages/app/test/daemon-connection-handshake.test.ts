/** Exercise the real main-process publication path with delayed HTTP replies on one client. */
import type { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { SocketHandlers } from "../src/client/subscription.js";
import type { ConnectionSnapshot } from "../src/bridge.js";
import type { Workspace } from "../src/main/workspace.js";

const shell = vi.hoisted(() => ({
  directory: "",
  workspace: undefined as Workspace | undefined,
  events: undefined as EventEmitter | undefined,
  sent: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  shell.events = new EventEmitter();
  return {
    app: {
      getPath: () => shell.directory,
      requestSingleInstanceLock: () => true,
      getVersion: () => "0.6.0",
      whenReady: () => new Promise(() => {}),
      on: vi.fn(),
    },
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, isFocused: () => true, webContents: { send: shell.sent } }],
    },
    ipcMain: Object.assign(shell.events, { handle: vi.fn() }),
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
vi.mock("../src/main/update-driver.js", () => ({ updateDriver: () => undefined }));

afterEach(async () => {
  await shell.workspace?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (shell.directory) await rm(shell.directory, { recursive: true, force: true });
});

it("fences stale same-client replies before workspace identity, protocol or capabilities are published", async () => {
  shell.directory = await mkdtemp(join(tmpdir(), "orca-connection-handshake-"));
  vi.stubEnv("ORCA_DAEMON_URL", "http://localhost:9999");
  vi.spyOn(LocalDaemonToken.prototype, "read").mockReturnValue(undefined);
  vi.spyOn(LocalDaemonToken.prototype, "refresh").mockReturnValue(false);
  const requests: ((hello: HelloResult) => void)[] = [];
  const failures: ((code: "AUTH_INVALID" | "AUTH_REQUIRED" | "AUTH_FORBIDDEN") => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          failures.push((code) =>
            resolve(
              new Response(JSON.stringify({ kind: "response", id: 1, ok: false, error: { code, message: "Refused" } })),
            ),
          );
          requests.push((result) =>
            resolve(new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result }))),
          );
        }),
    ),
  );
  const sockets: { handlers: SocketHandlers; send: ReturnType<typeof vi.fn> }[] = [];
  // Invoked with the real client's receiver below so only the socket boundary is replaced.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const subscribe = DaemonClient.prototype.subscribe;
  vi.spyOn(DaemonClient.prototype, "subscribe").mockImplementation(function (this: DaemonClient, options) {
    return subscribe.call(this, {
      ...options,
      backoffMs: [0],
      socket: (_url, handlers) => {
        const send = vi.fn();
        sockets.push({ handlers, send });
        return { send, close: () => {} };
      },
    });
  });
  const hello = (boot: string, overrides: Partial<HelloResult> = {}): HelloResult => ({
    protocol: PROTOCOL_VERSION,
    orcaVersion: boot,
    capabilities: ["runs.read", "runs.subscribe"],
    methods: ["hello", "runs.list"],
    identity: {
      workspaceId: "2c7bf988-cf11-4f6d-9b36-77a4a7bf714f",
      instanceId: `44112345-b16c-44ba-831d-a66f44488f6${boot}`,
    },
    ...overrides,
  });
  const stale = hello("1", {
    protocol: { major: PROTOCOL_VERSION.major + 1, minor: 0 },
    capabilities: ["runs.read", "runs.subscribe", "runs.control"],
    methods: ["hello", "config.set"],
  });
  const open = (index: number) => {
    const socket = sockets[index]!;
    socket.handlers.onOpen();
    const request = JSON.parse(socket.send.mock.calls[0]![0] as string) as { id: number };
    socket.handlers.onMessage(
      JSON.stringify({
        kind: "response",
        id: request.id,
        ok: true,
        result: { subscriptionId: `stream-${index}`, replayed: 0 },
      }),
    );
  };
  const connection = (): ConnectionSnapshot => {
    const event = { returnValue: undefined as ConnectionSnapshot | undefined };
    shell.events!.emit("orca:connection.read", event);
    return event.returnValue!;
  };
  await import("../src/main/index.js");
  const workspace = shell.workspace!;
  await workspace.connect();
  const client = workspace.client;
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  requests[0]!(hello("1"));
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  expect(workspace.connectionTarget.identity).toEqual(hello("1").identity);
  open(0);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  // A remains in flight after its socket closes. B verifies the new boot before subscribing.
  sockets[0]!.handlers.onClose();
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  requests[2]!(hello("2"));
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  const verifiedTarget = workspace.connectionTarget;
  const verifiedConnection = connection();
  expect(verifiedTarget.identity).toEqual(hello("2").identity);
  // The visual quiet window can still show the prior version until the stream is live.
  shell.sent.mockClear();
  requests[1]!(stale);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(workspace.connectionTarget).toEqual(verifiedTarget);
  expect(connection()).toEqual(verifiedConnection);
  expect(shell.sent).not.toHaveBeenCalled();

  open(1);
  await vi.waitFor(() => expect(requests).toHaveLength(4));
  expect(connection().orcaVersion).toBe("2");
  sockets[1]!.handlers.onClose();
  await vi.waitFor(() => expect(requests).toHaveLength(5));
  requests[4]!(hello("3"));
  await vi.waitFor(() => expect(sockets).toHaveLength(3));
  open(2);
  await vi.waitFor(() => expect(requests).toHaveLength(6));
  requests[5]!(hello("4", { orcaVersion: "current-post-subscribe" }));
  await vi.waitFor(() => expect(connection().orcaVersion).toBe("current-post-subscribe"));
  const currentTarget = workspace.connectionTarget;
  const currentConnection = connection();
  expect(workspace.client).toBe(client);
  expect(currentTarget.identity).toEqual(hello("4").identity);
  expect(currentTarget.epoch).toBeGreaterThan(verifiedTarget.epoch);
  expect(currentConnection).toMatchObject({ state: "live", capabilities: ["runs.read", "runs.subscribe"] });
  shell.sent.mockClear();
  // The prior post-subscribe reply is also ignored after both newer verification and hello.
  requests[3]!(stale);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(workspace.connectionTarget).toEqual(currentTarget);
  expect(connection()).toEqual(currentConnection);
  expect(shell.sent).not.toHaveBeenCalled();
  expect(() => workspace.assertEpoch(currentTarget.epoch)).not.toThrow();
  expect(() => workspace.assertEpoch(verifiedTarget.epoch)).toThrow("previous connection");

  // A probe on the current client is read-only until its owner explicitly commits it.
  const probe = client.hello("uncommitted-probe");
  requests[6]!(stale);
  await expect(probe).resolves.toEqual(stale);
  expect(workspace.connectionTarget).toEqual(currentTarget);
  expect(connection()).toEqual(currentConnection);
  expect(shell.sent).not.toHaveBeenCalled();

  // An old authentication error is subject to the same boundary as an old successful hello.
  sockets[2]!.handlers.onClose();
  await vi.waitFor(() => expect(requests).toHaveLength(8));
  requests[7]!(hello("5"));
  await vi.waitFor(() => expect(sockets).toHaveLength(4));
  open(3);
  await vi.waitFor(() => expect(requests).toHaveLength(9));
  sockets[3]!.handlers.onClose();
  await vi.waitFor(() => expect(requests).toHaveLength(10));
  requests[9]!(hello("6"));
  await vi.waitFor(() => expect(sockets).toHaveLength(5));
  open(4);
  await vi.waitFor(() => expect(requests).toHaveLength(11));
  const authenticatedTarget = workspace.connectionTarget;
  const authenticatedConnection = connection();
  expect(authenticatedConnection.state).toBe("live");
  shell.sent.mockClear();
  failures[8]!("AUTH_INVALID");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(workspace.connectionTarget).toEqual(authenticatedTarget);
  expect(connection()).toEqual(authenticatedConnection);
  expect(shell.sent).not.toHaveBeenCalled();

  // A refused candidate probe is also read-only until its owner chooses a connection.
  const refusedProbe = client.hello("uncommitted-probe");
  failures[11]!("AUTH_INVALID");
  await expect(refusedProbe).rejects.toMatchObject({ error: { code: "AUTH_INVALID" } });
  expect(workspace.connectionTarget).toEqual(authenticatedTarget);
  expect(connection()).toEqual(authenticatedConnection);
  expect(shell.sent).not.toHaveBeenCalled();

  // A current rejected handshake still publishes genuine revocation immediately.
  failures[10]!("AUTH_INVALID");
  await vi.waitFor(() => expect(connection().state).toBe("disconnected"));
  expect(workspace.connectionTarget).toEqual(authenticatedTarget);

  // Even a verifier still using the current client cannot publish after its stream closes.
  sockets[4]!.handlers.onClose();
  await vi.waitFor(() => expect(requests).toHaveLength(13));
  workspace.subscription!.close();
  const closedConnection = connection();
  shell.sent.mockClear();
  requests[12]!(stale);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(workspace.connectionTarget).toEqual(authenticatedTarget);
  expect(connection()).toEqual(closedConnection);
  expect(shell.sent).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(5);
});
