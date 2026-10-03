/** Synthetic protected stores through compiled public exports; no private instrumentation. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { unionMs } from "./model.js";

const [action, source, directory, dimensions, cache, seedText] = process.argv.slice(2);
const spec = JSON.parse(dimensions);
const seed = Number(seedText);
const { FileExecutionStore, JsonlEventStore, ProtectedEventStore, executionEvents } = await import(
  pathToFileURL(join(source, "packages/store/dist/index.js"))
);
const { reduceRun } = await import(pathToFileURL(join(source, "packages/core/dist/index.js")));
const secret = `synthetic-canary-${seed}`;
const blob = "x".repeat(spec.payloadBytes);
const clock = { now: () => Date.UTC(2026, 0, 1), isoNow: () => "2026-01-01T00:00:00.000Z" };
const execution = new FileExecutionStore(directory);
const publicEvents = new JsonlEventStore(directory, clock);
const events = new ProtectedEventStore(publicEvents, execution);
const runId = (index) => `synthetic-${seed}-${index}`;
const update = (index, value) => ({
  runId: runId(index),
  type: "vars.set",
  payload: { vars: { secret, value, blob } },
});

async function generate() {
  for (let index = 0; index < spec.runs; index++) {
    await execution.putInputs({
      runId: runId(index),
      workflowId: "synthetic",
      workflowVersion: "1",
      vars: { secret },
      sensitiveNames: ["secret"],
      secrets: [secret],
    });
    for (let overlay = 0; overlay < spec.overlays; overlay++)
      await execution.addSensitivity(runId(index), { sensitiveNames: ["late"], secrets: [`late-${seed}-${overlay}`] });
    await events.append({
      runId: runId(index),
      type: "run.created",
      payload: {
        workflowId: "synthetic",
        workflowVersion: "1",
        vars: { secret },
        workspace: { hostId: "synthetic", cwd: "/synthetic" },
      },
    });
    for (let value = 1; value < spec.history; value++) await events.append(update(index, value));
  }
  for (let index = 0; index < spec.catalog; index++)
    await execution.putGeneration(`unrelated-${seed}-${index}`, { synthetic: true, index, blob });
  await writeFile(join(directory, "fixture.json"), JSON.stringify({ spec, seed }), { flag: "wx", mode: 0o600 });
  return {
    runs: spec.runs,
    events: spec.runs * spec.history,
    privateRecords: spec.runs * (spec.history + 1 + spec.overlays) + spec.catalog,
  };
}

async function measure() {
  assert.deepEqual(JSON.parse(await readFile(join(directory, "fixture.json"), "utf8")), { spec, seed });
  let intervals = [];
  async function timed(label, fn) {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      intervals.push({ label, start, end: performance.now() });
    }
  }
  async function reader() {
    const ids = await timed("run-list", () => events.listRuns());
    assert.equal(ids.length, spec.runs);
    // Full inventory is deliberate: no claim this is the daemon's bounded runs.list API.
    for (const id of ids.sort()) {
      const inputs = await timed("input-read", () => execution.getInputs(id));
      assert.equal(inputs.vars.secret, secret);
      const page = await timed("public-tail", () =>
        events.readRange(id, { before: Number.MAX_SAFE_INTEGER, limit: 8 }),
      );
      assert.equal(page.length, Math.min(8, spec.history));
      const history = await timed("public-history", () => events.read(id));
      assert.equal(history.length, spec.history);
      assert.equal(JSON.stringify(history).includes(secret), false);
      const replay = await timed("replay-restore", () => executionEvents(history, execution));
      const state = await timed("reduce", () => reduceRun(replay));
      assert.equal(state.run.vars.secret, secret);
      assert.equal(state.run.vars.value, spec.history - 1);
      assert.equal(state.lastSeq, spec.history - 1);
    }
  }
  if (cache === "warm") await Promise.all(Array.from({ length: spec.readers }, reader));
  intervals = [];
  const start = performance.now();
  await Promise.all(Array.from({ length: spec.readers }, reader));
  const readWallMs = performance.now() - start;
  // Read-only warmup does not prewarm this append. Report it separately from read cache mode.
  await timed("protected-append", () => events.append(update(0, spec.history)));
  const wallMs = performance.now() - start;
  const labels = [...new Set(intervals.map((item) => item.label))];
  const operations = Object.fromEntries(
    labels.map((label) => {
      const matches = intervals.filter((item) => item.label === label);
      return [label, { count: matches.length, unionMs: unionMs(matches.map((item) => [item.start, item.end])) }];
    }),
  );
  // Oracle outside timed intervals: publication is visible, authenticated, reducible and redacted.
  const after = await events.read(runId(0));
  assert.equal(after.length, spec.history + 1);
  assert.equal(JSON.stringify(after).includes(secret), false);
  assert.equal(reduceRun(await executionEvents(after, execution)).run.vars.value, spec.history);
  return {
    wallMs,
    readWallMs,
    operationUnionMs: unionMs(intervals.map((item) => [item.start, item.end])),
    operations,
    maxRssKiB: process.resourceUsage().maxRSS,
    oracle: "passed",
  };
}

try {
  assert.ok(["generate", "measure"].includes(action));
  console.log(JSON.stringify(action === "generate" ? await generate() : await measure()));
} catch (error) {
  // Do not emit keys, plaintext payloads, assertions with actual values or full stacks.
  console.log(JSON.stringify({ error: error.code ?? error.name ?? "worker-failed" }));
  process.exitCode = 1;
}
