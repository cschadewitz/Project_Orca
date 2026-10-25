/** Allocation attribution only: real disk/controller, synthetic POSIX/key/fault ports; no native acceptance. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";

const [compiledDirectory, schedule] = process.argv.slice(2);
assert.ok(["metadata", "failure", "stall"].includes(schedule));
assert.equal(typeof globalThis.gc, "undefined", "run without forced GC");
const load = (name) => import(pathToFileURL(path.join(compiledDirectory, name + ".js")).href);
const { ControlledPayloadMemory } = await load("payload-memory");
const { NodeRecoveryDisk } = await load("recovery-disk");
const { RecoveryController } = await load("recovery-controller");
const { PosixFixtureNativeAdapter } = await load("native-adapter");
const { DIAGNOSTICS_PRODUCTION_ENABLED } = await import(
  pathToFileURL(path.resolve(compiledDirectory, "../../diagnostics-contract.js")).href
);
assert.equal(DIAGNOSTICS_PRODUCTION_ENABLED, false);
const parent = await mkdtemp(path.join(tmpdir(), "orca-arena-probe-"));
const baseline = process.memoryUsage();
let peak = baseline.heapUsed + baseline.external,
  heapPeak = baseline.heapUsed,
  externalPeak = baseline.external,
  rssPeak = baseline.rss,
  backingAllocated = 0,
  largestBacking = 0,
  controlledPeak = 0,
  phase = "setup";
const phases = {};
const sample = () => {
  const usage = process.memoryUsage();
  peak = Math.max(peak, usage.heapUsed + usage.external);
  heapPeak = Math.max(heapPeak, usage.heapUsed);
  externalPeak = Math.max(externalPeak, usage.external);
  rssPeak = Math.max(rssPeak, usage.rss);
  phases[phase] = Math.max(phases[phase] ?? 0, usage.heapUsed + usage.external - baseline.heapUsed - baseline.external);
};
// Count backing allocations at the real allocator, retaining only scalar totals.
class ObservedPayload extends ControlledPayloadMemory {
  allocate(length) {
    const before = this.stats().arenaBytes;
    const lease = super.allocate(length);
    const after = this.stats();
    const added = after.arenaBytes - before;
    backingAllocated += added;
    largestBacking = Math.max(largestBacking, added);
    controlledPeak = Math.max(controlledPeak, after.peakBytes);
    sample();
    return lease;
  }
}
const timer = setInterval(sample, 2);
let cells = 0,
  pressureRefusals = 0,
  zeroAfterEveryCell = true,
  pendingRelease;
const deadline = setTimeout(() => {
  throw Error("probe deadline");
}, 90_000);
try {
  for (let index = 0; index < 20; index++) {
    phase = "metadata";
    const payload = new ObservedPayload();
    const native = new PosixFixtureNativeAdapter({
      stopped: async () => true,
      moveNoReplace: async () => {
        throw Error("probe never publishes");
      },
    });
    const raw = new NodeRecoveryDisk({
      root: path.join(parent, String(index)),
      native,
      payload,
      keys: {
        available: async () => true,
        wrap: async (bytes) => Buffer.from(bytes),
        unwrap: async (bytes) => Buffer.from(bytes),
      },
    });
    await raw.writeSetting({ enabled: true, scopeVersion: 1, minutes: 5 });
    sample();
    if (schedule !== "metadata") {
      let entered, release;
      const seen = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      pendingRelease = release;
      const disk = new Proxy(raw, {
        get(object, method) {
          if (method === "checkpoint")
            return async () => {
              entered();
              if (schedule === "stall") await gate;
              throw Error("synthetic checkpoint failure");
            };
          const member = object[method];
          return typeof member === "function" ? member.bind(object) : member;
        },
      });
      let now = 1000;
      const controller = new RecoveryController({
        disk,
        payload,
        clock: { read: () => ({ bootId: "synthetic", elapsedMs: now }) },
        productionEnabled: true,
        operationTimeoutMs: 1000,
      });
      await controller.initialize();
      assert.equal(controller.status().code, "ready");
      phase = "record";
      for (let event = 0; event < 8192; event++) {
        now++;
        assert.equal(controller.record("run", "run_failed"), true);
        if (event % 128 === 0) await turn();
      }
      phase = "checkpoint";
      const work = controller.checkpoint();
      await seen;
      if (schedule === "stall") {
        const allocations = payload.stats().allocations;
        const pressure = await Promise.all(Array.from({ length: 128 }, () => controller.prepareExport("current")));
        assert.ok(pressure.every((result) => !result.ok));
        assert.equal(payload.stats().allocations, allocations);
        pressureRefusals += pressure.length;
      }
      await work;
      const off = controller.setEnabled(false, 1);
      await off;
      if (schedule === "stall") assert.ok(payload.stats().allocatedBytes > 0);
      phase = "settlement";
      release();
      await raw.waitForSettlement();
      for (let turnCount = 0; controller.busy && turnCount < 100; turnCount++) await delay(1);
      assert.equal(controller.busy, false);
      await controller.setEnabled(false, 1);
      await controller.retryCleanup();
      await controller.cleanExit();
      assert.equal(controller.status().payloadReservedBytes, 0);
      pendingRelease = undefined;
    } else await raw.cleanExit();
    sample();
    zeroAfterEveryCell &&= payload.stats().allocatedBytes === 0;
    assert.equal(zeroAfterEveryCell, true);
    cells++;
  }
  phase = "finalizer";
  sample();
} finally {
  pendingRelease?.();
  clearInterval(timer);
  clearTimeout(deadline);
  await rm(parent, { recursive: true, force: true });
}
const managedIncrementBytes = peak - baseline.heapUsed - baseline.external;
const managedPass = managedIncrementBytes <= 33_554_432;
process.stdout.write(
  JSON.stringify({
    schema: 1,
    schedule,
    cells,
    pressureRefusals,
    zeroAfterEveryCell,
    productionEnabled: false,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    method:
      "Single Node process, 2ms samples plus allocator/operation boundaries; heapUsed+external; no double-counted arrayBuffers, forced GC, renderer, CLI pair or native acceptance",
    managedIncrementBytes,
    managedLimitBytes: 33_554_432,
    managedPass,
    heapIncrementBytes: heapPeak - baseline.heapUsed,
    externalIncrementBytes: externalPeak - baseline.external,
    rssIncrementBytes: rssPeak - baseline.rss,
    backingAllocated,
    largestBacking,
    controlledPeak,
    controlledLimitBytes: 8_388_608,
    phases,
  }) + "\n",
);
if (!managedPass || controlledPeak > 8_388_608) process.exitCode = 1;
