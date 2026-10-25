/** Fixed requested history with independently growing unrelated, genuinely encrypted records. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { installProbe } from "./probe.js";

const [action, source, root, dimensions, cache, observed] = process.argv.slice(2);
const spec = JSON.parse(dimensions);
const probe = observed === "counts" ? installProbe() : undefined;
const { FileExecutionStore, JsonlEventStore, ProtectedEventStore, executionEvents } = await import(
  pathToFileURL(join(source, "packages/store/dist/index.js"))
);
const execution = new FileExecutionStore(root);
const publicEvents = new JsonlEventStore(root, { now: () => 0, isoNow: () => "2026-01-01T00:00:00.000Z" });
const events = new ProtectedEventStore(publicEvents, execution);
const runId = "synthetic-target";
const secret = "synthetic-c3-canary";
const vars = (value) => ({ secret, value, blob: "x".repeat(256) });
const update = (id, value) => ({ runId: id, type: "vars.set", payload: { vars: vars(value) } });
const created = (id) => ({
  runId: id,
  type: "run.created",
  payload: {
    workflowId: "synthetic",
    workflowVersion: "1",
    vars: vars(0),
    workspace: { hostId: "synthetic", cwd: "/synthetic" },
  },
});

async function generate() {
  await execution.putInputs({
    runId,
    workflowId: "synthetic",
    workflowVersion: "1",
    vars: vars(0),
    sensitiveNames: ["secret"],
    secrets: [secret],
  });
  await execution.addSensitivity(runId, { sensitiveNames: ["late"], secrets: ["synthetic-late-canary"] });
  await events.append(created(runId));
  await events.append(created("synthetic-public"));
  for (let value = 1; value < spec.history; value++) await events.append(update(runId, value));
  for (let index = 0; index < spec.catalog; index++)
    await execution.putGeneration(`unrelated-${index}`, { synthetic: true, index, blob: "x".repeat(256) });
  await writeFile(join(root, "fixture.json"), JSON.stringify(spec), { flag: "wx", mode: 0o600 });
  return { oracle: "passed", privateRecords: spec.history + 2 + spec.catalog };
}

async function measure() {
  assert.deepEqual(JSON.parse(await readFile(join(root, "fixture.json"), "utf8")), spec);
  // Fetch public references without the protected facade, outside all timed/counted intervals.
  const history = await publicEvents.read(runId);
  const readers = {
    "input-read": () => execution.getInputs(runId),
    "public-history": () => events.read(runId),
    "public-types": () => events.readTypes(runId, ["vars.set"]),
    "public-tail": () => events.readRange(runId, { before: Number.MAX_SAFE_INTEGER, limit: 2 }),
    "replay-restore": () => executionEvents(history, execution),
    "inputs-concurrent-4": () => Promise.all(Array.from({ length: 4 }, () => execution.getInputs(runId))),
  };
  if (cache === "warm") for (const read of Object.values(readers)) await read();
  const operations = {};
  const outputs = {};
  for (const [label, work] of Object.entries({
    ...readers,
    "public-append": () => events.append(update("synthetic-public", spec.history)),
    "protected-append": () => events.append(update(runId, spec.history)),
  })) {
    probe?.begin();
    const start = performance.now();
    outputs[label] = await work();
    const wallMs = performance.now() - start;
    operations[label] = { wallMs, ...(probe ? { metrics: probe.end() } : {}) };
  }
  // Full positive oracles outside timing: exact history, fresh sensitivity, private/public separation.
  assert.equal(history.length, spec.history);
  assert.deepEqual(outputs["input-read"].sensitiveNames, ["secret", "late"]);
  assert.equal(outputs["input-read"].sensitivityRefs.length, 1);
  for (const input of outputs["inputs-concurrent-4"]) assert.deepEqual(input, outputs["input-read"]);
  assert.equal(outputs["public-history"].length, spec.history);
  assert.equal(outputs["public-types"].length, spec.history - 1);
  assert.deepEqual(
    outputs["public-tail"].map((event) => event.seq),
    [spec.history - 2, spec.history - 1],
  );
  for (const [seq, event] of outputs["replay-restore"].entries()) {
    assert.equal(event.seq, seq);
    assert.equal(event.runId, runId);
    assert.equal(event.type, seq === 0 ? "run.created" : "vars.set");
    assert.deepEqual(event.payload.vars, vars(seq));
  }
  for (const label of ["public-history", "public-types", "public-tail", "protected-append"])
    assert.equal(JSON.stringify(outputs[label]).includes(secret), false);
  assert.equal(outputs["public-append"].executionPayloadRef, undefined);
  assert.ok(outputs["protected-append"].executionPayloadRef);
  const after = await executionEvents(await events.read(runId), execution);
  assert.equal(after.length, spec.history + 1);
  assert.deepEqual(after.at(-1).payload.vars, vars(spec.history));
  if (probe) {
    // These are operation-count regression oracles, independent of noisy timing.
    const expectedListings = {
      "input-read": 1,
      "public-history": 1,
      "public-types": 1,
      "public-tail": 1,
      "replay-restore": 1,
      "inputs-concurrent-4": 4,
      "public-append": 1,
      "protected-append": 4,
    };
    for (const [label, count] of Object.entries(expectedListings)) {
      const metrics = operations[label].metrics;
      assert.equal(metrics["fs.readdir.catalog"].count, count);
      assert.equal(metrics["fs.readdir.catalog"].entries, count * (spec.catalog + spec.history + 3));
    }
    assert.equal(operations["protected-append"].metrics["crypto.decrypt.create"].count, 8);
    assert.equal(operations["protected-append"].metrics["handle.readFile.key"].count, 8);
    assert.equal(operations["replay-restore"].metrics["crypto.decrypt.create"].count, spec.history + 2);
    assert.equal(operations["replay-restore"].metrics["handle.readFile.key"].count, 4);
    assert.equal(operations["public-append"].metrics["crypto.decrypt.create"], undefined);
  }
  return { oracle: "passed", operations, maxRssKiB: process.resourceUsage().maxRSS };
}

try {
  assert.ok(["generate", "measure"].includes(action));
  assert.ok(Number.isInteger(spec.catalog) && spec.catalog >= 0 && spec.catalog <= 1024);
  assert.equal(spec.history, 8);
  assert.ok(["off", "counts"].includes(observed));
  console.log(JSON.stringify(action === "generate" ? await generate() : await measure()));
} catch {
  // Assertion messages may contain protected values. No raw exception crosses the child boundary.
  console.log(JSON.stringify({ error: "catalog-worker-failed" }));
  process.exitCode = 1;
} finally {
  probe?.restore();
}
