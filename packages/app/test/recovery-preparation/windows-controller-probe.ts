import { frozenReportText } from "./frozen-report-text.js";
/** Windows Node observation with a memory-only disk/clock; never native or Electron acceptance. */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { RecoveryController } from "../../src/main/diagnostics/recovery-controller.js";
import {
  RECOVERY_LIMITS,
  type RecoveryDisk,
  type StoredCheckpoint,
  type ExportState,
} from "../../src/main/diagnostics/recovery-contract.js";
import type { DiagnosticsResult } from "../../src/diagnostics-contract.js";

assert.equal(process.platform, "win32");
const value = <T>(result: DiagnosticsResult<T>): T => {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("synthetic action refused");
  return result.value;
};
const reading = { bootId: "synthetic-windows-probe", elapsedMs: 1000 };
let stored: StoredCheckpoint | undefined;
let previous: StoredCheckpoint | undefined;
let stage: Buffer | undefined;
let exported: Buffer | undefined;
let state: ExportState = {};
const disk: RecoveryDisk = {
  revoke() {},
  readSetting: async () => ({ enabled: false, scopeVersion: 1, minutes: 5 }),
  writeSetting: async () => undefined,
  open: async () => previous !== undefined,
  maintain: async () => previous !== undefined,
  checkpoint: async (bytes, anchor, admit) => {
    if (admit()) stored = { bytes: Buffer.from(bytes), anchor: { ...anchor } };
  },
  previous: async () => previous,
  discardPrevious: async () => {
    previous = undefined;
  },
  cleanExit: async () => {
    stored = undefined;
  },
  cleanup: async () => {
    stored = previous = undefined;
  },
  readExportState: async () => state,
  writeExportState: async (next) => {
    state = next;
  },
  stageExport: async (_id, bytes) => {
    stage = Buffer.from(bytes);
    return { device: "synthetic", inode: "synthetic" };
  },
  clearStage: async () => {
    stage = undefined;
  },
  validateDestination: async () => true,
  publishStage: async (_identity, _destination, admit) => {
    if (!admit() || exported || !stage) return "refused";
    exported = stage;
    stage = undefined;
    return "saved";
  },
  writersStopped: async () => true,
};
const controller = new RecoveryController({
  disk,
  clock: { read: () => ({ ...reading }) },
  productionEnabled: true,
  chooseDestination: async () => "synthetic-destination",
});
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;
let hook: ReturnType<typeof createHook> | undefined;
try {
  await controller.initialize();
  value(await controller.setEnabled(true, 1));
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  let managedPeak = baseline.heapUsed + baseline.external;
  let rssPeak = baseline.rss;
  let payloadPeak = 0;
  let callbackMaxMs = 0;
  let phase = "idle";
  let beat = performance.now();
  const delays: Record<string, number> = {};
  const callbackDurations: Record<string, number> = {};
  let callbackStart = 0;
  let callbackPhase = "idle";
  hook = createHook({
    before() {
      callbackStart = performance.now();
      callbackPhase = phase;
    },
    after() {
      const label = callbackPhase === phase ? phase : `${callbackPhase}->${phase}`;
      callbackDurations[label] = Math.max(callbackDurations[label] ?? 0, performance.now() - callbackStart);
    },
  });
  hook.enable();
  const sample = () => {
    const memory = process.memoryUsage();
    managedPeak = Math.max(managedPeak, memory.heapUsed + memory.external);
    rssPeak = Math.max(rssPeak, memory.rss);
    payloadPeak = Math.max(payloadPeak, controller.status().payloadReservedBytes);
  };
  timer = setInterval(() => {
    const now = performance.now();
    delays[phase] = Math.max(delays[phase] ?? 0, Math.max(0, now - beat - 1));
    beat = now;
    sample();
  }, 1);
  unsubscribe = controller.subscribe(sample);
  await setTimeout(50);
  phase = "capture";
  for (let index = 0; index < 8192; index++) {
    reading.elapsedMs++;
    const started = performance.now();
    assert.equal(controller.record("unknown", "unknown"), true);
    callbackMaxMs = Math.max(callbackMaxMs, performance.now() - started);
    if (index % 128 === 0) await setImmediate();
  }
  phase = "checkpoint";
  await controller.checkpoint();
  assert.ok(stored);
  previous = { bytes: Buffer.from(stored.bytes), anchor: { ...stored.anchor } };
  await setTimeout(2);
  phase = "preview";
  const preview = await frozenReportText(controller, value(await controller.prepareExport("current")));
  await setTimeout(2);
  phase = "oracle";
  await setImmediate();
  const report = JSON.parse(preview.text) as {
    events: unknown[];
    omissions: { budget: number; expired: number; invalid: number; unavailable: string };
  };
  assert.equal(report.events.length, 8192);
  assert.deepEqual(report.omissions, { budget: 0, expired: 0, invalid: 0, unavailable: "unknown" });
  assert.equal(preview.byteLength, Buffer.byteLength(preview.text));
  phase = "save";
  const destination = value(await controller.chooseDestination(preview.handle));
  assert.equal(value(await controller.save(preview.handle, destination.token)).lastSaveOutcome, "saved");
  assert.deepEqual(exported, Buffer.from(preview.text));
  phase = "optOut";
  value(await controller.setEnabled(false, 1));
  assert.deepEqual(exported, Buffer.from(preview.text));
  assert.equal(stored, undefined);
  assert.equal(previous, undefined);
  assert.equal(stage, undefined);
  await setTimeout(2);
  assert.ok(payloadPeak <= RECOVERY_LIMITS.payloadBytes);
  process.stdout.write(
    JSON.stringify({
      source: "a991fbfea9da6d39dea2f0c513cc5a000d993c14",
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      offeredEvents: 8192,
      retainedEvents: report.events.length,
      omissions: report.omissions,
      serializedBytes: preview.byteLength,
      exactMemoryPortSaveAndExportSurvivesOptOut: true,
      simultaneousFullMemoryPortGenerations: true,
      recordCallbackMaxMs: callbackMaxMs,
      asyncCallbackMaxByPhaseMs: callbackDurations,
      delayByPhaseMs: delays,
      payloadPeak,
      managedIncrementBytes: managedPeak - baseline.heapUsed - baseline.external,
      rssIncrementBytes: rssPeak - baseline.rss,
      observedTimerSchedulingWithin4ms:
        callbackMaxMs < 4 &&
        Object.entries(delays)
          .filter(([key]) => key !== "idle")
          .every(([, delay]) => delay < 4),
      combined32MiBGate: "not measured",
      actualWindows4msAcceptance:
        "not established: timer scheduling exceeds 4ms; instrumented callbacks are bounded observations only",
      nativeStorageClockCrypto: "not exercised",
      method:
        "One Windows Node process; synthetic clock, memory-only disk/publication; shipping flag unchanged. 1 ms timer plus controller emissions; async_hooks callback duration (instrumentation overhead; microtasks and phase transitions measured separately; full-report harness oracle has its own phase); heapUsed+external, arrayBuffers not double-counted. Idle scheduling retained. No renderer, worker, actual execution, filesystem, DPAPI, hard allocation or native high-water proof.",
    }) + "\n",
  );
} finally {
  if (timer) clearInterval(timer);
  hook?.disable();
  unsubscribe?.();
  await controller.cleanExit();
}
