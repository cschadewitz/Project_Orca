/** Exactly two normal and two preload demos on the verified product build; no Windows acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { specification, verifyBuild, sha, regular, git, harness } from "./manifest.mjs";
import { launchCli } from "./cli-lifecycle.mjs";
const [sourceArg, reportArg] = process.argv.slice(2);
assert.ok(sourceArg && reportArg, "source and fresh report path required");
const repo = path.resolve(sourceArg),
  report = path.resolve(reportArg);
assert.equal(fs.existsSync(report), false, "never replace evidence");
verifyBuild(repo);
const { fileStores } = await import(pathToFileURL(path.join(repo, "packages/store/dist/index.js")));
const { parseFrontMatter } = await import(pathToFileURL(path.join(repo, "packages/core/dist/index.js")));
const entry = path.join(repo, "packages/cli/dist/main.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "orca-c15-parity-"));
const result = {
  schema: 1,
  sourceCommit: specification.sourceCommit,
  sourceTree: specification.sourceTree,
  harnessHead: git(harness, "rev-parse", "HEAD").toString().trim(),
  manifestSha256: sha(regular(new URL("candidate.json", import.meta.url))),
  runnerSha256: sha(regular(new URL(import.meta.url))),
  preloadSha256: specification.harness["tools/windows-c15/cli-lifecycle-preload.mjs"],
  node: process.version,
  nodeExecutableSha256: sha(regular(process.execPath)),
  platform: process.platform,
  root,
  cliLimitMs: 50000,
  demosPerMode: 2,
  rows: [],
  scope:
    "Bounded normal/preload product parity only; no Windows, diagnostic, memory, timing or fault-overlap acceptance.",
};
const save = () => fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
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
async function run(mode, index) {
  const directory = path.join(root, `${mode}-${index}`);
  fs.mkdirSync(directory);
  const args = [entry, "demo", "--dir", directory, "--keep", "--quiet"];
  const options = { cwd: directory, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe", "pipe"] };
  const started = performance.now();
  const tracked = mode === "preload" ? launchCli(spawn, process.execPath, args, options) : null;
  const child = tracked ? tracked.child : spawn(process.execPath, args, options);
  const raw = [];
  let receiptEof = false,
    outputBytes = 0;
  child.stdio[3].on("data", (bytes) => raw.push(bytes));
  child.stdio[3].once("end", () => {
    receiptEof = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      outputBytes += bytes.length;
    });
  // Attach immediately so a malformed live receipt cannot become an unhandled rejection.
  const lifecycle = tracked ? tracked.completed : Promise.resolve(null);
  let timer;
  let member, exitCode;
  try {
    [member, exitCode] = await Promise.race([
      Promise.all([
        lifecycle,
        new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => (signal ? reject(Error(signal)) : resolve(code)));
        }),
      ]),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(Error("CLI exceeded unchanged 50-second bound"));
        }, 50000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const receiptBytes = Buffer.concat(raw);
  assert.equal(receiptEof, true, "receipt pipe EOF required");
  assert.ok(receiptBytes.length <= 4096);
  const row = {
    mode,
    index,
    exitCode,
    elapsedMs: performance.now() - started,
    oracle: await semanticOracle(directory),
    counts: normalize(JSON.parse(fs.readFileSync(path.join(directory, ".orca-demo/state.json"), "utf8")).counts),
    playbookSha256: sha(regular(path.join(directory, "demo-playbook.yaml"))),
    normalizedConfigSha256: sha(
      fs.readFileSync(path.join(directory, "orca.config.yaml"), "utf8").replaceAll(directory, "<demo-root>"),
    ),
    outputBytes,
  };
  if (tracked) {
    // Retain raw bytes AND the independently captured launch/PID binding, unlike
    // the older supplemental report. launchCli already validated them live.
    row.lifecycle = {
      expected: member,
      rawBase64: receiptBytes.toString("base64"),
      rawSha256: sha(receiptBytes),
      eof: receiptEof,
      actualPid: child.pid,
    };
    assert.deepEqual(
      receiptBytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((frame) => JSON.parse(frame)),
      [member.startReceipt, member.lifecycleReceipt],
    );
  } else assert.equal(receiptBytes.length, 0);
  result.rows.push(row);
  save();
  process.stdout.write(
    JSON.stringify({
      mode,
      index,
      exitCode,
      elapsedMs: row.elapsedMs,
      artifactCount: row.oracle.artifactCount,
      semanticSignature: row.oracle.semanticSignature,
    }) + "\n",
  );
  assert.equal(exitCode, 0);
  assert.equal(row.oracle.artifactCount, 29);
}
try {
  for (const mode of ["normal", "preload"]) for (let index = 0; index < 2; index++) await run(mode, index);
  const first = result.rows[0];
  for (const [name, value] of Object.entries({
    semanticEqual: (row) => row.oracle.semanticSignature,
    workEqual: (row) => row.oracle.workItems,
    counterEqual: (row) => row.counts,
    playbookEqual: (row) => row.playbookSha256,
    configEqual: (row) => row.normalizedConfigSha256,
  })) {
    result[name] = result.rows.every((row) => JSON.stringify(value(row)) === JSON.stringify(value(first)));
    assert.equal(result[name], true, name);
  }
  result.artifactsByMode = Object.fromEntries(
    ["normal", "preload"].map((mode) => [
      mode,
      result.rows.filter((row) => row.mode === mode).reduce((sum, row) => sum + row.oracle.artifactCount, 0),
    ]),
  );
  assert.deepEqual(result.artifactsByMode, { normal: 58, preload: 58 });
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error);
  throw error;
} finally {
  save();
}
