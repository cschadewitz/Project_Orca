/** Focused boundary coverage separated from the mixed suite. */
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { DaemonClient, DaemonClientError } from "../src/client/daemon-client.js";
import { ConnectionTarget, connectionFailure, callInConnection } from "../src/main/connection-target.js";
import { daemonEndpoint } from "../src/daemon-connection.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import { DaemonSubscription } from "../src/client/subscription.js";

const hello = {
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  capabilities: ["runs.read", "runs.subscribe"] as HelloResult["capabilities"],
  identity: { workspaceId: "2c7bf988-cf11-4f6d-9b36-77a4a7bf714f", instanceId: "44112345-b16c-44ba-831d-a66f44488f66" },
};
const reply = (result: unknown) => new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result }));
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function rig(fetcher: typeof fetch = async () => reply(hello)) {
  const activate = vi.fn();
  const dispose = vi.fn(async () => {});
  const save = vi.fn();
  const guard = vi.fn(async () => true);
  const release = vi.fn();
  const prepare = vi.fn(async () => ({
    client: new DaemonClient("http://localhost:6722", fetcher),
    activate,
    dispose,
  }));
  const deps = { prepare, save, guard, release };
  return { manager: new ConnectionTarget(deps), deps, activate, dispose, save, guard, release };
}
describe("authenticated daemon connection transaction", () => {
  it("persists only after a valid hello and draft guard, then activates", async () => {
    const r = rig();
    await r.manager.connect("http://localhost:6722/");
    expect(r.save).toHaveBeenCalledWith("http://localhost:6722");
    expect(r.save.mock.invocationCallOrder[0]).toBeLessThan(r.activate.mock.invocationCallOrder[0]!);
    expect(r.activate).toHaveBeenCalledWith(hello);
    expect(r.dispose).not.toHaveBeenCalled();
  });
  it.each(["AUTH_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN", "PROTOCOL_VERSION"] as const)(
    "preserves old target and saved value on %s",
    async (code) => {
      const r = rig(
        async () =>
          new Response(JSON.stringify({ kind: "response", id: 1, ok: false, error: { code, message: "refused" } })),
      );
      await expect(r.manager.connect("http://localhost:6722")).rejects.toThrow();
      expect(r.activate).not.toHaveBeenCalled();
      expect(r.save).not.toHaveBeenCalled();
      expect(r.dispose).toHaveBeenCalled();
      expect(connectionFailure(new DaemonClientError({ code, message: "secret must not leak" }))).not.toContain(
        "secret",
      );
    },
  );
  it("rejects incompatible and unauthorized hello without mutation", async () => {
    for (const result of [
      { ...hello, protocol: { major: 99, minor: 0 } },
      { ...hello, capabilities: [] },
    ]) {
      const r = rig(async () => reply(result));
      await expect(r.manager.connect("http://localhost:6722")).rejects.toThrow();
      expect(r.save).not.toHaveBeenCalled();
      expect(r.activate).not.toHaveBeenCalled();
    }
  });
  it("cancels a slow probe without persisting or replacing", async () => {
    let answer!: (response: Response) => void;
    const r = rig(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const pending = r.manager.connect("http://localhost:6722");
    await Promise.resolve();
    r.manager.cancel();
    answer(reply(hello));
    await expect(pending).rejects.toThrow("cancelled");
    expect(r.save).not.toHaveBeenCalled();
    expect(r.activate).not.toHaveBeenCalled();
  });
  it("retains pending edits and refuses the switch, releasing the UI guard", async () => {
    const r = rig();
    r.guard.mockResolvedValue(false);
    await expect(r.manager.connect(null)).rejects.toThrow("pending edits");
    expect(r.save).not.toHaveBeenCalled();
    expect(r.activate).not.toHaveBeenCalled();
    expect(r.release).toHaveBeenCalled();
  });
  it("preserves the live connection on preference write failure", async () => {
    const r = rig();
    r.save.mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(r.manager.connect(null)).rejects.toThrow("disk full");
    expect(r.activate).not.toHaveBeenCalled();
  });
  it("environment overrides refuse both saved and bundled switching", async () => {
    const r = rig();
    const manager = new ConnectionTarget({ ...r.deps, explicitUrl: "http://localhost:9" });
    for (const url of [null, "http://localhost:6722"])
      await expect(manager.connect(url)).rejects.toThrow("ORCA_DAEMON_URL");
    expect(r.deps.prepare).not.toHaveBeenCalled();
  });
  it("authenticates the pinned environment return without saving a preference", async () => {
    const r = rig();
    const manager = new ConnectionTarget({ ...r.deps, explicitUrl: "http://localhost:9/" });
    await manager.returnToEnvironment();
    expect(r.deps.prepare).toHaveBeenCalledWith("http://localhost:9", "env");
    expect(r.guard).toHaveBeenCalledOnce();
    expect(r.activate).toHaveBeenCalledWith(hello);
    expect(r.save).not.toHaveBeenCalled();
    expect(r.release).toHaveBeenCalledOnce();
  });
  it("refuses an environment return when no endpoint was pinned at launch", async () => {
    const r = rig();
    await expect(r.manager.returnToEnvironment()).rejects.toThrow("No environment daemon");
    expect(r.deps.prepare).not.toHaveBeenCalled();
  });
  it("rejects a malformed URL with a safe diagnostic", () => {
    const supplied = "not-a-url-with-private-token";
    expect(() => daemonEndpoint(supplied)).toThrow("Enter an HTTP or HTTPS daemon URL");
    try {
      daemonEndpoint(supplied);
    } catch (error) {
      expect(String(error)).not.toContain(supplied);
    }
  });
  it.each(["ftp://host", "http://owner:secret@host", "http://host?token=secret", "http://host/#secret"])(
    "rejects unsafe endpoint without echoing it",
    (url) => {
      expect(() => daemonEndpoint(url)).toThrow();
      try {
        daemonEndpoint(url);
      } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    },
  );
});

function workspaceRig(explicitUrl?: string, savedUrl?: string) {
  const clients: DaemonClient[] = [];
  const stop = vi.fn(async () => {});
  const deps: WorkspaceDeps = {
    explicitUrl,
    savedUrl,
    defaultPath: () => "/workspace",
    defaultUrl: "http://localhost:6722",
    findEntry: () => "daemon.mjs",
    start: async () => ({ url: "http://localhost:8888", pid: 1, stop }),
    client: (url) => {
      const client = new DaemonClient(url, async () => reply(hello));
      clients.push(client);
      return client;
    },
    subscribe: () =>
      new DaemonSubscription({
        url: "ws://localhost",
        params: {},
        onNotification: () => {},
        socket: () => ({ send: () => {}, close: () => {} }),
      }),
    onSwitch: vi.fn(),
    onSnapshot: vi.fn(),
    onDaemonGone: vi.fn(),
    onTarget: vi.fn(),
  };
  return { workspace: new Workspace(deps), deps, stop, clients };
}
it("uses environment > saved > bundled at startup", async () => {
  for (const [env, saved, expected] of [
    ["http://localhost:1", "http://localhost:2", "env"],
    [undefined, "http://localhost:2", "saved"],
    [undefined, undefined, "bundled"],
  ] as const) {
    const r = workspaceRig(env, saved);
    await r.workspace.connect();
    expect(r.workspace.connectionTarget.source).toBe(expected);
    await r.workspace.close();
  }
});
it("stages environment return without closing the store, and publishes its source only on commit", async () => {
  const r = workspaceRig("http://localhost:1", "http://localhost:2");
  await r.workspace.connect();
  await r.workspace.open("/archive");
  const oldClient = r.workspace.client;
  const oldStream = r.workspace.subscription;
  const oldTarget = r.workspace.connectionTarget;
  await expect(r.workspace.prepareConnection("http://localhost:2", "env")).rejects.toThrow("launch-pinned");
  await expect(r.workspace.prepareConnection(null, "env")).rejects.toThrow("launch-pinned");
  const candidate = await r.workspace.prepareConnection("http://localhost:1", "env");
  expect(r.workspace.client).toBe(oldClient);
  expect(r.workspace.subscription).toBe(oldStream);
  expect(r.workspace.connectionTarget).toEqual(oldTarget);
  expect(r.stop).not.toHaveBeenCalled();
  candidate.check?.();
  candidate.activate(await candidate.client.hello("test"));
  expect(r.workspace.connectionTarget).toMatchObject({ source: "env", url: "http://localhost:1" });
  expect(r.workspace.snapshot).toMatchObject({ readOnly: false, source: "env" });
  expect(r.stop).toHaveBeenCalledOnce();
  await r.workspace.close();
});
it("replaces even a disconnected old daemon and rejects old epochs; bundled return clears the saved source", async () => {
  const r = workspaceRig(undefined, "http://localhost:1");
  await r.workspace.connect();
  const old = r.workspace.connectionTarget.epoch;
  const candidate = await r.workspace.prepareConnection("http://localhost:2");
  candidate.activate(await candidate.client.hello("test"));
  expect(() => r.workspace.assertEpoch(old)).toThrow();
  const bundled = await r.workspace.prepareConnection(null);
  bundled.activate(await bundled.client.hello("test"));
  expect(r.workspace.connectionTarget.source).toBe("bundled");
  await r.workspace.close();
});
it("same URL/new workspace, boot changes and legacy identity reset scope; late old client hello is ignored", async () => {
  const r = workspaceRig();
  await r.workspace.connect();
  const candidate = await r.workspace.prepareConnection("http://localhost:2");
  const first = await candidate.client.hello("test");
  candidate.activate(first);
  let epoch = r.workspace.connectionTarget.epoch;
  r.workspace.observeHello(candidate.client, first);
  expect(r.workspace.connectionTarget.epoch).toBe(epoch);
  for (const identity of [
    { ...hello.identity, instanceId: "restart" },
    { ...hello.identity, workspaceId: "clone" },
    undefined,
  ]) {
    r.workspace.observeHello(candidate.client, { ...first, identity });
    expect(r.workspace.connectionTarget.epoch).toBe(++epoch);
  }
  r.workspace.observeHello(r.clients[0]!, first);
  expect(r.workspace.connectionTarget.epoch).toBe(epoch);
  await r.workspace.close();
});
it("keeps bundled execution alive while viewing another daemon and reuses it on return", async () => {
  const r = workspaceRig();
  await r.workspace.connect();
  const localUrl = r.workspace.client.url;
  const remote = await r.workspace.prepareConnection("http://localhost:2");
  remote.activate(await remote.client.hello("test"));
  expect(r.stop).not.toHaveBeenCalled();
  await expect(r.workspace.prepareUpdate("update-token")).rejects.toThrow("Return to the bundled daemon");
  const back = await r.workspace.prepareConnection(null);
  back.activate(await back.client.hello("test"));
  expect(r.workspace.client.url).toBe(localUrl);
  expect(r.stop).not.toHaveBeenCalled();
  await r.workspace.close();
  expect(r.stop).toHaveBeenCalledTimes(1);
});

it("does not dispatch an old queued write, and discards a late result without retry", async () => {
  let epoch = 1;
  const workspace = {
    ready: async () => {},
    assertEpoch: (value: number) => {
      if (value !== epoch) throw new Error("Old target");
    },
  };
  const queued = vi.fn(async () => "write");
  const pending = callInConnection(workspace, 1, queued);
  epoch = 2;
  await expect(pending).rejects.toThrow("Old target");
  expect(queued).not.toHaveBeenCalled();
  let finish!: (value: string) => void;
  const dispatched = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const late = callInConnection(workspace, 2, dispatched);
  await Promise.resolve();
  epoch = 3;
  finish("old response");
  await expect(late).rejects.toThrow("Old target");
  expect(dispatched).toHaveBeenCalledTimes(1);
});

it("never saves a current or parked bundled daemon URL as an external target", async () => {
  const r = workspaceRig();
  await r.workspace.connect();
  const local = r.workspace.connectionTarget;
  const save = vi.fn();
  const manager = new ConnectionTarget({
    prepare: (url, source) => r.workspace.prepareConnection(url, source),
    save,
    guard: async () => true,
    release: () => {},
  });
  await expect(manager.connect(`${local.url}/`)).rejects.toThrow("temporary URL");
  expect(r.workspace.connectionTarget).toEqual(local);
  expect(save).not.toHaveBeenCalled();
  await manager.connect("http://localhost:2");
  save.mockClear();
  const external = r.workspace.connectionTarget;
  await expect(manager.connect(local.url)).rejects.toThrow("temporary URL");
  expect(r.workspace.connectionTarget).toEqual(external);
  expect(save).not.toHaveBeenCalled();
  await manager.connect(null);
  expect(r.workspace.connectionTarget.source).toBe("bundled");
  expect(save).toHaveBeenCalledWith(null);
  await r.workspace.close();
});

it("keeps the first verified hello in the startup/store epoch, then fences boot changes", async () => {
  const r = workspaceRig();
  for (const open of [() => r.workspace.connect(), () => r.workspace.open("/archive")]) {
    await open();
    const epoch = r.workspace.connectionTarget.epoch;
    r.workspace.observeHello(r.workspace.client, hello);
    expect(r.workspace.connectionTarget).toMatchObject({ epoch, identity: hello.identity });
    r.workspace.observeHello(r.workspace.client, hello);
    expect(r.workspace.connectionTarget.epoch).toBe(epoch);
    r.workspace.observeHello(r.workspace.client, { ...hello, identity: { ...hello.identity, instanceId: "restart" } });
    expect(r.workspace.connectionTarget.epoch).toBe(epoch + 1);
  }
  await r.workspace.close();
});

it("seeds a legacy startup once and still invalidates later unidentifiable connections", async () => {
  const r = workspaceRig();
  await r.workspace.connect();
  const epoch = r.workspace.connectionTarget.epoch;
  const legacy = { protocol: hello.protocol, orcaVersion: hello.orcaVersion, capabilities: hello.capabilities };
  r.workspace.observeHello(r.workspace.client, legacy);
  expect(r.workspace.connectionTarget.epoch).toBe(epoch);
  r.workspace.observeHello(r.workspace.client, legacy);
  expect(r.workspace.connectionTarget.epoch).toBe(epoch + 1);
  await r.workspace.close();
});

it("does not invalidate a deliberate legacy switch again on its first subscription verification", async () => {
  const r = workspaceRig();
  await r.workspace.connect();
  const candidate = await r.workspace.prepareConnection("http://localhost:2");
  const legacy = { protocol: hello.protocol, orcaVersion: hello.orcaVersion, capabilities: hello.capabilities };
  candidate.activate(legacy);
  const epoch = r.workspace.connectionTarget.epoch;
  r.workspace.observeHello(candidate.client, legacy);
  expect(r.workspace.connectionTarget.epoch).toBe(epoch);
  r.workspace.observeHello(candidate.client, legacy);
  expect(r.workspace.connectionTarget.epoch).toBe(epoch + 1);
  await r.workspace.close();
});
