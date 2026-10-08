/** Exact candidate ownership and cold-start policy, plus a real compiled CLI child over disposable directories. */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type HelloResult } from "@orca/protocol";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import type { BundledDaemon } from "../src/main/daemon-process.js";
import { startBundledDaemon } from "../src/main/daemon-process.js";
import { Workspace, type WorkspaceDeps } from "../src/main/workspace.js";
import { FirstRunSetup } from "../src/main/first-run/setup.js";
import { startFirstRunWorkspace } from "../src/main/first-run/ipc.js";
import { compiledSourceFixture } from "./compiled-source-fixture.js";

const identity = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
const hello = (path = "/selected"): HelloResult => ({
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  capabilities: ["runs.read", "runs.control", "runs.subscribe"],
  identity,
  processId: 123,
  storeDir: join(path, ".orca"),
});
function rig(options: Partial<WorkspaceDeps> = {}) {
  let exited = false;
  const stop = vi.fn(async () => {
    exited = true;
  });
  const start = vi.fn<WorkspaceDeps["start"]>().mockResolvedValue({
    url: "http://127.0.0.1:7654",
    pid: 123,
    tokenFile: "/selected/auth/local-client.token",
    get exited() {
      return exited;
    },
    stop,
  });
  const client = vi.fn<WorkspaceDeps["client"]>((url) => new DaemonClient(url));
  const subscribe = vi.fn(() => ({ close: vi.fn() }) as unknown as DaemonSubscription);
  const workspace = new Workspace({
    findEntry: () => "/bundle.mjs",
    start,
    client,
    subscribe,
    onSwitch: () => {},
    onSnapshot: () => {},
    onDaemonGone: () => {},
    defaultPath: () => undefined,
    defaultUrl: "http://127.0.0.1:6722",
    // Existing unit cases model an in-memory process; durable filesystem behavior has its own tests.
    reserveFirstRunOwnership: () => ({
      check: () => {},
      attach: () => {},
      verify: () => {},
      complete: () => exited,
    }),
    ...options,
  });
  return { workspace, start, stop, client, subscribe, exited: () => exited };
}
it("cold startup with no selection creates only an inert client and starts no child or probe", async () => {
  const f = rig();
  const setup = new FirstRunSetup({
    home: tmpdir(),
    receiptPath: "/absent/selection.json",
    choose: async () => undefined,
    prepareConnection: (path) => f.workspace.prepareFirstRunConnection(path),
    current: (path) => f.workspace.currentFirstRun(path),
  });
  await startFirstRunWorkspace(setup, {
    explicitTarget: false,
    connectExplicit: () => f.workspace.connect(),
    assertCurrent: () => f.workspace.assertEpoch(0),
  });
  expect(f.client).toHaveBeenCalledExactlyOnceWith("", { workspace: "", bundled: false });
  expect(f.start).not.toHaveBeenCalled();
  expect(f.subscribe).not.toHaveBeenCalled();
  await expect(f.workspace.prepareConnection(null)).rejects.toThrow("first-run workspace");
  await f.workspace.close();
});
it("keeps the old stream intact while a strict owned candidate fences competing connection/update work", async () => {
  const f = rig({ savedUrl: "http://remote:6722" });
  await f.workspace.connect();
  const oldClient = f.workspace.client,
    oldStream = f.workspace.subscription,
    epoch = f.workspace.connectionTarget.epoch;
  const candidate = await f.workspace.prepareFirstRunConnection("/selected");
  expect(f.start.mock.calls[0]![0]).toMatchObject({
    cwd: "/selected",
    configPath: "/selected/orca.config.yaml",
    readOnly: false,
  });
  expect(f.workspace.client).toBe(oldClient);
  expect(f.workspace.subscription).toBe(oldStream);
  await expect(f.workspace.prepareFirstRunConnection("/selected")).rejects.toThrow("busy");
  await expect(f.workspace.prepareConnection("http://other:6722")).rejects.toThrow("busy");
  await expect(f.workspace.open("/archive")).rejects.toThrow("progress");
  await expect(f.workspace.prepareUpdate("token")).rejects.toThrow("busy");
  expect(await f.workspace.captureMacUpdateTarget({ epoch, ...identity })).toBeUndefined();
  candidate.activate(hello());
  expect(f.workspace.currentFirstRun("/selected")).toBe(true);
  expect(f.workspace.connectionTarget.epoch).toBeGreaterThan(epoch);
  expect(() => f.workspace.assertEpoch(epoch)).toThrow("previous connection");
  await candidate.dispose();
  expect(f.stop).not.toHaveBeenCalled();
  await f.workspace.close();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("disposes only a failed candidate once, preserving the remote target", async () => {
  const f = rig({ savedUrl: "http://remote:6722" });
  await f.workspace.connect();
  const target = f.workspace.connectionTarget;
  const candidate = await f.workspace.prepareFirstRunConnection("/selected");
  expect(() => candidate.activate({ ...hello(), processId: 124 })).toThrow("identity changed");
  await candidate.dispose();
  await candidate.dispose();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.workspace.connectionTarget).toEqual(target);
  await f.workspace.close();
});
it("reuses the exact parked first-run child and never starts a competing writer", async () => {
  const f = rig();
  (await f.workspace.prepareFirstRunConnection("/selected")).activate(hello());
  const remote = await f.workspace.prepareConnection("http://remote:6722");
  remote.activate({ ...hello(), identity: { ...identity, instanceId: "33333333-3333-4333-8333-333333333333" } });
  await expect(f.workspace.prepareFirstRunConnection("/other")).rejects.toThrow("parked");
  await expect(f.workspace.open("/selected")).rejects.toThrow("parked owned daemon");
  const back = await f.workspace.prepareFirstRunConnection("/selected");
  await back.dispose();
  expect(f.stop).not.toHaveBeenCalled();
  const retry = await f.workspace.prepareFirstRunConnection("/selected");
  retry.activate(hello());
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.workspace.currentFirstRun("/selected")).toBe(true);
  f.workspace.observeHello(f.workspace.client, { ...hello(), capabilities: ["runs.read"] });
  expect(f.workspace.currentFirstRun("/selected")).toBe(false);
  await f.workspace.close();
});
it.each(["metadata", "entry", "startup"] as const)(
  "%s failure never probes or subscribes to a default port",
  async (kind) => {
    const f = rig(kind === "entry" ? { findEntry: () => undefined } : {});
    if (kind === "metadata") f.start.mockResolvedValueOnce({ url: "http://127.0.0.1:7654", pid: 123, stop: f.stop });
    if (kind === "startup") f.start.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(f.workspace.prepareFirstRunConnection("/selected")).rejects.toThrow();
    expect(f.client).toHaveBeenCalledTimes(1);
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledTimes(kind === "metadata" ? 1 : 0);
    await f.workspace.close();
  },
);
it("an interrupted spawn stops the late owned child without activating it", async () => {
  const f = rig();
  let finish!: (daemon: BundledDaemon) => void;
  f.start.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const preparing = f.workspace.prepareFirstRunConnection("/selected");
  const refused = expect(preparing).rejects.toThrow("changed");
  await f.workspace.close();
  finish({
    url: "http://127.0.0.1:7654",
    pid: 123,
    tokenFile: "/selected/auth/local-client.token",
    get exited() {
      return f.exited();
    },
    stop: f.stop,
  });
  await refused;
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.subscribe).not.toHaveBeenCalled();
});
it("uncertain ordinary candidate cleanup keeps ownership reserved and prohibits another writer", async () => {
  const f = rig();
  f.stop.mockImplementation(async () => {});
  const candidate = await f.workspace.prepareFirstRunConnection("/selected");
  await expect(candidate.dispose()).rejects.toThrow("ownership requires reconciliation");
  await expect(f.workspace.prepareFirstRunConnection("/selected")).rejects.toThrow("busy");
  await expect(f.workspace.prepareUpdate("token")).rejects.toThrow("busy");
  expect(f.start).toHaveBeenCalledOnce();
  await f.workspace.close();
});
it("setup activity refuses both updater reservation paths and explicit remote precedence refuses local activation", async () => {
  const f = rig({ setupBusy: () => true, explicitUrl: "http://remote:6722" });
  await f.workspace.connect();
  await expect(f.workspace.prepareUpdate("token")).rejects.toThrow("busy");
  expect(
    await f.workspace.captureMacUpdateTarget({ epoch: f.workspace.connectionTarget.epoch, ...identity }),
  ).toBeUndefined();
  await expect(f.workspace.prepareFirstRunConnection("/selected")).rejects.toThrow("ORCA_DAEMON_URL");
  expect(f.start).not.toHaveBeenCalled();
  await f.workspace.close();
});

const compile = compiledSourceFixture(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "packages/app/test/fixtures/first-run-daemon.ts",
  ["package.json", "pnpm-lock.yaml", "tsconfig.json"],
);
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
it.skipIf(typeof process.getuid !== "function")(
  "prepares, authenticates and reopens a real CLI child with exact config/store/owned PID",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-first-run-owned-"));
    const ownerState: { workspace?: Workspace } = {};
    cleanup = async () => {
      await ownerState.workspace?.close();
      await rm(root, { recursive: true, force: true });
    };
    const home = join(root, "home"),
      project = join(root, "project"),
      selected = join(root, "selected");
    for (const path of [home, project, selected]) await mkdir(path);
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
    const entry = join(root, "daemon.mjs");
    await writeFile(entry, compile().source);
    const start = vi.fn<WorkspaceDeps["start"]>((options) =>
      startBundledDaemon({
        ...options,
        execPath: process.execPath,
        env: { PATH: process.env.PATH ?? "" },
        startTimeoutMs: 10_000,
        stopTimeoutMs: 1000,
      }),
    );
    const workspaceDeps: WorkspaceDeps = {
      findEntry: () => entry,
      start,
      client: (url, options) =>
        new DaemonClient(url, fetch, {
          requireAuthentication: true,
          auth: new LocalDaemonToken({ url, ...(options.tokenFile ? { tokenFile: options.tokenFile } : {}), env: {} }),
        }),
      subscribe: () => ({ close: () => {} }) as unknown as DaemonSubscription,
      onSwitch: () => {},
      onSnapshot: () => {},
      onDaemonGone: () => {},
      defaultPath: () => undefined,
      defaultUrl: "http://127.0.0.1:6722",
    };
    const workspace = new Workspace(workspaceDeps);
    ownerState.workspace = workspace;
    let owner = workspace;
    const deps = {
      home,
      receiptPath: join(root, "profile", "selection.json"),
      choose: async (kind: "project" | "workspace") => (kind === "project" ? project : selected),
      prepareConnection: (path: string) => owner.prepareFirstRunConnection(path),
      current: (path: string) => owner.currentFirstRun(path),
    };
    const setup = new FirstRunSetup(deps);
    const review = await setup.choose(() => owner.assertEpoch(0));
    if (review.state !== "review") throw new Error("Expected review");
    await setup.prepare(review.review.id, () => owner.assertEpoch(0));
    await startFirstRunWorkspace(setup, {
      explicitTarget: false,
      connectExplicit: () => owner.connect(),
      assertCurrent: () => owner.assertEpoch(0),
    });
    expect(owner.currentFirstRun(selected)).toBe(true);
    expect(await owner.client.hello("first-run-evidence", false)).toMatchObject({
      processId: (await start.mock.results[0]!.value).pid,
      storeDir: join(selected, ".orca"),
      capabilities: expect.arrayContaining(["runs.control"]),
    });
    const restarted = new FirstRunSetup(deps);
    const epoch = owner.connectionTarget.epoch;
    expect((await restarted.status()).state).toBe("prepared");
    await restarted.connect(() => owner.assertEpoch(epoch));
    expect(start).toHaveBeenCalledOnce();
    // A saved external target must win even when an intact setup receipt exists.
    const connectExplicit = vi.fn(async () => {});
    await startFirstRunWorkspace(restarted, {
      explicitTarget: true,
      connectExplicit,
      assertCurrent: () => owner.assertEpoch(epoch),
    });
    expect(connectExplicit).toHaveBeenCalledOnce();
    // A recreated app cannot launch a rival while the original real child is alive.
    const rival = new Workspace(workspaceDeps);
    await expect(rival.prepareFirstRunConnection(selected)).rejects.toThrow("reconciliation");
    expect(start).toHaveBeenCalledOnce();
    await rival.close();
    // Ordinary, positively observed direct-child termination records a terminal marker.
    await owner.close();
    owner = new Workspace(workspaceDeps);
    ownerState.workspace = owner;
    await new FirstRunSetup(deps).connect(() => owner.assertEpoch(0));
    expect(start).toHaveBeenCalledTimes(2);
    expect(owner.currentFirstRun(selected)).toBe(true);
    expect((await owner.client.hello("first-run-recreated", false)).processId).not.toBe(
      (await start.mock.results[0]!.value).pid,
    );
  },
  30_000,
);
