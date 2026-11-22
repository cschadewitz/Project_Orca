/** Run the Debian adapter's stdlib tests in the normal repository check set. */
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it.skipIf(process.platform === "win32")("isolated Debian activation, admission and recovery", () => {
  expect(() => execFileSync("python3", ["-B", "tools/deploy/test_release.py"], { stdio: "pipe" })).not.toThrow();
});
it.skipIf(process.platform === "win32")("server bundle assembly and verified stage --bundle (#876)", () => {
  expect(() => execFileSync("python3", ["-B", "tools/deploy/test_server_bundle.py"], { stdio: "pipe" })).not.toThrow();
});
it.skipIf(process.platform === "win32")("one-step server setup: idempotent, repairs, refuses unmanaged (#881)", () => {
  expect(() => execFileSync("python3", ["-B", "tools/deploy/test_server_setup.py"], { stdio: "pipe" })).not.toThrow();
});
