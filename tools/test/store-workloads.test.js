/**
 * Self-test for the store workload benchmark (#341): the smoke shape runs end to end on the
 * memory, file and SQLite (#339) backends through the package sources, every workload invariant
 * holds, and an unavailable backend is reported as skipped rather than silently dropped.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as core from "@orca/core";
import * as store from "@orca/store";
import { backends } from "../benchmarks/store-workloads/backends.js";
import { allChecks, REPORT_SCHEMA_VERSION, runBenchmark } from "../benchmarks/store-workloads/harness.js";
import { SCALES } from "../benchmarks/store-workloads/scales.js";
import { prng, summarize } from "../benchmarks/store-workloads/stats.js";

const scratch = await mkdtemp(join(tmpdir(), "orca-store-bench-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe("store workload benchmark", () => {
  it("runs every workload at the smoke shape on memory, file and sqlite, with all invariants holding", async () => {
    const report = await runBenchmark({
      api: { store, core },
      scale: "smoke",
      backends: ["memory", "file", "sqlite", "absent"],
      extraBackends: { absent: { name: "absent", durable: true, unavailable: "not built here" } },
      repeat: 1,
      scratch,
    });
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.results.map((r) => [r.backend, r.status])).toEqual([
      ["memory", "ran"],
      ["file", "ran"],
      ["sqlite", "ran"],
      ["absent", "skipped"],
    ]);
    for (const result of report.results.filter((r) => r.status === "ran")) {
      expect(result.checksPassed).toBe(true);
      expect(Object.keys(result.workloads).sort()).toEqual(
        ["concurrentMetadataWrites", "dependencyTraversal", "paginatedHistory", "projectionRebuild"].sort(),
      );
      expect(result.seeding.history.events).toBe(SCALES.smoke.runs * SCALES.smoke.eventsPerRun);
      expect(result.workloads.concurrentMetadataWrites.levels.map((l) => l.writers)).toEqual(SCALES.smoke.concurrency);
      expect(result.workloads.paginatedHistory.warm.forwardPages.n).toBeGreaterThan(0);
    }
    for (const durable of ["file", "sqlite"]) {
      const result = report.results.find((r) => r.backend === durable);
      expect(result.storeBytes).toBeGreaterThan(0);
      expect(result.workloads.dependencyTraversal.cold.n).toBe(SCALES.smoke.traversalSamples);
    }
  });

  it("fails the write workload for a backend that does not commit, and counts only committed throughput", async () => {
    const real = backends({ store, core }).memory;
    /** Wrap the metadata collections; everything else is the real memory backend. */
    const faulty = (name, wrap) => ({
      name,
      durable: false,
      async create(dir) {
        const inner = await real.create(dir);
        return {
          ...inner,
          collection: (n) => (n.startsWith("bench-metadata-") ? wrap(inner.collection(n)) : inner.collection(n)),
        };
      },
    });
    // Acknowledges every write and keeps none of them: it must not look correct.
    const silent = faulty("silent", (c) => ({
      ...c,
      getVersioned: c.getVersioned.bind(c),
      putMany: c.putMany.bind(c),
      list: c.list.bind(c),
      query: c.query.bind(c),
      deleteIfVersion: c.deleteIfVersion.bind(c),
      get: c.get.bind(c),
      delete: c.delete.bind(c),
      put: async () => {},
      putIfVersion: async () => ({ ok: true, version: "v" }),
    }));
    // Every write fails.
    const failing = faulty("failing", (c) => ({
      ...c,
      getVersioned: c.getVersioned.bind(c),
      putMany: c.putMany.bind(c),
      list: c.list.bind(c),
      query: c.query.bind(c),
      deleteIfVersion: c.deleteIfVersion.bind(c),
      get: c.get.bind(c),
      delete: c.delete.bind(c),
      put: async () => {
        throw Object.assign(new Error("disk full"), { code: "STORE_WRITE" });
      },
      putIfVersion: async () => ({ ok: false, current: undefined }),
    }));
    const report = await runBenchmark({
      api: { store, core },
      scale: "smoke",
      backends: ["silent", "failing"],
      workloads: ["concurrentMetadataWrites"],
      extraBackends: { silent, failing },
      repeat: 1,
      scratch,
    });
    const [silentResult, failingResult] = report.results;
    expect(silentResult.checksPassed).toBe(false);
    for (const level of silentResult.workloads.concurrentMetadataWrites.levels) {
      expect(level.checks.hotCountersRoseByIntendedIncrements).toBe(false);
      expect(level.checks.everyIntendedUnconditionalWritePresent).toBe(false);
    }
    expect(failingResult.checksPassed).toBe(false);
    for (const level of failingResult.workloads.concurrentMetadataWrites.levels) {
      expect(level.succeededOps).toBe(0);
      expect(level.succeededOpsPerSecond).toBe(0);
      expect(level.attemptedOpsPerSecond).toBeGreaterThan(0);
      expect(level.errorCodes).toEqual({ STORE_WRITE: level.attemptedOps / 2 });
      expect(level.cas.retriesExhausted).toBe(level.cas.intended);
      expect(level.checks.everyIntendedOperationCommitted).toBe(false);
    }
  });

  it("gives the same operation plan at every writer level on every run", async () => {
    const first = await runBenchmark({
      api: { store, core },
      scale: "smoke",
      backends: ["file"],
      workloads: ["concurrentMetadataWrites"],
      repeat: 1,
      scratch,
    });
    const second = await runBenchmark({
      api: { store, core },
      scale: "smoke",
      backends: ["file"],
      workloads: ["concurrentMetadataWrites"],
      repeat: 1,
      scratch,
    });
    const shape = (r) =>
      r.results[0].workloads.concurrentMetadataWrites.levels.map((l) => [l.writers, l.attemptedOps, l.cas.intended]);
    expect(shape(first)).toEqual(shape(second));
    expect(first.results[0].checksPassed).toBe(true);
  });

  it("refuses unknown scales, backends and workloads", async () => {
    const api = { store, core };
    await expect(runBenchmark({ api, scale: "huge", scratch })).rejects.toThrow("unknown scale");
    await expect(runBenchmark({ api, scale: "smoke", backends: ["nope"], scratch })).rejects.toThrow("unknown backend");
    await expect(runBenchmark({ api, scale: "smoke", workloads: ["nope"], scratch })).rejects.toThrow(
      "unknown workload",
    );
  });

  it("finds a failed invariant anywhere in a result", () => {
    expect(allChecks({ a: { levels: [{ checks: { ok: true } }] } })).toBe(true);
    expect(allChecks({ a: { levels: [{ checks: { ok: true } }, { checks: { lost: false } }] } })).toBe(false);
  });

  it("summarizes with nearest-rank percentiles and seeds deterministically", () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect([s.n, s.min, s.p50, s.p95, s.max]).toEqual([100, 1, 50, 95, 100]);
    expect(summarize([])).toEqual({ n: 0 });
    const a = prng(7);
    const b = prng(7);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
  });
});
