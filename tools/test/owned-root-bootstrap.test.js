/** Run the inactive bootstrap's Node tests in the normal CI lane without installing dependencies. */
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("runs the bootstrap admission and inventory checks with explicit platform evidence", () => {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-isolation=none", "--test-reporter=tap", "tools/deploy/owned-root-bootstrap/prepare.test.mjs"],
    { encoding: "utf8", timeout: 25000, maxBuffer: 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(/# tests 17\b/);
  expect(result.stdout).toMatch(/# fail 0\b/);
  // Linux must run every admission assertion. Only the non-Linux rejection case skips.
  // Windows/macOS run portable inventory checks; skips are never Linux acceptance.
  expect(result.stdout).toMatch(process.platform === "linux" ? /# pass 16\b/ : /# pass 5\b/);
  expect(result.stdout).toMatch(process.platform === "linux" ? /# skipped 1\b/ : /# skipped 12\b/);
});
