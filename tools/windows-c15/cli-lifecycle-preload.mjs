/** Child-only lifecycle boundary; no candidate imports, work, waits or exit interception. */
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const startedNs = process.hrtime.bigint().toString();
const binding = JSON.parse(process.env.C15_CLI_LIFECYCLE);
// The scripted agents must not inherit the receipt binding. --import is supplied
// only on this CLI's argv, never via NODE_OPTIONS.
delete process.env.C15_CLI_LIFECYCLE;
assert.equal(process.argv[1], binding.entry);
assert.equal(process.cwd(), binding.cwd);
const preloadSha256 = createHash("sha256")
  .update(fs.readFileSync(new URL(import.meta.url)))
  .digest("hex");
assert.equal(preloadSha256, binding.preloadSha256);
const start = { schema: 2, kind: "start", ...binding, preloadSha256, pid: process.pid, startedNs };
process.prependOnceListener("exit", (exitCode) => {
  // Capture before receipt serialization/I/O and before candidate exit handlers.
  // This is the beginning of exit, not the kernel's process termination time.
  const endedNs = process.hrtime.bigint().toString();
  fs.writeFileSync(3, JSON.stringify({ ...start, kind: "final", endedNs, exitCode }) + "\n");
  fs.closeSync(3);
});
// Emitted by this actual preload after validating bindings and installing final
// receipt capture. The CLI continues immediately; no sleep or work extension.
fs.writeFileSync(3, JSON.stringify(start) + "\n");
