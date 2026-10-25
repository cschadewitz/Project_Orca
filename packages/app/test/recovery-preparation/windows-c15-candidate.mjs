/** Allocator candidate: original paired protocol with separate reviewed source/build pins. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  verifySeal,
  validateDiagnostic,
  specification,
  sha as hash,
  regular,
} from "../../../../tools/windows-c15/manifest.mjs";
import { DEMO_COUNT, validateOverlap } from "../../../../tools/windows-c15/overlap.mjs";
import { launchCli } from "../../../../tools/windows-c15/cli-lifecycle.mjs";
const [sourceDirectory, electronDirectory, outputDirectory, schedule, privateParent, sealFile, sealDigest] =
  process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.ok(["failure", "stall"].includes(schedule), "one explicit schedule per invocation");
assert.ok(privateParent && path.isAbsolute(privateParent), "explicit previously accepted disposable parent");
const repo = path.resolve(sourceDirectory);
const electron = path.resolve(electronDirectory),
  output = path.resolve(outputDirectory);
fs.mkdirSync(output, { recursive: true });
assert.equal(fs.existsSync(path.join(output, schedule + "-results.json")), false, "never replace an attempt");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = specification.sourceCommit;
const buildReceipt = verifySeal(repo, electron, sealFile, sealDigest);
const harnessHead = buildReceipt.harnessHead;
const compiled = path.join(repo, "packages/app/dist/main/diagnostics");
const setup = JSON.parse(regular(path.join(output, "setup.json")));
assert.equal(setup.accepted, true, "native Documents probe required");
assert.equal(path.resolve(privateParent), setup.parent, "use probed parent only");
const backend = createRequire(import.meta.url)(
  path.join(electron, "resources/native/diagnostics/win32-x64/diagnostics_storage.node"),
);
const { createHandleRelativeStorage } = await import(pathToFileURL(path.join(compiled, "native-storage.js")).href);
const { fileStores } = await import(pathToURL(path.join(repo, "packages/store/dist/index.js")));
const { parseFrontMatter } = await import(pathToURL(path.join(repo, "packages/core/dist/index.js")));
function pathToURL(p) {
  return pathToFileURL(p).href;
}
const fixtureParent = fs.realpathSync(privateParent);
assert.notEqual(fixtureParent, path.parse(fixtureParent).root);
const root = path.join(fixtureParent, "orca-c15-" + randomUUID());
const owned = new Set();
const result = {
  schema: 1,
  schedule,
  sourceCommit: pin,
  harnessHead,
  productionSource: pin,
  buildReceiptSha256: sealDigest,
  candidateManifestSha256: hash(regular(new URL("../../../../tools/windows-c15/candidate.json", import.meta.url))),
  nativeManifest: buildReceipt.nativeManifest,
  hostedSyntheticOnly: true,
  historicalFailuresUnchanged: true,
  productionEnabled: false,
  macHeld: true,
  timingDeferred: true,
  attempts: 1,
  runs: [],
  overlapEvidence:
    "Child-owned captured-clock lifecycle segment (CLI preload evaluation + 2 us, beginning of CLI exit handler - 2 us), strict interior only, conditional on complete successful demos and semantic oracles. Conservative QPC one-tick exclusion; includes startup/waits/cleanup, not exact physical overlap or continuous CPU/engine work or exact OS exit. Parent callback brackets are audit-only.",
  method:
    "One failure or stall schedule compares sequential Off/On members, each executing two complete sequential CLI demos; 20 fixed fault cells inside On, no performance retry. Synthetic seams with real Windows x64 Electron/native disk, DPAPI and clock.",
};
function launch(command, args, options) {
  const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
  owned.add(child);
  child.once("exit", () => owned.delete(child));
  let bytes = 0;
  child.stdout.on("data", (data) => {
    bytes += data.length;
  });
  child.stderr.on("data", (data) => {
    bytes += data.length;
  });
  child.outputBytes = () => bytes;
  return child;
}
async function bounded(work, ms, code) {
  let timeout;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error(code)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  execFileSync("C:/Windows/System32/taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 5000,
  });
  await bounded(exited, 5000, "owned-exit-unconfirmed");
}
async function file(p, child, ms) {
  const end = performance.now() + ms;
  while (!fs.existsSync(p)) {
    if (child.exitCode !== null) throw Error("child-no-receipt");
    if (performance.now() > end) throw Error("receipt-deadline");
    await delay(10);
  }
}
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v)
        .filter(
          ([k]) =>
            ![
              "id",
              "requestId",
              "runId",
              "stepRunId",
              "createdAt",
              "updatedAt",
              "timestamp",
              "producedBy",
              "parentId",
            ].includes(k),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, normalize(x)]),
    );
  if (typeof v === "string")
    return v
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<generated-id>")
      .replace(
        /\b(req|wi|wf|run|step|art|evt|sess|orc|tpl|host|hi|plan|dep|risk|dec|pev)_[0-9A-HJKMNP-TV-Z]{26}\b/g,
        "$1_<generated-id>",
      )
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<generated-time>");
  return v;
}
async function semanticOracle(directory) {
  const stores = fileStores(path.join(directory, ".orca"));
  const inventory = await stores.artifacts.list(),
    semantic = [];
  for (const artifact of inventory) {
    const parsed = parseFrontMatter(await stores.artifacts.content(artifact.id));
    semantic.push({
      kind: artifact.kind,
      name: normalize(artifact.name),
      data: normalize(parsed.data),
      body: normalize(parsed.body),
    });
  }
  semantic.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    artifactCount: inventory.length,
    semanticSignature: sha(JSON.stringify(semantic)),
    semanticByKind: semantic.map((x) => ({ kind: x.kind, name: x.name, sha256: sha(JSON.stringify(x)) })),
    workItems: (await stores.workItems.list())
      .map((x) => ({ slug: x.slug, status: x.status }))
      .sort((a, b) => a.slug.localeCompare(b.slug)),
    normalization:
      "Reused successful-pair oracle: generated identities/provenance/times removed, semantic front matter/prose/kind/name/multiplicity retained. Not complete execution graph equivalence.",
  };
}
async function run(mode) {
  verifySeal(repo, electron, sealFile, sealDigest);
  const row = { mode, completed: false };
  result.runs.push(row);
  const base = path.join(root, mode);
  const storage = createHandleRelativeStorage(base, backend);
  assert.equal(await storage.native.verifyRoot(base), true);
  await storage.close();
  fs.writeFileSync(path.join(base, "sentinel"), "synthetic unrelated file");
  const request = path.join(base, "request.json");
  fs.writeFileSync(request, JSON.stringify({ base, compiled, mode, schedule }));
  const env = {
    SystemRoot: "C:/Windows",
    WINDIR: "C:/Windows",
    PATH: "C:/Windows/System32",
    TEMP: base,
    TMP: base,
    APPDATA: path.join(base, "appdata"),
    LOCALAPPDATA: path.join(base, "localappdata"),
    USERPROFILE: base,
  };
  for (const name of ["APPDATA", "LOCALAPPDATA"]) fs.mkdirSync(env[name]);
  process.stdout.write(JSON.stringify({ schedule, phase: "launch", mode }) + "\n");
  const diagnostic = launch(
    path.join(electron, "electron.exe"),
    [fileURLToPath(new URL("windows-c15-candidate-child.cjs", import.meta.url)), request],
    { env },
  );
  const diagnosticExit = once(diagnostic, "exit");
  diagnosticExit.catch(() => {});
  await file(path.join(base, "execution.start"), diagnostic, 5000);
  const execution = path.join(base, "execution");
  fs.mkdirSync(execution);
  const start = performance.now();
  row.executionMembers = [];
  const oracles = [];
  row.outputBytes = 0;
  for (let index = 0; index < DEMO_COUNT; index++) {
    const directory = path.join(execution, String(index));
    fs.mkdirSync(directory);
    const { child: cli, completed } = launchCli(
      launch,
      process.execPath,
      [path.join(repo, "packages/cli/dist/main.js"), "demo", "--dir", directory, "--keep", "--quiet"],
      { cwd: directory, env: { ...env, PATH: process.env.PATH } },
    );
    if (index === 0) fs.writeFileSync(path.join(base, "execution.running"), "running");
    const member = await bounded(completed, 50000, "cli-deadline");
    row.executionMembers.push({ index, ...member });
    row.outputBytes += cli.outputBytes();
    assert.equal(member.exitCode, 0, "fixed CLI workload member failed");
    // Read stores only after all workflow processes have exited; do not insert
    // oracle work or an idle gate between the two actual CLI executions.
  }
  row.executionElapsedMs = performance.now() - start;
  row.executionExitCode = 0;
  fs.writeFileSync(path.join(base, "execution.done"), "done");
  await file(path.join(base, "result.json"), diagnostic, 40000);
  row.diagnosticExitCode = (await bounded(diagnosticExit, 5000, "diagnostic-exit-deadline"))[0];
  row.diagnostic = JSON.parse(fs.readFileSync(path.join(base, "result.json"), "utf8"));
  validateDiagnostic(row.diagnostic, mode, schedule);
  for (let index = 0; index < DEMO_COUNT; index++) {
    const oracle = await semanticOracle(path.join(execution, String(index)));
    assert.equal(oracle.artifactCount, 29);
    oracles.push(oracle);
  }
  row.executionOracle = {
    demos: oracles,
    artifactCount: oracles.reduce((sum, oracle) => sum + oracle.artifactCount, 0),
    semanticSignature: sha(JSON.stringify(oracles.map((oracle) => oracle.semanticSignature))),
    workItems: oracles.map((oracle) => oracle.workItems),
  };
  row.sentinelUnchanged = fs.readFileSync(path.join(base, "sentinel"), "utf8") === "synthetic unrelated file";
  row.completed = true;
  fs.writeFileSync(path.join(output, schedule + "-" + mode + ".json"), JSON.stringify(row, null, 2) + "\n");
  assert.equal(row.executionExitCode, 0);
  assert.equal(row.diagnosticExitCode, 0);
  assert.equal(row.diagnostic.ok, true);
  assert.equal(row.sentinelUnchanged, true);
  assert.equal(row.executionOracle.artifactCount, 29 * DEMO_COUNT);
  assert.ok(row.diagnostic.cells.every((x) => mode === "off" || x.faultObserved));
  // Each seam must have been reached while execution was alive; campaign may finish after the CLI.
  row.allFaultsEnteredDuringExecution =
    mode === "off" || row.diagnostic.cells.every((x) => x.enteredMs < row.executionElapsedMs);
  assert.equal(row.allFaultsEnteredDuringExecution, true, "fault-campaign-outlived-workload");
  row.monotonicOverlapPass = false;
  validateOverlap(row);
  row.monotonicOverlapPass = true;
}
try {
  const rootStorage = createHandleRelativeStorage(root, backend);
  try {
    assert.equal(await rootStorage.native.verifyRoot(root), true, "native private fixture root");
  } finally {
    await rootStorage.close();
  }
  await run("off");
  await run("on");
  const [off, on] = result.runs;
  result.semanticEqual = off.executionOracle.semanticSignature === on.executionOracle.semanticSignature;
  result.workEqual = JSON.stringify(off.executionOracle.workItems) === JSON.stringify(on.executionOracle.workItems);
  assert.equal(result.semanticEqual, true);
  assert.equal(result.workEqual, true);
  result.correctnessPass = true;
  result.aggregateMemory = result.runs.map((row) => ({ mode: row.mode, ...row.diagnostic.memory }));
  result.memoryPass = result.runs.every((x) => x.diagnostic.memory.managedPass && x.diagnostic.memory.binaryPass);
} catch (error) {
  result.correctnessPass = false;
  result.failureCode = error.message;
} finally {
  // Retain partial receipts even on failure, before disposing an owned profile.
  for (const mode of ["off", "on"]) {
    const receipt = path.join(root, mode, "result.json");
    if (fs.existsSync(receipt)) fs.copyFileSync(receipt, path.join(output, schedule + "-" + mode + "-receipt.json"));
  }
  result.allOwnedExitsConfirmed = true;
  for (const child of owned)
    try {
      await stop(child);
    } catch {
      result.allOwnedExitsConfirmed = false;
    }
  result.allOwnedExitsConfirmed &&= owned.size === 0;
  if (result.allOwnedExitsConfirmed && fs.existsSync(root)) {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fixtureParent);
    assert.ok(path.basename(resolved).startsWith("orca-c15-"));
    fs.rmSync(resolved, { recursive: true, force: true });
    result.disposableStateRemoved = !fs.existsSync(resolved);
  }
  fs.writeFileSync(path.join(output, schedule + "-results.json"), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({
      schedule,
      correctnessPass: result.correctnessPass,
      memoryPass: result.memoryPass,
      failureCode: result.failureCode,
      allOwnedExitsConfirmed: result.allOwnedExitsConfirmed,
      disposableStateRemoved: result.disposableStateRemoved,
    }) + "\n",
  );
  if (!result.correctnessPass || !result.memoryPass || !result.allOwnedExitsConfirmed || !result.disposableStateRemoved)
    process.exitCode = 1;
}
