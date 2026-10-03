import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PretriggerBuffer } from "../src/main/diagnostics/pretrigger-buffer.js";
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_LIMITS,
  type DiagnosticCode,
  type DiagnosticPhase,
} from "../src/main/diagnostics/profile.js";
import {
  DIAGNOSTIC_ENVELOPE_BYTES,
  eventReservation,
  type DiagnosticReport,
} from "../src/main/diagnostics/snapshot.js";

const buffers: PretriggerBuffer[] = [];
function buffer(options: ConstructorParameters<typeof PretriggerBuffer>[0] = {}) {
  const result = new PretriggerBuffer(options);
  buffers.push(result);
  return result;
}
function report(subject: PretriggerBuffer): DiagnosticReport {
  const snapshot = subject.snapshot()!;
  expect(snapshot.byteLength).toBe(Buffer.byteLength(snapshot.json));
  return JSON.parse(snapshot.json) as DiagnosticReport;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const subject of buffers.splice(0)) subject.stop();
  vi.useRealTimers();
});

describe("volatile diagnostic pre-trigger buffer", () => {
  it("is off by default, reads nothing while off, and restarts empty/off", () => {
    const now = vi.fn(() => 0);
    const subject = buffer({ now });
    expect(subject.enabled).toBe(false);
    expect(subject.record("run", "run_failed")).toBe(false);
    expect(subject.snapshot()).toBeUndefined();
    expect(now).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    subject.start();
    subject.record("run", "run_failed");
    subject.stop();
    expect(subject.snapshot()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    subject.start();
    expect(report(subject).events).toEqual([]);
    expect(buffer().enabled).toBe(false);
  });

  it("expires at five minutes, including without new observations", () => {
    const subject = buffer();
    subject.start();
    subject.record("lifecycle", "app_started");
    vi.advanceTimersByTime(299_999);
    expect(report(subject).events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    // Expiry's timer has already released the sole record, without a read or append.
    expect(vi.getTimerCount()).toBe(0);
    const snapshot = report(subject);
    expect(snapshot.events).toEqual([]);
    expect(snapshot.omissions.expired).toBe(1);
    expect(snapshot.coverage).toEqual({
      requestedWindowMs: 300_000,
      observedWindowMs: 300_000,
      retainedWindowMs: 0,
      capacityLimited: false,
    });
  });

  it("shortens immediately and never reconstructs history when lengthened", () => {
    let now = 0;
    const subject = buffer({ now: () => now });
    subject.start();
    subject.record("run", "run_failed");
    now = 120_000;
    subject.record("connection", "connection_lost");
    subject.setMinutes(1);
    expect(report(subject).events).toHaveLength(1);
    expect(report(subject).omissions.expired).toBe(1);
    subject.setMinutes(15);
    now = 130_000;
    expect(report(subject).coverage).toMatchObject({
      requestedWindowMs: 900_000,
      observedWindowMs: 70_000,
      retainedWindowMs: 10_000,
    });
    const idle = buffer({ now: () => now });
    idle.start();
    idle.record("run", "run_failed");
    now += 400_000;
    idle.setMinutes(15);
    expect(report(idle).events).toEqual([]);
    expect(report(idle).coverage.observedWindowMs).toBe(300_000);
  });

  it("evicts oldest at the count cap, shows loss and coverage, and wraps the ring", () => {
    let now = 0;
    const subject = buffer({ maxEvents: 3, now: () => now });
    subject.start();
    for (let index = 0; index < 10; index++) {
      now = index * 1000;
      subject.record("run", "run_failed");
    }
    const snapshot = report(subject);
    expect(snapshot.events.map((event) => event.offsetMs)).toEqual([7000, 8000, 9000]);
    expect(snapshot.omissions).toMatchObject({ budget: 7, expired: 0, invalid: 0 });
    expect(snapshot.coverage).toMatchObject({ retainedWindowMs: 2000, observedWindowMs: 9000, capacityLimited: true });
    now = 400_000;
    expect(report(subject).coverage.capacityLimited).toBe(false);
    expect(report(subject).omissions).toMatchObject({ budget: 7, expired: 3 });
  });

  it("enforces complete serialized bytes independently of count and counts unfit events", () => {
    const cost = eventReservation("startup", "startup_exited_before_handshake");
    const maxReportBytes = DIAGNOSTIC_ENVELOPE_BYTES + cost * 2;
    const subject = buffer({ maxEvents: 100, maxReportBytes });
    subject.start();
    for (let index = 0; index < 5; index++) subject.record("startup", "startup_exited_before_handshake");
    expect(report(subject).events).toHaveLength(2);
    expect(report(subject).omissions.budget).toBe(3);
    expect(subject.snapshot()!.byteLength).toBeLessThanOrEqual(maxReportBytes);
    const below = buffer({ maxReportBytes: maxReportBytes - 1 });
    below.start();
    below.record("startup", "startup_exited_before_handshake");
    below.record("startup", "startup_exited_before_handshake");
    expect(report(below).events).toHaveLength(1);
    expect(report(below).omissions.budget).toBe(1);
    const tiny = buffer({ maxReportBytes: DIAGNOSTIC_ENVELOPE_BYTES });
    tiny.start();
    expect(tiny.record("run", "run_failed")).toBe(false);
    expect(report(tiny).events).toHaveLength(0);
    expect(report(tiny).omissions.budget).toBe(1);
    expect(report(tiny).coverage.capacityLimited).toBe(true);
  });

  it("keeps a frozen complete snapshot above the old 256-event/256-KiB limits", () => {
    const subject = buffer();
    subject.start();
    for (let index = 0; index < 3000; index++) subject.record("startup", "startup_exited_before_handshake");
    const frozen = subject.snapshot()!;
    expect(frozen.byteLength).toBeGreaterThan(262_144);
    expect(frozen.byteLength).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxReportBytes);
    expect((JSON.parse(frozen.json) as DiagnosticReport).events).toHaveLength(3000);
    expect(Object.isFrozen(frozen)).toBe(true);
    const original = frozen.json;
    subject.record("run", "run_failed");
    subject.setMinutes(1);
    vi.advanceTimersByTime(60_000);
    subject.stop();
    expect(frozen.json).toBe(original);
    // This value has no save authority; the later preview owner must revoke its copies.
    expect(subject.snapshot()).toBeUndefined();
  });

  it("caps a burst at 4096 with visible saturated omissions and bounded snapshots", () => {
    const subject = buffer();
    subject.start();
    for (let index = 0; index < 70_000; index++) subject.record("run", "run_failed");
    const snapshot = report(subject);
    expect(snapshot.events).toHaveLength(4096);
    expect(snapshot.omissions.budget).toBe("at_least_65535");
    expect(subject.snapshot()!.byteLength).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.maxReportBytes);
  });

  it("does not reset an active session and refreshes exported identities for every snapshot", () => {
    let now = 0;
    const subject = buffer({ now: () => now });
    subject.start();
    subject.record("run", "run_failed");
    const first = report(subject);
    // A preparation retry with unchanged history and clock still needs fresh IDs.
    const retry = report(subject);
    expect(retry.events).toEqual(first.events);
    expect(retry.coverage).toEqual(first.coverage);
    now = 1000;
    subject.start();
    const second = report(subject);
    expect(second.events).toEqual(first.events);
    expect(second.coverage.observedWindowMs).toBe(1000);
    subject.stop();
    subject.start();
    const next = report(subject);
    const ids = [first, retry, second, next].flatMap(({ reportId, sessionId }) => [reportId, sessionId]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(next.events).toEqual([]);
    expect(next.omissions).toMatchObject({ budget: 0, expired: 0, invalid: 0 });
  });

  it.each([
    { maxEvents: 0 },
    { maxEvents: 4097 },
    { maxReportBytes: DIAGNOSTIC_ENVELOPE_BYTES - 1 },
    { maxReportBytes: 1_048_577 },
  ])("refuses unsupported resource caps %j", (options) => {
    expect(() => buffer(options)).toThrow("Invalid diagnostics limit");
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])("invalidates on uncertain clock %s", (bad) => {
    let now = 10;
    const subject = buffer({ now: () => now });
    subject.start();
    subject.record("run", "run_failed");
    now = bad;
    expect(subject.snapshot()).toBeUndefined();
    expect(subject.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed on backward/throwing clocks and ignores wall-clock jumps", () => {
    let now = 10;
    const subject = buffer({ now: () => now });
    subject.start();
    subject.record("run", "run_failed");
    now = 9;
    expect(subject.record("run", "run_failed")).toBe(false);
    const throwing = buffer({
      now: () => {
        throw new Error("private path");
      },
    });
    expect(throwing.start()).toBe(false);
    const monotonic = buffer();
    monotonic.start();
    monotonic.record("run", "run_failed");
    vi.setSystemTime(new Date("2040-01-01"));
    expect(report(monotonic).events).toHaveLength(1);
  });

  it("rejects content-bearing objects and strings without reading or coercing them", () => {
    const subject = buffer();
    subject.start();
    const read = vi.fn(() => {
      throw new Error("SYNTHETIC_CANARY");
    });
    const poisoned = new Proxy({}, { get: read, ownKeys: read, getOwnPropertyDescriptor: read });
    const sensitive = [
      poisoned,
      new Error("SYNTHETIC_CANARY"),
      { phase: "run", code: "run_failed", prompt: "SYNTHETIC_CANARY" },
      "SYNTHETIC_CANARY",
      "U1lOVEhFVElDX0NBTkFSWQ==",
      ["SYNTHETIC_", "CANARY"],
      "/home/private/source.ts",
      "C:\\private\\source.ts",
      "\\\\host\\private",
      "x".repeat(2_000_000),
    ];
    for (const value of sensitive) {
      expect(subject.record(value as DiagnosticPhase, "unknown")).toBe(false);
      expect(subject.record("run", value as DiagnosticCode)).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
    expect(subject.record("run", "app_started")).toBe(false);
    expect(subject.record("__proto__" as DiagnosticPhase, "unknown")).toBe(false);
    subject.record("run", "run_failed");
    const snapshot = report(subject);
    expect(snapshot.events).toEqual([{ phase: "run", code: "run_failed", offsetMs: 0, entityAlias: "unknown" }]);
    expect(snapshot.omissions.invalid).toBe(sensitive.length * 2 + 2);
    expect(subject.snapshot()!.json).not.toMatch(/CANARY|private|source\.ts|U1lO/);
    expect(snapshot.entities).toEqual([]);
    expect(Object.values(snapshot.versions).every((value) => value === "unknown")).toBe(true);
  });

  it.each([0, 16, 1.5, NaN, Infinity])("rejects invalid configuration %s without changing retention", (minutes) => {
    expect(() => buffer({ minutes })).toThrow("Invalid diagnostics limit");
    const subject = buffer();
    subject.start();
    expect(() => subject.setMinutes(minutes)).toThrow("Invalid diagnostics limit");
    expect(report(subject).coverage.requestedWindowMs).toBe(300_000);
  });

  it("keeps the draft schema, count/time ceilings and phase/code allowlist coordinated", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../docs/preparation/manual-diagnostics-contract/schema-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      properties: {
        windowMs: { maximum: number };
        events: {
          maxItems: number;
          items: {
            allOf: {
              if: { properties: { phase: { const: string } } };
              then: { properties: { code: { enum: string[] } } };
            }[];
          };
        };
      };
    };
    expect(schema.properties.events.maxItems).toBe(DIAGNOSTIC_LIMITS.maxEvents);
    expect(schema.properties.windowMs.maximum).toBe(DIAGNOSTIC_LIMITS.maxMinutes * 60_000);
    for (const rule of schema.properties.events.items.allOf) {
      expect(DIAGNOSTIC_CODES[rule.if.properties.phase.const as DiagnosticPhase]).toEqual(
        rule.then.properties.code.enum,
      );
    }
  });
});
