/** Portable adversarial protocol/pin checks and static validation; no Windows acceptance. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preload, launchCli, validateLifecycle, CLI_LIMIT_MS } from "../windows-c15/cli-lifecycle.mjs";
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
import { BOUNDARY_EXCLUSION_NS, DEMO_COUNT, validateOverlap } from "../windows-c15/overlap.mjs";
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
test("candidate preserves the frozen cell campaign byte-for-byte apart from observer construction and entry evidence", () => {
  const campaign = (name) => {
    const text = read(`packages/app/test/recovery-preparation/${name}`);
    return text
      .slice(text.indexOf("    // Every asynchronous"), text.indexOf('    phase = "execution-wait";'))
      .replaceAll("ObservedPayloadMemory", "ControlledPayloadMemory")
      .replace("      cell.faultEnteredNs = fault.enteredNs;\n", "");
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
  assert.match(supervisor, /oracle.artifactCount, 29/);
  assert.match(supervisor, /index < DEMO_COUNT/);
  assert.match(supervisor, /validateOverlap\(row\)/);
  assert.match(child, /this.enteredNs = process.hrtime.bigint\(\).toString\(\);\s+entered\(\)/);
  assert.match(supervisor, /semanticEqual, true/);
  assert.match(supervisor, /workEqual, true/);
  assert.match(supervisor, /row.executionOracle.artifactCount, 29 \* DEMO_COUNT/);
  assert.match(supervisor, /bounded\(completed, 50000/);
  assert.match(
    supervisor,
    /await ready;\s+if \(index === 0\) fs.writeFileSync\(path.join\(base, "execution.running"\)/,
  );
  assert.match(child, /120000/);
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
test("native header extraction keeps colon-bearing scratch paths out of tar's archive argument", () => {
  const source = process.env.C15_SOURCE || harness;
  const { parse } = createRequire(path.join(source, "packages/cli/package.json"))("yaml");
  const workflow = parse(read(".github/workflows/windows-c15-candidate.yml"));
  const build = workflow.jobs.proof.steps.find(
    (step) => step.name === "Build native x64 package with verified local Node inputs",
  );
  const extraction = build.run.split("\n").filter((line) => line.includes("tar -xzf"));
  assert.equal(extraction.length, 1);
  // On POSIX use a drive-like relative path: GNU tar's remote separator must precede any slash.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c15-archive-"));
  const scratch = path.join(root, process.platform === "win32" ? "headers with spaces" : "D: headers with spaces");
  const headersScratch = process.platform === "win32" ? scratch : path.relative(root, scratch);
  const archive = "node-v24.21.0-headers.tar.gz";
  try {
    fs.mkdirSync(scratch);
    assert.ok(headersScratch.includes(":"), "fixture must exercise a colon-bearing local path");
    fs.writeFileSync(path.join(scratch, "header.h"), "verified local header\n");
    execFileSync("tar", ["-czf", archive, "header.h"], { cwd: scratch, timeout: 10_000 });
    fs.unlinkSync(path.join(scratch, "header.h"));
    execFileSync("bash", ["-euc", extraction[0]], {
      cwd: root,
      env: { ...process.env, headers_scratch: headersScratch, archive, TAR_OPTIONS: "--rsh-command=false" },
      timeout: 10_000,
    });
    assert.equal(fs.readFileSync(path.join(scratch, "header.h"), "utf8"), "verified local header\n");
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
    assert.equal(Object.keys(specification.compiled).length, 365);
    // Recompute the Windows native source digest from the selected product bytes.
    const digestInputs = [
      "binding.gyp",
      "clock.c",
      "storage-windows.c",
      "storage-windows-common.h",
      "acl-policy.h",
      "first-run-windows.c",
      "keys-windows.c",
      "windows-delay-load.c",
    ];
    const bytes = digestInputs.flatMap((name) => [
      Buffer.from(name + "\0"),
      regular(path.join(process.env.C15_SOURCE, "packages/app/native/diagnostics", name)),
    ]);
    assert.equal(sha(Buffer.concat(bytes)), specification.nativeSourceSha256);
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

test("launch arguments use a file URL while native receipt and hash paths retain identity", async () => {
  const f = fixture();
  try {
    const work = launchCli(
      (command, args, options) => {
        assert.equal(args[0], "--import");
        assert.ok(args[1].startsWith("file:"), "Node --import requires an ESM file URL on Windows");
        assert.equal(fileURLToPath(args[1]), preload);
        assert.equal(
          sha(regular(fileURLToPath(args[1]))),
          specification.harness["tools/windows-c15/cli-lifecycle-preload.mjs"],
        );
        assert.equal(args[2], f.entry);
        const binding = JSON.parse(options.env.C15_CLI_LIFECYCLE);
        assert.equal(binding.entry, f.entry);
        assert.equal(binding.cwd, f.root);
        return spawn(command, args, options);
      },
      process.execPath,
      [f.entry, path.join(f.root, "url-ticks")],
      { cwd: f.root, env: { ...process.env } },
    );
    await work.completed;
    const special = path.join(f.root, "space # % 日本語");
    fs.mkdirSync(special);
    for (const name of ["cli-lifecycle.mjs", "cli-lifecycle-preload.mjs", "manifest.mjs", "candidate.json"])
      fs.copyFileSync(path.join(harness, "tools/windows-c15", name), path.join(special, name));
    const relocated = await import(pathToFileURL(path.join(special, "cli-lifecycle.mjs")).href);
    const relocatedWork = relocated.launchCli(
      (command, args, options) => {
        assert.equal(fileURLToPath(args[1]), path.join(special, "cli-lifecycle-preload.mjs"));
        return spawn(command, args, options);
      },
      process.execPath,
      [f.entry, path.join(f.root, "special-ticks")],
      { cwd: f.root, env: { ...process.env } },
    );
    await relocatedWork.completed;
    for (const [native, windows] of [
      [String.raw`C:\runner path\#hash%percent\日本語\preload.mjs`, true],
      [String.raw`\\server\share\space # %\preload.mjs`, true],
      ["/tmp/space # %/日本語/preload.mjs", false],
    ]) {
      const url = pathToFileURL(native, { windows });
      assert.equal(url.protocol, "file:");
      assert.equal(fileURLToPath(url, { windows }), native);
      assert.ok(!url.href.includes(" ") && !url.hash);
    }
  } finally {
    await cleanupFixture(f);
  }
});

// These fixtures exercise the production preload/pipe/validator with actual child
// computations. Delays/blocking exist only in adversarial tests, never the campaign.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c15-lifecycle-"));
  const entry = path.join(root, "main.mjs");
  fs.writeFileSync(
    entry,
    `
    import fs from "node:fs";
    import {createHash} from "node:crypto";
    const ticks = [];
    let bytes = Buffer.alloc(262144, 7);
    for (let i = 0; i < 10; i++) {
      bytes = createHash("sha256").update(bytes).digest();
      ticks.push(process.hrtime.bigint().toString());
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(ticks));
    process.on("exit", () => fs.writeFileSync(process.argv[2] + ".exiting", "done"));
    process.exit(0);
  `,
  );
  return { root, entry, children: [] };
}
function tracked(f, index, entry = f.entry, launch = spawn) {
  const ticks = path.join(f.root, String(index));
  const tracked = launchCli(launch, process.execPath, [entry, ticks], { cwd: f.root, env: { ...process.env } });
  // Observe immediately, even when a synchronous adversary throws before await.
  // Keep the original promise rejected so assertions still see the failure.
  tracked.completed.catch(() => {});
  const closed = new Promise((resolve) => tracked.child.once("close", resolve));
  f.children.push({ ...tracked, closed });
  return { ...tracked, ticks };
}
async function cleanupFixture(f) {
  for (const { child } of f.children) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(f.children.map(({ closed }) => closed));
  await Promise.allSettled(f.children.map(({ completed }) => completed));
  fs.rmSync(f.root, { recursive: true, force: true });
}
async function clockWorkload(f) {
  const executionMembers = [],
    cells = [];
  for (let index = 0; index < DEMO_COUNT; index++) {
    const work = tracked(f, index);
    executionMembers.push({ index, ...(await work.completed) });
    cells.push(...JSON.parse(fs.readFileSync(work.ticks)).map((faultEnteredNs) => ({ faultEnteredNs })));
  }
  cells.forEach((cell, index) => {
    cell.target = targets[index];
  });
  return { mode: "on", executionMembers, diagnostic: { cells } };
}
test("child-owned lifecycle accepts faults during two actual subprocess computations", async () => {
  const f = fixture();
  try {
    const row = await clockWorkload(f);
    validateOverlap(row);
    validateOverlap({ ...row, mode: "off", diagnostic: { cells: [] } });
    for (const member of row.executionMembers) validateLifecycle(member);
  } finally {
    await cleanupFixture(f);
  }
});
test("rejects missing, late, substituted, duplicate and failed child receipts", async () => {
  const f = fixture();
  try {
    const row = await clockWorkload(f);
    const mutate = (change) => {
      const copy = structuredClone(row);
      change(copy);
      assert.throws(() => validateOverlap(copy));
    };
    for (const key of ["nonce", "pid", "entry", "cwd", "preloadSha256", "exitCode"])
      mutate((copy) => {
        copy.executionMembers[0].lifecycleReceipt[key] = "substituted";
      });
    mutate((copy) => {
      delete copy.executionMembers[0].lifecycleReceipt;
    });
    mutate((copy) => {
      copy.executionMembers[1].lifecycleReceipt = copy.executionMembers[0].lifecycleReceipt;
    });
    mutate((copy) => {
      copy.executionMembers[1].lifecycleReceipt.endedNs = String(
        BigInt(copy.executionMembers[1].parentExitDeliveredNs) + 1n,
      );
    });
    mutate((copy) => {
      copy.diagnostic.cells[19].faultEnteredNs = copy.executionMembers[1].lifecycleReceipt.endedNs;
    });
    mutate((copy) => {
      copy.diagnostic.cells[0].faultEnteredNs = copy.executionMembers[0].parentSpawnedNs;
    });
    mutate((copy) => {
      delete copy.diagnostic.cells[0].faultEnteredNs;
    });
    mutate((copy) => {
      copy.diagnostic.cells.pop();
    });
    mutate((copy) => {
      copy.executionMembers.pop();
    });
    mutate((copy) => {
      copy.executionMembers[1].exitCode = 2;
      copy.executionMembers[1].lifecycleReceipt.exitCode = 2;
    });
    mutate((copy) => {
      copy.executionMembers[1].lifecycleReceipt.startedNs = copy.executionMembers[0].lifecycleReceipt.startedNs;
    });
    mutate((copy) => {
      copy.diagnostic.cells[0].faultEnteredNs = "-1";
    });
    const bad = path.join(f.root, "bad.mjs");
    for (const script of [
      "process.exit(2);",
      'process.kill(process.pid, "SIGKILL");',
      'import fs from "node:fs"; fs.writeFileSync(3, "substituted\\n"); process.exit(0);',
      'import fs from "node:fs"; fs.writeFileSync(3, "x".repeat(5000)); process.exit(0);',
      'process.removeAllListeners("exit"); process.exit(0);',
      'import fs from "node:fs"; process.removeAllListeners("exit"); fs.writeFileSync(3, "{"); process.exit(0);',
    ]) {
      fs.writeFileSync(bad, script);
      await assert.rejects(tracked(f, "bad", bad).completed);
    }
  } finally {
    await cleanupFixture(f);
  }
});
test("startup failure reports bounded stderr and remains rejected during adversarial cleanup", async () => {
  const f = fixture();
  try {
    const bad = path.join(f.root, "startup-failure.mjs");
    fs.writeFileSync(bad, 'import "./missing-startup-module.mjs";');
    const work = tracked(f, "startup", bad, (command, args, options) => {
      // Inject a missing preload to fail before any receipt exit handler exists.
      args[1] = pathToFileURL(path.join(f.root, "missing-startup-module.mjs")).href;
      return spawn(command, args, options);
    });
    // Let failure settle before awaiting, as when the synchronous adversary throws.
    await f.children.at(-1).closed;
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(work.ready, /before readiness/);
    await assert.rejects(work.completed, (error) => {
      assert.match(error.message, /empty child lifecycle receipt/);
      assert.match(error.message, /exit=1; receiptBytes=0/);
      assert.match(error.message, /ERR_MODULE_NOT_FOUND/);
      assert.match(error.message, /missing-startup-module/);
      return true;
    });
    fs.writeFileSync(
      bad,
      'process.removeAllListeners("exit"); process.stderr.write("x".repeat(100000) + "TAIL-MARKER");',
    );
    await assert.rejects(tracked(f, "large-stderr", bad).completed, (error) => {
      assert.match(error.message, /stderrBytes=100011/);
      assert.match(error.message, /TAIL-MARKER/);
      assert.ok(error.message.length < 5000, "stderr retention is bounded");
      return true;
    });
  } finally {
    await cleanupFixture(f);
  }
});

// The blocker is a separate test-only preload, released explicitly by IPC. No
// timer determines success: both modes must remain parked until the real,
// digest-pinned child preload can emit its validated start frame.
test("slow child startup gates both Off and On fault work on actual preload readiness", async () => {
  for (const mode of ["off", "on"]) {
    const f = fixture();
    try {
      const blocker = path.join(f.root, "before-preload.mjs");
      fs.writeFileSync(
        blocker,
        `
        process.send("blocked");
        await new Promise(resolve => process.once("message", resolve));
      `,
      );
      fs.writeFileSync(
        f.entry,
        `
        process.send("entry");
        await new Promise(resolve => process.once("message", resolve));
        process.disconnect();
      `,
      );
      const work = tracked(f, mode, f.entry, (command, args, options) =>
        spawn(command, ["--import", pathToFileURL(blocker).href, ...args], {
          ...options,
          stdio: [...options.stdio, "ipc"],
        }),
      );
      let faultEnteredNs;
      const campaign = work.ready.then(() => {
        faultEnteredNs = process.hrtime.bigint().toString();
      });
      campaign.catch(() => {});
      assert.deepEqual(await once(work.child, "message"), ["blocked", undefined]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(faultEnteredNs, undefined, `${mode} must not start faults on spawn`);
      const entry = once(work.child, "message");
      work.child.send("release-start");
      const ready = await work.ready;
      await campaign;
      await entry;
      assert.equal(ready.startReceipt.pid, work.child.pid);
      assert.ok(BigInt(ready.startReceipt.startedNs) < BigInt(faultEnteredNs));
      assert.ok(BigInt(ready.parentReadyDeliveredNs) <= BigInt(faultEnteredNs));
      work.child.send("finish");
      const member = await work.completed;
      assert.deepEqual(member.startReceipt, ready.startReceipt);
      validateLifecycle(member);
    } finally {
      await cleanupFixture(f);
    }
  }
});

// Controlled child pipe events exercise framing, early failure and deadlines
// without a real-time sleep or relying on OS chunk/exit delivery order.
function protocolFixture() {
  let expected;
  const child = new EventEmitter();
  Object.assign(child, {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [null, null, null, new PassThrough()],
  });
  const work = launchCli(
    (_command, _args, options) => {
      expected = JSON.parse(options.env.C15_CLI_LIFECYCLE);
      return child;
    },
    process.execPath,
    ["synthetic-entry"],
    { cwd: "synthetic-cwd", env: {} },
  );
  const start = {
    schema: 2,
    kind: "start",
    ...expected,
    pid: child.pid,
    startedNs: process.hrtime.bigint().toString(),
  };
  const write = (...frames) => child.stdio[3].write(frames.map((frame) => JSON.stringify(frame) + "\n").join(""));
  const close = (code = 0) => {
    child.exitCode = code;
    child.emit("exit", code, null);
    child.stdio[3].end();
    // Let PassThrough deliver EOF before ChildProcess.close, as spawn does.
    setImmediate(() => child.emit("close", code, null));
  };
  return { ...work, start, write, close };
}
test("fragmented start/final frames require final receipt, EOF and exit before acceptance", async () => {
  const f = protocolFixture();
  let ready = false,
    completed = false;
  f.ready.then(() => {
    ready = true;
  });
  f.completed.then(() => {
    completed = true;
  });
  const frame = JSON.stringify(f.start);
  f.child.stdio[3].write(frame.slice(0, 10));
  await Promise.resolve();
  assert.equal(ready, false);
  f.child.stdio[3].write(frame.slice(10));
  await Promise.resolve();
  assert.equal(ready, false, "newline framing is mandatory");
  f.child.stdio[3].write("\n");
  await f.ready;
  assert.equal(ready, true);
  f.write({ ...f.start, kind: "final", endedNs: process.hrtime.bigint().toString(), exitCode: 0 });
  await Promise.resolve();
  assert.equal(completed, false);
  f.close();
  validateLifecycle(await f.completed);
});
test("invalid, stale, duplicate or failed starts cannot authorize diagnostic work", async () => {
  const cases = [
    (f) => f.child.emit("error", Error("spawn failed")),
    (f) => f.close(2),
    (f) => f.child.emit("close", 0, null),
    (f) => f.child.stdio[3].destroy(),
    (f) => f.child.stdio[3].write("not-json\n"),
    (f) => f.write({ ...f.start, schema: 1 }),
    (f) => f.write({ ...f.start, kind: "final" }),
    (f) => f.write({ ...f.start, startedNs: "0" }),
    (f) => f.write({ ...f.start, startedNs: String(process.hrtime.bigint() + 10n ** 18n) }),
    (f) => f.write(f.start, f.start),
    (f) => f.write({ ...f.start, unexpected: true }),
    ...["nonce", "pid", "entry", "cwd", "preloadSha256"].map((key) => (f) => f.write({ ...f.start, [key]: "wrong" })),
    (f) => f.child.stdio[3].write("x".repeat(4097)),
  ];
  for (const inject of cases) {
    const f = protocolFixture();
    let campaignStarted = false;
    const campaign = f.ready.then(() => {
      campaignStarted = true;
    });
    campaign.catch(() => {});
    inject(f);
    await assert.rejects(campaign);
    await assert.rejects(f.completed);
    assert.equal(campaignStarted, false);
  }
});
test("readiness alone cannot replace final frame, EOF, successful exit or the launch deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Missing or unterminated start remains bounded, even with no child events.
    for (const partial of ["", '{"schema":2']) {
      const f = protocolFixture();
      if (partial) f.child.stdio[3].write(partial);
      t.mock.timers.tick(CLI_LIMIT_MS);
      await assert.rejects(f.ready, /cli-deadline/);
      await assert.rejects(f.completed, /cli-deadline/);
    }
    for (const state of [
      "no-final",
      "no-eof",
      "no-close",
      "failed-exit",
      "mismatched-final",
      "duplicate-start",
      "oversized-total",
    ]) {
      const f = protocolFixture();
      // Move most of the launch budget before readiness, then prove it is not reset.
      t.mock.timers.tick(CLI_LIMIT_MS - 1000);
      f.write(f.start);
      await f.ready;
      const final = { ...f.start, kind: "final", endedNs: process.hrtime.bigint().toString(), exitCode: 0 };
      if (state === "no-eof" || state === "no-close") f.write(final);
      if (state === "no-close") f.child.stdio[3].end();
      if (state === "failed-exit") f.close(2);
      if (state === "mismatched-final") f.write({ ...final, startedNs: String(BigInt(f.start.startedNs) + 1n) });
      if (state === "duplicate-start") f.write(f.start);
      if (state === "oversized-total") f.child.stdio[3].write(" ".repeat(4096));
      t.mock.timers.tick(1000);
      await assert.rejects(f.completed);
    }
  } finally {
    t.mock.timers.reset();
  }
});

function independentEntries(f, afterFile) {
  // execFileSync intentionally blocks the supervisor while a separate fault
  // process observes the CLI beginning exit, then records all 20 entries.
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import fs from "node:fs";
    const until = Date.now() + 5000;
    while (!fs.existsSync(process.argv[1])) {
      if (Date.now() > until) process.exit(3);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    process.stdout.write(JSON.stringify(Array.from({length: 20}, () => process.hrtime.bigint().toString())));
  `,
        afterFile,
      ],
      { cwd: f.root, encoding: "utf8", timeout: 10000 },
    ),
  );
}
test("delayed parent exit delivery cannot accept 20 independent post-exit entries", async () => {
  const f = fixture();
  try {
    const first = tracked(f, 0);
    // Parent cannot deliver exit/pipe callbacks until this synchronous child
    // returns. Its faults are strictly after the CLI's child-stamped end.
    const entries = independentEntries(f, first.ticks + ".exiting");
    const member = { index: 0, ...(await first.completed) };
    for (const entry of entries) {
      assert.ok(BigInt(entry) > BigInt(member.lifecycleReceipt.endedNs));
      assert.ok(BigInt(entry) < BigInt(member.parentExitDeliveredNs));
    }
    const second = tracked(f, 1);
    const row = {
      mode: "on",
      executionMembers: [member, { index: 1, ...(await second.completed) }],
      diagnostic: { cells: entries.map((faultEnteredNs, i) => ({ target: targets[i], faultEnteredNs })) },
    };
    // The superseded parent bracket would accept every one of these entries.
    assert.throws(() => validateOverlap(row), /fault-outside-cli-execution/);
  } finally {
    await cleanupFixture(f);
  }
});
test("independent entries in the real inter-demo gap are rejected", async () => {
  const f = fixture();
  try {
    const first = tracked(f, 0);
    const member = { index: 0, ...(await first.completed) };
    const entries = independentEntries(f, first.ticks + ".exiting");
    const second = tracked(f, 1);
    const next = { index: 1, ...(await second.completed) };
    for (const entry of entries) {
      assert.ok(BigInt(entry) > BigInt(member.lifecycleReceipt.endedNs));
      assert.ok(BigInt(entry) < BigInt(next.lifecycleReceipt.startedNs));
    }
    assert.throws(
      () =>
        validateOverlap({
          mode: "on",
          executionMembers: [member, next],
          diagnostic: { cells: entries.map((faultEnteredNs, i) => ({ target: targets[i], faultEnteredNs })) },
        }),
      /fault-outside-cli-execution/,
    );
  } finally {
    await cleanupFixture(f);
  }
});

test("conservative captured-clock gate rejects both boundaries and their exclusion zones", async () => {
  assert.equal(BOUNDARY_EXCLUSION_NS, 2000n);
  const f = fixture();
  try {
    const row = await clockWorkload(f);
    const receipt = row.executionMembers[0].lifecycleReceipt;
    const start = BigInt(receipt.startedNs),
      end = BigInt(receipt.endedNs);
    for (const entry of [
      start - 1n,
      start,
      start + 1n,
      start + BOUNDARY_EXCLUSION_NS,
      end - BOUNDARY_EXCLUSION_NS,
      end - 1n,
      end,
      end + 1n,
    ]) {
      const copy = structuredClone(row);
      copy.diagnostic.cells[0].faultEnteredNs = String(entry);
      assert.throws(() => validateOverlap(copy), /fault-outside-cli-execution/);
    }
  } finally {
    await cleanupFixture(f);
  }
});

test("bounded parity probe reuses the exact candidate semantic/work oracle", () => {
  const supervisor = read("packages/app/test/recovery-preparation/windows-c15-candidate.mjs");
  const parity = read("tools/windows-c15/parity.mjs");
  const oracle = (text) => text.slice(text.indexOf("function normalize(v) {"), text.indexOf("async function run(mode"));
  assert.equal(oracle(parity), oracle(supervisor));
  assert.match(parity, /for \(const mode of \["normal", "preload"\]\) for \(let index = 0; index < 2; index\+\+\)/);
  assert.match(parity, /row.oracle.artifactCount, 29/);
  assert.match(parity, /normal: 58, preload: 58/);
  assert.match(parity, /50000/);
  assert.match(parity, /rawBase64/);
  assert.match(parity, /receiptEof, true/);
  assert.doesNotMatch(parity, /globalThis.gc|global.gc|--expose-gc/);
});
