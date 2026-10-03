/** Harness oracles: plans, overlap arithmetic, failure accounting and compiled fixture round trips. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LIMITS, plan, rotate, stats, summarize, unionMs } from "./model.js";
import { supervise, usage } from "./supervisor.js";

test("supervisor retains timeout/output failures and refuses exhausted suites and disk bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "orca-supervisor-selftest-"));
  const run = (code, limits = {}) =>
    supervise(["-e", code], {
      cwd: root,
      root,
      started: performance.now(),
      limits: { ...LIMITS, ...limits },
    });
  try {
    assert.equal((await run("setInterval(() => {}, 1000)", { childMs: 100 })).reason, "timeout");
    assert.equal((await run("console.log('x'.repeat(10000))", { outputBytes: 100 })).reason, "output-limit");
    assert.equal((await run("process.exit(1)")).status, "failed");
    assert.equal((await run("process.exit(0)", { suiteMs: 0 })).status, "unrun");
    await writeFile(join(root, "fixture"), "synthetic");
    await assert.rejects(usage(root, { ...LIMITS, maxFiles: 0 }), /disk-or-file-limit/);
    await assert.rejects(usage(root, { ...LIMITS, diskBytes: 1 }), /disk-or-file-limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent axes and combined fixture stay within fixed bounds", () => {
  for (const profile of ["smoke", "baseline"]) {
    const cases = plan(profile);
    assert.equal(new Set(cases.map((row) => row.id)).size, 13);
    for (const axis of ["history", "runs", "catalog", "readers"]) {
      const rows = cases.filter((row) => row.id.startsWith(`${axis}-`));
      const fixed = ({ id: _id, [axis]: _value, ...rest }) => rest;
      assert.equal(rows.length, 3);
      assert.deepEqual(fixed(rows[0]), fixed(rows[2]));
    }
    const files = cases.reduce((sum, row) => sum + row.runs * (row.history + row.overlays + 2) + row.catalog + 2, 0);
    assert.ok(files * 2 < LIMITS.maxFiles);
  }
  assert.throws(() => plan("unbounded"));
});

test("rotations pair both cache orders and preserve all cases", () => {
  assert.deepEqual(rotate(["cold", "warm"], 0), ["cold", "warm"]);
  assert.deepEqual(rotate(["cold", "warm"], 1), ["warm", "cold"]);
  assert.deepEqual(rotate([1, 2, 3], 5), [3, 1, 2]);
});

test("interval union never double counts nested or concurrent calls", () => {
  assert.equal(
    unionMs([
      [0, 10],
      [2, 4],
      [8, 15],
      [20, 22],
    ]),
    17,
  );
  assert.equal(unionMs([]), 0);
  assert.equal(
    unionMs([
      [4, 5],
      [0, 4],
    ]),
    5,
  );
  assert.throws(() => unionMs([[2, 1]]));
  assert.deepEqual(stats([5, 1, 3]), { n: 3, median: 3, min: 1, max: 5, spread: 4 });
  assert.equal(stats([1, 3]).median, 2);
});

test("failed and unrun samples remain visible and never enter successful medians", () => {
  const row = { case: { id: "test" }, cache: "warm" };
  const result = summarize([
    { ...row, status: "passed", result: { wallMs: 10, operations: { read: { unionMs: 8, count: 2 } } } },
    { ...row, status: "failed" },
    { ...row, status: "unrun" },
  ])[0];
  assert.deepEqual(result.outcomes, ["passed", "failed", "unrun"]);
  assert.equal(result.wallMs.n, 1);
  assert.deepEqual(result.operations.read.counts, [2]);
  assert.equal(summarize([{ ...row, status: "blocked" }])[0].wallMs, null);
});

test(
  "compiled workers create protected fixtures and validate fresh and warm concurrent readers",
  { timeout: 20_000 },
  async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = resolve(here, "../../..");
    const root = await mkdtemp(join(tmpdir(), "orca-benchmark-selftest-"));
    const spec = { ...plan("smoke")[0], readers: 2, runs: 2 };
    const worker = (action, cache) => {
      const result = spawnSync(
        process.execPath,
        [join(here, "worker.js"), action, source, root, JSON.stringify(spec), cache, "423"],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(result.status, 0, result.error?.message ?? result.stdout);
      return JSON.parse(result.stdout);
    };
    try {
      assert.equal(worker("generate", "process-cold").events, 16);
      const result = worker("measure", "warm");
      assert.equal(result.operations["replay-restore"].count, 4);
      assert.equal(result.operations["protected-append"].count, 1);
      assert.ok(result.operationUnionMs <= result.wallMs);
      assert.equal(result.oracle, "passed");
      // A reused/mutated fixture must fail the history-length oracle rather than supply a timing pass.
      assert.throws(() => worker("measure", "process-cold"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
