// Exercise the coordinator's refusal boundaries without running an agent or a daemon.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./fixture.js", import.meta.url));
function invoke(args, exitCode = 0) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, exitCode, result.stderr);
  return exitCode === 0 ? JSON.parse(result.stdout) : result.stderr;
}

test("repeat validation and refuse changed tests, extra files, wrong workspace and symlinks", () => {
  const report = invoke(["validate"]);
  assert.equal(report.status, "pass");
  const root = report.attempts[0].root;
  const workspace = report.attempts[0].workspace;
  assert.equal(invoke(["verify", root]).status, "pass");
  assert.match(invoke(["verify", workspace], 1), /owner.json/);

  const tests = join(workspace, "shipping.test.js");
  const original = readFileSync(tests);
  writeFileSync(tests, "process.exit(0);\n");
  assert.match(invoke(["verify", root], 1), /Unexpected bytes: shipping.test.js/);
  writeFileSync(tests, original);

  const extra = join(workspace, "unexpected.txt");
  writeFileSync(extra, "unrelated\n");
  assert.match(invoke(["verify", root], 1), /Unexpected workspace files/);
  unlinkSync(extra);

  const sentinel = join(root, "Other β/sentinel.txt");
  const untouched = readFileSync(sentinel);
  writeFileSync(sentinel, "changed\n");
  assert.match(invoke(["verify", root], 1), /Fixture check failed/);
  writeFileSync(sentinel, untouched);

  // A passing file reached through a link must not hide a workspace escape.
  if (process.platform !== "win32") {
    unlinkSync(tests);
    symlinkSync(fileURLToPath(new URL("./template/shipping.test.js", import.meta.url)), tests);
    assert.match(invoke(["verify", root], 1), /Not a regular file/);
    unlinkSync(tests);
    writeFileSync(tests, original);
  }
  assert.equal(invoke(["verify", root]).status, "pass");
  const fresh = invoke(["reset"]);
  assert.notEqual(fresh.root, root);
  assert.deepEqual(fresh.hashes, report.attempts[0].hashes);
  assert.equal(fresh.before.exitCode, 1);
  assert.match(invoke(["verify", fresh.root], 1), /Unexpected bytes: shipping.js/);
  // Reset preserved the completed attempt and refuses a destructive target argument.
  assert.equal(invoke(["verify", root]).status, "pass");
  assert.match(invoke(["reset", root], 1), /Usage:/);

  const addedRemote = spawnSync(
    "git",
    ["-C", workspace, "remote", "add", "unexpected", "https://example.invalid/repo"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(addedRemote.status, 0, addedRemote.stderr);
  assert.match(invoke(["verify", root], 1), /Unexpected Git remote/);
  const removedRemote = spawnSync("git", ["-C", workspace, "remote", "remove", "unexpected"], { encoding: "utf8" });
  assert.equal(removedRemote.status, 0, removedRemote.stderr);
  const staged = spawnSync("git", ["-C", workspace, "add", "shipping.js"], { encoding: "utf8" });
  assert.equal(staged.status, 0, staged.stderr);
  assert.match(invoke(["verify", root], 1), /Unexpected Git changes/);
});
