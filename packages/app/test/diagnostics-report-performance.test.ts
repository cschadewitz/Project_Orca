import { previewText } from "./recovery-preparation/preview-text.js";
/** Canonical compatibility and authority at cooperative report turns; no device acceptance. */
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { PretriggerBuffer } from "../src/main/diagnostics/pretrigger-buffer.js";
import { DIAGNOSTIC_CODES, type DiagnosticPhase } from "../src/main/diagnostics/profile.js";
import { RecoveryController } from "../src/main/diagnostics/recovery-controller.js";
import { ControlledPayloadMemory } from "../src/main/diagnostics/payload-memory.js";
import { RECOVERY_LIMITS, type RecoveryDisk } from "../src/main/diagnostics/recovery-contract.js";
import { DIAGNOSTIC_PREVIEW_BLOCK_BYTES } from "../src/diagnostics-contract.js";
import {
  validateDiagnosticReportAsync,
  validateOwnedDiagnosticText,
} from "../src/main/diagnostics/report-validation.js";
import { scheduleReportWork } from "../src/main/diagnostics/report-work.js";
import {
  canonicalJson,
  canonicalDiagnosticReportAsync,
  diagnosticReport,
  type DiagnosticReport,
} from "../src/main/diagnostics/snapshot.js";
import { value } from "./recovery-preparation/implementation-fixture.js";

afterEach(() => vi.restoreAllMocks());

function fullReport(): DiagnosticReport {
  const pairs = (Object.keys(DIAGNOSTIC_CODES) as DiagnosticPhase[]).flatMap((phase) =>
    DIAGNOSTIC_CODES[phase].map((code) => ({ phase, code })),
  );
  return diagnosticReport(
    "00000000-0000-4000-8000-000000000000",
    "00000000-0000-4000-8000-000000000001",
    { requestedWindowMs: 900_000, observedWindowMs: 900_000, retainedWindowMs: 900_000, capacityLimited: true },
    { budget: "at_least_65535", expired: 3, invalid: 2 },
    Array.from({ length: 8192 }, (_, index) => ({
      ...(pairs[index] ?? { phase: "unknown", code: "unknown" }),
      offsetMs: index === 8191 ? 900_000 : index,
      entityAlias: "unknown" as const,
    })),
  );
}

it("preserves the generic canonical oracle for every enum, maximum offsets/count and empty reports", async () => {
  const report = fullReport();
  for (const sample of [report, { ...report, events: [], coverage: { ...report.coverage, retainedWindowMs: 0 } }]) {
    const json = await canonicalDiagnosticReportAsync(sample);
    expect(json).toBe(canonicalJson(sample));
    expect(json.endsWith("\n")).toBe(true);
    const refreshed = await validateDiagnosticReportAsync(Buffer.from(json), true);
    const parsed = JSON.parse(refreshed.toString()) as DiagnosticReport;
    expect(parsed.reportId).not.toBe(sample.reportId);
    expect(parsed.sessionId).not.toBe(sample.sessionId);
    expect({ ...parsed, reportId: sample.reportId, sessionId: sample.sessionId }).toEqual(sample);
  }
});

it("freezes all 8192 events before yielding and remains immutable across collection/stop", async () => {
  let now = 1000;
  const ring = new PretriggerBuffer({ now: () => now });
  ring.start();
  for (let index = 0; index < 8192; index++) {
    now++;
    ring.record("unknown", "unknown");
  }
  let settled = false;
  const pending = ring.snapshotAsync().then((snapshot) => {
    settled = true;
    return snapshot!;
  });
  await setImmediate();
  expect(settled).toBe(false);
  now++;
  ring.record("run", "run_failed");
  ring.stop();
  const snapshot = await pending;
  const report = JSON.parse(snapshot.json) as DiagnosticReport;
  expect(report.events).toHaveLength(8192);
  expect(report.events[0]?.offsetMs).toBe(1);
  expect(report.events.at(-1)?.offsetMs).toBe(8192);
  expect(report.omissions.budget).toBe(0);
  expect(snapshot.json).toBe(canonicalJson(report));
  expect(snapshot.byteLength).toBe(Buffer.byteLength(snapshot.json));
});

it("keeps a full-count checkpoint immutable and owned after the live ring stops", async () => {
  const payload = new ControlledPayloadMemory();
  let now = 1000;
  const ring = new PretriggerBuffer({ payload, now: () => now });
  ring.start();
  for (let index = 0; index < 8192; index++) {
    now++;
    ring.record("run", "run_failed");
  }
  const pending = ring.snapshotOwnedAsync();
  await setImmediate();
  ring.stop();
  const owned = (await pending)!;
  const report = JSON.parse(owned.bytes.toString()) as DiagnosticReport;
  expect(report.events).toHaveLength(8192);
  expect(report.events[0]?.offsetMs).toBe(1);
  expect(report.events.at(-1)?.offsetMs).toBe(8192);
  expect(owned.bytes.toString()).toBe(canonicalJson(report));
  expect(payload.stats().leases).toBe(1);
  owned.release();
  expect(owned.bytes.every((byte) => byte === 0)).toBe(true);
  expect(payload.stats().allocatedBytes).toBe(0);
});

it("validates immutable decoded bytes even if the source Buffer changes during a yielded turn", async () => {
  const json = canonicalJson(fullReport());
  const input = Buffer.from(json);
  const pending = validateDiagnosticReportAsync(input);
  await setImmediate();
  input.fill(0);
  expect(await pending).toEqual(Buffer.from(json));
});

it("retains exact rejection of extra/duplicate fields, framing, invalid UTF-8 and event semantics", async () => {
  const report = fullReport();
  const json = canonicalJson(report);
  const corruptions = [
    Buffer.from(json.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')),
    Buffer.from(json.replace('"entityAlias": "unknown"', '"entityAlias": "unknown", "prompt": "CANARY"')),
    Buffer.from(json.replace('"app": "unknown"', '"app": "CANARY"')),
    Buffer.from(json.trimEnd()),
    Buffer.from(json.replace('"offsetMs": 0', '"offsetMs": -1')),
    Buffer.from(json.replace('"phase": "startup"', '"phase": "run"')),
    Buffer.from(json.replace('"events": [', '"events": [[], ')),
    Buffer.from(json.replace('"expired": 3', '"expired": 65535')),
    Buffer.from(canonicalJson({ ...report, events: [...report.events, report.events.at(-1)] })),
    Buffer.concat([Buffer.from([0xff]), Buffer.from(json)]),
    Buffer.alloc(1_048_577),
  ];
  for (const bytes of corruptions) await expect(validateDiagnosticReportAsync(bytes)).rejects.toThrow();
});

it("accepts every closed pair at decimal boundaries and rejects noncanonical event spellings", async () => {
  const pairs = (Object.keys(DIAGNOSTIC_CODES) as DiagnosticPhase[]).flatMap((phase) =>
    DIAGNOSTIC_CODES[phase].map((code) => ({ phase, code })),
  );
  const events = [0, 1, 9, 10, 99, 100, 899_999, 900_000].flatMap((offsetMs) =>
    pairs.map((pair) => ({ ...pair, offsetMs, entityAlias: "unknown" as const })),
  );
  const json = canonicalJson({ ...fullReport(), events });
  expect((await validateDiagnosticReportAsync(Buffer.from(json))).toString()).toBe(json);
  for (const offset of [
    "-0",
    "00",
    "01",
    "+0",
    "0.0",
    "0e0",
    "null",
    "false",
    "900001",
    "99999999999999999999",
    '"0"',
    "\u0660",
  ]) {
    const corrupted = json.replace('"offsetMs": 0', `"offsetMs": ${offset}`);
    await expect(validateDiagnosticReportAsync(Buffer.from(corrupted))).rejects.toThrow();
  }
  for (const corrupted of [
    json.replace('"entityAlias": "unknown"', '"entityAlias": "other"'),
    json.replace('"code": "startup_spawn_failed"', '"code": "startup_spawn_failed", "code": "startup_spawn_failed"'),
    json.replace('"phase": "startup"', '"phase": "run"'),
    json.replace('"offsetMs": 0,', '"offsetMs": 0 ,'),
    json.replace('"offsetMs": 0', '"offsetMs":  0'),
    json.replace('"phase": "startup"', '"phase": "startup", "path": "CANARY"'),
  ])
    await expect(validateDiagnosticReportAsync(Buffer.from(corrupted))).rejects.toThrow();
});

it("keeps validated immutable text and independently owned exact bytes through disposal", async () => {
  const json = canonicalJson(fullReport());
  const payload = new ControlledPayloadMemory();
  const validated = await validateOwnedDiagnosticText(json, payload);
  expect(validated.text).toBe(json);
  expect(validated.payload.bytes.toString()).toBe(json);
  validated.payload.release();
  expect(validated.payload.bytes.every((byte) => byte === 0)).toBe(true);
  expect(payload.stats().allocatedBytes).toBe(0);
  expect(validated.text).toBe(json);
});

it("yields each batch with one completion promise and rejects scheduled generator failures", async () => {
  const turns: string[] = [];
  function* work() {
    turns.push("first");
    yield;
    turns.push("second");
    throw new Error("bounded-failure");
  }
  const pending = scheduleReportWork(work());
  const rejected = expect(pending).rejects.toThrow("bounded-failure");
  expect(turns).toEqual([]);
  await setImmediate();
  expect(turns).toEqual(["first"]);
  await rejected;
  expect(turns).toEqual(["first", "second"]);
});

// No filesystem or native authority in these controller schedule regressions.
function fixture() {
  const reading = { bootId: "synthetic-report-turns", elapsedMs: 1000 };
  const disk: RecoveryDisk = {
    revoke: vi.fn(),
    readSetting: async () => ({ enabled: false, scopeVersion: 1, minutes: 5 }),
    writeSetting: vi.fn(async () => undefined),
    open: async () => false,
    maintain: async () => false,
    checkpoint: vi.fn(async () => undefined),
    previous: async () => undefined,
    discardPrevious: async () => undefined,
    cleanExit: async () => undefined,
    cleanup: async () => undefined,
    readExportState: async () => ({}),
    writeExportState: async () => undefined,
    stageExport: async () => ({ device: "1", inode: "2" }),
    clearStage: async () => undefined,
    validateDestination: async () => true,
    publishStage: async () => "refused",
    writersStopped: async () => true,
  };
  const payload = new ControlledPayloadMemory();
  const controller = new RecoveryController({
    disk,
    payload,
    clock: { read: () => reading },
    productionEnabled: true,
    chooseDestination: async () => "/synthetic-report.json",
  });
  return { controller, disk, reading, payload };
}

it("admits exact byte ownership, one ordered transport block and a complete-read picker fence", async () => {
  const { controller, payload } = fixture();
  await controller.initialize();
  value(await controller.setEnabled(true, 1));
  for (let i = 0; i < 8192; i++) controller.record("run", "run_failed");
  const preview = value(await controller.preparePreview("current"));
  expect(preview).not.toHaveProperty("text");
  expect(payload.stats().externalAllowanceBytes).toBe(RECOVERY_LIMITS.exportBytes + 3 * DIAGNOSTIC_PREVIEW_BLOCK_BYTES);
  expect((await controller.chooseDestination(preview.handle)).ok).toBe(false);
  expect((await controller.readPreviewBlock(preview.handle, 1)).ok).toBe(false);
  const first = value(await controller.readPreviewBlock(preview.handle, 0));
  expect(first.bytes.buffer.byteLength).toBe(DIAGNOSTIC_PREVIEW_BLOCK_BYTES);
  expect(first.bytes.length).toBeLessThanOrEqual(DIAGNOSTIC_PREVIEW_BLOCK_BYTES);
  expect(first.bytes.at(-1)).toBe(10);
  expect((await controller.readPreviewBlock(preview.handle, 0)).ok).toBe(false);
  expect((await controller.releasePreviewBlock("stale", 0)).ok).toBe(false);
  value(await controller.releasePreviewBlock(preview.handle, 0));
  expect(first.bytes.every((byte) => byte === 0)).toBe(true);
  let offset = first.bytes.length;
  while (offset < preview.byteLength) {
    const block = value(await controller.readPreviewBlock(preview.handle, offset));
    expect(block.bytes.buffer).toBe(first.bytes.buffer);
    offset += block.bytes.length;
    value(await controller.releasePreviewBlock(preview.handle, block.offset));
  }
  expect((await controller.chooseDestination(preview.handle)).ok).toBe(true);
  value(await controller.closePreview(preview.handle));
  expect((await controller.readPreviewBlock(preview.handle, 0)).ok).toBe(false);
  value(await controller.setEnabled(false, 1));
  expect(payload.stats().allocatedBytes).toBe(0);
  await controller.cleanExit();
});

it.each(["off", "expiry", "document"])(
  "erases a transported block on %s and charges retirement until disposal",
  async (reason) => {
    const { controller, payload, reading } = fixture();
    await controller.initialize();
    value(await controller.setEnabled(true, 1));
    const preview = value(await controller.preparePreview("current"));
    const block = value(await controller.readPreviewBlock(preview.handle, 0));
    if (reason === "off") value(await controller.setEnabled(false, 1));
    else if (reason === "expiry") {
      reading.elapsedMs += RECOVERY_LIMITS.previewMs;
      controller.status();
    } else controller.revokePreviewAuthority();
    expect(block.bytes.every((byte) => byte === 0)).toBe(true);
    expect((await controller.readPreviewBlock(preview.handle, 0)).ok).toBe(false);
    expect(payload.stats().externalAllowanceBytes).toBeGreaterThan(0);
    value(await controller.closePreview("stale"));
    expect(payload.stats().externalAllowanceBytes).toBeGreaterThan(0);
    value(await controller.closePreview(preview.handle));
    expect(payload.stats().externalAllowanceBytes).toBe(0);
    value(await controller.setEnabled(false, 1));
    expect(payload.stats().allocatedBytes).toBe(0);
    await controller.cleanExit();
  },
);

it.each(["off", "document", "clock"])(
  "revokes %s during report preparation without returning plaintext or early reservation release",
  async (revocation) => {
    const { controller, reading } = fixture();
    await controller.initialize();
    value(await controller.setEnabled(true, 1));
    for (let index = 0; index < 8192; index++) {
      reading.elapsedMs++;
      controller.record("unknown", "unknown");
    }
    try {
      const pending = controller.preparePreview("current");
      await setImmediate();
      let off: Promise<unknown> | undefined;
      if (revocation === "off") off = controller.setEnabled(false, 1);
      else if (revocation === "document") controller.rendererDisposed();
      else {
        reading.elapsedMs--;
        controller.status();
      }
      expect(controller.status().payloadReservedBytes).toBe(4 * RECOVERY_LIMITS.exportBytes);
      expect((await pending).ok).toBe(false);
      await off;
      expect(controller.status().activePreviewHandle).toBeUndefined();
      expect(controller.status().payloadReservedBytes).toBe(0);
    } finally {
      await controller.cleanExit();
    }
  },
);

it("rechecks authority after checkpoint serialization before any disk dispatch", async () => {
  const { controller, disk, reading } = fixture();
  const checkpoint = vi.spyOn(disk, "checkpoint");
  await controller.initialize();
  value(await controller.setEnabled(true, 1));
  for (let index = 0; index < 8192; index++) controller.record("unknown", "unknown");
  try {
    const pending = controller.checkpoint();
    await setImmediate();
    expect(controller.status().payloadReservedBytes).toBe(3 * RECOVERY_LIMITS.exportBytes);
    reading.elapsedMs--;
    controller.status();
    await pending;
    expect(checkpoint).not.toHaveBeenCalled();
    expect(controller.status().payloadReservedBytes).toBe(0);
  } finally {
    await controller.cleanExit();
  }
});

it.each(["timeout", "off"])("retains frozen binary bytes until a %s Save actually settles", async (revocation) => {
  const { controller, disk, payload } = fixture();
  let entered!: () => void, settle!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let frozen: Buffer | undefined, exact: Buffer | undefined;
  vi.spyOn(disk, "stageExport").mockImplementation(async (_id, bytes) => {
    frozen = bytes;
    exact = Buffer.from(bytes);
    entered();
    await held;
    expect(bytes).toEqual(exact);
    return { device: "1", inode: "2" };
  });
  await controller.initialize();
  value(await controller.setEnabled(true, 1));
  controller.record("run", "run_failed");
  const preview = await previewText(controller, value(await controller.preparePreview("current")));
  const destination = value(await controller.chooseDestination(preview.handle));
  if (revocation === "timeout") vi.useFakeTimers();
  const saving = controller.save(preview.handle, destination.token);
  await started;
  let off: Promise<unknown> | undefined;
  try {
    if (revocation === "timeout") {
      await vi.advanceTimersByTimeAsync(RECOVERY_LIMITS.operationMs + 1);
      expect((await saving).ok).toBe(false);
    } else off = controller.setEnabled(false, 1);
    expect(controller.status().activePreviewHandle).toBeUndefined();
    expect(payload.stats().leases).toBeGreaterThan(0);
    expect(frozen).toEqual(exact);
  } finally {
    settle();
    vi.useRealTimers();
    await saving;
    await off;
    controller.rendererDisposed();
    for (let turn = 0; turn < 10 && controller.status().payloadReservedBytes; turn++) await setImmediate();
    await controller.cleanExit();
  }
  expect(frozen?.every((byte) => byte === 0)).toBe(true);
  expect(payload.stats().allocatedBytes).toBe(0);
});
