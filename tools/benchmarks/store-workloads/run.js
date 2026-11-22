/**
 * Store workload benchmark (#341): the four workloads at one dataset scale over the chosen
 * backends, measured through the #338 store contracts. Needs built packages (`pnpm run build`,
 * or `npx tsc -b packages/store`).
 *
 *   node tools/benchmarks/store-workloads/run.js --scale small|medium|large|smoke
 *     [--backend memory,file,sqlite] [--seed 341] [--repeat 3] [--scratch DIR]
 *     [--workloads dependencyTraversal,paginatedHistory,concurrentMetadataWrites,projectionRebuild]
 *     [--output FILE]
 *
 * Writes the JSON report to --output (refusing to overwrite) or stdout, and progress to stderr.
 * The scratch directory holds the disposable store roots and is removed per backend; it defaults
 * to the OS temp dir. Nothing here touches a real ORCA store or makes a network call.
 * docs/performance/store-workloads/README.md describes the workloads, scales and report.
 */
import { execFileSync } from "node:child_process";
import { open } from "node:fs/promises";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBenchmark } from "./harness.js";
import { SCALE_NAMES } from "./scales.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const options = { backend: "memory,file", seed: "341", repeat: "3", scratch: tmpdir() };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  const value = process.argv[i + 1];
  if (!["scale", "backend", "seed", "repeat", "scratch", "workloads", "output"].includes(key) || value === undefined)
    throw new Error(
      `usage: run.js --scale ${SCALE_NAMES.join("|")} [--backend memory,file] [--seed N] [--repeat N] [--scratch DIR] [--workloads a,b] [--output FILE]`,
    );
  options[key] = value;
}
if (!SCALE_NAMES.includes(options.scale)) throw new Error(`--scale must be one of ${SCALE_NAMES.join(", ")}`);

const api = {
  store: await import("../../../packages/store/dist/index.js"),
  core: await import("../../../packages/core/dist/index.js"),
};
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};

const report = await runBenchmark({
  api,
  scale: options.scale,
  backends: options.backend.split(","),
  seed: Number(options.seed),
  repeat: Number(options.repeat),
  scratch: resolve(options.scratch),
  ...(options.workloads ? { workloads: options.workloads.split(",") } : {}),
  log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
});
const output = {
  ...report,
  recordedAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain") ? true : false,
  machine: {
    platform: platform(),
    release: release(),
    node: process.version,
    cpu: cpus()[0]?.model,
    cpus: cpus().length,
    memoryBytes: totalmem(),
    // On a GitHub-hosted runner, which image it was: the reference machine's identity.
    ...(process.env.ImageOS
      ? { runnerImage: { os: process.env.ImageOS, version: process.env.ImageVersion ?? null } }
      : {}),
  },
  limitations: [
    "Cold means a fresh store handle with empty in-process caches; the OS page cache is not dropped.",
    "Concurrent writers are handles in one process; cross-process exclusion is proven by the store tests, not timed here.",
    "No power-loss or fsync-latency attribution: durability is the backend's contract, not measured here.",
  ],
};
const json = `${JSON.stringify(output, null, 2)}\n`;
if (options.output) {
  const file = await open(resolve(options.output), "wx");
  await file.writeFile(json);
  await file.close();
} else process.stdout.write(json);
if (report.results.some((r) => r.status === "ran" && !r.checksPassed)) {
  process.stderr.write("A workload invariant failed; see the checks in the report.\n");
  process.exitCode = 1;
}
