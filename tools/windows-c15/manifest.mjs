/** Closed source/output identities and receipt validation for the manual hosted candidate. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
export const harness = fileURLToPath(new URL("../../", import.meta.url));
export const specification = JSON.parse(fs.readFileSync(new URL("candidate.json", import.meta.url), "utf8"));
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const git = (root, ...args) => execFileSync("git", args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
export function regular(file) {
  assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), `regular file: ${file}`);
  return fs.readFileSync(file);
}
export function inventory(root, include = () => true, prefix = "") {
  assert.ok(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), "regular directory required");
  const entries = {};
  for (const name of fs.readdirSync(root).sort()) {
    const relative = prefix + name;
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, `symlink refused: ${relative}`);
    if (stat.isDirectory()) Object.assign(entries, inventory(file, include, relative + "/"));
    else {
      assert.ok(stat.isFile());
      if (include(relative)) entries[relative] = sha(regular(file));
    }
  }
  return entries;
}
export function compiledInventory(source) {
  const entries = {};
  for (const name of fs.readdirSync(path.join(source, "packages")).sort()) {
    const root = path.join(source, "packages", name, "dist");
    if (!fs.existsSync(root)) continue;
    Object.assign(
      entries,
      Object.fromEntries(
        Object.entries(
          inventory(
            root,
            (p) => /\.(?:js|cjs|mjs|json)$/.test(p) && !/^(?:diagnostics-native|renderer|daemon|release)\//.test(p),
          ),
        ).map(([p, digest]) => [`packages/${name}/dist/${p}`, digest]),
      ),
    );
  }
  return entries;
}
export function verifySource(source) {
  assert.equal(git(source, "rev-parse", "HEAD").toString().trim(), specification.sourceCommit, "exact allocator head");
  assert.equal(git(source, "rev-parse", "HEAD^{tree}").toString().trim(), specification.sourceTree, "exact tree");
  // Compare actual bytes with every pinned Git blob, including ignored tracked files.
  // git diff alone can miss assume-unchanged/skip-worktree substitutions.
  for (const record of git(source, "ls-tree", "-rz", "--full-tree", "HEAD").toString().split("\0").filter(Boolean)) {
    const [metadata, name] = record.split("\t");
    const [mode, type, digest] = metadata.split(" ");
    assert.equal(type, "blob", "submodules refused");
    const file = path.join(source, name);
    const bytes = mode === "120000" ? Buffer.from(fs.readlinkSync(file)) : regular(file);
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(actual, digest, `source substitution: ${name}`);
  }
  assert.equal(git(source, "ls-files", "--others", "--exclude-standard").length, 0, "untracked source refused");
}
export function verifyBuild(source) {
  verifySource(source);
  assert.deepEqual(compiledInventory(source), specification.compiled, "compiled substitution or extra executable");
  for (const [name, digest] of Object.entries(specification.harness))
    assert.equal(sha(regular(path.join(harness, name))), digest, `harness substitution: ${name}`);
}
export function verifySeal(source, runtime, sealFile, expectedDigest) {
  verifyBuild(source);
  assert.match(expectedDigest ?? "", /^[a-f0-9]{64}$/, "separate build-receipt digest required");
  const bytes = regular(sealFile);
  assert.equal(sha(bytes), expectedDigest, "build receipt substitution");
  const seal = JSON.parse(bytes);
  assert.equal(seal.schema, 1);
  assert.equal(seal.specificationSha256, sha(regular(new URL("candidate.json", import.meta.url))));
  assert.equal(seal.sourceCommit, specification.sourceCommit);
  assert.equal(seal.nativeManifest.sourceSha256, specification.nativeSourceSha256, "native source pin");
  assert.equal(
    seal.harnessHead,
    git(harness, "rev-parse", "HEAD").toString().trim(),
    "harness head changed since staging",
  );
  assert.equal(seal.nodeExecutableSha256, sha(regular(process.execPath)), "CLI Node runtime changed since staging");
  assert.equal(seal.runtimeArchiveSha256, specification.electron.sha256);
  assert.equal(path.resolve(runtime), seal.runtime);
  assert.equal(path.resolve(source), seal.source);
  assert.deepEqual(inventory(runtime), seal.runtimeFiles, "runtime/native substitution");
  return seal;
}
export const targets = Object.freeze([
  "readSetting",
  "readExportState",
  "writeSetting",
  "open",
  "maintain",
  "checkpoint",
  "previous",
  "discardPrevious",
  "cleanExit",
  "cleanup",
  "writeExportState",
  "stageExport",
  "clearStage",
  "validateDestination",
  "publishStage",
  "writersStopped",
  "picker",
  "completionRecord",
  "nativePublish",
  "nativeWrite",
]);
export function validateDiagnostic(row, mode, schedule) {
  assert.equal(row.mode, mode);
  assert.equal(row.schedule, schedule);
  assert.equal(row.ok, true);
  assert.equal(row.productionEnabled, false);
  assert.equal(row.regressionOnly, false);
  assert.deepEqual(row.expectedCells, targets);
  assert.deepEqual(
    row.cells.map((cell) => cell.target),
    targets,
  );
  assert.equal(row.unhandledRejections, 0);
  assert.equal(row.legacyCalls, 0);
  assert.equal(row.electron, specification.electron.version);
  assert.equal(row.memory.managedLimitBytes, 33_554_432);
  assert.equal(row.memory.binaryLimitBytes, 8_388_608);
  assert.equal(row.memory.zeroAfterEveryCell, true);
  for (const name of ["heapUsed", "external", "rss"])
    assert.ok(Number.isFinite(row.memory.baseline[name]) && row.memory.baseline[name] >= 0);
  assert.equal(
    row.memory.managedIncrementBytes,
    row.memory.aggregateManagedPeakBytes - row.memory.baseline.heapUsed - row.memory.baseline.external,
  );
  for (const name of ["backingAllocatedBytes", "largestBackingBytes", "backingGrowths"])
    assert.ok(Number.isFinite(row.memory.attribution[name]) && row.memory.attribution[name] >= 0);
  assert.ok(Object.keys(row.memory.attribution.phaseManagedIncrementBytes).length > 0);
  assert.ok(Number.isFinite(row.memory.managedIncrementBytes) && row.memory.managedIncrementBytes >= 0);
  assert.ok(Number.isFinite(row.memory.controlledBinaryPeakBytes) && row.memory.controlledBinaryPeakBytes >= 0);
  assert.equal(row.memory.managedPass, row.memory.managedIncrementBytes <= 33_554_432);
  assert.equal(row.memory.binaryPass, row.memory.controlledBinaryPeakBytes <= 8_388_608);
  for (const cell of row.cells) {
    if (mode === "off") assert.equal(cell.checks.defaultOff, true);
    else {
      assert.equal(cell.faultObserved, true);
      assert.equal(cell.syntheticFault, true);
      assert.equal(cell.faultHits, 1);
      assert.equal(cell.faultPeak, 1);
      assert.equal(cell.operationTimeoutMs, cell.target === "nativeWrite" ? 10_000 : 1000);
      for (const key of [
        "zeroReservation",
        "zeroControlledBinary",
        "noLateDestination",
        "writerSettled",
        "noHistoryOrStage",
        "diskBound",
      ])
        assert.equal(cell.checks[key], true, key);
      if (cell.target === "completionRecord") assert.equal(cell.checks.exactSavedBytes, true);
      if (schedule === "stall") {
        assert.deepEqual(cell.pressure, {
          attempts: 128,
          refused: 128,
          diskCallsAdded: 0,
          dispatchesAdded: 0,
          payloadAllocationsAdded: 0,
        });
        assert.equal(cell.writerOutstandingBeforeRelease, 1);
        if (["checkpoint", "nativeWrite", "stageExport", "nativePublish"].includes(cell.target)) {
          assert.ok(cell.retainedWhileParked.reservation > 0);
          assert.ok(cell.retainedWhileParked.binary > 0);
        }
      }
    }
  }
}
