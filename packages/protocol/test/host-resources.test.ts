/** Consumer fixtures, strict measurement invariants, advisory semantics and response ordering. */
import { describe, expect, it } from "vitest";
import {
  HostResourceSnapshotSchema,
  acceptResourceSnapshot,
  hostResourceFixture,
  workstreamSummaryFixture,
  WorkstreamSummarySchema,
  resourceWarnings,
} from "../src/index.js";

describe("shared host resource contract", () => {
  it.each(["healthy", "pressure", "partial", "stale", "tmpfs"] as const)(
    "validates deterministic %s fixture",
    (kind) => {
      const fixture = hostResourceFixture(kind);
      expect(HostResourceSnapshotSchema.parse(fixture)).toEqual(fixture);
      expect(JSON.stringify(fixture).length).toBeLessThan(32_768);
      expect(hostResourceFixture(kind)).toEqual(fixture);
    },
  );
  it.each(["active", "empty", "partial", "denied"] as const)("shares %s authorized summary fixture", (kind) => {
    expect(WorkstreamSummarySchema.safeParse(workstreamSummaryFixture(kind)).success).toBe(true);
    const snapshot = hostResourceFixture();
    snapshot.workstreams = workstreamSummaryFixture(kind);
    expect(HostResourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it("reports pressure basis without making launch or thrashing decisions", () => {
    const healthy = hostResourceFixture();
    expect(healthy.warnings).toEqual([]); // Half-full swap with no I/O is not activity.
    const codes = hostResourceFixture("pressure").warnings.map((w) => w.code);
    expect(codes).toEqual([
      "cpu-pressure",
      "memory-pressure",
      "swap-activity",
      "storage-pressure",
      "storage-pressure",
      "storage-pressure",
    ]);
    expect(hostResourceFixture("partial").warnings.map((w) => w.code)).toEqual(["partial-data"]);
    expect(hostResourceFixture("partial").capabilities).toEqual(healthy.capabilities);
    expect(hostResourceFixture("stale").warnings.map((w) => w.code)).toEqual(["stale-data"]);
    expect(resourceWarnings(healthy)).toEqual(healthy.warnings);
  });
  it("allows MemAvailable below MemFree, both independently bounded by total", () => {
    const s = hostResourceFixture();
    if (s.memory.status !== "available") throw new Error();
    s.memory.value.availableBytes = 1;
    expect(HostResourceSnapshotSchema.safeParse(s).success).toBe(true);
    s.memory.value.freeBytes = s.memory.value.totalBytes + 1;
    expect(HostResourceSnapshotSchema.safeParse(s).success).toBe(false);
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid byte count %s", (value) => {
    const s = hostResourceFixture();
    if (s.memory.status !== "available") throw new Error();
    s.memory.value.totalBytes = value;
    expect(HostResourceSnapshotSchema.safeParse(s).success).toBe(false);
  });
  it("rejects capacity lies, duplicate roles/capabilities, expired and future observations", () => {
    const mutate = (fn: (s: ReturnType<typeof hostResourceFixture>) => void) => {
      const s = hostResourceFixture();
      fn(s);
      expect(HostResourceSnapshotSchema.safeParse(s).success).toBe(false);
    };
    mutate((s) => {
      s.storage[1]!.role = "store";
    });
    mutate((s) => {
      s.capabilities.push("cpu");
    });
    mutate((s) => {
      if (s.cpu.status === "available") s.cpu.ageMs = s.expiresAfterMs;
    });
    mutate((s) => {
      if (s.cpu.status === "available") s.cpu.observedAt = "2026-10-05T12:00:00.000Z";
    });
    mutate((s) => {
      if (s.cpuLimit.status === "available") s.cpuLimit.value.effectiveCores = 100;
    });
    mutate((s) => {
      const m = s.storage[2]!.measurement;
      if (m.status === "available") m.value.backing = "tmpfs";
    });
    mutate((s) => {
      const m = s.storage[2]!.measurement;
      if (m.status === "available") {
        m.value.backing = "tmpfs";
        m.value.capacityRelation = "shared-memory";
      }
    });
  });
  it("rejects arbitrary payloads, paths and reasons at every boundary", () => {
    const s = hostResourceFixture();
    expect(HostResourceSnapshotSchema.safeParse({ ...s, argv: "secret" }).success).toBe(false);
    expect(HostResourceSnapshotSchema.safeParse({ ...s, cpu: { ...s.cpu, path: "/private" } }).success).toBe(false);
    expect(
      HostResourceSnapshotSchema.safeParse({
        ...s,
        cpu: { status: "unavailable", source: "none", reason: "secret exception" },
      }).success,
    ).toBe(false);
    expect(
      HostResourceSnapshotSchema.safeParse({
        ...s,
        workstreams: {
          status: "permission-denied",
          source: "runtime-ownership",
          reason: "not-authorized",
          value: { activeRoots: 0 },
        },
      }).success,
    ).toBe(false);
  });
  it("rejects delayed requests across reconnect, boot and daemon identity changes", () => {
    const previous = hostResourceFixture();
    const next = hostResourceFixture();
    next.sequence++;
    const connection = {
      expectedDaemonInstanceId: previous.daemonInstanceId,
      requestGeneration: 1,
      currentGeneration: 1,
    };
    expect(acceptResourceSnapshot(previous, next, connection)).toBe(true);
    expect(acceptResourceSnapshot(next, previous, connection)).toBe(false);
    expect(acceptResourceSnapshot(undefined, next, { ...connection, currentGeneration: 2 })).toBe(false);
    expect(acceptResourceSnapshot(undefined, next, { ...connection, expectedDaemonInstanceId: "new-instance" })).toBe(
      false,
    );
    const reboot = hostResourceFixture("stale");
    if (!("value" in reboot.bootId)) throw new Error();
    reboot.bootId.value = "10000000-0000-4000-8000-000000000004";
    expect(acceptResourceSnapshot(previous, reboot, connection)).toBe(false);
    expect(
      acceptResourceSnapshot(undefined, reboot, { ...connection, requestGeneration: 2, currentGeneration: 2 }),
    ).toBe(true);
    const cached = hostResourceFixture();
    cached.ageMs = 1000;
    expect(acceptResourceSnapshot(previous, cached, connection)).toBe(true);
    expect(acceptResourceSnapshot(cached, previous, connection)).toBe(false);
  });
});
