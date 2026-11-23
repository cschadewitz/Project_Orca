/**
 * Self-test for the store workload benchmark (#341): the smoke shape runs end to end on the
 * memory, file and SQLite (#339) backends through the package sources, every workload invariant
 * holds, and an unavailable backend is reported as skipped rather than silently dropped.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as core from "@orca/core";
import * as store from "@orca/store";
import { backends } from "../benchmarks/store-workloads/backends.js";
import { allChecks, REPORT_SCHEMA_VERSION, runBenchmark } from "../benchmarks/store-workloads/harness.js";
import { SCALES } from "../benchmarks/store-workloads/scales.js";
import { LOAD_PHASES, startReaders } from "../benchmarks/store-workloads/workloads.js";
import { summarize as summarizeReport } from "../benchmarks/store-workloads/summarize.js";
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
        [
          "concurrentMetadataWrites",
          "dependencyTraversal",
          "paginatedHistory",
          "projectionRebuild",
          "walCheckpoint",
          "walUnderLoad",
        ].sort(),
      );
      expect(result.seeding.history.events).toBe(SCALES.smoke.runs * SCALES.smoke.eventsPerRun);
      expect(result.workloads.concurrentMetadataWrites.levels.map((l) => l.writers)).toEqual(SCALES.smoke.concurrency);
      expect(result.workloads.paginatedHistory.warm.forwardPages.n).toBeGreaterThan(0);
    }
    // Only SQLite has a write-ahead log; the others say so instead of reporting zeros.
    const wal = report.results.find((r) => r.backend === "sqlite").workloads.walCheckpoint;
    expect(wal.appends).toBe(SCALES.smoke.checkpointBurst - 1);
    expect(Object.keys(wal.checks).sort()).toEqual(["everyAppendCommitted", "truncateEmptiedLog"].sort());
    expect(wal.walBytes.afterTruncate).toBe(0);
    // Under load: every phase ran from an empty log, with its readers, and lost nothing.
    const load = report.results.find((r) => r.backend === "sqlite").workloads.walUnderLoad;
    for (const { name, readers } of LOAD_PHASES) {
      const phase = load[name];
      expect(phase.startedFromEmptyLog).toBe(true);
      expect(phase.appends).toBeGreaterThan(0);
      expect(phase.inProcessReads.n).toBeGreaterThan(0);
      expect(phase.readers).toHaveLength(readers.length);
      for (const reader of phase.readers) {
        expect(reader.reads).toBeGreaterThan(0);
        expect(reader.snapshotShare).toBeGreaterThan(0);
      }
      expect(phase.afterLoad.fullyCheckpointed).toBe(true);
      expect(phase.walBytes.samples.length).toBeLessThanOrEqual(40);
      expect(Object.values(phase.checks).every(Boolean)).toBe(true);
    }
    // The store's own idle checkpoint ran after the burst, and reported what it copied.
    expect(wal.idleCheckpoints.length).toBeGreaterThan(0);
    expect(wal.idleCheckpoints.every((c) => c.busy === false && c.checkpointedPages === c.logPages)).toBe(true);
    // The CI job summary: one column per backend that ran, a row per headline, a line per skip.
    const md = summarizeReport(report);
    expect(md).toContain("### Store workloads: smoke");
    expect(md).toContain("| | memory | file | sqlite |");
    expect(md).toMatch(/\| Checks \| pass \| pass \| pass \|/);
    expect(md).toContain("- absent: skipped (not built here)");
    expect(md).not.toContain("undefined");
    // Memory has no cold reads: its cold cell says so rather than borrowing the warm figure.
    expect(md).toMatch(/\| History tail page p95 \(cold\) \| no cold state \| [\d.]+ ms \| [\d.]+ ms \|/);
    for (const plain of ["memory", "file"])
      for (const w of ["walCheckpoint", "walUnderLoad"])
        expect(report.results.find((r) => r.backend === plain).workloads[w]).toMatchObject({
          skipped: "no write-ahead log on this backend",
        });
    expect(md).toMatch(
      /\| Under load, pinnedSnapshot \(appends\/s, max, log peak\) \| no log \| no log \| [\d,]+, [\d.]+ ms, [\d.]+ MB \|/,
    );
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

  describe("outside readers", () => {
    const seeded = async () => {
      const dir = await mkdtemp(join(scratch, "readers-"));
      const stores = store.sqliteStores(dir);
      await stores.events.append({
        type: "run.created",
        runId: "r",
        payload: { workflowId: "w", workflowVersion: "1", workspace: { hostId: "local", cwd: "/" }, vars: {} },
      });
      return { file: join(dir, store.SQLITE_METADATA_FILE), close: () => stores.close() };
    };

    it("start reading before the load and report how much of their time they held a snapshot", async () => {
      const { file, close } = await seeded();
      const readers = startReaders([{ holdMs: 20, gapMs: 0 }], { file, runIds: ["r"], pageSize: 10 });
      try {
        await readers.ready();
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        const [result] = await readers.stop();
        expect(result).toMatchObject({ holdMs: 20, errors: 0, ordered: true });
        expect(result.failed).toBeUndefined();
        expect(result.reads).toBeGreaterThan(0);
        expect(result.snapshotShare).toBeGreaterThan(0.5);
        close();
      }
    });

    it("record a reader that fails to start, and still stop the others", async () => {
      const { file, close } = await seeded();
      const readers = startReaders(
        [
          { holdMs: 0, gapMs: 10 },
          { holdMs: 0, gapMs: 10 },
        ],
        { file: join(scratch, "absent", "dir", "x.sqlite"), runIds: ["r"], pageSize: 10 },
      );
      await expect(readers.ready()).rejects.toThrow("an outside reader did not start");
      const results = await readers.stop();
      expect(results).toHaveLength(2);
      for (const r of results) expect(r.failed).toBeTruthy();
      // stop() is idempotent: the same results, no second stop.
      expect(await readers.stop()).toBe(results);
      close();
      void file;
    });

    it("do not leave a partly started set running when a later reader cannot be created", async () => {
      const { file, close } = await seeded();
      const terminate = vi.spyOn(Worker.prototype, "terminate");
      // The second reader's settings cannot be sent to a thread, so its Worker never starts.
      expect(() =>
        startReaders(
          [
            { holdMs: 0, gapMs: 10 },
            { holdMs: () => 0, gapMs: 0 },
          ],
          { file, runIds: ["r"], pageSize: 10 },
        ),
      ).toThrow();
      // The first one, already started, was terminated rather than left reading.
      expect(terminate).toHaveBeenCalledTimes(1);
      terminate.mockRestore();
      close();
    });

    it("terminate a reader that does not stop within the deadline", async () => {
      const { file, close } = await seeded();
      // Holds each snapshot a minute: it cannot see the stop signal in time.
      const readers = startReaders([{ holdMs: 60_000, gapMs: 0 }], { file, runIds: ["r"], pageSize: 10 }, 300);
      await readers.ready();
      await new Promise((resolve) => setTimeout(resolve, 100)); // Inside its first snapshot.
      const started = performance.now();
      const [result] = await readers.stop();
      expect(result.failed).toBe("did not stop within 300 ms; terminated");
      expect(performance.now() - started).toBeLessThan(5_000);
      close();
    });
  });
});
