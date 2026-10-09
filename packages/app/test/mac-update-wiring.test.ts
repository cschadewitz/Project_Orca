/** Only applied with the #571 wiring patch; actual owner RPC, synthetic child/subscription. */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Workspace } from "../src/main/workspace.js";
import { DaemonClient } from "../src/client/daemon-client.js";
import { LocalDaemonToken } from "../src/client/auth.js";
import type { DaemonSubscription } from "../src/client/subscription.js";
import { captureMacDrain, prepareMacDrain } from "../src/main/mac-update-drain.js";
import { runtimeMaintenanceFixture } from "../../daemon/test/runtime-maintenance-fixture.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture(bootstrap?: { ordinaryAllowed: boolean }) {
  const f = await runtimeMaintenanceFixture({ gated: true });
  closers.push(f.close);
  const directory = await mkdtemp(join(tmpdir(), "orca-wiring-token-"));
  closers.push(() => rm(directory, { recursive: true }));
  const tokenFile = join(directory, "owner.token");
  await writeFile(tokenFile, f.owner.token, { mode: 0o600 });
  const stop = vi.fn(async () => {});
  const start = vi.fn(async () => ({
    url: f.daemon.url,
    pid: process.pid,
    tokenFile,
    stop,
  }));
  const workspace = new Workspace({
    ...(bootstrap ? { updateBootstrap: bootstrap } : {}),
    findEntry: () => "fixture",
    start,
    client: (url) =>
      new DaemonClient(url, fetch, {
        requireAuthentication: true,
        auth: new LocalDaemonToken({ url, tokenFile, env: {} }),
      }),
    subscribe: () => ({ close: () => {} }) as unknown as DaemonSubscription,
    onSwitch: () => {},
    onSnapshot: () => {},
    onDaemonGone: () => {},
    defaultUrl: f.daemon.url,
    defaultPath: () => f.dir,
  });
  closers.push(() => workspace.close());
  return { ...f, workspace, start, stop };
}
it("keeps Workspace completion IPC usable during parked drain, then freezes on the same held owner", async () => {
  const f = await fixture();
  await f.workspace.connect();
  f.workspace.observeHello(f.workspace.client, await f.workspace.client.hello("wiring-test", false));
  const started = await f.call("runs.start", { workflowId: "flow" });
  if (!started.ok) throw new Error("Start failed");
  const runId = (started.result as { runId: string }).runId;
  const target = { ...f.identity, epoch: f.workspace.connectionTarget.epoch };
  const drain = await captureMacDrain(
    (expected) => f.workspace.captureMacUpdateDrainTarget(expected),
    target,
    randomUUID(),
  );
  if (drain.outcome !== "ready") throw new Error("Capture failed");
  expect(await drain.lease.observe()).toBe("draining");
  expect(f.workspace.macUpdateReserved).toBe(true);
  await expect(f.workspace.ready()).resolves.toBeUndefined();
  expect(() => f.workspace.assertEpoch(target.epoch)).not.toThrow();
  const [input] = await f.orc.pendingInputs(runId);
  expect(
    await f.call("inputs.answer", {
      runId,
      requestId: input!.id,
      optionId: "finish",
    }),
  ).toMatchObject({ ok: true });
  expect(await drain.lease.observe()).toBe("held");
  const prepared = await prepareMacDrain(drain.lease, target, drain.lease.token, () => true);
  expect(prepared.outcome).toBe("ready");
  await expect(f.workspace.ready()).rejects.toThrow("closed");
  expect(() => f.workspace.assertEpoch(target.epoch)).toThrow("closed");
  if (prepared.outcome !== "ready") throw new Error("Prepare failed");
  expect(await prepared.lease.release()).toBe("released");
  expect(f.workspace.macUpdateReserved).toBe(false);
  await expect(f.workspace.ready()).resolves.toBeUndefined();
});
it("ordinary quit never invokes forced shutdown for an updater-owned drain reservation", async () => {
  const f = await fixture();
  await f.workspace.connect();
  f.workspace.observeHello(f.workspace.client, await f.workspace.client.hello("wiring-test", false));
  const target = { ...f.identity, epoch: f.workspace.connectionTarget.epoch };
  const drain = await captureMacDrain(
    (expected) => f.workspace.captureMacUpdateDrainTarget(expected),
    target,
    randomUUID(),
  );
  if (drain.outcome !== "ready") throw new Error("Capture failed");
  await drain.lease.observe();
  await f.workspace.close();
  expect(f.stop).not.toHaveBeenCalled();
});
it("a durable bootstrap gate blocks normal and first-run process startup before writer work", async () => {
  const f = await fixture({ ordinaryAllowed: false });
  await expect(f.workspace.connect()).rejects.toThrow("closed");
  await expect(f.workspace.prepareFirstRunConnection(f.dir)).rejects.toThrow("closed");
  await expect(f.workspace.prepareConnection(null)).rejects.toThrow("closed");
  await expect(f.workspace.prepareConnection(f.daemon.url)).rejects.toThrow("closed");
  expect(f.start).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  expect(() => f.workspace.assertEpoch(0)).toThrow("closed");
});
