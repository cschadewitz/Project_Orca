/** Supervise bounded, disposable, compiled persistence workloads and write reviewable evidence. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem, version } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { supervise, usage } from "./supervisor.js";
import { BASELINE, LIMITS, plan, rotate, summarize } from "./model.js";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../..");
const owned = ["tools/benchmarks/persistence-baseline/", "docs/performance/persistence-baseline/"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const command = (file, args) => execFileSync(file, args, { cwd: source, encoding: "utf8", timeout: 10_000 }).trim();
const git = (...args) => command("git", args);
const options = { profile: "smoke", seed: "423" };
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, "");
  if (!["profile", "scratch", "output", "seed"].includes(key) || !process.argv[index + 1])
    throw new Error(
      "Usage: node run.js --scratch EXISTING-DIR --output NEW-DIR [--profile smoke|baseline] [--seed UINT32]",
    );
  options[key] = process.argv[index + 1];
}
const cases = plan(options.profile);
if (!options.scratch || !options.output || !/^\d+$/.test(options.seed) || Number(options.seed) > 0xffffffff)
  throw new Error("scratch, new output directory and uint32 seed required");
if (platform() !== "linux") throw new Error("blocked: supervisor currently requires Linux /proc and process groups");
const scratch = await realpath(options.scratch);
const output = resolve(options.output);
await mkdir(output, { mode: 0o700 }); // Never overwrite an earlier report.
const started = performance.now();
const root = await mkdtemp(join(scratch, "orca-persistence-"));
const report = {
  schemaVersion: 1,
  status: "unrun",
  startedAt: new Date().toISOString(),
  command: [process.execPath, ...process.argv.slice(1)],
  profile: options.profile,
  seed: Number(options.seed),
  limits: LIMITS,
  cases,
  setup: [],
  samples: [],
  demos: [],
  constraints: {
    productionState: false,
    providerCalls: false,
    runtimeChanges: false,
    osCold: "blocked: no kernel cache eviction; fixture creation/copy heats OS cache",
    physicalHardware: "blocked: filesystem mount evidence alone does not attest physical media or power-loss behavior",
    candidateComparison: "unrun: only this approved main baseline is executed",
    internalAttribution: "blocked: no public key-read, decode, validation, catalog-scan or fsync counters/timers",
  },
};

const child = (args, build = false) =>
  supervise(args, {
    cwd: source,
    root,
    started,
    limits: build ? { ...LIMITS, rssBytes: LIMITS.buildRssBytes } : LIMITS,
  });

async function worker(action, path, spec, cache = "process-cold") {
  const result = await child([
    join(here, "worker.js"),
    action,
    source,
    path,
    JSON.stringify(spec),
    cache,
    options.seed,
  ]);
  const { stdout, ...metadata } = result;
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    /* Retain failed outcome without unsafe raw diagnostics. */
  }
  return {
    ...metadata,
    status:
      metadata.status === "passed" && data && !data.error ? "passed" : metadata.status === "unrun" ? "unrun" : "failed",
    result: data,
  };
}

async function artifacts() {
  const entries = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (/\.(js|cjs|json)$/.test(entry.name)) {
        const bytes = await readFile(target);
        entries.push({ path: relative(source, target), bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  for (const name of (await readdir(join(source, "packages"))).sort()) {
    const path = join(source, "packages", name, "dist");
    try {
      await visit(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { entries, sha256: hash(JSON.stringify(entries)) };
}

async function save() {
  report.summary = summarize(report.samples);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}

try {
  // This harness intentionally does not import an active integration candidate.
  const changed = git("diff", "--name-only", BASELINE, "--").split("\n").filter(Boolean);
  if (changed.some((path) => !owned.some((prefix) => path.startsWith(prefix))))
    throw new Error("blocked: source differs from approved baseline outside owned paths");
  const fs = await statfs(root);
  if (fs.bavail * fs.bsize < LIMITS.diskBytes * 2) throw new Error("blocked: less than 512 MiB free");
  report.source = {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    approvedRuntimeCommit: BASELINE,
    approvedRuntimeTree: git("rev-parse", `${BASELINE}^{tree}`),
    originMainObserved: git("rev-parse", "origin/main"),
    ownedDiff: git("status", "--porcelain"),
    lockSha256: hash(await readFile(join(source, "pnpm-lock.yaml"))),
  };
  report.harness = await Promise.all(
    ["model.js", "run.js", "worker.js", "supervisor.js", "self-test.js"].map(async (path) => ({
      path,
      sha256: hash(await readFile(join(here, path))),
    })),
  );
  report.environment = {
    node: process.version,
    nodeSha256: hash(await readFile(process.execPath)),
    platform: platform(),
    release: release(),
    os: version(),
    arch: process.arch,
    cpu: cpus()[0]?.model,
    visibleCpus: cpus().length,
    memoryBytes: totalmem(),
    osRelease: await readFile("/etc/os-release", "utf8"),
    filesystem: {
      magic: fs.type,
      type: fs.type === 0x01021994 ? "tmpfs" : "disk-or-other",
      mount: command("findmnt", ["-T", root, "-n", "-o", "SOURCE,FSTYPE,OPTIONS"]),
      blocks: command("lsblk", ["-o", "NAME,TYPE,FSTYPE,ROTA,MOUNTPOINTS"]),
    },
    monitor: "1s allocated-byte/file scans and process-group RSS sampling; 384 MiB V8 heap; no cache eviction",
  };
  const buildArgs = ["node_modules/typescript/lib/tsc.js", "-b", "tsconfig.build.json", "--force"];
  const { stdout: buildOutput, ...build } = await child(buildArgs, true);
  report.build = { ...build, command: [process.execPath, ...buildArgs], stdoutSha256: hash(buildOutput ?? "") };
  if (build.status !== "passed") throw new Error("blocked: compiled build failed");
  const compiled = await artifacts();
  await writeFile(join(output, "artifacts.json"), JSON.stringify(compiled, null, 2) + "\n", { mode: 0o600 });
  report.artifactManifestSha256 = hash(await readFile(join(output, "artifacts.json")));
  report.status = "running";
  for (const spec of cases) {
    const fixture = join(root, spec.id);
    await mkdir(fixture, { mode: 0o700 });
    report.setup.push({ case: spec, ...(await worker("generate", fixture, spec)) });
  }
  for (let round = 0; round < LIMITS.repetitions; round++) {
    for (const [index, spec] of rotate(cases, round).entries()) {
      for (const cache of rotate(["process-cold", "warm"], round + index)) {
        const sample = { round, case: spec, cache, status: "unrun" };
        report.samples.push(sample);
        if (performance.now() - started >= LIMITS.suiteMs) sample.reason = "suite-deadline";
        else if (report.setup.find((row) => row.case.id === spec.id).status !== "passed")
          sample.reason = "fixture-failed";
        else {
          const copy = join(root, "sample");
          await cp(join(root, spec.id), copy, { recursive: true, errorOnExist: true, force: false });
          await usage(root);
          Object.assign(sample, await worker("measure", copy, spec, cache));
          await rm(copy, { recursive: true, force: true });
        }
        await save();
      }
    }
  }
  for (let round = 0; round < (options.profile === "smoke" ? 1 : LIMITS.repetitions); round++) {
    const path = join(root, `demo-${round}`);
    const args = ["packages/cli/dist/main.js", "demo", "--dir", path];
    const { stdout, ...result } = await child(args);
    report.demos.push({
      round,
      command: [process.execPath, ...args],
      ...result,
      stdoutSha256: hash(stdout ?? ""),
      stdoutBytes: Buffer.byteLength(stdout ?? ""),
      oracle: "compiled scripted CLI demo exit code; no provider calls",
    });
    await rm(path, { recursive: true, force: true });
  }
  report.finalUsage = await usage(root);
  const finalCompiled = await artifacts();
  if (finalCompiled.sha256 !== compiled.sha256 || git("rev-parse", "HEAD") !== report.source.commit)
    throw new Error("source-or-artifacts-changed-during-suite");
  report.status = [...report.setup, ...report.samples, ...report.demos].every((row) => row.status === "passed")
    ? "passed"
    : "failed";
} catch (error) {
  report.status = error.message.startsWith("blocked:") ? "blocked" : "failed";
  report.error = error.message;
} finally {
  report.elapsedMs = performance.now() - started;
  await rm(root, { recursive: true, force: true });
  report.cleanup = "passed";
  await save();
}
console.log(JSON.stringify({ status: report.status, report: join(output, "report.json") }));
if (report.status !== "passed") process.exitCode = 1;
