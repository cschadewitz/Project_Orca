/** Portable adversarial protocol/pin checks and static validation; no Windows acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  specification,
  targets,
  validateDiagnostic,
  inventory,
  sha,
  harness,
  verifySource,
  verifyBuild,
  verifySeal,
  git,
  regular,
} from "../windows-c15/manifest.mjs";
const read = (name) => fs.readFileSync(path.join(harness, name), "utf8");
function diagnostic(mode, schedule) {
  return {
    mode,
    schedule,
    ok: true,
    productionEnabled: false,
    regressionOnly: false,
    expectedCells: [...targets],
    unhandledRejections: 0,
    legacyCalls: 0,
    electron: specification.electron.version,
    memory: {
      managedLimitBytes: 33_554_432,
      binaryLimitBytes: 8_388_608,
      zeroAfterEveryCell: true,
      managedIncrementBytes: 100,
      controlledBinaryPeakBytes: 128,
      managedPass: true,
      binaryPass: true,
      baseline: { heapUsed: 1000, external: 100, rss: 2000 },
      aggregateManagedPeakBytes: 1200,
      attribution: {
        backingAllocatedBytes: 128,
        largestBackingBytes: 128,
        backingGrowths: 1,
        phaseManagedIncrementBytes: { setup: 100 },
      },
    },
    cells: targets.map((target) => ({
      target,
      syntheticFault: true,
      faultObserved: true,
      faultHits: 1,
      faultPeak: 1,
      operationTimeoutMs: target === "nativeWrite" ? 10_000 : 1000,
      writerOutstandingBeforeRelease: 1,
      retainedWhileParked: { reservation: 128, binary: 128 },
      pressure: { attempts: 128, refused: 128, diskCallsAdded: 0, dispatchesAdded: 0, payloadAllocationsAdded: 0 },
      checks: {
        defaultOff: true,
        zeroReservation: true,
        zeroControlledBinary: true,
        noLateDestination: true,
        writerSettled: true,
        noHistoryOrStage: true,
        diskBound: true,
        exactSavedBytes: true,
      },
    })),
  };
}
test("accepts complete original Off/On failure and stall protocol receipts", () => {
  assert.equal(targets.length, 20);
  for (const mode of ["off", "on"])
    for (const schedule of ["failure", "stall"]) validateDiagnostic(diagnostic(mode, schedule), mode, schedule);
});
test("rejects partial, duplicate, regression, missing checks, weakened bounds and false memory passes", () => {
  const mutations = [
    (r) => r.cells.pop(),
    (r) => {
      r.cells[19] = r.cells[0];
    },
    (r) => {
      r.regressionOnly = true;
    },
    (r) => {
      delete r.cells[0].checks.writerSettled;
    },
    (r) => {
      r.memory.managedLimitBytes++;
    },
    (r) => {
      r.memory.binaryLimitBytes++;
    },
    (r) => {
      r.memory.managedIncrementBytes = 33_554_433;
      r.memory.aggregateManagedPeakBytes = 33_555_533;
    },
    (r) => {
      r.memory.controlledBinaryPeakBytes = 8_388_609;
    },
    (r) => {
      r.cells[19].operationTimeoutMs = 1000;
    },
    (r) => {
      r.cells[0].pressure.dispatchesAdded = 1;
    },
    (r) => {
      r.cells[5].retainedWhileParked.binary = 0;
    },
    (r) => {
      r.memory.baseline.heapUsed++;
    },
    (r) => {
      r.electron = "wrong";
    },
  ];
  for (const mutate of mutations) {
    const receipt = diagnostic("on", "stall");
    mutate(receipt);
    assert.throws(() => validateDiagnostic(receipt, "on", "stall"));
  }
  const failure = diagnostic("on", "failure");
  failure.memory.managedIncrementBytes = 33_554_433;
  failure.memory.aggregateManagedPeakBytes = 33_555_533;
  failure.memory.managedPass = false;
  validateDiagnostic(failure, "on", "failure"); // Correctly reports memory failure; supervisor rejects the gate.
});
test("candidate preserves the frozen cell campaign byte-for-byte apart from observer construction", () => {
  const campaign = (name) => {
    const text = read(`packages/app/test/recovery-preparation/${name}`);
    return text
      .slice(text.indexOf("    // Every asynchronous"), text.indexOf("    sampleFinalMemory();"))
      .replaceAll("ObservedPayloadMemory", "ControlledPayloadMemory");
  };
  assert.equal(campaign("windows-c15-candidate-child.cjs"), campaign("windows-c15-child.cjs"));
  const child = read("packages/app/test/recovery-preparation/windows-c15-candidate-child.cjs");
  assert.match(child, /const baseline = process.memoryUsage\(\)/);
  assert.match(child, /managedLimitBytes: 33554432/);
  assert.match(child, /}, 2\)/);
  assert.doesNotMatch(child, /globalThis.gc|global.gc|--expose-gc/);
  const supervisor = read("packages/app/test/recovery-preparation/windows-c15-candidate.mjs");
  assert.match(supervisor, /enteredMs < row.executionElapsedMs/);
  assert.match(supervisor, /await run\("off"\);\s+await run\("on"\)/);
  assert.match(supervisor, /artifactCount, 29/);
  assert.match(supervisor, /semanticEqual, true/);
  assert.match(supervisor, /!result.disposableStateRemoved/);
});
test("closed inventory rejects symlinks and records extra or substituted files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c15-inventory-"));
  try {
    fs.writeFileSync(path.join(root, "one"), "original");
    const before = inventory(root);
    fs.writeFileSync(path.join(root, "one"), "substituted");
    assert.notDeepEqual(inventory(root), before);
    fs.writeFileSync(path.join(root, "extra"), "extra");
    assert.equal(Object.keys(inventory(root)).length, 2);
    // Junctions do not require Windows symlink privilege.
    fs.symlinkSync(root, path.join(root, "loop"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => inventory(root), /symlink refused/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("workflow is manual Windows x64 test-only, with closed checkouts and staged pins", () => {
  const source = process.env.C15_SOURCE || harness;
  const { parse } = createRequire(path.join(source, "packages/cli/package.json"))("yaml");
  const text = read(".github/workflows/windows-c15-candidate.yml");
  const workflow = parse(text);
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["proof"]);
  assert.equal(workflow.jobs.proof["runs-on"], "windows-2025");
  assert.equal(workflow.jobs.proof["timeout-minutes"], 20);
  const steps = workflow.jobs.proof.steps;
  const checkout = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.length, 2);
  assert.ok(checkout.every((step) => step.with["persist-credentials"] === false));
  assert.equal(checkout[1].with.ref, specification.sourceCommit);
  assert.ok(steps.every((step) => !step["continue-on-error"]));
  assert.match(text, /install --frozen-lockfile --ignore-scripts/);
  assert.match(text, /diagnostics-native-package.js --arch x64 --headers/);
  assert.match(text, /hashlib.sha256/);
  assert.match(text, /--proto '=https'/);
  assert.match(text, /--max-filesize/);
  assert.doesNotMatch(
    text,
    /secrets[.[]|--no-sandbox|icacls|Set-Acl|takeown|workflow_call|self-hosted|electron-builder --|gh workflow|contents: write/,
  );
  const runs = steps.filter((step) => step.run?.includes("windows-c15-candidate.mjs"));
  assert.equal(runs.length, 2);
  assert.ok(runs[1].if.includes("!cancelled()") && runs[1].if.includes("C15_PARENT"));
  assert.equal(steps.at(-1).if, "${{ always() }}");
  const probe = read("tools/windows-c15/root-probe.mjs");
  assert.match(probe, /os.homedir\(\), "Documents"/);
  assert.match(probe, /storage.native.verifyRoot\(probe\)/);
  assert.match(probe, /receiptFile/);
  assert.doesNotMatch(probe, /tmpdir|Set-Acl|icacls|takeown/);
});
if (process.env.C15_SOURCE) {
  test("exact compiled source, native source and harness pins validate", () => {
    verifyBuild(path.resolve(process.env.C15_SOURCE));
    assert.ok(Object.keys(specification.compiled).length > 300);
  });
  test("compiled substitution and extra executable are refused", () => {
    const source = path.resolve(process.env.C15_SOURCE);
    const name = Object.keys(specification.compiled)[0];
    const file = path.join(source, name),
      before = fs.readFileSync(file);
    const extra = path.join(source, "packages/app/dist/c15-unexpected.mjs");
    assert.equal(fs.existsSync(extra), false);
    try {
      fs.appendFileSync(file, "\n// substituted\n");
      assert.throws(() => verifyBuild(source), /compiled substitution/);
      fs.writeFileSync(file, before);
      fs.writeFileSync(extra, "export const substituted = true;\n", { flag: "wx" });
      assert.throws(() => verifyBuild(source), /compiled substitution/);
    } finally {
      fs.writeFileSync(file, before);
      if (fs.existsSync(extra)) fs.unlinkSync(extra);
    }
  });
  test("full source check detects assume-unchanged substitution, not just Git diff", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c15-source-"));
    try {
      execFileSync("git", [
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        path.resolve(process.env.C15_SOURCE),
        root,
      ]);
      execFileSync("git", ["-C", root, "-c", "core.autocrlf=false", "checkout", "--quiet", specification.sourceCommit]);
      verifySource(root);
      const file = "packages/app/src/main/diagnostics/payload-memory.ts";
      execFileSync("git", ["-C", root, "update-index", "--assume-unchanged", file]);
      fs.appendFileSync(path.join(root, file), "\n// substituted\n");
      assert.equal(execFileSync("git", ["-C", root, "diff"]).length, 0);
      assert.throws(() => verifySource(root), /source substitution/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("a separate receipt digest detects runtime and receipt replacement", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c15-seal-"));
    try {
      const runtime = path.join(root, "runtime");
      fs.mkdirSync(runtime);
      fs.writeFileSync(path.join(runtime, "fixture"), "synthetic inventory, no native execution");
      const seal = {
        schema: 1,
        harnessHead: git(harness, "rev-parse", "HEAD").toString().trim(),
        nodeExecutableSha256: sha(regular(process.execPath)),
        specificationSha256: sha(read("tools/windows-c15/candidate.json")),
        sourceCommit: specification.sourceCommit,
        nativeManifest: { sourceSha256: specification.nativeSourceSha256 },
        runtimeArchiveSha256: specification.electron.sha256,
        runtime,
        source: path.resolve(process.env.C15_SOURCE),
        runtimeFiles: inventory(runtime),
      };
      const file = path.join(root, "build.json");
      fs.writeFileSync(file, JSON.stringify(seal));
      const digest = sha(fs.readFileSync(file));
      verifySeal(seal.source, runtime, file, digest);
      fs.appendFileSync(path.join(runtime, "fixture"), "substitution");
      assert.throws(() => verifySeal(seal.source, runtime, file, digest), /runtime\/native substitution/);
      seal.runtimeFiles = inventory(runtime);
      fs.writeFileSync(file, JSON.stringify(seal));
      assert.throws(() => verifySeal(seal.source, runtime, file, digest), /build receipt substitution/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
