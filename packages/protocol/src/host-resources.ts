/** Shared advisory daemon-machine telemetry. No launch decision or wire method is defined here. */
import { z } from "zod";

export const HOST_RESOURCE_LIMITS = {
  refreshMs: 5_000,
  expiresAfterMs: 15_000,
  sourceTimeoutMs: 250,
  collectionTimeoutMs: 1_000,
  sourceBytes: 65_536,
  snapshotBytes: 32_768,
  workstreamRecords: 1_000,
} as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const number = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ precision: 3 });
export const ResourceSourceSchema = z.enum([
  "linux-proc-stat",
  "linux-proc-meminfo",
  "linux-proc-vmstat",
  "linux-cgroup-v2",
  "linux-boot-id",
  "node-statfs",
  "runtime-ownership",
  "none",
]);
export const ResourceReasonSchema = z.enum([
  "unsupported-platform",
  "unsupported-source",
  "permission-denied",
  "source-failed",
  "invalid-source",
  "timeout",
  "busy",
  "warming-up",
  "counter-reset",
  "clock-discontinuity",
  "not-configured",
  "scope-unverified",
  "expired",
  "not-authorized",
  "coverage-limit",
]);
export type ResourceReason = z.infer<typeof ResourceReasonSchema>;
export type ResourceSource = z.infer<typeof ResourceSourceSchema>;
export function resourceMetricSchema<T extends z.ZodType>(value: T) {
  const observed = {
    value,
    observedAt: timestamp,
    ageMs: number,
    source: ResourceSourceSchema,
    precision: z.enum(["counter", "estimate", "exact"]),
  };
  return z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("available"), ...observed }),
    z.strictObject({ status: z.literal("stale"), ...observed, reason: ResourceReasonSchema }),
    z.strictObject({
      status: z.enum(["unsupported", "unavailable", "permission-denied"]),
      source: ResourceSourceSchema,
      reason: ResourceReasonSchema,
    }),
  ]);
}
export type ResourceMetric<T> =
  | {
      status: "available";
      value: T;
      observedAt: string;
      ageMs: number;
      source: ResourceSource;
      precision: "counter" | "estimate" | "exact";
    }
  | {
      status: "stale";
      value: T;
      observedAt: string;
      ageMs: number;
      source: ResourceSource;
      precision: "counter" | "estimate" | "exact";
      reason: ResourceReason;
    }
  | { status: "unsupported" | "unavailable" | "permission-denied"; source: ResourceSource; reason: ResourceReason };
const cpu = z.strictObject({
  utilizationRatio: z.number().min(0).max(1),
  intervalMs: number.positive(),
  logicalCores: count.positive(),
});
const cpuLimit = z
  .strictObject({
    effectiveCores: number.positive(),
    quotaCores: number.positive().nullable(),
    cpusetCores: count.positive(),
    scope: z.literal("visible-cgroup-hierarchy"),
  })
  .refine((v) => v.effectiveCores <= v.cpusetCores && (v.quotaCores === null || v.effectiveCores <= v.quotaCores));
const memory = z
  .strictObject({ totalBytes: count, availableBytes: count, freeBytes: count })
  .refine((v) => v.freeBytes <= v.totalBytes && v.availableBytes <= v.totalBytes);
const memoryLimit = z
  .strictObject({
    limitBytes: count.nullable(),
    currentBytes: count,
    headroomBytes: count.nullable(),
    scope: z.literal("visible-cgroup-hierarchy"),
  })
  .refine((v) =>
    v.limitBytes === null ? v.headroomBytes === null : v.headroomBytes !== null && v.headroomBytes <= v.limitBytes,
  );
const swap = z.strictObject({ totalBytes: count, usedBytes: count }).refine((v) => v.usedBytes <= v.totalBytes);
const swapActivity = z.strictObject({
  inBytesPerSecond: number,
  outBytesPerSecond: number,
  intervalMs: number.positive(),
});
export const STORAGE_ROLES = ["store", "workspace", "temp"] as const;
const storage = z.strictObject({
  role: z.enum(STORAGE_ROLES),
  measurement: resourceMetricSchema(
    z
      .strictObject({
        totalBytes: count,
        availableBytes: count,
        backing: z.enum(["disk", "tmpfs", "unknown"]),
        backingId: z.enum(["fs-1", "fs-2", "fs-3"]),
        capacityRelation: z.enum(["shared-memory", "filesystem-only", "unknown"]),
      })
      .refine(
        (v) =>
          v.availableBytes <= v.totalBytes &&
          (v.backing === "tmpfs"
            ? v.capacityRelation === "shared-memory"
            : v.backing === "disk"
              ? v.capacityRelation === "filesystem-only"
              : v.capacityRelation === "unknown"),
      ),
  ),
});
export const WorkstreamSummarySchema = resourceMetricSchema(
  z.strictObject({
    scope: z.enum(["caller-visible", "authorized-aggregate"]),
    coverage: z.literal("authorized-run-set"),
    complete: z.boolean(),
    activeRoots: count,
    executingRuns: count,
    waitingRuns: count,
    blockedRuns: count,
    uncertainRuns: count,
  }),
);
export type WorkstreamSummary = z.infer<typeof WorkstreamSummarySchema>;
export const ResourceWarningSchema = z.strictObject({
  code: z.enum(["cpu-pressure", "memory-pressure", "swap-activity", "storage-pressure", "partial-data", "stale-data"]),
  metric: z.enum(["cpu", "memory", "memoryLimit", "swapActivity", "store", "workspace", "temp", "snapshot"]),
  policy: z.literal("advisory-v1"),
  basis: z.enum([
    "utilization-ratio",
    "available-ratio",
    "headroom-ratio",
    "swap-bytes-per-second",
    "missing-observation",
    "expired-observation",
  ]),
  threshold: number.nullable(),
});
export const HostResourceSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    target: z.literal("daemon-machine"),
    daemonInstanceId: z.uuid(),
    hostId: z.uuid(),
    hostIdentityScope: z.literal("collector-instance"),
    bootId: resourceMetricSchema(z.uuid()),
    sequence: count,
    collectedAt: timestamp,
    ageMs: number,
    refreshAfterMs: z.literal(HOST_RESOURCE_LIMITS.refreshMs),
    expiresAfterMs: z.literal(HOST_RESOURCE_LIMITS.expiresAfterMs),
    observationScope: z.literal("os-visible-machine"),
    physicalHostCapacity: z.literal("unknown"),
    configuredLimits: z.literal("not-collected"),
    capabilities: z
      .array(z.enum(["cpu", "memory", "swap", "swapActivity", "cpuLimit", "memoryLimit", "storage"]))
      .max(7)
      .refine((v) => new Set(v).size === v.length),
    cpu: resourceMetricSchema(cpu),
    cpuLimit: resourceMetricSchema(cpuLimit),
    memory: resourceMetricSchema(memory),
    memoryLimit: resourceMetricSchema(memoryLimit),
    swap: resourceMetricSchema(swap),
    swapActivity: resourceMetricSchema(swapActivity),
    storage: z
      .array(storage)
      .length(3)
      .refine((v) => new Set(v.map((s) => s.role)).size === 3),
    workstreams: WorkstreamSummarySchema,
    warnings: z.array(ResourceWarningSchema).max(12),
  })
  .superRefine((snapshot, ctx) => {
    const metrics = [
      snapshot.bootId,
      snapshot.cpu,
      snapshot.cpuLimit,
      snapshot.memory,
      snapshot.memoryLimit,
      snapshot.swap,
      snapshot.swapActivity,
      snapshot.workstreams,
      ...snapshot.storage.map((s) => s.measurement),
    ];
    for (const metric of metrics) {
      if (metric.status === "available" && metric.ageMs >= snapshot.expiresAfterMs)
        ctx.addIssue({ code: "custom", message: "expired metric cannot be available" });
      if ("observedAt" in metric && Date.parse(metric.observedAt) > Date.parse(snapshot.collectedAt))
        ctx.addIssue({ code: "custom", message: "observation cannot follow collection" });
    }
    const backings = new Map<string, string>();
    for (const { measurement } of snapshot.storage)
      if ("value" in measurement) {
        const v = measurement.value;
        const prior = backings.get(v.backingId);
        if (prior !== undefined && prior !== v.backing)
          ctx.addIssue({ code: "custom", message: "shared backing must have consistent type" });
        backings.set(v.backingId, v.backing);
      }
  });
export type HostResourceSnapshot = z.infer<typeof HostResourceSnapshotSchema>;
export type ResourceWarning = z.infer<typeof ResourceWarningSchema>;

/** One policy for every consumer. Occupancy alone never emits a swap activity warning. */
export function resourceWarnings(s: Omit<HostResourceSnapshot, "warnings">): ResourceWarning[] {
  const warnings: ResourceWarning[] = [];
  const add = (
    code: ResourceWarning["code"],
    metric: ResourceWarning["metric"],
    basis: ResourceWarning["basis"],
    threshold: number | null,
  ) => warnings.push({ code, metric, basis, threshold, policy: "advisory-v1" });
  if (s.cpu.status === "available" && s.cpu.value.utilizationRatio >= 0.9)
    add("cpu-pressure", "cpu", "utilization-ratio", 0.9);
  if (
    s.memory.status === "available" &&
    s.memory.value.totalBytes > 0 &&
    s.memory.value.availableBytes / s.memory.value.totalBytes <= 0.1
  )
    add("memory-pressure", "memory", "available-ratio", 0.1);
  if (
    s.memoryLimit.status === "available" &&
    s.memoryLimit.value.limitBytes !== null &&
    s.memoryLimit.value.limitBytes > 0 &&
    s.memoryLimit.value.headroomBytes! / s.memoryLimit.value.limitBytes <= 0.1
  )
    add("memory-pressure", "memoryLimit", "headroom-ratio", 0.1);
  if (
    s.swapActivity.status === "available" &&
    s.swapActivity.value.inBytesPerSecond + s.swapActivity.value.outBytesPerSecond >= 1_048_576
  )
    add("swap-activity", "swapActivity", "swap-bytes-per-second", 1_048_576);
  for (const disk of s.storage)
    if (
      disk.measurement.status === "available" &&
      disk.measurement.value.totalBytes > 0 &&
      disk.measurement.value.availableBytes / disk.measurement.value.totalBytes <= 0.1
    )
      add("storage-pressure", disk.role, "available-ratio", 0.1);
  const metrics = [
    s.bootId,
    s.cpu,
    s.cpuLimit,
    s.memory,
    s.memoryLimit,
    s.swap,
    s.swapActivity,
    ...s.storage.map((d) => d.measurement),
  ];
  if (metrics.some((m) => m.status !== "available" && m.status !== "stale"))
    add("partial-data", "snapshot", "missing-observation", null);
  if (metrics.some((m) => m.status === "stale")) add("stale-data", "snapshot", "expired-observation", null);
  return warnings;
}

/** The caller pins request generation to its current connection; late prior requests are rejected. */
export function acceptResourceSnapshot(
  previous: HostResourceSnapshot | undefined,
  next: HostResourceSnapshot,
  connection: { expectedDaemonInstanceId: string; requestGeneration: number; currentGeneration: number },
): boolean {
  if (
    connection.requestGeneration !== connection.currentGeneration ||
    next.daemonInstanceId !== connection.expectedDaemonInstanceId
  )
    return false;
  if (!previous) return true;
  if (previous.daemonInstanceId !== next.daemonInstanceId || previous.hostId !== next.hostId) return false;
  if ("value" in previous.bootId && "value" in next.bootId && previous.bootId.value !== next.bootId.value) return false;
  return next.sequence > previous.sequence || (next.sequence === previous.sequence && next.ageMs >= previous.ageMs);
}
