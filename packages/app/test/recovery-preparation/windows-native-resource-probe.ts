import { previewText } from "./preview-text.js";
/** Real Windows native I/O + controller. Single-process observation, not combined Electron acceptance. */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { createHandleRelativeStorage, type NativeStorageBackend } from "../../src/main/diagnostics/native-storage.js";
import { createNativeDiagnosticsClock } from "../../src/main/diagnostics/native-clock.js";
import { NodeRecoveryDisk } from "../../src/main/diagnostics/recovery-disk.js";
import { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import { RECOVERY_LIMITS } from "../../src/main/diagnostics/recovery-contract.js";
import { SyntheticKeys, value } from "./implementation-fixture.js";

assert.equal(process.platform, "win32");
const parent = resolve(process.argv[2]!);
const base = await mkdtemp(join(parent, "orca-win-task12-"));
assert.equal(dirname(base), parent);
const root = join(base, "private");
const child = fork(fileURLToPath(new URL("./windows-native-probe.ts", import.meta.url)), ["child-checkpoint", root], {
  execArgv: ["--import", "tsx"],
  stdio: ["ignore", "ignore", "ignore", "ipc"],
  windowsHide: true,
});
const childTimeout = globalThis.setTimeout(() => child.kill(), 15_000);
await Promise.race([
  once(child, "message"),
  once(child, "exit").then(() => {
    throw new Error("checkpoint-child-unavailable");
  }),
]);
clearTimeout(childTimeout);
const childExit = once(child, "exit");
child.kill();
await childExit;
const require = createRequire(import.meta.url);
const backend = require("../../native/diagnostics/build/Release/diagnostics_storage.node") as NativeStorageBackend;
const clock = createNativeDiagnosticsClock(
  require("../../native/diagnostics/build/Release/diagnostics_clock.node") as unknown,
);
const storage = createHandleRelativeStorage(root, backend);
const disk = new NodeRecoveryDisk({ root, native: storage.native, files: storage.files, keys: new SyntheticKeys() });
const destination = join(base, "report.json");
const controller = new RecoveryController({
  disk,
  clock,
  productionEnabled: true,
  chooseDestination: async () => destination,
});
await controller.initialize();
assert.equal(controller.status().previous, true);
globalThis.gc?.();
const baseline = process.memoryUsage();
let managedPeak = baseline.heapUsed + baseline.external,
  rssPeak = baseline.rss,
  payloadPeak = 0;
let phase = "idle",
  phaseGeneration = 0,
  lastBeat = performance.now();
const callbacks: Record<string, number> = {},
  delays: Record<string, number> = {};
const active = new Map<number, { start: number; phase: string; generation: number }>();
const sample = () => {
  const memory = process.memoryUsage();
  managedPeak = Math.max(managedPeak, memory.heapUsed + memory.external);
  rssPeak = Math.max(rssPeak, memory.rss);
  payloadPeak = Math.max(payloadPeak, controller.status().payloadReservedBytes);
};
const hook = createHook({
  before(id) {
    active.set(id, { start: performance.now(), phase, generation: phaseGeneration });
  },
  after(id) {
    const previous = active.get(id);
    if (!previous) return;
    active.delete(id);
    const label = previous.generation === phaseGeneration ? previous.phase : `${previous.phase}->${phase}`;
    callbacks[label] = Math.max(callbacks[label] ?? 0, performance.now() - previous.start);
    sample();
  },
  destroy(id) {
    active.delete(id);
  },
}).enable();
const timer = setInterval(() => {
  const now = performance.now();
  delays[phase] = Math.max(delays[phase] ?? 0, Math.max(0, now - lastBeat - 1));
  lastBeat = now;
  sample();
}, 1);
const setPhase = (next: string) => {
  phase = next;
  phaseGeneration++;
};
let recordMaxMs = 0;
try {
  await setTimeout(100);
  setPhase("capture");
  for (let index = 0; index < 8192; index++) {
    const started = performance.now();
    assert.equal(controller.record("run", "run_failed"), true);
    recordMaxMs = Math.max(recordMaxMs, performance.now() - started);
    if (index % 128 === 0) await setImmediate();
  }
  setPhase("checkpoint");
  await controller.checkpoint();
  await setTimeout(20);
  setPhase("preview-previous");
  const previous = await previewText(controller, value(await controller.preparePreview("previous")));
  await setTimeout(20);
  setPhase("oracle");
  assert.equal((JSON.parse(previous.text) as { events: unknown[] }).events.length, 8192);
  value(await controller.closePreview(previous.handle));
  setPhase("preview-current");
  const preview = await previewText(controller, value(await controller.preparePreview("current")));
  await setTimeout(20);
  setPhase("picker");
  const selected = value(await controller.chooseDestination(preview.handle));
  setPhase("save");
  assert.equal(value(await controller.save(preview.handle, selected.token)).lastSaveOutcome, "saved");
  await setTimeout(20);
  setPhase("opt-out");
  value(await controller.setEnabled(false, 1));
  await setTimeout(20);
  setPhase("oracle");
  assert.equal(await readFile(destination, "utf8"), preview.text);
  const report = JSON.parse(preview.text) as {
    events: unknown[];
    omissions: { budget: number; expired: number; invalid: number };
  };
  assert.equal(report.events.length, 8192);
  assert.equal(report.omissions.budget + report.omissions.expired + report.omissions.invalid, 0);
  assert.ok(payloadPeak <= RECOVERY_LIMITS.payloadBytes);
  hook.disable();
  clearInterval(timer);
  process.stdout.write(
    JSON.stringify({
      schema: 1,
      platform: "win32",
      arch: process.arch,
      node: process.versions.node,
      offeredEvents: 8192,
      retainedEvents: report.events.length,
      previousRetainedEvents: 8192,
      serializedBytes: preview.byteLength,
      omissions: report.omissions,
      exactSaveAndExportSurvivesOptOut: true,
      recordMaxMs,
      callbackMaxMsByPhase: callbacks,
      timerDelayMaxMsByPhase: delays,
      managedIncrementBytes: Math.max(0, managedPeak - baseline.heapUsed - baseline.external),
      rssIncrementBytes: Math.max(0, rssPeak - baseline.rss),
      payloadPeak,
      method:
        "Real Windows native clock/storage and actual controller; synthetic key adapter; full current+previous; async_hooks callback elapsed duration and 1ms timers. Oracle and phase-transition callbacks separate, retained. Memory sampled heap+external and RSS increment in one Node process; baseline after initialization/promotion, includes allocated ring. No renderer/paired runtime or native allocation high-water. Combined 32MiB and full 4ms Windows acceptance unproven.",
    }) + "\n",
  );
} finally {
  hook.disable();
  clearInterval(timer);
  await controller.cleanExit().catch(() => undefined);
  await disk.waitForSettlement();
  await storage.close();
  assert.equal(dirname(base), parent);
  await rm(base, { recursive: true, force: true });
}
