/**
 * Stages and checks the receipts guard-receipts.yml signs (#1026), so that only this run's
 * validated outputs are signed and only those are proposed:
 *
 *   node tools/guard-qualification/stage-receipts.js stage <out-dir> <receipt.json>...
 *   node tools/guard-qualification/stage-receipts.js verify <dir>
 *
 * `stage` copies each receipt into an empty directory and writes `manifest.json` beside them:
 * this run's build, and each receipt's file name, SHA-256, agent, route and kind. A receipt is
 * staged only when it is an installed receipt of this build (`GITHUB_SHA`), for an agent and a
 * route the matrix lists, named `<agent>-<route>.json` (or `fault-<route>.json` for the
 * end-to-end check's fault run, which must name its fault). The signing job attests exactly the
 * files the manifest lists.
 *
 * `verify` checks a staged directory: the manifest lists exactly the receipts present, each
 * file's digest is the manifest's, and each one's attestation (`<receipt>.sigstore.json`)
 * verifies under `attestation.js`, whatever tier any row claims. The proposal job runs it again
 * on what it downloaded before it writes anything.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { attestationProblems } from "./attestation.js";
import { loadMatrix } from "./check-support-matrix.js";

export const MANIFEST = "manifest.json";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Why `receipt`, from a file named `name`, is not one this run may sign. Empty when it is. */
export function stageProblems(name, receipt, build, matrix = loadMatrix()) {
  const problems = [];
  if (receipt?.format !== "orca-enforcement-receipt/1") return [`${name}: not an orca-enforcement-receipt/1`];
  if (receipt.kind !== "installed") problems.push(`${name}: kind ${receipt.kind}, only installed receipts are signed`);
  if (receipt.build !== build) problems.push(`${name}: build ${receipt.build}, not this run's ${build}`);
  if (!matrix.agents.some((a) => a.id === receipt.agent)) problems.push(`${name}: no row for agent ${receipt.agent}`);
  if (!matrix.paths.some((p) => p.id === receipt.route && !p.connected))
    problems.push(`${name}: ${receipt.route} is not a route in the matrix`);
  const expected =
    receipt.fault === undefined ? `${receipt.agent}-${receipt.route}.json` : `fault-${receipt.route}.json`;
  if (name !== expected) problems.push(`${name}: must be named ${expected}`);
  return problems;
}

/** Copy the receipts into `out` (which must be empty or absent) and write the manifest. */
export function stage(out, files, build, matrix = loadMatrix()) {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  const entries = [];
  const problems = [];
  for (const file of files) {
    const name = basename(file);
    const bytes = readFileSync(file);
    const receipt = JSON.parse(bytes.toString("utf8"));
    problems.push(...stageProblems(name, receipt, build, matrix));
    if (entries.some((e) => e.name === name)) problems.push(`${name}: staged twice`);
    entries.push({
      name,
      sha256: sha256(bytes),
      agent: receipt.agent,
      route: receipt.route,
      kind: receipt.kind,
      ...(receipt.fault === undefined ? {} : { fault: receipt.fault }),
    });
  }
  if (entries.length === 0) problems.push("no receipts to stage");
  if (problems.length) throw new Error(problems.join("\n"));
  for (const file of files) copyFileSync(file, join(out, basename(file)));
  writeFileSync(join(out, MANIFEST), `${JSON.stringify({ build, receipts: entries }, null, 2)}\n`);
  return entries;
}

/**
 * Why the staged directory `dir` does not hold exactly its manifest's receipts, each signed by
 * this repository's receipts workflow. `verify` is injectable for tests.
 */
export function verifyStaged(dir, verify = (root, file, receipt) => attestationProblems(root, file, receipt)) {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  const problems = [];
  const listed = new Set(manifest.receipts.map((e) => e.name));
  const present = readdirSync(dir).filter(
    (f) => f.endsWith(".json") && f !== MANIFEST && !f.endsWith(".sigstore.json"),
  );
  for (const f of present) if (!listed.has(f)) problems.push(`${f}: not in the manifest`);
  for (const e of manifest.receipts) {
    const path = join(dir, e.name);
    if (!existsSync(path)) {
      problems.push(`${e.name}: listed but missing`);
      continue;
    }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== e.sha256) problems.push(`${e.name}: its digest is not the manifest's`);
    const receipt = JSON.parse(bytes.toString("utf8"));
    if (receipt.build !== manifest.build) problems.push(`${e.name}: build ${receipt.build}, not ${manifest.build}`);
    problems.push(...verify(dir, e.name, receipt).map((p) => `${e.name}: ${p}`));
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [mode, target, ...files] = process.argv.slice(2);
  if (mode === "stage") {
    const build = process.env["GITHUB_SHA"];
    if (!/^[0-9a-f]{40}$/.test(build ?? "")) throw new Error("GITHUB_SHA must name this run's commit");
    for (const e of stage(target, files, build)) console.log(`staged ${e.name} ${e.sha256}`);
  } else if (mode === "verify") {
    const problems = verifyStaged(target);
    for (const p of problems) console.error(p);
    if (problems.length === 0) console.log("every staged receipt is in the manifest and its attestation verifies");
    process.exit(problems.length === 0 ? 0 : 1);
  } else {
    console.error("usage: stage-receipts.js stage <out-dir> <receipt.json>... | verify <dir>");
    process.exit(2);
  }
}
