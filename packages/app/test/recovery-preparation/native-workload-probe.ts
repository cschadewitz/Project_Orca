/** Bounded native-port workload. Linux uses synthetic keys/clock and is never Mac acceptance. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { createHandleRelativeStorage, type NativeStorageBackend } from "../../src/main/diagnostics/native-storage.js";
import { NodeRecoveryDisk } from "../../src/main/diagnostics/recovery-disk.js";
import { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import { RECOVERY_LIMITS } from "../../src/main/diagnostics/recovery-contract.js";
import { SyntheticKeys, value } from "./implementation-fixture.js";

assert.ok(process.platform === "linux" || process.platform === "darwin");
const backend = createRequire(import.meta.url)(
  "../../native/diagnostics/build/Release/diagnostics_storage.node",
) as NativeStorageBackend;
assert.equal(backend.abi, 1);
assert.equal(backend.platform, process.platform === "darwin" ? "darwin" : "posix-fixture");
const directory = await mkdtemp(join(process.argv[2] ?? tmpdir(), "orca-native-workload-"));
const root = join(directory, "private");
const storage = createHandleRelativeStorage(root, backend);
const disk = new NodeRecoveryDisk({ root, native: storage.native, files: storage.files, keys: new SyntheticKeys() });
const reading = { bootId: "synthetic-workload-clock", elapsedMs: 1000 };
const destination = join(directory, "report.json");
const controller = new RecoveryController({
  disk,
  clock: { read: () => ({ ...reading }) },
  productionEnabled: true,
  chooseDestination: async () => destination,
});
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;
try {
  await controller.initialize();
  value(await controller.setEnabled(true, 1));
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  const cpu = process.cpuUsage();
  let managedPeak = baseline.heapUsed + baseline.external;
  let rssPeak = baseline.rss;
  let payloadPeak = 0;
  let eventLoopDelayMaxMs = 0;
  let idleDelayMaxMs = 0;
  let phase = "idle";
  const delayByPhase: Record<string, number> = {};
  let recordMaxMs = 0;
  let dispatchMaxMs = 0;
  let diskBytesObservedPeak = 0;
  let lastBeat = performance.now();
  const sample = () => {
    const memory = process.memoryUsage();
    managedPeak = Math.max(managedPeak, memory.heapUsed + memory.external);
    rssPeak = Math.max(rssPeak, memory.rss);
    payloadPeak = Math.max(payloadPeak, controller.status().payloadReservedBytes);
  };
  timer = setInterval(() => {
    const now = performance.now();
    const delay = Math.max(0, now - lastBeat - 1);
    if (phase === "idle") idleDelayMaxMs = Math.max(idleDelayMaxMs, delay);
    else {
      eventLoopDelayMaxMs = Math.max(eventLoopDelayMaxMs, delay);
      delayByPhase[phase] = Math.max(delayByPhase[phase] ?? 0, delay);
    }
    lastBeat = now;
    sample();
  }, 1);
  unsubscribe = controller.subscribe(sample);
  await setTimeout(50);
  phase = "capture";
  const observeDisk = async () => {
    const entries = await readdir(root);
    assert.ok(entries.length <= RECOVERY_LIMITS.entries);
    let bytes = 0;
    for (const name of entries) bytes += (await stat(join(root, name))).size;
    diskBytesObservedPeak = Math.max(diskBytesObservedPeak, bytes);
  };
  const operation = async <T>(run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const pending = run();
    dispatchMaxMs = Math.max(dispatchMaxMs, performance.now() - start);
    sample();
    const result = await pending;
    sample();
    await observeDisk();
    return result;
  };
  for (let index = 0; index < 8192; index++) {
    reading.elapsedMs++;
    const start = performance.now();
    assert.equal(controller.record("unknown", "unknown"), true);
    recordMaxMs = Math.max(recordMaxMs, performance.now() - start);
    if (index % 256 === 0) {
      sample();
      await setImmediate();
    }
  }
  const checkpointStart = performance.now();
  phase = "checkpoint";
  await operation(() => controller.checkpoint());
  await setTimeout(2);
  const checkpointMs = performance.now() - checkpointStart;
  const previewStart = performance.now();
  phase = "preview";
  const preview = value(await operation(() => controller.preparePreview("current")));
  await setTimeout(2);
  const previewMs = performance.now() - previewStart;
  const selected = value(await operation(() => controller.chooseDestination(preview.handle)));
  phase = "save";
  const saved = value(await operation(() => controller.save(preview.handle, selected.token)));
  assert.equal(saved.lastSaveOutcome, "saved");
  assert.deepEqual(await readFile(destination), Buffer.from(preview.text));
  value(await operation(() => controller.setEnabled(false, 1)));
  assert.deepEqual(await readFile(destination), Buffer.from(preview.text));
  await setImmediate();
  sample();
  const report = JSON.parse(preview.text) as { events: unknown[]; omissions: { budget: number } };
  assert.ok(preview.byteLength <= RECOVERY_LIMITS.exportBytes);
  assert.ok(report.events.length <= 8192);
  assert.ok(payloadPeak <= RECOVERY_LIMITS.payloadBytes);
  process.stdout.write(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      offeredEvents: 8192,
      retainedEvents: report.events.length,
      omissions: report.omissions.budget,
      serializedBytes: preview.byteLength,
      exactSaveAndExportSurvivesOptOut: true,
      recordMaxMs,
      dispatchMaxMs,
      checkpointMs,
      previewMs,
      eventLoopDelayMaxMs,
      idleDelayMaxMs,
      delayByPhase,
      managedIncrementBytes: managedPeak - baseline.heapUsed - baseline.external,
      rssIncrementBytes: rssPeak - baseline.rss,
      payloadPeak,
      diskBytesObservedPeak,
      cpuMicros: process.cpuUsage(cpu),
      callbackTargetMs: 4,
      recordAndInitialDispatchWithin4ms: recordMaxMs < 4 && dispatchMaxMs < 4,
      observedResponsivenessWithin4ms: recordMaxMs < 4 && dispatchMaxMs < 4 && eventLoopDelayMaxMs < 4,
      method:
        "One disposable Node process; native POSIX port; synthetic keys/clock; 1 ms and operation/batch samples. Disk observed after operations, not transient high-water. No paired runtime, Electron/renderer, secure-storage, Mac clock/ACL or whole-process memory proof.",
    }) + "\n",
  );
} finally {
  if (timer) clearInterval(timer);
  unsubscribe?.();
  await controller.cleanExit().catch(() => undefined);
  await disk.waitForSettlement();
  await storage.close();
  await rm(directory, { recursive: true, force: true });
}
