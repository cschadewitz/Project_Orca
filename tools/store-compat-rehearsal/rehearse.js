#!/usr/bin/env node
/**
 * Disposable cross-version store rehearsal: prior release -> candidate -> offline restore.
 *
 *   node tools/store-compat-rehearsal/rehearse.js --old <checkout> --new <checkout> --work <new dir>
 *        [--entry source|dist] [--old-node <node>] [--new-node <node>]
 *
 * Both checkouts need their own dependencies installed (`pnpm install --frozen-lockfile`;
 * `pnpm run build` too for `--entry dist`). Everything is written under --work, which must
 * not exist; nothing is deleted, including on failure, and no operator workspace, service,
 * credential or network is used. The store comes from the prior release's own scripted
 * `demo`, so it is that release's source output on this machine - synthetic, never
 * installed evidence. The prior binary only ever writes its own fresh store and, after the
 * restore, that same restored store; the candidate's records are judged by the prior
 * release's schemas in-process (schema-read.js) instead of by running the prior binary on
 * them. See docs/preparation/store-compatibility-rehearsal/README.md.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareSnapshots, copyToNew, snapshotRoots } from "./snapshot.js";

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    work: { type: "string" },
    entry: { type: "string", default: "source" },
    "old-node": { type: "string", default: process.execPath },
    "new-node": { type: "string", default: process.execPath },
  },
});
if (!options.old || !options.new || !options.work || !["source", "dist"].includes(options.entry)) {
  console.error("usage: rehearse.js --old <checkout> --new <checkout> --work <new dir> [--entry source|dist]");
  process.exit(2);
}
const work = resolve(options.work);
if (existsSync(work)) {
  console.error(`refusing: ${work} already exists; give a directory that does not`);
  process.exit(2);
}
const sides = {
  old: { checkout: resolve(options.old), node: options["old-node"] },
  new: { checkout: resolve(options.new), node: options["new-node"] },
};
// Operator settings must not leak into a disposable rehearsal (daemon URLs, workspaces,
// update fences, admission files, tokens).
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")));

function describe(side) {
  const { checkout, node } = sides[side];
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  const json = (file) => JSON.parse(readFileSync(join(checkout, file), "utf8"));
  const manifest = json("release-compatibility.json");
  const pkg = json("package.json");
  return {
    checkout,
    commit: git("rev-parse", "HEAD"),
    modified: git("status", "--porcelain", "--untracked-files=no") !== "",
    version: pkg.version,
    nodeEngine: pkg.engines?.node,
    node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
    storeEpoch: manifest.storeEpoch,
    protocol: manifest.protocol,
    capabilities: manifest.capabilities,
  };
}

function command(side, args) {
  const { checkout, node } = sides[side];
  return options.entry === "dist"
    ? { file: node, args: [join(checkout, "packages/cli/dist/main.js"), ...args], cwd: checkout }
    : { file: node, args: ["--import", "tsx", join(checkout, "packages/cli/src/main.ts"), ...args], cwd: checkout };
}

/** Run one CLI command to completion, or until `until` matches its output and then SIGTERM. */
function run(side, args, { until, timeoutMs = 600_000 } = {}) {
  const { file, args: argv, cwd } = command(side, args);
  return new Promise((done) => {
    const child = spawn(file, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let matched = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const watch = (chunk) => {
      output += chunk;
      if (until && !matched && until.test(output)) {
        matched = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", watch);
    child.stderr.on("data", watch);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ side, args, code, signal, matched, tail: output.split("\n").slice(-6).join("\n") });
    });
  });
}

/** Point a disposable copy's config at its own store. Refuses anything but the one demo line. */
async function retarget(copy, original) {
  const file = join(copy, "orca.config.yaml");
  const text = await readFile(file, "utf8");
  const from = `storeDir: ${join(original, ".orca")}\n`;
  if (text.split(from).length !== 2) throw new Error(`refusing to retarget ${file}: unexpected storeDir`);
  await writeFile(file, text.replace(from, `storeDir: ${join(copy, ".orca")}\n`));
}

function schemaRead(side, store) {
  const { checkout, node } = sides[side];
  const out = execFileSync(node, ["--import", "tsx", join(here, "schema-read.js"), checkout, store], {
    cwd: checkout,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

const summarize = (comparison) => ({
  equal: comparison.equal,
  added: comparison.added,
  removed: comparison.removed,
  changed: comparison.changed,
});
const report = {
  evidence: "synthetic source rehearsal: prior-release scripted demo store on this machine; not installed evidence",
  startedAt: new Date().toISOString(),
  entry: options.entry,
  old: describe("old"),
  new: describe("new"),
  steps: {},
};
const step = (name, value) => {
  report.steps[name] = value;
  console.log(`[${name}] ${JSON.stringify(value).slice(0, 400)}`);
};

await mkdir(work, { recursive: false });
const live = join(work, "workspace");
const backup = join(work, "backup", "workspace");
await mkdir(join(work, "backup"));

// 1. The prior release writes its own store.
const generated = await run("old", ["demo", "--dir", live, "--quiet"]);
step("generate", { code: generated.code, tail: generated.tail });
if (generated.code !== 0) throw new Error("prior-release demo failed; see the report");

// 2. Writers stopped (nothing is running): consistent manifest, then a verified offline copy.
const pre = await snapshotRoots({ workspace: live });
await writeFile(join(work, "pre-upgrade.manifest.json"), JSON.stringify(pre, null, 2));
await copyToNew(live, backup);
step("backup", {
  entries: pre.roots.workspace.entries.length,
  verified: compareSnapshots(pre, await snapshotRoots({ workspace: backup })).equal,
});

// 3. What the candidate writes when it merely opens the prior store (fresh copy each time).
const probes = [
  ["validate", ["validate"]],
  ["read command (runs)", ["runs"]],
  ["read-only daemon", ["serve", "--read-only", "--port", "0"], /listening on /],
];
const probeResults = [];
for (const [index, [name, args, until]] of probes.entries()) {
  const copy = join(work, `probe-${index}`, "workspace");
  await mkdir(dirname(copy));
  await copyToNew(backup, copy);
  await retarget(copy, live);
  const before = await snapshotRoots({ workspace: copy });
  const result = await run("new", [...args, "--cwd", copy], { until, timeoutMs: 120_000 });
  probeResults.push({
    name,
    code: result.code,
    signal: result.signal,
    reachedReady: until ? result.matched : undefined,
    writes: summarize(compareSnapshots(before, await snapshotRoots({ workspace: copy }))),
  });
}
step("first-open probes", probeResults);

// 4. The candidate's scripted writer on the live store: the first upgraded writer.
const upgraded = await run("new", ["demo", "--dir", live, "--quiet"]);
const post = await snapshotRoots({ workspace: live });
step("upgrade", { code: upgraded.code, tail: upgraded.tail, writes: summarize(compareSnapshots(pre, post)) });

// 5. Attempted downgrade, measured without the prior binary: its schemas over the new records.
step("prior schemas over upgraded store", schemaRead("old", join(live, ".orca")));
step("candidate schemas over upgraded store (control)", schemaRead("new", join(live, ".orca")));

// 6. Rollback = keep the upgraded state aside, restore the whole backup to the original path.
const retained = join(work, "upgraded-retained", "workspace");
await mkdir(dirname(retained));
await rename(live, retained);
await copyToNew(backup, live);
const restored = await snapshotRoots({ workspace: live });
step("restore", {
  equalsPreUpgrade: compareSnapshots(pre, restored).equal,
  writesSinceBackupNeedingReconciliation: summarize(
    compareSnapshots(pre, await snapshotRoots({ workspace: retained })),
  ),
});

// 7. Offline validation with the matching prior binary, on its own restored store.
const validations = [];
for (const args of [["validate"], ["runs"]]) {
  const result = await run("old", [...args, "--cwd", live], { timeoutMs: 120_000 });
  validations.push({ args, code: result.code, tail: result.tail });
}
step("prior binary on restored store", {
  validations,
  writes: summarize(compareSnapshots(pre, await snapshotRoots({ workspace: live }))),
});

// 8. A partial or mixed restore must not pass as the backup. The partial copy has one run
// log moved out of it (kept beside it, not deleted); the mixed copy has one upgraded file.
const partial = join(work, "negative-partial", "workspace");
const mixed = join(work, "negative-mixed", "workspace");
for (const path of [partial, mixed]) {
  await mkdir(dirname(path));
  await copyToNew(backup, path);
}
const firstRun = readdirSync(join(partial, ".orca", "runs")).sort()[0];
await rename(join(partial, ".orca", "runs", firstRun), join(work, "negative-partial", `withheld-${firstRun}`));
await copyFile(join(retained, ".orca", "requests.json"), join(mixed, ".orca", "requests.json"));
step("negative restores", {
  partial: summarize(compareSnapshots(pre, await snapshotRoots({ workspace: partial }))),
  mixed: summarize(compareSnapshots(pre, await snapshotRoots({ workspace: mixed }))),
});

report.finishedAt = new Date().toISOString();
await writeFile(join(work, "report.json"), JSON.stringify(report, null, 2));
console.log(`report: ${join(work, "report.json")}`);
