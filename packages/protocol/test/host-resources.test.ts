/** Consumer fixtures, strict measurement invariants, advisory semantics and response ordering. */
import { describe, expect, it } from "vitest";
import {
  HostResourceSnapshotSchema,
  acceptResourceSnapshot,
  advanceResourceSnapshot,
  composeResourceSnapshot,
  hostResourceFixture,
  workstreamSummaryFixture,
  WorkstreamSummarySchema,
  resourceWarnings,
  type ResourceSnapshotProvenance,
} from "../src/index.js";

describe("shared host resource contract", () => {
  it.each([
    "healthy",
    "pressure",
    "partial",
    "stale",
    "tmpfs",
    "cgroup-cpu-unsupported",
    "cgroup-cpu-denied",
    "cgroup-memory-unsupported",
    "cgroup-memory-denied",
  ] as const)("validates deterministic %s fixture", (kind) => {
    const fixture = hostResourceFixture(kind);
    expect(HostResourceSnapshotSchema.parse(fixture)).toEqual(fixture);
    expect(JSON.stringify(fixture).length).toBeLessThan(32_768);
    expect(hostResourceFixture(kind)).toEqual(fixture);
  });
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
  it.each(["unsupported", "denied"] as const)("shares independent cgroup %s states and warnings", (state) => {
    const cpuMissing = hostResourceFixture(`cgroup-cpu-${state}`);
    expect(cpuMissing.cpuLimit.status).toBe(state === "denied" ? "permission-denied" : "unsupported");
    expect(cpuMissing.cpuLimit).not.toHaveProperty("value");
    expect(cpuMissing.memoryLimit.status).toBe("available");
    expect(cpuMissing.warnings).toEqual([
      {
        code: "memory-pressure",
        metric: "memoryLimit",
        policy: "advisory-v1",
        basis: "headroom-ratio",
        threshold: 0.1,
      },
      {
        code: "partial-data",
        metric: "snapshot",
        policy: "advisory-v1",
        basis: "missing-observation",
        threshold: null,
      },
    ]);
    const memoryMissing = hostResourceFixture(`cgroup-memory-${state}`);
    expect(memoryMissing.memoryLimit.status).toBe(state === "denied" ? "permission-denied" : "unsupported");
    expect(memoryMissing.memoryLimit).not.toHaveProperty("value");
    expect(memoryMissing.cpuLimit.status).toBe("available");
    expect(memoryMissing.warnings.map((w) => w.code)).toEqual(["partial-data"]);
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

  it.each(["available", "stale"] as const)(
    "keeps a known boot across missing observations and rejects a %s different boot",
    (status) => {
      const first = hostResourceFixture();
      const connection = {
        expectedDaemonInstanceId: first.daemonInstanceId,
        requestGeneration: 1,
        currentGeneration: 1,
      };
      let cursor: ResourceSnapshotProvenance | undefined = advanceResourceSnapshot(undefined, first, connection);
      const missing = hostResourceFixture();
      missing.sequence = 2;
      missing.bootId = { status: "unavailable", source: "linux-boot-id", reason: "source-failed" };
      cursor = advanceResourceSnapshot(cursor, missing, connection);
      expect(cursor?.bootId).toEqual(first.bootId);
      const changed = hostResourceFixture();
      changed.sequence = 3;
      if (!("value" in changed.bootId)) throw new Error();
      changed.bootId.value = "10000000-0000-4000-8000-000000000004";
      if (status === "stale") changed.bootId = { ...changed.bootId, status, reason: "source-failed" };
      expect(advanceResourceSnapshot(cursor, changed, connection)).toBeUndefined();
      const sameBoot = hostResourceFixture();
      sameBoot.sequence = 3;
      expect(advanceResourceSnapshot(cursor, sameBoot, connection)?.sequence).toBe(3);
      expect(advanceResourceSnapshot(cursor, missing, { ...connection, currentGeneration: 2 })).toBeUndefined();
      // Only an authoritative transition can discard the old cursor; delayed generations still fail.
      expect(
        advanceResourceSnapshot(undefined, changed, { ...connection, requestGeneration: 2, currentGeneration: 2 }),
      ).toBeDefined();
    },
  );

  it("composes later summary timestamps and ages each observation without changing the input", () => {
    const host = hostResourceFixture();
    const summary = workstreamSummaryFixture();
    if (!("value" in summary)) throw new Error();
    summary.observedAt = "2026-10-04T12:00:00.001Z";
    const result = composeResourceSnapshot(host, summary, {
      collectedAt: "2026-10-04T12:00:00.010Z",
      hostElapsedMs: 10,
      summaryElapsedMs: 9,
    });
    expect(result.collectedAt).toBe("2026-10-04T12:00:00.010Z");
    expect(result.ageMs).toBe(10);
    expect(result.cpu).toEqual({ ...host.cpu, ageMs: 10 });
    expect(result.storage[0]!.measurement).toEqual({ ...host.storage[0]!.measurement, ageMs: 10 });
    expect(result.workstreams).toEqual({ ...summary, ageMs: 9 });
    expect(host).toEqual(hostResourceFixture());
    expect(summary.ageMs).toBe(0);
  });

  it("does not alias mutable boot observations into retained provenance", () => {
    const host = hostResourceFixture();
    const cursor = advanceResourceSnapshot(undefined, host, {
      expectedDaemonInstanceId: host.daemonInstanceId,
      requestGeneration: 1,
      currentGeneration: 1,
    });
    if (!("value" in host.bootId)) throw new Error();
    host.bootId.value = "10000000-0000-4000-8000-000000000004";
    expect(cursor?.bootId).toEqual(hostResourceFixture().bootId);
  });

  it("expires host and summary observations independently and recomputes the shared warnings", () => {
    const host = hostResourceFixture("pressure");
    const summary = workstreamSummaryFixture();
    if (!("value" in summary) || !("value" in host.cpu)) throw new Error();
    host.cpu = { ...host.cpu, ageMs: 14999 };
    summary.ageMs = 14999;
    const result = composeResourceSnapshot(host, summary, {
      collectedAt: "2026-10-04T12:00:00.002Z",
      hostElapsedMs: 2,
      summaryElapsedMs: 1,
    });
    expect(result.cpu).toEqual({ ...host.cpu, ageMs: 15001, status: "stale", reason: "expired" });
    expect(result.workstreams).toEqual({ ...summary, ageMs: 15000, status: "stale", reason: "expired" });
    expect(result.warnings).toEqual(resourceWarnings(result));
    expect(result.warnings.map((warning) => warning.code)).not.toContain("cpu-pressure");
    expect(result.warnings.map((warning) => warning.code)).toContain("stale-data");
  });

  it.each([
    { collectedAt: "invalid", hostElapsedMs: 1, summaryElapsedMs: 0 },
    { collectedAt: "2026-10-04T11:59:59.999Z", hostElapsedMs: 1, summaryElapsedMs: 0 },
    { collectedAt: "2026-10-04T12:00:00.000Z", hostElapsedMs: -1, summaryElapsedMs: 0 },
    { collectedAt: "2026-10-04T12:00:00.000Z", hostElapsedMs: NaN, summaryElapsedMs: 0 },
    { collectedAt: "2026-10-04T12:00:00.000Z", hostElapsedMs: 1, summaryElapsedMs: -1 },
    { collectedAt: "2026-10-04T12:00:00.000Z", hostElapsedMs: 1, summaryElapsedMs: 2 },
  ])("rejects invalid composition clocks %#", (completion) => {
    expect(() => composeResourceSnapshot(hostResourceFixture(), workstreamSummaryFixture(), completion)).toThrow();
  });

  it("keeps the future-observation invariant when composing a separately timed summary", () => {
    const summary = workstreamSummaryFixture();
    if (!("value" in summary)) throw new Error();
    summary.observedAt = "2026-10-04T12:00:00.001Z";
    expect(() =>
      composeResourceSnapshot(hostResourceFixture(), summary, {
        collectedAt: "2026-10-04T12:00:00.000Z",
        hostElapsedMs: 0,
        summaryElapsedMs: 0,
      }),
    ).toThrow();
  });
});
