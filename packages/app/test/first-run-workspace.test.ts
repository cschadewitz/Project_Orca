/** Exact candidate ownership and cold-start policy, plus a real compiled CLI child over disposable directories. */
import type { UpdateHandoff } from "@orca/protocol/update-handoff";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { refusalMessage, startFirstRunWorkspace } from "../src/main/first-run/ipc.js";
import { Updates, UpdatePreflightRefusal } from "../src/main/updates.js";
import { compiledSourceFixture } from "./compiled-source-fixture.js";

const selectedPath = resolve("/selected");
const identity = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
const hello = (path = selectedPath): HelloResult => ({
  protocol: PROTOCOL_VERSION,
  orcaVersion: "test",
  capabilities: ["runs.read", "runs.control", "runs.subscribe"],
  identity,
  processId: 123,
  storeDir: join(path, ".orca"),
});
/** The reservation the fake first-run ownership reports for every attempt. */
const STOPPED = { reservationId: "11111111-1111-4111-8111-111111111111", claimHash: "a".repeat(64) };

function rig(options: Partial<WorkspaceDeps> = {}) {
  let exited = false;
  const stop = vi.fn(async () => {
    exited = true;
  });
  const start = vi.fn<WorkspaceDeps["start"]>().mockResolvedValue({
    url: "http://127.0.0.1:7654",
    pid: 123,
    tokenFile: join(selectedPath, "auth", "local-client.token"),
    get exited() {
      return exited;
    },
    stop,
  });
  const client = vi.fn<WorkspaceDeps["client"]>((url) => new DaemonClient(url));
  const subscribe = vi.fn(() => ({ close: vi.fn() }) as unknown as DaemonSubscription);
  const workspace = new Workspace({
    findEntry: () => resolve("/bundle.mjs"),
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
      reservationId: STOPPED.reservationId,
      claimHash: STOPPED.claimHash,
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
  const candidate = await f.workspace.prepareFirstRunConnection(selectedPath);
  expect(f.start.mock.calls[0]![0]).toMatchObject({
    cwd: selectedPath,
    configPath: join(selectedPath, "orca.config.yaml"),
    readOnly: false,
  });
  expect(f.workspace.client).toBe(oldClient);
  expect(f.workspace.subscription).toBe(oldStream);
  await expect(f.workspace.prepareFirstRunConnection(selectedPath)).rejects.toThrow("busy");
  await expect(f.workspace.prepareConnection("http://other:6722")).rejects.toThrow("busy");
  await expect(f.workspace.open(resolve("/archive"))).rejects.toThrow("progress");
  await expect(f.workspace.prepareUpdate("token")).rejects.toThrow("busy");
  expect(await f.workspace.captureMacUpdateTarget({ epoch, ...identity })).toBeUndefined();
  candidate.activate(hello());
  expect(f.workspace.currentFirstRun(selectedPath)).toBe(true);
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
  const candidate = await f.workspace.prepareFirstRunConnection(selectedPath);
  expect(() => candidate.activate({ ...hello(), processId: 124 })).toThrow("identity changed");
  await candidate.dispose();
  await candidate.dispose();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.workspace.connectionTarget).toEqual(target);
  await f.workspace.close();
});
it("reuses the exact parked first-run child and never starts a competing writer", async () => {
  const f = rig();
  (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  const remote = await f.workspace.prepareConnection("http://remote:6722");
  remote.activate({ ...hello(), identity: { ...identity, instanceId: "33333333-3333-4333-8333-333333333333" } });
  await expect(f.workspace.prepareFirstRunConnection(resolve("/other"))).rejects.toThrow("parked");
  await expect(f.workspace.open(selectedPath)).rejects.toThrow("parked owned daemon");
  const back = await f.workspace.prepareFirstRunConnection(selectedPath);
  await back.dispose();
  expect(f.stop).not.toHaveBeenCalled();
  const retry = await f.workspace.prepareFirstRunConnection(selectedPath);
  retry.activate(hello());
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.workspace.currentFirstRun(selectedPath)).toBe(true);
  f.workspace.observeHello(f.workspace.client, { ...hello(), capabilities: ["runs.read"] });
  expect(f.workspace.currentFirstRun(selectedPath)).toBe(false);
  await f.workspace.close();
});
it.each(["metadata", "entry", "startup"] as const)(
  "%s failure never probes or subscribes to a default port",
  async (kind) => {
    const f = rig(kind === "entry" ? { findEntry: () => undefined } : {});
    if (kind === "metadata") f.start.mockResolvedValueOnce({ url: "http://127.0.0.1:7654", pid: 123, stop: f.stop });
    if (kind === "startup") f.start.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(f.workspace.prepareFirstRunConnection(selectedPath)).rejects.toThrow();
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
  const preparing = f.workspace.prepareFirstRunConnection(selectedPath);
  const refused = expect(preparing).rejects.toThrow("changed");
  await f.workspace.close();
  finish({
    url: "http://127.0.0.1:7654",
    pid: 123,
    tokenFile: join(selectedPath, "auth", "local-client.token"),
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
  const candidate = await f.workspace.prepareFirstRunConnection(selectedPath);
  await expect(candidate.dispose()).rejects.toThrow("ownership requires reconciliation");
  await expect(f.workspace.prepareFirstRunConnection(selectedPath)).rejects.toThrow("busy");
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
  await expect(f.workspace.prepareFirstRunConnection(selectedPath)).rejects.toThrow("ORCA_DAEMON_URL");
  expect(f.start).not.toHaveBeenCalled();
  await f.workspace.close();
});
it("tells setup that ORCA_DAEMON_URL, not the selected folders, stopped Connect", async () => {
  const f = rig({ explicitUrl: "http://127.0.0.1:6722" });
  const refusal = await f.workspace.prepareFirstRunConnection(selectedPath).catch((error: unknown) => error);
  // What the setup card shows: the reason itself, not the generic folder refusal.
  expect(refusalMessage(refusal)).toMatch(/^ORCA_DAEMON_URL is set\b.*Unset ORCA_DAEMON_URL, restart ORCA/);
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
    const root = await mkdtemp(join(process.cwd(), ".orca-first-run-owned-test-"));
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
    // Installer non-launch recovery uses the real saved receipt and a fresh exact owned child.
    workspaceDeps.recoverFirstRun = async (path, check, prepareConnection) => {
      await new FirstRunSetup(deps).connect(check, { workspace: path, prepareConnection });
    };
    const receiptBefore = await readFile(deps.receiptPath, "utf8");
    const releaseDrafts = vi.fn();
    const updater = new Updates(
      {
        check: async () => "synthetic-next",
        download: async () => {},
        install: async () => "not-launched",
      },
      "fixture",
      {
        prepareDrafts: async () => {},
        prepareDaemon: (token) => owner.prepareUpdate(token),
        stopDaemon: (token) => owner.stopForUpdate(token),
        resume: (token) => owner.cancelUpdate(token),
        releaseDrafts,
      },
      () => {},
    );
    await updater.act("check");
    await updater.act("download");
    expect((await updater.act("restart")).phase).toBe("ready");
    expect(releaseDrafts).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
    expect(owner.currentFirstRun(selected)).toBe(true);
    expect(await readFile(deps.receiptPath, "utf8")).toBe(receiptBefore);
    expect(await readFile(join(selected, ".orca-first-run-ownership", "000001", "terminal.json"), "utf8")).toContain(
      "direct-child-terminal",
    );
    expect(await readdir(join(selected, ".orca-first-run-ownership", "000002"))).not.toContain("terminal.json");
    await expect(owner.cancelUpdate("stale")).rejects.toThrow("stale");
    await expect(owner.connect()).rejects.toThrow("reconciliation");
    expect(start).toHaveBeenCalledTimes(2);
    // Ordinary, positively observed direct-child termination records a terminal marker.
    await owner.close();
    owner = new Workspace(workspaceDeps);
    ownerState.workspace = owner;
    await new FirstRunSetup(deps).connect(() => owner.assertEpoch(0));
    expect(start).toHaveBeenCalledTimes(3);
    expect(owner.currentFirstRun(selected)).toBe(true);
    expect((await owner.client.hello("first-run-recreated", false)).processId).not.toBe(
      (await start.mock.results[0]!.value).pid,
    );
  },
  30_000,
);

it("captures saved-config binding only over the exact surviving first-run owner and rejects target changes", async () => {
  const rebindConfig = vi.fn();
  const f = rig({
    reserveFirstRunOwnership: () => ({
      reservationId: STOPPED.reservationId,
      claimHash: STOPPED.claimHash,
      check: () => {},
      attach: () => {},
      verify: () => {},
      complete: () => f.exited(),
      rebindConfig,
    }),
  });
  const candidate = await f.workspace.prepareFirstRunConnection(selectedPath);
  expect(() => f.workspace.captureFirstRunConfiguration(selectedPath)).toThrow("reconciliation");
  candidate.activate(hello());
  expect(() => f.workspace.captureFirstRunConfiguration(resolve("/wrong"))).toThrow("reconciliation");
  const boundary = f.workspace.captureFirstRunConfiguration(selectedPath);
  boundary.rebind("reviewed-old-hash", "reviewed-new-hash");
  expect(rebindConfig).toHaveBeenCalledExactlyOnceWith("reviewed-old-hash", "reviewed-new-hash");
  (await f.workspace.prepareConnection("http://remote:6722")).activate(hello());
  expect(() => boundary.rebind("old", "new")).toThrow("previous connection");
  expect(rebindConfig).toHaveBeenCalledOnce();
  await f.workspace.close();
});
it("refuses saved-config capture without the durable rebind interface and after app close", async () => {
  const legacy = rig();
  (await legacy.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  expect(() => legacy.workspace.captureFirstRunConfiguration(selectedPath)).toThrow("reconciliation");
  await legacy.workspace.close();
  const rebindConfig = vi.fn();
  const f = rig({
    reserveFirstRunOwnership: () => ({
      reservationId: STOPPED.reservationId,
      claimHash: STOPPED.claimHash,
      check: () => {},
      attach: () => {},
      verify: () => {},
      complete: () => f.exited(),
      rebindConfig,
    }),
  });
  (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  const boundary = f.workspace.captureFirstRunConfiguration(selectedPath);
  await f.workspace.close();
  expect(() => boundary.rebind("old", "new")).toThrow("reconciliation");
  expect(rebindConfig).not.toHaveBeenCalled();
});

it("preflight refusal with a parked child releases only this restart's guards and permits retry", async () => {
  const f = rig();
  (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  const localMaintenance = vi.spyOn(f.workspace.client, "maintenance");
  const remote = await f.workspace.prepareConnection("http://remote:6722");
  remote.activate(hello());
  const remoteMaintenance = vi.spyOn(f.workspace.client, "maintenance");
  const prepareDrafts = vi.fn(async () => {});
  const releaseDrafts = vi.fn();
  const resume = vi.fn((token: string) => f.workspace.cancelUpdate(token));
  const install = vi.fn(async () => "not-launched" as const);
  const updater = new Updates(
    { check: async () => "fixture-next", download: async () => {}, install },
    "fixture",
    {
      prepareDrafts,
      prepareDaemon: (token) => f.workspace.prepareUpdate(token),
      stopDaemon: (token) => f.workspace.stopForUpdate(token),
      resume,
      releaseDrafts,
    },
    () => {},
  );
  await updater.act("check");
  await updater.act("download");
  expect((await updater.act("restart")).phase).toBe("ready");
  expect(releaseDrafts).toHaveBeenCalledOnce();
  expect(resume).not.toHaveBeenCalled();
  expect(localMaintenance).not.toHaveBeenCalled();
  expect(remoteMaintenance).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  await f.workspace.ready();
  expect((await updater.act("restart")).phase).toBe("ready");
  expect(prepareDrafts).toHaveBeenCalledTimes(2);
  expect(releaseDrafts).toHaveBeenCalledTimes(2);
  (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  expect(f.workspace.currentFirstRun(selectedPath)).toBe(true);
  expect(f.start).toHaveBeenCalledOnce();
  await f.workspace.close();
});

it.each(["candidate", "connection", "setup"] as const)(
  "real %s preflight refusal makes no update claim and leaves its original guard intact",
  async (kind) => {
    let setupBusy = false;
    const f = rig({ setupBusy: () => setupBusy });
    const candidate =
      kind === "candidate"
        ? await f.workspace.prepareFirstRunConnection(selectedPath)
        : kind === "connection"
          ? await f.workspace.prepareConnection("http://remote:6722")
          : undefined;
    setupBusy = kind === "setup";
    const prepareDrafts = vi.fn(async () => {});
    const releaseDrafts = vi.fn();
    const resume = vi.fn((token: string) => f.workspace.cancelUpdate(token));
    const install = vi.fn(async () => "not-launched" as const);
    const updater = new Updates(
      { check: async () => "fixture-next", download: async () => {}, install },
      "fixture",
      {
        prepareDrafts,
        prepareDaemon: (token) => f.workspace.prepareUpdate(token),
        stopDaemon: (token) => f.workspace.stopForUpdate(token),
        resume,
        releaseDrafts,
      },
      () => {},
    );
    await updater.act("check");
    await updater.act("download");
    expect((await updater.act("restart")).phase).toBe("ready");
    expect(resume).not.toHaveBeenCalled();
    expect(releaseDrafts).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    if (kind === "candidate") await expect(f.workspace.prepareFirstRunConnection(selectedPath)).rejects.toThrow("busy");
    if (kind === "connection") await expect(f.workspace.prepareUpdate("other")).rejects.toThrow("busy");
    if (kind === "setup") await expect(f.workspace.prepareUpdate("other")).rejects.toThrow("busy");
    await candidate?.dispose();
    setupBusy = false;
    await f.workspace.ready();
    expect((await updater.act("restart")).phase).toBe("ready");
    expect(prepareDrafts).toHaveBeenCalledTimes(2);
    expect(releaseDrafts).toHaveBeenCalledTimes(2);
    await f.workspace.close();
  },
);
it("uncertain preparation after a real claim retains both the claim and draft hold", async () => {
  const f = rig();
  (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  const maintenance = vi.spyOn(f.workspace.client, "maintenance").mockRejectedValue(new Error("uncertain RPC"));
  const prepareDrafts = vi.fn(async () => {});
  const releaseDrafts = vi.fn();
  const install = vi.fn(async () => "not-launched" as const);
  const updater = new Updates(
    { check: async () => "fixture-next", download: async () => {}, install },
    "fixture",
    {
      prepareDrafts,
      prepareDaemon: (token) => f.workspace.prepareUpdate(token),
      stopDaemon: (token) => f.workspace.stopForUpdate(token),
      resume: (token) => f.workspace.cancelUpdate(token),
      releaseDrafts,
    },
    () => {},
  );
  await updater.act("check");
  await updater.act("download");
  expect((await updater.act("restart")).phase).toBe("error");
  expect(maintenance.mock.calls.map(([params]) => params.action)).toEqual(["prepare", "resume"]);
  expect(maintenance.mock.calls[0]![0].token).toBe(maintenance.mock.calls[1]![0].token);
  expect(releaseDrafts).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  await expect(f.workspace.ready()).rejects.toThrow("admission is closed");
  await updater.act("restart");
  expect(prepareDrafts).toHaveBeenCalledOnce();
  await f.workspace.close();
});
it("preflight evidence for another token cannot revoke an existing exact claim", async () => {
  const f = rig();
  (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  const maintenance = vi
    .spyOn(f.workspace.client, "maintenance")
    .mockResolvedValueOnce({ ready: true, active: [] })
    .mockResolvedValueOnce({ ready: false, active: [] });
  await f.workspace.prepareUpdate("owner");
  await expect(f.workspace.prepareUpdate("other")).rejects.toMatchObject({ token: "other" });
  await expect(f.workspace.prepareUpdate("owner")).rejects.not.toBeInstanceOf(UpdatePreflightRefusal);
  await expect(f.workspace.cancelUpdate("other")).rejects.toThrow("stale");
  await expect(f.workspace.ready()).rejects.toThrow("admission is closed");
  expect(maintenance).toHaveBeenCalledOnce();
  await f.workspace.cancelUpdate("owner");
  await f.workspace.ready();
  expect(maintenance.mock.calls[1]![0]).toEqual({ action: "resume", token: "owner" });
  await f.workspace.close();
});

it("hands the stopped daemon's store off only after the exact stop, once, and never deletes it itself (#897)", async () => {
  const receipt = { reservationId: "receipt" } as unknown as UpdateHandoff;
  const handOffStore = vi.fn(() => receipt);
  const f = rig({ handOffStore });
  (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
  vi.spyOn(f.workspace.client, "maintenance").mockResolvedValue({ ready: true, active: [] });
  await expect(f.workspace.handOffForUpdate("owner", "0.8.0", "0.9.0")).rejects.toThrow("not prepared");
  await f.workspace.prepareUpdate("owner");
  await expect(f.workspace.handOffForUpdate("owner", "0.8.0", "0.9.0")).rejects.toThrow("not available");
  expect(handOffStore).not.toHaveBeenCalled();
  await f.workspace.stopForUpdate("owner");
  await expect(f.workspace.handOffForUpdate("other", "0.8.0", "0.9.0")).rejects.toThrow("not prepared");
  await f.workspace.handOffForUpdate("owner", "0.8.0", "0.9.0");
  // With the exact reservation this attempt stopped, never the journal's latest by then.
  expect(handOffStore).toHaveBeenCalledExactlyOnceWith(selectedPath, STOPPED, "0.8.0", "0.9.0");
  await expect(f.workspace.handOffForUpdate("owner", "0.8.0", "0.9.0")).rejects.toThrow("not available");
  // The installer never ran: recovery proceeds, and the record is left for the recovered
  // daemon to spend under its own fence (packages/app/test/store-carryover).
  await expect(f.workspace.cancelUpdate("owner")).rejects.toThrow();
  await f.workspace.close();
});

it("refusal after the preflight await keeps an intervening connection candidate's guard", async () => {
  const f = rig();
  let connection: Awaited<ReturnType<Workspace["prepareConnection"]>> | undefined;
  vi.spyOn(f.workspace, "ready").mockImplementationOnce(async () => {
    connection = await f.workspace.prepareConnection("http://remote:6722");
  });
  await expect(f.workspace.prepareUpdate("unclaimed")).rejects.toMatchObject({ token: "unclaimed" });
  await expect(f.workspace.prepareFirstRunConnection(selectedPath)).rejects.toThrow("busy");
  expect(f.start).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  connection!.check?.();
  await connection!.dispose();
  await f.workspace.prepareUpdate("owner");
  await f.workspace.cancelUpdate("owner");
  await f.workspace.ready();
  await f.workspace.close();
});

it.each(["parked", "setup"] as const)(
  "rechecks the %s guard after preflight awaits, before reserving",
  async (kind) => {
    let busy = false;
    const f = rig({ setupBusy: () => busy });
    (await f.workspace.prepareFirstRunConnection(selectedPath)).activate(hello());
    const maintenance = vi.spyOn(f.workspace.client, "maintenance").mockResolvedValue({ ready: true, active: [] });
    vi.spyOn(f.workspace, "ready").mockImplementationOnce(async () => {
      if (kind === "setup") busy = true;
      else (await f.workspace.prepareConnection("http://remote:6722")).activate(hello());
    });
    await expect(f.workspace.prepareUpdate("unclaimed")).rejects.toMatchObject({ token: "unclaimed" });
    expect(maintenance).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledOnce();
    await expect(f.workspace.stopForUpdate("unclaimed")).rejects.toThrow("not prepared");
    await f.workspace.close();
  },
);
