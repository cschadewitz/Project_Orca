/** Real filesystem evidence and app recreation: uncertainty never becomes a second startup. */
import { mkdtemp, mkdir, readFile, readdir, rm, rename, link, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import { DaemonClient } from "../src/client/daemon-client.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import type { BundledDaemon } from "../src/main/daemon-process.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import {
  OWNERSHIP_ANCHOR,
  OWNERSHIP_DIRECTORY,
  FirstRunOwnershipRefusal,
  reserveFirstRunOwnership,
} from "../src/main/first-run/ownership.js";
import { installFirstRunIPC } from "../src/main/first-run/ipc.js";
import { FirstRunSetup } from "../src/main/first-run/setup.js";

const roots: string[] = [];
it.each([true, false])(
  "IPC exposes the safe reconciliation route through the setup wrapper (%s)",
  async (ownership) => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown, epoch: number) => unknown>();
    const setup = new FirstRunSetup({
      home: tmpdir(),
      receiptPath: "/unused/receipt.json",
      choose: async () => {
        throw ownership ? new FirstRunOwnershipRefusal() : new Error("sensitive raw startup failure");
      },
      current: () => false,
      prepareConnection: async () => {
        throw new Error("unused");
      },
    });
    installFirstRunIPC(setup, {
      ipc: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      ready: async () => {},
      held: () => false,
      capture: () => () => {},
      connect: (check) => setup.connect(check),
    });
    // Exercise the real setup operation wrapper before the IPC error boundary.
    const result = await handlers.get("orca:workspace.firstRun.choose")!({} as IpcMainInvokeEvent, undefined, 0);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "AGENT_TRANSPORT",
        message: ownership
          ? expect.stringContaining("no supported orphan reconciliation")
          : expect.stringContaining("Project setup was refused"),
      },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive raw startup failure");
  },
);
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function selected() {
  const path = await mkdtemp(join(tmpdir(), "orca-durable-first-run-"));
  roots.push(path);
  await writeFile(join(path, "orca.config.yaml"), "synthetic config\n");
  return path;
}
function child(path: string) {
  let exited = false;
  const stop = vi.fn(async () => {
    exited = true;
  });
  const daemon: BundledDaemon = {
    url: "http://127.0.0.1:7654",
    pid: 123,
    tokenFile: join(path, "auth", "local-client.token"),
    get exited() {
      return exited;
    },
    stop,
  };
  return {
    daemon,
    stop,
    exit: () => {
      exited = true;
    },
  };
}
const hello = (path: string): HelloResult => ({
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  capabilities: ["runs.read", "runs.control", "runs.subscribe"],
  identity: {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    instanceId: "22222222-2222-4222-8222-222222222222",
  },
  processId: 123,
  storeDir: join(path, ".orca"),
});
function app(path: string, options: Partial<WorkspaceDeps> = {}) {
  const owned = child(path);
  const start = vi.fn<WorkspaceDeps["start"]>().mockResolvedValue(owned.daemon);
  const subscribe = vi.fn(() => ({ close: vi.fn() }) as unknown as DaemonSubscription);
  const client = vi.fn((url: string) => new DaemonClient(url));
  const workspace = new Workspace({
    findEntry: () => "/synthetic-bundle.mjs",
    start,
    client,
    subscribe,
    onSwitch: () => {},
    onSnapshot: () => {},
    onDaemonGone: () => {},
    defaultPath: () => undefined,
    defaultUrl: "http://127.0.0.1:6722",
    ...options,
  });
  return { workspace, start, subscribe, client, ...owned };
}
const attempt = (path: string, name = "000001") => join(path, OWNERSHIP_DIRECTORY, name);
async function evidence(path: string) {
  const result: Record<string, string> = {};
  result[OWNERSHIP_ANCHOR] = await readFile(join(path, OWNERSHIP_ANCHOR), "utf8");
  for (const name of await readdir(join(path, OWNERSHIP_DIRECTORY))) {
    for (const file of await readdir(attempt(path, name)))
      result[`${name}/${file}`] = await readFile(join(attempt(path, name), file), "utf8");
  }
  return result;
}

it("persists the reservation before startup, and app recreation cannot retry interrupted startup", async () => {
  const path = await selected();
  const first = app(path, {
    start: async () => {
      expect(await readdir(attempt(path))).toEqual(["claim.json"]);
      throw new Error("startup result lost");
    },
  });
  await expect(first.workspace.prepareFirstRunConnection(path)).rejects.toThrow("no supported orphan reconciliation");
  const before = await evidence(path);
  await first.workspace.close();
  const second = app(path);
  await expect(second.workspace.prepareFirstRunConnection(path)).rejects.toThrow("ownership requires reconciliation");
  await expect(second.workspace.prepareFirstRunConnection(path)).rejects.toThrow("ownership requires reconciliation");
  expect(second.start).not.toHaveBeenCalled();
  expect(second.subscribe).not.toHaveBeenCalled();
  expect(await evidence(path)).toEqual(before);
});

it.each(["timeout", "throw"])(
  "uncertain %s cleanup remains reserved after recreation and blocks read-only/legacy starts",
  async (kind) => {
    const path = await selected();
    const first = app(path);
    first.stop.mockImplementation(async () => {
      if (kind === "throw") throw new Error("uncertain cleanup");
    });
    const candidate = await first.workspace.prepareFirstRunConnection(path);
    await expect(candidate.dispose()).rejects.toThrow();
    await candidate.dispose();
    await first.workspace.close().catch(() => {});
    const before = await evidence(path);
    const second = app(path, { defaultPath: () => path });
    await expect(second.workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
    await expect(second.workspace.open(join(path, ".orca"))).rejects.toThrow("reconciliation");
    await expect(second.workspace.prepareConnection(null)).rejects.toThrow("reconciliation");
    await expect(second.workspace.connect()).rejects.toThrow("reconciliation");
    const storeAlias = app(path, { defaultPath: () => join(path, ".orca") });
    await expect(storeAlias.workspace.prepareConnection(null)).rejects.toThrow("reconciliation");
    expect(storeAlias.start).not.toHaveBeenCalled();
    const nested = app(path, { defaultPath: () => join(path, "nested") });
    await expect(nested.workspace.prepareConnection(null)).rejects.toThrow("reconciliation");
    expect(nested.start).not.toHaveBeenCalled();
    expect(second.start).not.toHaveBeenCalled();
    expect(second.subscribe).not.toHaveBeenCalled();
    expect(before["000001/terminal.json"]).toBeUndefined();
    expect(await evidence(path)).toEqual(before);
  },
);

it("active and parked owners block a competing recreated app without disturbing its remote target", async () => {
  const path = await selected();
  const first = app(path);
  (await first.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  const second = app(path, { savedUrl: "http://remote:6722" });
  await second.workspace.connect();
  const target = second.workspace.connectionTarget,
    client = second.workspace.client,
    stream = second.workspace.subscription;
  await expect(second.workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  expect(second.workspace.connectionTarget).toEqual(target);
  expect(second.workspace.client).toBe(client);
  expect(second.workspace.subscription).toBe(stream);
  expect(second.start).not.toHaveBeenCalled();
  const remote = await first.workspace.prepareConnection("http://remote:6722");
  remote.activate(hello(path));
  await expect(app(path).workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  const back = await first.workspace.prepareFirstRunConnection(path);
  back.activate(hello(path));
  expect(first.start).toHaveBeenCalledOnce();
  await first.workspace.close();
  await second.workspace.close();
});

it("confirmed direct-child termination permits a new app attempt while retaining all prior evidence", async () => {
  const path = await selected();
  const first = app(path);
  (await first.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  await first.workspace.close();
  const before = await evidence(path);
  expect(before["000001/terminal.json"]).toContain("direct-child-terminal");
  const second = app(path);
  const candidate = await second.workspace.prepareFirstRunConnection(path);
  for (const [name, text] of Object.entries(before)) expect((await evidence(path))[name]).toBe(text);
  await candidate.dispose();
  await candidate.dispose();
  expect(second.stop).toHaveBeenCalledOnce();
  expect(await readdir(join(path, OWNERSHIP_DIRECTORY))).toEqual(["000001", "000002"]);
  await second.workspace.close();
});

it("an exit callback alone cannot settle ownership without matching direct-child terminal fields", async () => {
  const path = await selected();
  const first = app(path);
  (await first.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  first.start.mock.calls[0]![0].onExit({ code: 0, signal: null, output: "" });
  expect((await evidence(path))["000001/terminal.json"]).toBeUndefined();
  await expect(app(path).workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  first.exit();
  first.start.mock.calls[0]![0].onExit({ code: 0, signal: null, output: "" });
  const next = app(path);
  await (await next.workspace.prepareFirstRunConnection(path)).dispose();
});

it("app loss before persisting even an otherwise terminal child exit leaves relaunch blocked", async () => {
  const path = await selected();
  const lostApp = app(path);
  (await lostApp.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  // The OS terminates the child after the app is gone; no surviving app callback/cleanup records it.
  lostApp.exit();
  const before = await evidence(path);
  const relaunched = app(path);
  await expect(relaunched.workspace.prepareFirstRunConnection(path)).rejects.toThrow(
    "no supported orphan reconciliation",
  );
  expect(relaunched.start).not.toHaveBeenCalled();
  expect(before["000001/terminal.json"]).toBeUndefined();
  expect(await evidence(path)).toEqual(before);
});

it("a stale prior terminal marker cannot release a new attempt even with the same PID and identity", async () => {
  const path = await selected();
  const first = app(path);
  (await first.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  await first.workspace.close();
  const stale = await readFile(join(attempt(path), "terminal.json"), "utf8");
  const second = app(path);
  (await second.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  await writeFile(join(attempt(path, "000002"), "terminal.json"), stale);
  await expect(app(path).workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  expect(await readFile(join(attempt(path, "000002"), "terminal.json"), "utf8")).toBe(stale);
});

it("a transplanted journal and anchor cannot establish ownership of another workspace", async () => {
  const original = await selected(),
    other = await selected();
  reserveFirstRunOwnership(original);
  await rename(join(original, OWNERSHIP_DIRECTORY), join(other, OWNERSHIP_DIRECTORY));
  await rename(join(original, OWNERSHIP_ANCHOR), join(other, OWNERSHIP_ANCHOR));
  const next = app(other);
  await expect(next.workspace.prepareFirstRunConnection(other)).rejects.toThrow("reconciliation");
  expect(next.start).not.toHaveBeenCalled();
});

it("a late startup result after quit settles only when its own exit is actually observed", async () => {
  const path = await selected();
  let finish!: (daemon: BundledDaemon) => void;
  const first = app(path, {
    start: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  first.stop.mockImplementation(async () => {});
  const preparing = first.workspace.prepareFirstRunConnection(path);
  const refused = expect(preparing).rejects.toThrow("changed");
  await first.workspace.close();
  finish(first.daemon);
  await refused;
  await expect(app(path).workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  expect((await evidence(path))["000001/terminal.json"]).toBeUndefined();
});

it.each(["anchor", "journal", "claim.json", "child.json", "identity.json", "terminal.json"])(
  "missing %s evidence fails closed and is never regenerated",
  async (missing) => {
    const path = await selected();
    const first = app(path);
    (await first.workspace.prepareFirstRunConnection(path)).activate(hello(path));
    await first.workspace.close();
    await rm(
      missing === "anchor"
        ? join(path, OWNERSHIP_ANCHOR)
        : missing === "journal"
          ? join(path, OWNERSHIP_DIRECTORY)
          : join(attempt(path), missing),
      { recursive: true },
    );
    const next = app(path);
    await expect(next.workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
    expect(next.start).not.toHaveBeenCalled();
  },
);

it.each([
  "malformed",
  "wrong-reservation",
  "wrong-child",
  "wrong-identity",
  "changed-config",
  "extra-file",
  "journal-replaced",
])("%s evidence refuses a new attempt without deleting or repairing it", async (kind) => {
  const path = await selected();
  const first = app(path);
  (await first.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  await first.workspace.close();
  const terminal = join(attempt(path), "terminal.json");
  if (kind === "malformed") await writeFile(terminal, "{");
  if (kind === "wrong-reservation") {
    const value: unknown = JSON.parse(await readFile(terminal, "utf8"));
    await writeFile(
      terminal,
      JSON.stringify({ ...(value as Record<string, unknown>), reservationId: "33333333-3333-4333-8333-333333333333" }),
    );
  }
  if (kind === "wrong-child")
    await writeFile(
      join(attempt(path), "child.json"),
      JSON.stringify({ reservationId: "33333333-3333-4333-8333-333333333333", processId: 124 }),
    );
  if (kind === "wrong-identity") await writeFile(join(attempt(path), "identity.json"), "{}");
  if (kind === "changed-config") await writeFile(join(path, "orca.config.yaml"), "changed\n");
  if (kind === "extra-file") await writeFile(join(attempt(path), "unexpected"), "preserve");
  if (kind === "journal-replaced") {
    await rename(join(path, OWNERSHIP_DIRECTORY), join(path, "preserved-journal"));
    await mkdir(join(path, OWNERSHIP_DIRECTORY));
  }
  const terminalBefore = kind === "journal-replaced" ? undefined : await readFile(terminal, "utf8");
  const next = app(path);
  await expect(next.workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  expect(next.start).not.toHaveBeenCalled();
  if (terminalBefore !== undefined) expect(await readFile(terminal, "utf8")).toBe(terminalBefore);
});

it.each([".orca", "auth"])("pre-ledger %s state is preserved and cannot be silently adopted", async (tree) => {
  const path = await selected();
  await mkdir(join(path, tree));
  const next = app(path);
  await expect(next.workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  expect(await readdir(path)).toContain(tree);
  expect(await readdir(path)).not.toContain(OWNERSHIP_DIRECTORY);
  expect(next.start).not.toHaveBeenCalled();
});

it.each(["symlink", "hardlink"])("%s evidence is refused before startup", async (kind) => {
  const path = await selected();
  const claim = reserveFirstRunOwnership(path);
  claim.attach(child(path).daemon);
  const file = join(attempt(path), "child.json"),
    copied = join(path, "preserved-child.json");
  await rename(file, copied);
  if (kind === "symlink") await symlink(copied, file);
  else await link(copied, file);
  expect(() => claim.check()).toThrow("reconciliation");
  await expect(app(path).workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
});

it("wrong PID/store/instance cannot activate or rewrite the recorded identity", async () => {
  const path = await selected();
  const first = app(path);
  const candidate = await first.workspace.prepareFirstRunConnection(path);
  expect(() => candidate.activate({ ...hello(path), processId: 124 })).toThrow("identity changed");
  expect(() => candidate.activate({ ...hello(path), storeDir: "/other/.orca" })).toThrow("identity changed");
  candidate.validateActivation(hello(path));
  const before = await readFile(join(attempt(path), "identity.json"), "utf8");
  expect(() =>
    candidate.activate({
      ...hello(path),
      identity: { ...hello(path).identity!, instanceId: "33333333-3333-4333-8333-333333333333" },
    }),
  ).toThrow("reconciliation");
  expect(await readFile(join(attempt(path), "identity.json"), "utf8")).toBe(before);
  await candidate.dispose();
});

it("live evidence tampering blocks repeated Connect and cleanup preserves the uncertain record", async () => {
  const path = await selected();
  const first = app(path);
  (await first.workspace.prepareFirstRunConnection(path)).activate(hello(path));
  await writeFile(join(attempt(path), "child.json"), "{}");
  expect(() => first.workspace.currentFirstRun(path)).toThrow("reconciliation");
  await expect(first.workspace.prepareFirstRunConnection(path)).rejects.toThrow("reconciliation");
  expect(first.stop).not.toHaveBeenCalled();
  await expect(first.workspace.close()).rejects.toThrow("reconciliation");
  expect(await readFile(join(attempt(path), "child.json"), "utf8")).toBe("{}");
  expect((await evidence(path))["000001/terminal.json"]).toBeUndefined();
});

it("no selection, no bundle and explicit remote precedence start no child and create no ownership files", async () => {
  const path = await selected();
  const noSelection = app(path);
  await noSelection.workspace.connect();
  const noBundle = app(path, { findEntry: () => undefined });
  await expect(noBundle.workspace.prepareFirstRunConnection(path)).rejects.toThrow("no bundled daemon");
  const explicit = app(path, { explicitUrl: "http://remote:6722" });
  await expect(explicit.workspace.prepareFirstRunConnection(path)).rejects.toThrow("ORCA_DAEMON_URL");
  for (const f of [noSelection, noBundle, explicit]) expect(f.start).not.toHaveBeenCalled();
  expect(await readdir(path)).toEqual(["orca.config.yaml"]);
});
