/**
 * Self-test for the store workload benchmark (#341): the smoke shape runs end to end on the
 * memory and file backends through the package sources, every workload invariant holds, and an
 * unavailable backend is reported as skipped rather than silently dropped.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as core from "@orca/core";
import * as store from "@orca/store";
import { allChecks, REPORT_SCHEMA_VERSION, runBenchmark } from "../benchmarks/store-workloads/harness.js";
import { SCALES } from "../benchmarks/store-workloads/scales.js";
import { prng, summarize } from "../benchmarks/store-workloads/stats.js";

const scratch = await mkdtemp(join(tmpdir(), "orca-store-bench-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe("store workload benchmark", () => {
  it("runs every workload at the smoke shape on memory and file, with all invariants holding", async () => {
    const report = await runBenchmark({
      api: { store, core },
      scale: "smoke",
      backends: ["memory", "file", "sqlite"],
      repeat: 1,
      scratch,
    });
    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.results.map((r) => [r.backend, r.status])).toEqual([
      ["memory", "ran"],
      ["file", "ran"],
      ["sqlite", "skipped"],
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
    const file = report.results.find((r) => r.backend === "file");
    expect(file.storeBytes).toBeGreaterThan(0);
    expect(file.workloads.dependencyTraversal.cold.n).toBe(SCALES.smoke.traversalSamples);
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
