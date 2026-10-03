/** Serial synthetic benchmark for PR #441; never imports app startup or live producers. */
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PretriggerBuffer } from "../../packages/app/dist/main/diagnostics/pretrigger-buffer.js";
import { DIAGNOSTIC_CODES, DIAGNOSTIC_LIMITS } from "../../packages/app/dist/main/diagnostics/profile.js";
import {
  canonicalJson,
  diagnosticReport,
  DIAGNOSTIC_ENVELOPE_BYTES,
  eventReservation,
} from "../../packages/app/dist/main/diagnostics/snapshot.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = "97097ea076044555b401d49b8e75da8cc1e42df9";
const MiB = 1024 * 1024;
const ceilings = { rss: 384 * MiB, heapUsed: 192 * MiB, hostAvailable: 512 * MiB, cgroupAvailable: 256 * MiB };
const scenarios = ["low", "typical", "high", "bursty"];
const pairs = Object.entries(DIAGNOSTIC_CODES).flatMap(([phase, codes]) => codes.map((code) => [phase, code]));
const largest = pairs.reduce((a, b) => (eventReservation(...a) >= eventReservation(...b) ? a : b));
const mix = [
  ["lifecycle", "app_started"],
  ["connection", "connection_lost"],
  ["admission", "admission_uncertain"],
  ["resume", "resume_failed"],
  ["protected_state", "protected_state_unavailable"],
  ["run", "run_failed"],
];
const clock = () => performance.now();
const elapsed = (start) => clock() - start;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}
function maybeRead(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

// Check every visible cgroup-v2 ancestor, including the session's own memory boundary.
function pressure() {
  const available = /MemAvailable:\s+(\d+)/.exec(maybeRead("/proc/meminfo") ?? "");
  const hostAvailable = available ? Number(available[1]) * 1024 : freemem();
  const group = maybeRead("/proc/self/cgroup")
    ?.split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  let cgroupAvailable = null;
  let cgroupLimit = null;
  if (group !== undefined) {
    let path = join("/sys/fs/cgroup", group);
    while (path.startsWith("/sys/fs/cgroup")) {
      const max = maybeRead(join(path, "memory.max"));
      const current = maybeRead(join(path, "memory.current"));
      if (max && max !== "max" && current) {
        cgroupAvailable = Math.min(cgroupAvailable ?? Infinity, Number(max) - Number(current));
        cgroupLimit = Math.min(cgroupLimit ?? Infinity, Number(max));
      }
      if (path === "/sys/fs/cgroup") break;
      path = dirname(path);
    }
  }
  return { hostAvailable, cgroupAvailable, cgroupLimit };
}
function guard() {
  const memory = process.memoryUsage();
  const p = pressure();
  assert(
    memory.rss < ceilings.rss &&
      memory.heapUsed < ceilings.heapUsed &&
      p.hostAvailable > ceilings.hostAvailable &&
      (p.cgroupAvailable === null || p.cgroupAvailable > ceilings.cgroupAvailable),
    "STOP: memory pressure; remaining workloads must not run",
  );
  return memory;
}
function gcMemory() {
  guard();
  global.gc();
  return guard();
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {
    count: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted.at(-1),
  };
}
function* schedule(name) {
  if (name === "low") {
    for (let at = 10_000; at <= 300_000; at += 10_000) yield at;
    return;
  }
  for (let second = 0; second < 300; second++) {
    const rate = name === "typical" ? 1 : name === "high" ? 10 : second % 60 < 10 ? 100 : 1;
    for (let index = 1; index <= rate; index++) yield second * 1000 + (index * 1000) / rate;
  }
}
function makeMaximumFixture() {
  // This is a schema stress fixture, NOT metadata accepted or produced by the buffer.
  const report = diagnosticReport(
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    { requestedWindowMs: 300_000, observedWindowMs: 300_000, retainedWindowMs: 0, capacityLimited: false },
    { budget: "at_least_65535", expired: "at_least_65535", invalid: "at_least_65535" },
    Array.from({ length: 4096 }, () => ({
      phase: largest[0],
      code: largest[1],
      offsetMs: 300_000,
      entityAlias: "unknown",
    })),
  );
  report.versions = {
    app: "99999.99999.99999",
    daemon: "99999.99999.99999",
    buildRevision: "f".repeat(40),
    appProtocol: { major: 65535, minor: 65535 },
    daemonProtocol: { major: 65535, minor: 65535 },
    storeFormat: "config-generations-v3",
    os: "unknown",
    osVersion: "99999.99999.99999",
    arch: "unknown",
  };
  report.entities = Array.from({ length: 64 }, (_, i) => ({ alias: `e${i + 1}`, kind: "admission" }));
  report.evidence.handshake = true;
  report.snapshot.connection = "disconnected";
  report.snapshot.authentication = "forbidden";
  report.snapshot.admission = "recoverable_failure";
  report.evidence.admissionObservation = true;
  // Keep longer "unknown" where a known enum would be shorter.
  report.omissions.unavailable = "at_least_65535";
  return report;
}
function exportProbe(json, directory) {
  guard();
  const start = clock();
  const bytes = Buffer.from(json, "utf8");
  const encodeMs = elapsed(start);
  const destination = join(directory, "synthetic.json");
  const beginWrite = clock();
  const fd = openSync(destination, "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const localWriteFsyncMs = elapsed(beginWrite);
  assert(readFileSync(destination).equals(bytes));
  guard();
  return { bytes, encodeMs, localWriteFsyncMs };
}
function runCase(name, payload, directory, measured) {
  let now = 0;
  const times = [...schedule(name)]; // Fixed <= 5,250 timestamps; allocated before memory baseline.
  const samples = new Float64Array(times.length);
  const baseline = gcMemory();
  const buffer = new PretriggerBuffer({ now: () => now });
  assert.equal(buffer.enabled, false);
  assert.equal(buffer.record(...largest), false);
  assert.equal(buffer.snapshot(), undefined);
  assert(buffer.start()); // Only this disposable synthetic instance, as in the existing unit suite.
  const checkpoints = [];
  let nextCheckpoint = 30_000;
  let sampledPeak = baseline;
  function sample() {
    const memory = guard();
    sampledPeak = Object.fromEntries(Object.keys(memory).map((key) => [key, Math.max(memory[key], sampledPeak[key])]));
    return memory;
  }
  try {
    for (let i = 0; i < times.length; i++) {
      now = times[i];
      const pair = payload === "maximum" ? largest : mix[i % mix.length];
      const start = clock();
      const accepted = buffer.record(...pair);
      samples[i] = elapsed(start) * 1000;
      assert(accepted);
      if (i % 128 === 0) sample();
      if (now >= nextCheckpoint) {
        checkpoints.push({ atMs: now, offered: i + 1, ...sample() });
        nextCheckpoint += 30_000;
      }
    }
    now = 300_000;
    const afterRecording = gcMemory();
    const snapshotsMs = [];
    // Repeated single snapshots are released; no unbounded preview accumulation.
    for (let i = 0; i < 5; i++) {
      guard();
      const start = clock();
      const snapshot = buffer.snapshot();
      snapshotsMs.push(elapsed(start));
      assert(snapshot && snapshot.byteLength <= DIAGNOSTIC_LIMITS.maxReportBytes);
      sample();
    }
    global.gc();
    const beginSnapshot = clock();
    const snapshot = buffer.snapshot();
    const snapshotMs = elapsed(beginSnapshot);
    sample();
    const beginParse = clock();
    const preview = JSON.parse(snapshot.json);
    const previewParseMs = elapsed(beginParse);
    sample();
    const exported = exportProbe(snapshot.json, directory);
    sample();
    const withPreviewAndExport = gcMemory();
    // Keep all three copies observably alive through the heap sample.
    assert.equal(exported.bytes.toString("utf8"), snapshot.json);
    assert.equal(preview.events.length, Math.min(times.length, 4096));
    assert.equal(preview.omissions.budget, Math.max(0, times.length - 4096));
    assert.equal(preview.omissions.expired, 0);
    assert.equal(preview.coverage.retainedWindowMs, 300_000 - times[Math.max(0, times.length - 4096)]);
    assert.deepEqual(
      preview.events.map((event) => event.offsetMs),
      times.slice(-4096),
    );
    assert.equal(snapshot.byteLength, exported.bytes.length);
    assert(Object.values(preview.versions).every((value) => value === "unknown"));
    now = 600_000; // All retained events reach or exceed the exact age boundary.
    const startExpiry = clock();
    assert(buffer.record(...largest));
    const expireOnRecordMs = elapsed(startExpiry);
    const expired = JSON.parse(buffer.snapshot().json);
    assert.equal(expired.events.length, 1);
    assert.equal(expired.omissions.expired, preview.events.length);
    assert.equal(expired.coverage.capacityLimited, false);
    assert.equal(snapshot.json, exported.bytes.toString("utf8"));
    buffer.stop();
    const afterStopWithPreview = gcMemory();
    // Preview ownership is deliberately visible: stop purges the ring, not caller copies.
    assert.equal(preview.events.length, Math.min(times.length, 4096));
    assert.equal(exported.bytes.length, snapshot.byteLength);
    assert.equal(buffer.enabled, false);
    return measured
      ? {
          scenario: name,
          payload,
          offered: times.length,
          retained: preview.events.length,
          bytes: snapshot.byteLength,
          coverage: preview.coverage,
          omissions: preview.omissions,
          recordUs: stats(samples),
          beforeCountCapRecordUs: stats(samples.slice(0, 4096)),
          afterCountCapRecordUs: samples.length > 4096 ? stats(samples.slice(4096)) : null,
          snapshotMs: stats([...snapshotsMs, snapshotMs]),
          previewParseMs,
          encodeMs: exported.encodeMs,
          localWriteFsyncMs: exported.localWriteFsyncMs,
          expireOnRecordMs,
          memory: {
            baseline,
            checkpoints,
            afterRecording,
            sampledPeak,
            withPreviewAndExport,
            afterStopWithPreview,
            maxRssKiB: process.resourceUsage().maxRSS,
          },
        }
      : undefined;
  } finally {
    buffer.stop();
  }
}
function extraProbes(directory) {
  let now = 0;
  const cost = eventReservation(...largest);
  const budget = DIAGNOSTIC_ENVELOPE_BYTES + 100 * cost;
  const buffer = new PretriggerBuffer({ now: () => now, maxReportBytes: budget });
  buffer.start();
  const latencies = [];
  for (let i = 0; i < 1000; i++) {
    now++;
    const start = clock();
    assert(buffer.record(...largest));
    latencies.push(elapsed(start) * 1000);
  }
  const report = JSON.parse(buffer.snapshot().json);
  assert.equal(report.events.length, 100);
  assert.equal(report.omissions.budget, 900);
  buffer.stop();
  const off = [];
  const timerOnly = [];
  for (let i = 0; i < 10_000; i++) buffer.record(...largest);
  for (let i = 0; i < 10_000; i++) {
    const start = clock();
    const accepted = buffer.record(...largest);
    off.push(elapsed(start) * 1000);
    assert.equal(accepted, false);
  }
  for (let i = 0; i < 10_000; i++) {
    const start = clock();
    timerOnly.push(elapsed(start) * 1000);
  }
  const metadata = makeMaximumFixture();
  for (let i = 0; i < 3; i++) canonicalJson(metadata);
  const maximum = [];
  for (let i = 0; i < 5; i++) {
    const before = gcMemory();
    const start = clock();
    const json = canonicalJson(metadata);
    const serializeMs = elapsed(start);
    const afterSerialize = guard();
    const beginParse = clock();
    const parsed = JSON.parse(json);
    const parseMs = elapsed(beginParse);
    const exported = exportProbe(json, directory);
    const held = gcMemory();
    assert.equal(parsed.events.length, 4096);
    assert.equal(exported.bytes.toString("utf8"), json);
    assert(exported.bytes.length <= DIAGNOSTIC_LIMITS.maxReportBytes);
    // Validate the complete synthetic maximum fixture using the existing independent checker.
    const checked = spawnSync(
      "python3",
      [join(ROOT, "docs/preparation/manual-diagnostics-contract/validate.py"), join(directory, "synthetic.json")],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert(!checked.error, "Fixture validator could not execute");
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    maximum.push({
      bytes: exported.bytes.length,
      serializeMs,
      parseMs,
      encodeMs: exported.encodeMs,
      localWriteFsyncMs: exported.localWriteFsyncMs,
      before,
      afterSerialize,
      held,
    });
  }
  return {
    bytePressure: {
      maxReportBytes: budget,
      offered: 1000,
      retained: 100,
      omissions: report.omissions,
      recordUs: stats(latencies),
    },
    disabledRecordUs: stats(off),
    timerOnlyUs: stats(timerOnly),
    maximumMetadata: maximum,
  };
}

assert.equal(typeof global.gc, "function", "Run with --expose-gc");
if (process.argv[2] === "--child") {
  const [, , , name, payload] = process.argv;
  assert(scenarios.includes(name) && ["mixed", "maximum"].includes(payload));
  const directory = mkdtempSync(join(tmpdir(), "orca-synthetic-bench-"));
  try {
    runCase(name, payload, directory, false);
    runCase(name, payload, directory, false);
    const result = runCase(name, payload, directory, true);
    result.memory.afterRelease = gcMemory();
    result.extra = name === "bursty" && payload === "maximum" ? extraProbes(directory) : undefined;
    process.stdout.write(JSON.stringify(result));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  assert.equal(process.argv.length, 2, "No workload expansion flags; edit/review fixed bounds deliberately");
  const sources = ["pretrigger-buffer", "profile", "snapshot"];
  const sourceHashes = {};
  const compiledHashes = {};
  for (const name of sources) {
    const path = `packages/app/src/main/diagnostics/${name}.ts`;
    const bytes = readFileSync(join(ROOT, path));
    assert.equal(
      bytes.toString(),
      execFileSync("git", ["show", `${BASE}:${path}`], { cwd: ROOT, encoding: "utf8" }),
      "Implementation differs from pinned PR head",
    );
    sourceHashes[name] = hash(bytes);
    compiledHashes[name] = hash(readFileSync(join(ROOT, `packages/app/dist/main/diagnostics/${name}.js`)));
  }
  const results = {
    formatVersion: 1,
    measuredAt: new Date().toISOString(),
    implementationCommit: BASE,
    harnessCommit: git("rev-parse", "HEAD"),
    harnessSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    sourceHashes,
    compiledHashes,
    environment: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemory: totalmem(),
      pressure: pressure(),
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      typescript: JSON.parse(readFileSync(join(ROOT, "node_modules/typescript/package.json"), "utf8")).version,
      python: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
      jsonschema: execFileSync(
        "python3",
        ["-c", "from importlib.metadata import version; print(version('jsonschema'))"],
        { encoding: "utf8" },
      ).trim(),
      execArgv: process.execArgv,
    },
    method: {
      logicalDurationMs: 300_000,
      warmupsPerChild: 2,
      independentTrials: 3,
      snapshotCallsPerTrial: 6,
      memoryCeilings: ceilings,
      childTimeoutMs: 120_000,
      maxOfferedPerTrial: 5250,
      largestPair: largest,
      eventReservation: eventReservation(...largest),
      envelopeReservation: DIAGNOSTIC_ENVELOPE_BYTES,
    },
    trials: [],
  };
  for (const name of scenarios)
    for (const payload of ["mixed", "maximum"])
      for (let trial = 1; trial <= 3; trial++) {
        guard();
        process.stderr.write(`${name}/${payload} trial ${trial}/3\n`);
        const child = spawnSync(
          process.execPath,
          ["--expose-gc", "--max-old-space-size=256", fileURLToPath(import.meta.url), "--child", name, payload],
          { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * MiB },
        );
        assert(!child.error, `STOP: child execution error; remaining workloads cancelled: ${child.error}`);
        assert.equal(
          child.status,
          0,
          `STOP: child failure; remaining workloads cancelled: ${child.stderr || child.error || child.signal}`,
        );
        results.trials.push({ trial, ...JSON.parse(child.stdout) });
      }
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
}
