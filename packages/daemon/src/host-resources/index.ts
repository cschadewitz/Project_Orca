/** Bounded, demand-driven advisory observations of the daemon machine. */
/** Bounded demand-driven daemon-host collection; no transport registration or background loop. */
import { randomUUID } from "node:crypto";
import {
  HOST_RESOURCE_LIMITS,
  HostResourceSnapshotSchema,
  STORAGE_ROLES,
  resourceWarnings,
  type HostResourceSnapshot,
  type ResourceMetric,
  type ResourceReason,
  type ResourceSource,
} from "@orca/protocol";
import { availableMemory, cpuCounters, swapMemory, swapCounters, SourceError } from "./parsers.js";
import { failureReason, nodeHostResourceSources, type HostResourceSources } from "./sources.js";
export { nodeHostResourceSources } from "./sources.js";
export type { HostResourceSources, StorageReading, CgroupReading } from "./sources.js";

export interface HostResourceCollectorOptions {
  daemonInstanceId: string;
  /** Bootstrap-owned paths only; snapshot() accepts no caller-supplied path. */
  storagePaths: Partial<Record<(typeof STORAGE_ROLES)[number], string>>;
  sources?: HostResourceSources;
  clock?: { monotonic: () => number; wall: () => number };
  hostId?: string;
}
type Result<T> = { ok: true; value: T } | { ok: false; reason: ResourceReason };
const unavailable = <T>(source: ResourceSource, reason: ResourceReason): ResourceMetric<T> => ({
  status:
    reason === "permission-denied" || reason === "not-authorized"
      ? "permission-denied"
      : reason === "unsupported-platform" || reason === "unsupported-source"
        ? "unsupported"
        : "unavailable",
  source,
  reason,
});
/** Demand-driven advisory sampling. No interval, notifications, admission, or transport. */
export class HostResourceCollector {
  private readonly sources: HostResourceSources;
  private readonly clock: NonNullable<HostResourceCollectorOptions["clock"]>;
  private readonly paths: HostResourceCollectorOptions["storagePaths"];
  private readonly hostId: string;
  private readonly daemonInstanceId: string;
  private cached: HostResourceSnapshot | undefined;
  private collectedMono = 0;
  private lastMono = -Infinity;
  private lastWall = 0;
  private sequence = 0;
  private clockReset = false;
  private active = 0;
  private pending: Promise<HostResourceSnapshot> | undefined;
  private previous:
    | { mono: number; boot: string; cpu?: ReturnType<typeof cpuCounters>; swap?: ReturnType<typeof swapCounters> }
    | undefined;
  constructor(options: HostResourceCollectorOptions) {
    this.sources = options.sources ?? nodeHostResourceSources({ storagePaths: Object.values(options.storagePaths) });
    this.clock = options.clock ?? { monotonic: () => performance.now(), wall: Date.now };
    this.paths = { ...options.storagePaths };
    this.hostId = options.hostId ?? randomUUID();
    this.daemonInstanceId = options.daemonInstanceId;
    if (
      !HostResourceSnapshotSchema.shape.daemonInstanceId.safeParse(this.daemonInstanceId).success ||
      !HostResourceSnapshotSchema.shape.hostId.safeParse(this.hostId).success
    )
      throw new Error("invalid collector identity");
  }
  async snapshot(): Promise<HostResourceSnapshot> {
    if (this.pending) return structuredClone(await this.pending);
    const mono = this.clock.monotonic(),
      wall = this.clock.wall();
    if (!Number.isFinite(mono) || !Number.isFinite(wall) || Number.isNaN(new Date(wall).getTime()))
      throw new Error("invalid collector clock");
    const reset =
      mono < this.lastMono ||
      wall < this.lastWall ||
      (this.lastMono !== -Infinity &&
        Math.abs(wall - this.lastWall - (mono - this.lastMono)) > HOST_RESOURCE_LIMITS.expiresAfterMs);
    const monotonicReset = mono < this.lastMono;
    this.lastMono = mono;
    this.lastWall = wall;
    if (reset) {
      this.previous = undefined;
      this.clockReset = true;
      if (this.cached) this.invalidateClock(this.cached, wall);
      if (monotonicReset) this.cached = undefined;
    }
    if (this.cached && mono - this.collectedMono < HOST_RESOURCE_LIMITS.refreshMs) return this.aged(mono);
    const resetEpoch = this.clockReset;
    this.clockReset = false;
    this.pending = this.collect(mono, wall, resetEpoch).finally(() => {
      this.pending = undefined;
    });
    return structuredClone(await this.pending);
  }
  /** Dispose the isolated native worker; never wait on a stuck diagnostic syscall. */
  close(): void {
    this.sources.close?.();
    this.previous = undefined;
    this.cached = undefined;
  }
  /** Cached observation without I/O, useful to show expiry while a refresh is pending. */
  peek(): HostResourceSnapshot | undefined {
    const mono = this.clock.monotonic();
    if (!this.cached || !Number.isFinite(mono) || mono < this.collectedMono) return undefined;
    return this.aged(mono);
  }
  private invalidateClock(snapshot: HostResourceSnapshot, wall: number): void {
    for (const key of ["bootId", "cpu", "cpuLimit", "memory", "memoryLimit", "swap", "swapActivity"] as const)
      Object.assign(snapshot, { [key]: unavailable(snapshot[key].source, "clock-discontinuity") });
    for (const disk of snapshot.storage) disk.measurement = unavailable("node-statfs", "clock-discontinuity");
    snapshot.collectedAt = new Date(wall).toISOString();
    snapshot.ageMs = 0;
    snapshot.warnings = resourceWarnings(snapshot);
  }
  private aged(mono: number): HostResourceSnapshot {
    const copy = structuredClone(this.cached!);
    const elapsed = Math.max(0, mono - this.collectedMono);
    copy.ageMs = elapsed;
    const age = <T>(metric: ResourceMetric<T>) => {
      if (metric.status !== "available" && metric.status !== "stale") return;
      metric.ageMs += elapsed;
      if (metric.ageMs >= HOST_RESOURCE_LIMITS.expiresAfterMs)
        Object.assign(metric, { status: "stale", reason: "expired" });
    };
    for (const key of ["bootId", "cpu", "cpuLimit", "memory", "memoryLimit", "swap", "swapActivity"] as const)
      age(copy[key] as ResourceMetric<unknown>);
    for (const storage of copy.storage) age(storage.measurement);
    copy.warnings = resourceWarnings(copy);
    return copy;
  }
  private async bounded<T>(operation: () => Promise<T>, deadline: number): Promise<Result<T>> {
    const remaining = deadline - this.clock.monotonic();
    if (remaining <= 0) return { ok: false, reason: "timeout" };
    if (this.active >= 4) return { ok: false, reason: "busy" };
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A timeout only releases the waiter. An uninterruptible syscall retains its slot.
    const work: Promise<Result<T>> = Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, reason: failureReason(error) }),
      )
      .finally(() => {
        this.active--;
      });
    const timeout = new Promise<Result<T>>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, reason: "timeout" }),
        Math.min(HOST_RESOURCE_LIMITS.sourceTimeoutMs, remaining),
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async collect(mono: number, wall: number, reset: boolean): Promise<HostResourceSnapshot> {
    const observedAt = new Date(wall).toISOString();
    const old = this.cached ? this.aged(mono) : undefined;
    const available = <T>(
      value: T,
      source: ResourceSource,
      precision: "counter" | "estimate" | "exact" = "counter",
    ): ResourceMetric<T> => ({ status: "available", value, observedAt, ageMs: 0, source, precision });
    const metric = <T>(result: Result<T>, source: ResourceSource): ResourceMetric<T> =>
      result.ok ? available(result.value, source, "exact") : unavailable(source, result.reason);
    const deadline = mono + HOST_RESOURCE_LIMITS.collectionTimeoutMs;
    const linux = this.sources.platform === "linux";
    const source = <T>(op: () => Promise<T>) =>
      linux ? this.bounded(op, deadline) : Promise.resolve<Result<T>>({ ok: false, reason: "unsupported-platform" });
    const read = async (path: string) => {
      const text = await this.sources.read(path);
      if (Buffer.byteLength(text) > HOST_RESOURCE_LIMITS.sourceBytes) throw new SourceError("invalid-source");
      return text;
    };
    const [boot, cpu, memory, swap] = await Promise.all([
      source(async () => {
        const value = (await read("/proc/sys/kernel/random/boot_id")).trim();
        if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value))
          throw new SourceError("invalid-source");
        return value;
      }),
      source(async () => cpuCounters(await read("/proc/stat"))),
      source(() => read("/proc/meminfo")),
      source(async () => swapCounters(await read("/proc/vmstat"))),
    ]);
    const parseMemory = <T>(parse: (text: string) => T): ResourceMetric<T> => {
      if (!memory.ok) return unavailable("linux-proc-meminfo", memory.reason);
      try {
        return available(parse(memory.value), "linux-proc-meminfo", "estimate");
      } catch (error) {
        return unavailable("linux-proc-meminfo", failureReason(error));
      }
    };
    const [cgroup, pages] = await Promise.all([
      source(() => this.sources.cgroup()),
      source(() => this.sources.pageSize()),
    ]);
    const cgroupMetric = <T>(result: Result<T>): ResourceMetric<T> =>
      result.ok
        ? available(result.value, "linux-cgroup-v2", "estimate")
        : unavailable("linux-cgroup-v2", result.reason);
    const diskResults = await Promise.all(
      STORAGE_ROLES.map((role) => {
        const path = this.paths[role];
        return path === undefined
          ? Promise.resolve<Result<Awaited<ReturnType<HostResourceSources["storage"]>>>>({
              ok: false,
              reason: "not-configured",
            })
          : this.bounded(() => this.sources.storage(path), deadline);
      }),
    );
    let intervalReason: ResourceReason = reset ? "clock-discontinuity" : "warming-up";
    let prior = this.previous;
    if (!boot.ok || (prior && prior.boot !== boot.value)) {
      prior = undefined;
      intervalReason = "counter-reset";
    }
    const intervalMs = prior ? mono - prior.mono : 0;
    let cpuMetric: HostResourceSnapshot["cpu"] = unavailable("linux-proc-stat", cpu.ok ? intervalReason : cpu.reason);
    let swapMetric: HostResourceSnapshot["swapActivity"] = unavailable(
      "linux-proc-vmstat",
      !swap.ok ? swap.reason : !pages.ok ? pages.reason : intervalReason,
    );
    if (cpu.ok && prior?.cpu && intervalMs > 0) {
      const total = cpu.value.total - prior.cpu.total,
        idle = cpu.value.idle - prior.cpu.idle;
      cpuMetric =
        total > 0 && idle >= 0 && idle <= total && prior.cpu.logicalCores === cpu.value.logicalCores
          ? available(
              { utilizationRatio: (total - idle) / total, intervalMs, logicalCores: cpu.value.logicalCores },
              "linux-proc-stat",
            )
          : unavailable("linux-proc-stat", "counter-reset");
    }
    if (swap.ok && pages.ok && prior?.swap && intervalMs > 0) {
      const input = swap.value.input - prior.swap.input,
        output = swap.value.output - prior.swap.output;
      if (!Number.isSafeInteger(pages.value) || pages.value <= 0)
        swapMetric = unavailable("linux-proc-vmstat", "invalid-source");
      else
        swapMetric =
          input >= 0 && output >= 0
            ? available(
                {
                  inBytesPerSecond: (input * pages.value * 1000) / intervalMs,
                  outBytesPerSecond: (output * pages.value * 1000) / intervalMs,
                  intervalMs,
                },
                "linux-proc-vmstat",
              )
            : unavailable("linux-proc-vmstat", "counter-reset");
    }
    if (boot.ok)
      this.previous = {
        mono,
        boot: boot.value,
        ...(cpu.ok ? { cpu: cpu.value } : {}),
        ...(swap.ok ? { swap: swap.value } : {}),
      };
    else this.previous = undefined;
    const backingIds = new Map<string, "fs-1" | "fs-2" | "fs-3">();
    const storage: HostResourceSnapshot["storage"] = STORAGE_ROLES.map((role, i) => {
      const result = diskResults[i]!;
      if (!result.ok) return { role, measurement: unavailable("node-statfs", result.reason) };
      const { device, backing, totalBytes, availableBytes } = result.value;
      const backingId = backingIds.get(device) ?? (["fs-1", "fs-2", "fs-3"] as const)[backingIds.size]!;
      backingIds.set(device, backingId);
      return {
        role,
        measurement: available(
          {
            totalBytes,
            availableBytes,
            backing,
            backingId,
            capacityRelation:
              backing === "tmpfs" ? "shared-memory" : backing === "disk" ? "filesystem-only" : "unknown",
          },
          "node-statfs",
          "exact",
        ),
      };
    });
    const snapshot: HostResourceSnapshot = {
      version: 1,
      target: "daemon-machine",
      daemonInstanceId: this.daemonInstanceId,
      hostId: this.hostId,
      hostIdentityScope: "collector-instance",
      bootId: metric(boot, "linux-boot-id"),
      sequence: ++this.sequence,
      collectedAt: observedAt,
      ageMs: 0,
      refreshAfterMs: HOST_RESOURCE_LIMITS.refreshMs,
      expiresAfterMs: HOST_RESOURCE_LIMITS.expiresAfterMs,
      observationScope: "os-visible-machine",
      physicalHostCapacity: "unknown",
      configuredLimits: "not-collected",
      capabilities: linux
        ? ["cpu", "memory", "swap", "swapActivity", "cpuLimit", "memoryLimit", "storage"]
        : ["storage"],
      cpu: cpuMetric,
      cpuLimit: cgroupMetric(cgroup.ok ? cgroup.value.cpu : cgroup),
      memory: parseMemory(availableMemory),
      memoryLimit: cgroupMetric(cgroup.ok ? cgroup.value.memory : cgroup),
      swap: parseMemory(swapMemory),
      swapActivity: swapMetric,
      storage,
      workstreams: unavailable("runtime-ownership", "not-authorized"),
      warnings: [],
    };
    for (const key of ["bootId", "cpu", "cpuLimit", "memory", "memoryLimit", "swap", "swapActivity"] as const) {
      if (!HostResourceSnapshotSchema.shape[key].safeParse(snapshot[key]).success)
        Object.assign(snapshot, { [key]: unavailable(snapshot[key].source, "invalid-source") });
    }
    for (const disk of snapshot.storage) {
      if (!HostResourceSnapshotSchema.shape.storage.element.safeParse(disk).success)
        disk.measurement = unavailable("node-statfs", "invalid-source");
    }
    // Filesystem identity can race a mount change between statfs and stat. A
    // contradictory shared group is unknown, rather than a whole-snapshot error.
    const backingTypes = new Map<string, Set<string>>();
    for (const disk of snapshot.storage)
      if (disk.measurement.status === "available") {
        const { backingId, backing } = disk.measurement.value;
        const types = backingTypes.get(backingId) ?? new Set<string>();
        types.add(backing);
        backingTypes.set(backingId, types);
      }
    for (const disk of snapshot.storage)
      if (disk.measurement.status === "available" && backingTypes.get(disk.measurement.value.backingId)!.size > 1) {
        disk.measurement = unavailable("node-statfs", "invalid-source");
      }
    // Preserve last observations only inside a verified unchanged boot and clock epoch.
    if (old && boot.ok && old.bootId.status === "available" && old.bootId.value === boot.value) {
      const preserve = <T>(next: ResourceMetric<T>, prev: ResourceMetric<T>): ResourceMetric<T> =>
        next.status !== "available" &&
        next.status !== "stale" &&
        next.reason !== "counter-reset" &&
        (prev.status === "available" || prev.status === "stale")
          ? { ...prev, status: "stale", reason: next.reason }
          : next;
      snapshot.cpu = preserve(snapshot.cpu, old.cpu);
      snapshot.cpuLimit = preserve(snapshot.cpuLimit, old.cpuLimit);
      snapshot.memory = preserve(snapshot.memory, old.memory);
      snapshot.memoryLimit = preserve(snapshot.memoryLimit, old.memoryLimit);
      snapshot.swap = preserve(snapshot.swap, old.swap);
      snapshot.swapActivity = preserve(snapshot.swapActivity, old.swapActivity);
      // Backing IDs are snapshot-local. Keeping an old disk would mix identity maps.
      // Failed storage reads remain explicitly unavailable instead of reusing old IDs.
    }
    snapshot.warnings = resourceWarnings(snapshot);
    const completedMono = this.clock.monotonic(),
      completedWall = this.clock.wall();
    if (
      !Number.isFinite(completedMono) ||
      !Number.isFinite(completedWall) ||
      Number.isNaN(new Date(completedWall).getTime())
    )
      throw new Error("invalid collector clock");
    if (
      completedMono < mono ||
      completedWall < wall ||
      Math.abs(completedWall - wall - (completedMono - mono)) > HOST_RESOURCE_LIMITS.expiresAfterMs
    ) {
      this.invalidateClock(snapshot, completedWall);
      this.previous = undefined;
      this.clockReset = true;
    } else {
      const elapsed = completedMono - mono;
      for (const key of ["bootId", "cpu", "cpuLimit", "memory", "memoryLimit", "swap", "swapActivity"] as const) {
        const field = snapshot[key];
        if (field.status === "available" || field.status === "stale") {
          field.ageMs += elapsed;
          if (field.ageMs >= HOST_RESOURCE_LIMITS.expiresAfterMs)
            Object.assign(field, { status: "stale", reason: "expired" });
        }
      }
      for (const disk of snapshot.storage)
        if (disk.measurement.status === "available" || disk.measurement.status === "stale") {
          disk.measurement.ageMs += elapsed;
          if (disk.measurement.ageMs >= HOST_RESOURCE_LIMITS.expiresAfterMs)
            Object.assign(disk.measurement, { status: "stale", reason: "expired" });
        }
      snapshot.collectedAt = new Date(completedWall).toISOString();
    }
    snapshot.warnings = resourceWarnings(snapshot);
    const checked = HostResourceSnapshotSchema.parse(snapshot);
    if (Buffer.byteLength(JSON.stringify(checked)) > HOST_RESOURCE_LIMITS.snapshotBytes)
      throw new Error("snapshot coverage limit");
    this.cached = checked;
    this.collectedMono = completedMono;
    this.lastWall = completedWall;
    this.lastMono = completedMono;
    return checked;
  }
}
