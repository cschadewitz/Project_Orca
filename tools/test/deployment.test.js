/** Run the Debian adapter's stdlib tests in the normal repository check set. */
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it.skipIf(process.platform === "win32")("isolated Debian activation, admission and recovery", () => {
  expect(() => execFileSync("python3", ["-B", "tools/deploy/test_release.py"], { stdio: "pipe" })).not.toThrow();
});
