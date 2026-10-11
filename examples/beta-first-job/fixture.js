// Coordinator-only fixture creation and offline verification; never launches an agent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, "template");
const patch = resolve(here, "../../docs/preparation/beta-first-job/reference.patch");
const files = ["README.md", "shipping.js", "shipping.test.js"];
const sentinel = "Do not change this workspace.\n";
const fixture = "beta-first-job-v1";
const initialOutput = [
  "PASS zero subtotal",
  "PASS below threshold",
  "FAIL exact threshold: expected 0, got 499",
  "PASS above threshold",
  "PASS large subtotal",
  "4 passed; 1 failed",
  "",
].join("\n");
const fixedOutput = initialOutput
  .replace("FAIL exact threshold: expected 0, got 499", "PASS exact threshold")
  .replace("4 passed; 1 failed", "5 passed; 0 failed");
const expectedSource = readFileSync(join(template, "shipping.js"), "utf8").replace(
  "subtotalCents > 5000",
  "subtotalCents >= 5000",
);

// Prevent ambient Git configuration, hooks, signing or Node preload options from
// turning a local fixture check into unrelated work. No shell or provider process.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(GIT_|NODE_OPTIONS$|NODE_PATH$)/.test(key)),
);
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: "1",
  // Git for Windows reads /dev/null as the null device too, and refuses NUL as a config path.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Synthetic Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
});
function run(command, args, cwd, expected = 0) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 256 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${command} exit: ${result.stderr}${result.stdout}`);
  assert.equal(result.signal, null);
  return result.stdout.replaceAll("\r\n", "\n");
}
function git(root, args) {
  return run(
    "git",
    ["-c", `core.hooksPath=${join(root, "hooks")}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    join(root, "Sample α"),
  );
}
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function regular(path) {
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Not a regular file: ${path}`);
  return readFileSync(path, "utf8");
}
function directory(path) {
  assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `Not a directory: ${path}`);
}
function inspect(root, fixed) {
  directory(root);
  assert.equal(realpathSync(root), root, "Use the canonical root printed by init");
  assert.equal(regular(join(root, "owner.json")), `${JSON.stringify({ fixture, root })}\n`);
  const workspace = join(root, "Sample α");
  directory(workspace);
  directory(join(workspace, ".git"));
  assert.deepEqual(readdirSync(workspace).sort(), [".git", ...files].sort(), "Unexpected workspace files");
  for (const file of files) {
    const expected = fixed && file === "shipping.js" ? expectedSource : readFileSync(join(template, file), "utf8");
    assert.equal(regular(join(workspace, file)), expected, `Unexpected bytes: ${file}`);
  }
  directory(join(root, "Other β"));
  assert.deepEqual(readdirSync(join(root, "Other β")), ["sentinel.txt"]);
  assert.equal(regular(join(root, "Other β/sentinel.txt")), sentinel);
  assert.equal(git(root, ["remote"]), "", "Unexpected Git remote");
  assert.equal(git(root, ["status", "--porcelain"]), fixed ? " M shipping.js\n" : "", "Unexpected Git changes");
  assert.equal(git(root, ["diff", "--summary"]), "", "Unexpected file mode changes");
  if (fixed) {
    const initial = JSON.parse(regular(join(root, "evidence/initial.json")));
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), initial.baseline, "Unexpected commit");
  }
  return workspace;
}
function test(root, fixed) {
  const workspace = inspect(root, fixed);
  const output = run(process.execPath, ["shipping.test.js"], workspace, fixed ? 0 : 1);
  assert.equal(output, fixed ? fixedOutput : initialOutput);
  return { exitCode: fixed ? 0 : 1, output };
}
function hashes(root) {
  return Object.fromEntries(files.map((file) => [file, sha(readFileSync(join(root, "Sample α", file)))]));
}
function init() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-beta-first-job-")));
  for (const path of ["Sample α", "Other β", "hooks", "evidence"]) mkdirSync(join(root, path), { mode: 0o700 });
  writeFileSync(join(root, "owner.json"), `${JSON.stringify({ fixture, root })}\n`);
  writeFileSync(join(root, "Other β/sentinel.txt"), sentinel);
  for (const file of files) writeFileSync(join(root, "Sample α", file), readFileSync(join(template, file)));
  git(root, ["init", "--initial-branch=fixture", `--template=${join(root, "hooks")}`, "."]);
  git(root, ["add", "--", ...files]);
  git(root, ["commit", "-m", "Synthetic broken baseline"]);
  assert.equal(git(root, ["remote"]), "");
  assert.equal(git(root, ["status", "--porcelain"]), "");
  const before = test(root, false);
  const record = {
    fixture,
    mode: "offline-scripted",
    root,
    workspace: join(root, "Sample α"),
    baseline: git(root, ["rev-parse", "HEAD"]).trim(),
    hashes: hashes(root),
    before,
  };
  writeFileSync(join(root, "evidence/initial.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
function validate() {
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const record = init();
    git(record.root, ["apply", "--check", patch]);
    git(record.root, ["apply", patch]);
    const after = test(record.root, true);
    assert.equal(git(record.root, ["diff", "--name-only"]), "shipping.js\n");
    const diff = git(record.root, ["diff", "--no-ext-diff", "--no-textconv", "--", "shipping.js"]);
    writeFileSync(join(record.root, "evidence/fix.diff"), diff);
    attempts.push({ ...record, after, fixedHashes: hashes(record.root), diff });
  }
  assert.deepEqual(attempts[0].hashes, attempts[1].hashes);
  assert.deepEqual(attempts[0].fixedHashes, attempts[1].fixedHashes);
  assert.equal(attempts[0].baseline, attempts[1].baseline);
  assert.equal(attempts[0].diff, attempts[1].diff);
  const report = {
    fixture,
    mode: "offline-scripted",
    status: "pass",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    attempts,
    packagedApp: "not run",
    realAgent: "not run",
    physicalHardware: "not run",
  };
  const evidence = join(attempts[0].root, "evidence/validation.json");
  writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`);
  return { ...report, evidence };
}
try {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node.js >=24 required; do not auto-install");
  const [command, target, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, "Unexpected arguments");
  let result;
  if ((command === "init" || command === "reset") && target === undefined) result = init();
  else if (command === "validate" && target === undefined) result = validate();
  else if (command === "verify" && target) {
    const root = resolve(target);
    result = { fixture, status: "pass", after: test(root, true), hashes: hashes(root) };
  } else throw new Error("Usage: node fixture.js init|reset|validate|verify <run-root>");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(`Fixture check failed: ${error.message}`);
  process.exitCode = 1;
}
