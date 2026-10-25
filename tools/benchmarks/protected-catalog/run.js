/** Current-main C3-01 preparation, reusing the reviewed #423/#432 resource and ordering helpers. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { LIMITS, rotate, schedule, stats } from "../persistence-baseline/model.js";
import { supervise, usage } from "../persistence-baseline/supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../..");
const RUNTIME = "0f45181c52dfc4bf1edd0e4469ff688dedef9189";
const owned = ["tools/benchmarks/protected-catalog/", "docs/performance/protected-catalog/"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", timeout: 10_000 }).trim();
const options = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, "");
  if (!["scratch", "output"].includes(key) || !process.argv[index + 1])
    throw new Error("scratch and new output required");
  options[key] = process.argv[index + 1];
}
if (!options.scratch || !options.output || platform() !== "linux")
  throw new Error("Linux, scratch and output required");
const changed = git("diff", "--name-only", RUNTIME, "--").split("\n").filter(Boolean);
const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
if ([...changed, ...untracked].some((path) => !owned.some((prefix) => path.startsWith(prefix))))
  throw new Error("source differs from approved runtime outside owned paths");
const scratch = await realpath(options.scratch);
const output = resolve(options.output);
await mkdir(output, { mode: 0o700 });
const root = await mkdtemp(join(scratch, "orca-c3-catalog-"));
const started = performance.now();
const limits = { ...LIMITS, suiteMs: 300_000 };
const cases = [0, 128, 1024].map((catalog) => ({ id: `catalog-${catalog}`, catalog, history: 8 }));
const fs = await statfs(root);
if (fs.bavail * fs.bsize < limits.diskBytes * 2) throw new Error("less than 512 MiB free");
const report = {
  schemaVersion: 1,
  status: "running",
  command: [process.execPath, ...process.argv.slice(1)],
  source: {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    approvedRuntime: RUNTIME,
    runtimeTree: git("rev-parse", `${RUNTIME}^{tree}`),
    originMainObserved: git("rev-parse", "origin/main"),
    status: git("status", "--porcelain"),
    lockSha256: hash(await readFile(join(source, "pnpm-lock.yaml"))),
  },
  environment: {
    node: process.version,
    nodeSha256: hash(await readFile(process.execPath)),
    kernel: release(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    visibleCpus: cpus().length,
    osRelease: await readFile("/etc/os-release", "utf8"),
    filesystem: {
      magic: fs.type,
      mount: execFileSync("findmnt", ["-T", root, "-n", "-o", "FSTYPE"], { encoding: "utf8" }).trim(),
    },
  },
  limits,
  cases,
  constraints: {
    physicalMedia: "unverified; mount type is not physical-media/power-loss proof",
    storageCold: "unrun; fixture copy heats OS cache, no cache eviction",
    timing: "read process-cold/warm; appends follow reads; per-label unions overlap and are not additive",
    attribution: "builtin boundary counts; no JSON/schema/whole-private-phase CPU timer; other I/O is not exhaustive",
    security: "no runtime edits, key/identity/revocation shortcuts, provider calls or production data",
    observer: "child-only wrappers add overhead; off samples have no observers installed",
  },
  setup: [],
  samples: [],
};
const child = (args, build = false) =>
  supervise(args, {
    cwd: source,
    root,
    started,
    limits: build ? { ...limits, rssBytes: LIMITS.buildRssBytes } : limits,
  });
async function worker(action, path, spec, cache, observer) {
  const { stdout, ...metadata } = await child([
    join(here, "worker.js"),
    action,
    source,
    path,
    JSON.stringify(spec),
    cache,
    observer,
  ]);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    /* Keep sanitized outcome, not raw worker diagnostics. */
  }
  return {
    ...metadata,
    status: metadata.status === "passed" && result?.oracle === "passed" ? "passed" : "failed",
    result,
  };
}
async function manifest() {
  const entries = [];
  async function nested(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await nested(path);
      else if (entry.name.endsWith(".js")) {
        const name = relative(source, path);
        entries.push({ path: name, sha256: hash(await readFile(path)) });
      }
    }
  }
  for (const name of ["core", "store"]) await nested(join(source, "packages", name, "dist"));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
function summarize() {
  const result = [];
  for (const spec of cases)
    for (const cache of ["process-cold", "warm"])
      for (const observer of ["off", "counts"]) {
        const rows = report.samples.filter(
          (row) => row.case.id === spec.id && row.cache === cache && row.observer === observer,
        );
        const passed = rows.filter((row) => row.status === "passed");
        const labels = Object.keys(passed[0]?.result.operations ?? {});
        result.push({
          case: spec.id,
          cache,
          observer,
          outcomes: rows.map((row) => row.status),
          operations: Object.fromEntries(
            labels.map((label) => [label, stats(passed.map((row) => row.result.operations[label].wallMs))]),
          ),
        });
      }
  return result;
}
async function save() {
  report.summary = summarize();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
try {
  report.harness = await Promise.all(
    [
      ...["run.js", "worker.js", "probe.js", "self-test.js"].map((name) => join(here, name)),
      ...["model.js", "supervisor.js"].map((name) => join(here, "../persistence-baseline", name)),
    ].map(async (path) => ({ path: relative(source, path), sha256: hash(await readFile(path)) })),
  );
  const { stdout, ...build } = await child(
    ["node_modules/typescript/lib/tsc.js", "-b", "packages/store/tsconfig.json", "--force"],
    true,
  );
  report.build = { ...build, stdoutSha256: hash(stdout) };
  if (build.status !== "passed") throw new Error("build-failed");
  const artifacts = await manifest();
  await writeFile(join(output, "artifacts.json"), JSON.stringify(artifacts, null, 2) + "\n", { mode: 0o600 });
  report.artifactsSha256 = hash(await readFile(join(output, "artifacts.json")));
  for (const spec of cases) {
    const path = join(root, spec.id);
    await mkdir(path, { mode: 0o700 });
    report.setup.push({ case: spec.id, ...(await worker("generate", path, spec, "process-cold", "off")) });
  }
  for (const planned of schedule(cases)) {
    const { case: spec, cache, round } = planned;
    for (const observer of rotate(["off", "counts"], round + cases.indexOf(spec))) {
      const sample = { ...planned, observer, status: "unrun" };
      report.samples.push(sample);
      if (report.setup.find((row) => row.case === spec.id).status !== "passed") continue;
      const path = join(root, "sample");
      try {
        await cp(join(root, spec.id), path, { recursive: true, errorOnExist: true, force: false });
        await usage(root, limits);
        Object.assign(sample, await worker("measure", path, spec, cache, observer));
      } finally {
        await rm(path, { recursive: true, force: true });
      }
      await save();
    }
  }
  report.artifactsUnchanged = JSON.stringify(await manifest()) === JSON.stringify(artifacts);
  report.status =
    report.artifactsUnchanged && report.samples.every((row) => row.status === "passed") ? "passed" : "failed";
} catch {
  report.status = "failed";
  report.reason = "catalog-run-failed";
} finally {
  await save();
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: report.status, samples: report.samples.length }));
if (report.status !== "passed") process.exitCode = 1;
