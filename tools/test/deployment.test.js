/**
 * Run every stdlib test of the Debian adapter (tools/deploy/test_*.py) in the normal repository
 * check set. The files are discovered, not listed, so a new or forgotten one cannot silently
 * fall out of CI (test_operator_compatibility.py did, and went stale across protocol bumps).
 * The agent01 tests run in agent01-owner-staging.test.js, also on Windows.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { expect, it } from "vitest";

const ELSEWHERE = new Set(["test_agent01_staging.py", "test_agent01_hardening.py"]);
const files = readdirSync("tools/deploy")
  .filter((name) => /^test_.*\.py$/.test(name))
  .sort();

it("discovers the adapter's Python tests, including the ones that once ran nowhere", () => {
  for (const name of [
    "test_release.py",
    "test_server_bundle.py",
    "test_server_setup.py",
    "test_auto_update.py",
    "test_operator_compatibility.py",
    "test_auth.py",
    "test_integration.py",
  ])
    expect(files).toContain(name);
  for (const name of ELSEWHERE) expect(files).toContain(name);
});

for (const name of files.filter((file) => !ELSEWHERE.has(file))) {
  it.skipIf(process.platform === "win32")(`tools/deploy/${name}`, () => {
    expect(() => execFileSync("python3", ["-B", `tools/deploy/${name}`], { stdio: "pipe" })).not.toThrow();
  });
}
