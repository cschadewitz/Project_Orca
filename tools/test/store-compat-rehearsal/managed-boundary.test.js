/** Run the managed adapter's store-epoch boundary rows in the normal repository check set. */
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it.skipIf(process.platform === "win32")("managed activation, recovery and downgrade across the store epoch", () => {
  expect(() =>
    execFileSync("python3", ["-B", "tools/store-compat-rehearsal/test_managed_boundary.py"], { stdio: "pipe" }),
  ).not.toThrow();
});
