/** Deterministic public fixtures shared by the collector and future UI/MCP consumers. */
import {
  HOST_RESOURCE_LIMITS,
  resourceWarnings,
  type HostResourceSnapshot,
  type ResourceMetric,
  type ResourceSource,
} from "./host-resources.js";
const observedAt = "2026-10-04T12:00:00.000Z";
const available = <T>(value: T, source: ResourceSource): ResourceMetric<T> => ({
  status: "available",
  value,
  observedAt,
  ageMs: 0,
  source,
  precision:
    source === "linux-proc-meminfo"
      ? "estimate"
      : source === "node-statfs" || source === "linux-boot-id" || source === "runtime-ownership"
        ? "exact"
        : "counter",
});
export function hostResourceFixture(
  kind:
    | "healthy"
    | "pressure"
    | "partial"
    | "stale"
    | "tmpfs"
    | "cgroup-cpu-unsupported"
    | "cgroup-cpu-denied"
    | "cgroup-memory-unsupported"
    | "cgroup-memory-denied" = "healthy",
): HostResourceSnapshot {
  const s: HostResourceSnapshot = {
    version: 1,
    target: "daemon-machine",
    daemonInstanceId: "10000000-0000-4000-8000-000000000001",
    hostId: "10000000-0000-4000-8000-000000000002",
    hostIdentityScope: "collector-instance",
    bootId: available("10000000-0000-4000-8000-000000000003", "linux-boot-id"),
    sequence: 1,
    collectedAt: observedAt,
    ageMs: 0,
    refreshAfterMs: HOST_RESOURCE_LIMITS.refreshMs,
    expiresAfterMs: HOST_RESOURCE_LIMITS.expiresAfterMs,
    observationScope: "os-visible-machine",
    physicalHostCapacity: "unknown",
    configuredLimits: "not-collected",
    capabilities: ["cpu", "memory", "swap", "swapActivity", "cpuLimit", "memoryLimit", "storage"],
    cpu: available(
      { utilizationRatio: kind === "pressure" ? 0.98 : 0.2, intervalMs: 5_000, logicalCores: 8 },
      "linux-proc-stat",
    ),
    cpuLimit: available(
      { effectiveCores: 2, quotaCores: 2, cpusetCores: 8, scope: "visible-cgroup-hierarchy" },
      "linux-cgroup-v2",
    ),
    memory: available(
      {
        totalBytes: 16_000_000_000,
        availableBytes: kind === "pressure" ? 100_000_000 : 8_000_000_000,
        freeBytes: 50_000_000,
      },
      "linux-proc-meminfo",
    ),
    memoryLimit: available(
      {
        limitBytes: 4_000_000_000,
        currentBytes: 1_000_000_000,
        headroomBytes: 3_000_000_000,
        scope: "visible-cgroup-hierarchy",
      },
      "linux-cgroup-v2",
    ),
    swap: available({ totalBytes: 2_000_000_000, usedBytes: 1_000_000_000 }, "linux-proc-meminfo"),
    swapActivity: available(
      { inBytesPerSecond: kind === "pressure" ? 2_000_000 : 0, outBytesPerSecond: 0, intervalMs: 5_000 },
      "linux-proc-vmstat",
    ),
    storage: ["store", "workspace", "temp"].map((role) => ({
      role: role as "store" | "workspace" | "temp",
      measurement: available(
        {
          totalBytes: 100_000_000_000,
          availableBytes: kind === "pressure" ? 1_000_000_000 : 50_000_000_000,
          backing: "disk",
          backingId: "fs-1",
          capacityRelation: "filesystem-only",
        },
        "node-statfs",
      ),
    })),
    workstreams: { status: "permission-denied", source: "runtime-ownership", reason: "not-authorized" },
    warnings: [],
  };
  if (kind === "partial") {
    s.cpuLimit = { status: "unsupported", source: "linux-cgroup-v2", reason: "unsupported-source" };
    s.memoryLimit = { status: "permission-denied", source: "linux-cgroup-v2", reason: "permission-denied" };
    s.swapActivity = { status: "unavailable", source: "linux-proc-vmstat", reason: "timeout" };
  }
  if (kind === "cgroup-cpu-unsupported" || kind === "cgroup-cpu-denied") {
    s.cpuLimit = {
      status: kind === "cgroup-cpu-denied" ? "permission-denied" : "unsupported",
      source: "linux-cgroup-v2",
      reason: kind === "cgroup-cpu-denied" ? "permission-denied" : "unsupported-source",
    };
    s.memoryLimit = available(
      {
        limitBytes: 4_000_000_000,
        currentBytes: 3_800_000_000,
        headroomBytes: 200_000_000,
        scope: "visible-cgroup-hierarchy",
      },
      "linux-cgroup-v2",
    );
  }
  if (kind === "cgroup-memory-unsupported" || kind === "cgroup-memory-denied")
    s.memoryLimit = {
      status: kind === "cgroup-memory-denied" ? "permission-denied" : "unsupported",
      source: "linux-cgroup-v2",
      reason: kind === "cgroup-memory-denied" ? "permission-denied" : "unsupported-source",
    };
  if (kind === "stale") {
    s.ageMs = 20_000;
    for (const key of ["bootId", "cpu", "cpuLimit", "memory", "memoryLimit", "swap", "swapActivity"] as const) {
      const m = s[key];
      if (m.status === "available") Object.assign(m, { status: "stale", ageMs: 20_000, reason: "expired" });
    }
    for (const d of s.storage) Object.assign(d.measurement, { status: "stale", ageMs: 20_000, reason: "expired" });
  }
  if (kind === "tmpfs")
    s.storage[2]!.measurement = available(
      {
        totalBytes: 2_000_000_000,
        availableBytes: 1_000_000_000,
        backing: "tmpfs",
        backingId: "fs-2",
        capacityRelation: "shared-memory",
      },
      "node-statfs",
    );
  s.warnings = resourceWarnings(s);
  return s;
}

/** Authorized summaries contain counts only; missing authority is a separate metric state. */
export function workstreamSummaryFixture(kind: "active" | "empty" | "partial" | "denied" = "active") {
  if (kind === "denied") return hostResourceFixture().workstreams;
  return available(
    {
      scope: "caller-visible" as const,
      coverage: "authorized-run-set" as const,
      complete: kind !== "partial",
      activeRoots: kind === "empty" ? 0 : 2,
      executingRuns: kind === "empty" ? 0 : 1,
      waitingRuns: kind === "empty" ? 0 : 1,
      blockedRuns: kind === "empty" ? 0 : 1,
      uncertainRuns: kind === "partial" ? 1 : 0,
    },
    "runtime-ownership",
  );
}
