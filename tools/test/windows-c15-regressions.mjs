/** Focused native fixture regressions; no CLI pair, production consent or hardware proof. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
const [runtimeDirectory, outputDirectory, privateParent] = process.argv.slice(2);
assert.equal(process.platform, "win32");
const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const runtime = path.resolve(runtimeDirectory),
  output = path.resolve(outputDirectory);
const parent = fs.realpathSync(privateParent);
fs.mkdirSync(output, { recursive: true });
assert.equal(fs.existsSync(path.join(output, "regressions.json")), false);
const backend = createRequire(import.meta.url)(
  path.join(runtime, "resources/native/diagnostics/win32-x64/diagnostics_storage.node"),
);
const compiled = path.join(repo, "packages/app/dist/main/diagnostics");
const { createHandleRelativeStorage } = await import(pathToFileURL(path.join(compiled, "native-storage.js")).href);
const childFile = path.join(repo, "packages/app/test/recovery-preparation/windows-c15-child.cjs");
const result = {
  schema: 1,
  regressionOnly: true,
  pairedExecution: false,
  productionEnabled: false,
  childSha256: createHash("sha256").update(fs.readFileSync(childFile)).digest("hex"),
  cases: [],
};
const cases = [
  {
    name: "startup-guard-destination-and-known-save",
    targets: ["open", "writeExportState", "completionRecord"],
    badPrefix: true,
    expectedOk: true,
  },
  { name: "accounting-on-controlled-stop", targets: ["open"], stopAfter: 1, expectedOk: false },
];
for (const spec of cases) {
  const root = path.join(parent, "orca-c15-regression-" + randomUUID());
  let child, timer;
  const row = { name: spec.name };
  result.cases.push(row);
  try {
    const storage = createHandleRelativeStorage(root, backend);
    assert.equal(await storage.native.verifyRoot(root), true);
    await storage.close();
    fs.writeFileSync(path.join(root, "sentinel"), "synthetic unrelated file");
    fs.writeFileSync(path.join(root, "execution.running"), "regression-only");
    fs.writeFileSync(path.join(root, "execution.done"), "regression-only");
    const request = path.join(root, "request.json");
    fs.writeFileSync(
      request,
      JSON.stringify({
        base: root,
        compiled,
        mode: "on",
        schedule: "failure",
        regressionTargets: spec.targets,
        regressionBadDestinationProbe: spec.badPrefix,
        regressionStopAfter: spec.stopAfter,
      }),
    );
    const env = {
      SystemRoot: "C:/Windows",
      WINDIR: "C:/Windows",
      PATH: "C:/Windows/System32",
      TEMP: root,
      TMP: root,
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "localappdata"),
      USERPROFILE: root,
    };
    fs.mkdirSync(env.APPDATA);
    fs.mkdirSync(env.LOCALAPPDATA);
    child = spawn(path.join(runtime, "electron.exe"), [childFile, request], {
      windowsHide: true,
      stdio: "ignore",
      env,
    });
    const exited = once(child, "exit");
    timer = setTimeout(() => {
      if (child.exitCode === null)
        execFileSync("C:/Windows/System32/taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 5000,
        });
    }, 15000);
    row.exitCode = (await exited)[0];
    row.receipt = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8"));
    assert.equal(row.exitCode, spec.expectedOk ? 0 : 1);
    assert.equal(row.receipt.ok, spec.expectedOk);
    if (!spec.expectedOk) assert.equal(row.receipt.failureCode, "synthetic-regression-stop");
    assert.ok(row.receipt.memory);
    assert.equal(row.receipt.memory.zeroAfterEveryCell, true);
    assert.equal(row.receipt.legacyCalls, 0);
    assert.equal(row.receipt.unhandledRejections, 0);
    assert.ok(row.receipt.cells.every((cell) => cell.faultHits === 1 && Object.values(cell.checks).every(Boolean)));
    if (spec.badPrefix) assert.ok(row.receipt.cells.every((cell) => cell.prefixRefusalVerified));
    row.pass = true;
  } catch (error) {
    row.pass = false;
    row.failureCode = error.message;
  } finally {
    clearTimeout(timer);
    row.ownedExitConfirmed = !child || child.exitCode !== null;
    if (row.ownedExitConfirmed && fs.existsSync(root)) {
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), parent);
      assert.ok(path.basename(resolved).startsWith("orca-c15-regression-"));
      fs.rmSync(resolved, { recursive: true, force: true });
      row.disposableStateRemoved = !fs.existsSync(resolved);
    }
    fs.writeFileSync(path.join(output, "regressions.json"), JSON.stringify(result, null, 2) + "\n");
  }
  if (!row.pass) break;
}
result.pass =
  result.cases.length === cases.length &&
  result.cases.every((row) => row.pass && row.ownedExitConfirmed && row.disposableStateRemoved);
fs.writeFileSync(path.join(output, "regressions.json"), JSON.stringify(result, null, 2) + "\n");
process.stdout.write(
  JSON.stringify({
    pass: result.pass,
    cases: result.cases.map((row) => ({ name: row.name, pass: row.pass, error: row.failureCode })),
  }) + "\n",
);
if (!result.pass) process.exitCode = 1;
