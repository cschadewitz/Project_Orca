/** Deterministic collector, source-boundary, pressure, reset and privacy checks. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_RESOURCE_LIMITS, HostResourceSnapshotSchema } from "@orca/protocol";
import { HostResourceCollector, type HostResourceSources } from "../src/host-resources/index.js";
import { readCgroup } from "../src/host-resources/sources.js";
import { cpuCounters, cpusetCount, memoryCounters } from "../src/host-resources/parsers.js";
const daemonInstanceId = "10000000-0000-4000-8000-000000000001";
const bootId = "10000000-0000-4000-8000-000000000002";
function harness() {
  let mono = 0,
    wall = Date.parse("2026-10-04T12:00:00.000Z");
  const values: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": bootId,
    "/proc/stat": "cpu  100 0 0 100 0 0 0 0 90 0\ncpu0 100 0 0 100 0 0 0 0 90 0\n",
    "/proc/meminfo":
      "MemTotal: 10000 kB\nMemAvailable: 5000 kB\nMemFree: 1000 kB\nSwapTotal: 10000 kB\nSwapFree: 1000 kB\n",
    "/proc/vmstat": "pswpin 10\npswpout 20\n",
  };
  const sources: HostResourceSources = {
    platform: "linux",
    read: vi.fn(async (path) => values[path]!),
    pageSize: vi.fn(async () => 4096),
    cgroup: vi.fn<HostResourceSources["cgroup"]>(async () => ({
      cpu: { ok: true, value: { effectiveCores: 1, quotaCores: 1, cpusetCores: 4, scope: "visible-cgroup-hierarchy" } },
      memory: {
        ok: true,
        value: { limitBytes: 10000, currentBytes: 1000, headroomBytes: 9000, scope: "visible-cgroup-hierarchy" },
      },
    })),
    storage: vi.fn<HostResourceSources["storage"]>(async (path) => ({
      totalBytes: 10000,
      availableBytes: 5000,
      device: path === "/secret/temp" ? "88" : "77",
      backing: path === "/secret/temp" ? "tmpfs" : "disk",
    })),
  };
  const collector = new HostResourceCollector({
    daemonInstanceId,
    sources,
    storagePaths: { store: "/secret/store", workspace: "/secret/work", temp: "/secret/temp" },
    clock: { monotonic: () => mono, wall: () => wall },
  });
  return {
    collector,
    sources,
    values,
    advance: (ms: number) => {
      mono += ms;
      wall += ms;
    },
    jumpWall: (ms: number) => {
      wall += ms;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("host resource collector", () => {
  it("warms intervals, caches for five seconds, clones results and measures host CPU without guest double count", async () => {
    const h = harness();
    const first = await h.collector.snapshot();
    expect(first.cpu).toMatchObject({ status: "unavailable", reason: "warming-up" });
    first.storage.length = 0;
    h.advance(4999);
    const cached = await h.collector.snapshot();
    expect(cached.storage).toHaveLength(3);
    expect(cached.ageMs).toBe(4999);
    expect(h.sources.read).toHaveBeenCalledTimes(4);
    h.advance(1);
    h.values["/proc/stat"] = "cpu 200 0 0 150 50 0 0 0 190 0\ncpu0 200 0 0 150 50 0 0 0 190 0";
    const second = await h.collector.snapshot();
    expect(second.cpu).toMatchObject({
      status: "available",
      value: { utilizationRatio: 0.5, intervalMs: 5000, logicalCores: 1 },
    });
    expect(second.swapActivity).toMatchObject({
      status: "available",
      value: { inBytesPerSecond: 0, outBytesPerSecond: 0 },
    });
    expect(second.warnings.some((w) => w.code === "swap-activity")).toBe(false);
    expect(HostResourceSnapshotSchema.safeParse(second).success).toBe(true);
  });
  it("emits pressure using available memory and swap movement, with tmpfs shared-memory and device grouping", async () => {
    const h = harness();
    await h.collector.snapshot();
    h.advance(5000);
    h.values["/proc/stat"] = "cpu 200 0 0 100 0 0 0 0 190 0\ncpu0 200 0 0 100 0 0 0 0 190 0";
    h.values["/proc/meminfo"] =
      "MemTotal: 10000 kB\nMemAvailable: 100 kB\nMemFree: 200 kB\nSwapTotal: 10000 kB\nSwapFree: 1000 kB";
    h.values["/proc/vmstat"] = "pswpin 10000\npswpout 20000";
    const s = await h.collector.snapshot();
    expect(s.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["cpu-pressure", "memory-pressure", "swap-activity"]),
    );
    expect(s.storage.map((d) => d.measurement.status === "available" && d.measurement.value.backingId)).toEqual([
      "fs-1",
      "fs-1",
      "fs-2",
    ]);
    expect(s.storage[2]!.measurement).toMatchObject({ value: { backing: "tmpfs", capacityRelation: "shared-memory" } });
    const json = JSON.stringify(s);
    for (const forbidden of ["/secret", "device", "argv", "environment", "credential"])
      expect(json).not.toContain(forbidden);
  });
  it("retains stale observations on partial refresh and expires cached data by monotonic age", async () => {
    const h = harness();
    await h.collector.snapshot();
    h.advance(5000);
    const read = h.sources.read;
    h.sources.read = async (path) => {
      if (path === "/proc/meminfo") throw Object.assign(new Error("secret credentials /private"), { code: "EACCES" });
      return read(path);
    };
    const s = await h.collector.snapshot();
    expect(s.memory).toMatchObject({ status: "stale", ageMs: 5000, reason: "permission-denied" });
    expect(JSON.stringify(s)).not.toContain("secret");
    h.advance(15000);
    expect(h.collector.peek()?.memory).toMatchObject({ status: "stale", ageMs: 20000, reason: "expired" });
  });
  it("resets baselines on boot change, counter decrease and wall/monotonic discontinuity", async () => {
    const h = harness();
    await h.collector.snapshot();
    h.advance(5000);
    h.values["/proc/stat"] = "cpu 1 0 0 1 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0";
    expect((await h.collector.snapshot()).cpu).toMatchObject({ reason: "counter-reset" });
    h.advance(5000);
    h.values["/proc/sys/kernel/random/boot_id"] = daemonInstanceId;
    expect((await h.collector.snapshot()).cpu).toMatchObject({ reason: "counter-reset" });
    h.advance(5000);
    h.jumpWall(-60000);
    expect((await h.collector.snapshot()).cpu).toMatchObject({ reason: "clock-discontinuity" });
    h.advance(-10000);
    expect(h.collector.peek()).toBeUndefined();
    expect((await h.collector.snapshot()).cpu).toMatchObject({ reason: "clock-discontinuity" });
  });
  it("fails closed on small backwards clock jumps without bypassing the refresh cooldown", async () => {
    const h = harness();
    await h.collector.snapshot();
    h.advance(1000);
    h.jumpWall(-2000);
    expect((await h.collector.snapshot()).memory).toMatchObject({ reason: "clock-discontinuity" });
    expect(h.sources.read).toHaveBeenCalledTimes(4);
    h.advance(4000);
    expect((await h.collector.snapshot()).cpu).toMatchObject({ reason: "clock-discontinuity" });
    expect(h.sources.read).toHaveBeenCalledTimes(8);
  });
  it("handles a clock rewind while I/O is pending before validating the final snapshot", async () => {
    const h = harness();
    const original = h.sources.storage;
    h.sources.storage = async (path) => {
      h.jumpWall(-1000);
      return original(path);
    };
    const s = await h.collector.snapshot();
    expect(s.memory).toMatchObject({ reason: "clock-discontinuity" });
    expect(HostResourceSnapshotSchema.safeParse(s).success).toBe(true);
  });
  it("marks a delayed collection stale rather than rejecting valid old values", async () => {
    const h = harness();
    const read = h.sources.read;
    h.sources.read = async (path) => {
      const value = await read(path);
      if (path.endsWith("boot_id")) h.advance(20_000);
      return value;
    };
    const snapshot = await h.collector.snapshot();
    expect(snapshot.memory.status).toBe("stale");
    expect(HostResourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it("coalesces simultaneous refreshes and retains four stuck slots after timeout", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sources.read = vi.fn(() => new Promise<string>(() => {}));
    const first = h.collector.snapshot(),
      same = h.collector.snapshot();
    await vi.advanceTimersByTimeAsync(250);
    const s = await first;
    expect((await same).sequence).toBe(s.sequence);
    expect(s.cpu).toMatchObject({ reason: "timeout" });
    expect(s.memoryLimit).toMatchObject({ reason: "busy" });
    expect(h.sources.read).toHaveBeenCalledTimes(4);
    h.advance(5000);
    expect((await h.collector.snapshot()).cpu).toMatchObject({ reason: "busy" });
    expect(h.sources.read).toHaveBeenCalledTimes(4);
  });
  it("releases timed-out slots only when the actual read settles", async () => {
    vi.useFakeTimers();
    const h = harness();
    const original = h.sources.read;
    let release!: (value: string) => void;
    h.sources.read = (path) =>
      path === "/proc/stat"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original(path);
    const pending = h.collector.snapshot();
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    release(h.values["/proc/stat"]!);
    await Promise.resolve();
    await Promise.resolve();
    h.sources.read = original;
    h.advance(5000);
    expect((await h.collector.snapshot()).memory.status).toBe("available");
  });
  it("rejects oversized and malformed sources with fixed reasons and keeps capability support stable", async () => {
    const h = harness();
    h.values["/proc/stat"] = "x".repeat(HOST_RESOURCE_LIMITS.sourceBytes + 1);
    h.sources.storage = async () => ({ totalBytes: -1, availableBytes: 0, device: "private", backing: "unknown" });
    const s = await h.collector.snapshot();
    expect(s.cpu).toMatchObject({ status: "unavailable", reason: "invalid-source" });
    expect(s.storage[0]!.measurement).toMatchObject({ reason: "invalid-source" });
    expect(s.capabilities).toContain("cpu");
  });
  it("keeps RAM available when swap fields are missing, and swap available when MemAvailable is absent", async () => {
    const h = harness();
    h.values["/proc/meminfo"] = "MemTotal: 10 kB\nMemAvailable: 5 kB\nMemFree: 1 kB";
    const s = await h.collector.snapshot();
    expect(s.memory.status).toBe("available");
    expect(s.swap).toMatchObject({ reason: "invalid-source" });
    const other = harness();
    other.values["/proc/meminfo"] = "MemTotal: 10 kB\nMemFree: 1 kB\nSwapTotal: 10 kB\nSwapFree: 2 kB";
    const partial = await other.collector.snapshot();
    expect(partial.memory).toMatchObject({ reason: "invalid-source" });
    expect(partial.swap.status).toBe("available");
  });
  it("isolates contradictory backing types on one device without losing other metrics", async () => {
    const h = harness();
    const storage = h.sources.storage;
    h.sources.storage = async (path) => ({ ...(await storage(path)), device: "same-device" });
    const snapshot = await h.collector.snapshot();
    expect(
      snapshot.storage.every(
        (d) => d.measurement.status === "unavailable" && d.measurement.reason === "invalid-source",
      ),
    ).toBe(true);
    expect(snapshot.memory.status).toBe("available");
    expect(HostResourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it("does not mix old filesystem identities into a refreshed storage map", async () => {
    const h = harness();
    await h.collector.snapshot();
    h.advance(5000);
    const original = h.sources.storage;
    h.sources.storage = async (path) => {
      if (path === "/secret/store") throw new Error("offline");
      return original(path);
    };
    const s = await h.collector.snapshot();
    expect(s.storage[0]!.measurement.status).toBe("unavailable");
    expect(s.storage[1]!.measurement).toMatchObject({ status: "available", value: { backingId: "fs-1" } });
  });
  it("does not assume a page size and returns explicit unsupported platform states", async () => {
    const h = harness();
    h.sources.pageSize = async () => {
      throw new Error("unavailable");
    };
    await h.collector.snapshot();
    h.advance(5000);
    expect((await h.collector.snapshot()).swapActivity).toMatchObject({
      status: "unavailable",
      reason: "source-failed",
    });
    const other = harness();
    other.sources.platform = "darwin";
    const s = await other.collector.snapshot();
    expect(s.cpu).toMatchObject({ status: "unsupported", reason: "unsupported-platform" });
    expect(other.sources.read).not.toHaveBeenCalled();
    expect(s.capabilities).toEqual(["storage"]);
  });
  it("parses reserve-adjusted MemAvailable and validates malformed CPU sets", () => {
    expect(
      memoryCounters("MemTotal: 10 kB\nMemAvailable: 1 kB\nMemFree: 2 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB").memory
        .availableBytes,
    ).toBe(1024);
    expect(cpusetCount("0-3,6,8-9")).toBe(7);
    for (const invalid of ["0-3,2", "3-1", "", "0,0"]) expect(() => cpusetCount(invalid)).toThrow();
    expect(() => cpuCounters("cpu 1 2")).toThrow();
  });
});
describe("bounded visible cgroup hierarchy", () => {
  function files() {
    return {
      "/proc/self/cgroup": "0::/parent/leaf\n",
      "/proc/self/mountinfo": "1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
      "/sys/fs/cgroup/cpuset.cpus.effective": "0-7",
      "/sys/fs/cgroup/parent/cpuset.cpus.effective": "0-3",
      "/sys/fs/cgroup/parent/cpu.max": "150000 100000",
      "/sys/fs/cgroup/parent/memory.max": "10000",
      "/sys/fs/cgroup/parent/memory.current": "9500",
      "/sys/fs/cgroup/parent/leaf/cpuset.cpus.effective": "0-1",
      "/sys/fs/cgroup/parent/leaf/cpu.max": "max 100000",
      "/sys/fs/cgroup/parent/leaf/memory.max": "8000",
      "/sys/fs/cgroup/parent/leaf/memory.current": "1000",
    } satisfies Record<string, string>;
  }
  const fixtureRead =
    (values: Record<string, string>, failPath?: string, code = "EACCES") =>
    async (path: string) => {
      if (path === failPath) throw Object.assign(new Error("secret controller path"), { code });
      if (values[path] === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return values[path];
    };
  it.each([
    ["cpu.max", "ENOENT"],
    ["cpu.max", "EACCES"],
    ["cpuset.cpus.effective", "ENOENT"],
    ["cpuset.cpus.effective", "EACCES"],
  ])("preserves memory pressure when %s is %s", async (file, code) => {
    const values: Record<string, string> = files();
    values["/sys/fs/cgroup/parent/leaf/memory.max"] = "10000";
    const h = harness();
    h.sources.cgroup = () => readCgroup(fixtureRead(values, `/sys/fs/cgroup/parent/${file}`, code));
    const snapshot = await h.collector.snapshot();
    expect(snapshot.cpuLimit).toEqual({
      status: code === "ENOENT" ? "unsupported" : "permission-denied",
      reason: code === "ENOENT" ? "unsupported-source" : "permission-denied",
      source: "linux-cgroup-v2",
    });
    expect(snapshot.memoryLimit).toMatchObject({
      status: "available",
      value: { limitBytes: 10000, currentBytes: 1000, headroomBytes: 500 },
    });
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "memory-pressure", metric: "memoryLimit" }),
        expect.objectContaining({ code: "partial-data" }),
      ]),
    );
    expect(HostResourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });
  it.each([
    ["memory.max", "EACCES"],
    ["memory.current", "EACCES"],
    ["memory.max", "ENOENT"],
    ["memory.current", "ENOENT"],
  ])("preserves CPU limits when %s is %s", async (file, code) => {
    const h = harness();
    h.sources.cgroup = () => readCgroup(fixtureRead(files(), `/sys/fs/cgroup/parent/leaf/${file}`, code));
    const snapshot = await h.collector.snapshot();
    expect(snapshot.cpuLimit).toMatchObject({
      status: "available",
      value: { effectiveCores: 1.5, quotaCores: 1.5, cpusetCores: 2 },
    });
    expect(snapshot.memoryLimit).toEqual({
      status: code === "ENOENT" ? "unsupported" : "permission-denied",
      reason: code === "ENOENT" ? "unsupported-source" : "permission-denied",
      source: "linux-cgroup-v2",
    });
    expect(snapshot.warnings).not.toContainEqual(expect.objectContaining({ code: "memory-pressure" }));
    expect(HostResourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
  it("retains only the failed metric as stale while refreshing independent memory pressure", async () => {
    const h = harness();
    const values: Record<string, string> = files();
    let failPath: string | undefined = undefined;
    h.sources.cgroup = () => readCgroup(fixtureRead(values, failPath));
    await h.collector.snapshot();
    h.advance(5000);
    failPath = "/sys/fs/cgroup/parent/leaf/cpu.max";
    values["/sys/fs/cgroup/parent/memory.current"] = "9800";
    const snapshot = await h.collector.snapshot();
    expect(snapshot.cpuLimit).toMatchObject({ status: "stale", reason: "permission-denied", ageMs: 5000 });
    expect(snapshot.memoryLimit).toMatchObject({ status: "available", ageMs: 0, value: { headroomBytes: 200 } });
    expect(snapshot.warnings).toContainEqual(
      expect.objectContaining({ code: "memory-pressure", metric: "memoryLimit" }),
    );
  });
  it.each(["/proc/self/cgroup", "/proc/self/mountinfo"])(
    "fails both metrics closed when discovery %s is denied",
    async (path) => {
      const read = vi.fn(fixtureRead(files(), path));
      const h = harness();
      h.sources.cgroup = () => readCgroup(read);
      const snapshot = await h.collector.snapshot();
      for (const key of ["cpuLimit", "memoryLimit"] as const)
        expect(snapshot[key]).toEqual({
          status: "permission-denied",
          reason: "permission-denied",
          source: "linux-cgroup-v2",
        });
      expect(read.mock.calls.every(([file]) => file.startsWith("/proc/self/"))).toBe(true);
    },
  );
  it("accepts independently absent root CPU controls without losing namespace-root memory limits", async () => {
    const values: Record<string, string> = files();
    values["/sys/fs/cgroup/memory.max"] = "10000";
    values["/sys/fs/cgroup/memory.current"] = "9900";
    const result = await readCgroup(fixtureRead(values));
    expect(result.cpu).toMatchObject({ ok: true, value: { effectiveCores: 1.5 } });
    expect(result.memory).toMatchObject({ ok: true, value: { headroomBytes: 100 } });
  });
  it("refuses incomplete root memory controls without suppressing readable CPU limits", async () => {
    const values: Record<string, string> = files();
    values["/sys/fs/cgroup/cpu.max"] = "50000 100000";
    values["/sys/fs/cgroup/memory.max"] = "10000";
    const result = await readCgroup(fixtureRead(values));
    expect(result.cpu).toMatchObject({ ok: true, value: { effectiveCores: 0.5 } });
    expect(result.memory).toEqual({ ok: false, reason: "scope-unverified" });
  });
  it("uses ancestor quota and sibling consumption without treating the leaf as the machine", async () => {
    const values: Record<string, string> = files();
    const paths: string[] = [];
    const result = await readCgroup(async (path) => {
      paths.push(path);
      if (values[path] === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return values[path];
    });
    expect(result.cpu).toMatchObject({ ok: true, value: { effectiveCores: 1.5, quotaCores: 1.5, cpusetCores: 2 } });
    expect(result.memory).toMatchObject({
      ok: true,
      value: { limitBytes: 8000, currentBytes: 1000, headroomBytes: 500 },
    });
    expect(paths).toHaveLength(14);
  });
  it("includes limits exposed at a namespace root", async () => {
    const values: Record<string, string> = files();
    values["/sys/fs/cgroup/cpu.max"] = "50000 100000";
    values["/sys/fs/cgroup/memory.max"] = "10000";
    values["/sys/fs/cgroup/memory.current"] = "9900";
    const s = await readCgroup(async (path) => values[path]!);
    expect(s.cpu).toMatchObject({ ok: true, value: { effectiveCores: 0.5 } });
    expect(s.memory).toMatchObject({ ok: true, value: { headroomBytes: 100 } });
  });
  it.each(["0::/", "0::/../secret", "0::/a/b/c/d/e/f/g/h/i", "2:memory:/parent/leaf"])(
    "fails closed on hidden, escaped, too-deep or v1 membership %s",
    async (membership) => {
      const values: Record<string, string> = files();
      values["/proc/self/cgroup"] = membership;
      await expect(readCgroup(async (path) => values[path]!)).rejects.toThrow(/scope-unverified|unsupported-source/);
    },
  );
  it("marks subtree mounts unverified instead of claiming unlimited resources", async () => {
    const values: Record<string, string> = files();
    values["/proc/self/mountinfo"] = "1 0 0:1 /hidden /sys/fs/cgroup rw - cgroup2 cgroup rw";
    await expect(readCgroup(async (path) => values[path]!)).rejects.toThrow("scope-unverified");
  });
});
