/** Dedicated child pipe receipt, bound to one launch; parent callback times are audit-only. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { specification } from "./manifest.mjs";
const preloadUrl = new URL("cli-lifecycle-preload.mjs", import.meta.url);
export const preload = fileURLToPath(preloadUrl);
export function validateLifecycle(member) {
  const receipt = member.lifecycleReceipt;
  assert.equal(receipt?.schema, 1, "complete child lifecycle receipt required");
  assert.deepEqual(
    Object.keys(receipt).sort(),
    ["schema", "nonce", "entry", "cwd", "preloadSha256", "pid", "startedNs", "endedNs", "exitCode"].sort(),
  );
  assert.match(member.nonce, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isSafeInteger(member.pid) && member.pid > 0);
  for (const key of ["nonce", "entry", "cwd", "pid", "exitCode", "preloadSha256"])
    assert.equal(receipt[key], member[key], `child lifecycle binding: ${key}`);
  assert.equal(receipt.preloadSha256, specification.harness["tools/windows-c15/cli-lifecycle-preload.mjs"]);
  for (const key of ["startedNs", "endedNs"])
    assert.match(receipt[key] ?? "", /^[0-9]+$/, "child monotonic boundary required");
  const start = BigInt(receipt.startedNs),
    end = BigInt(receipt.endedNs);
  assert.ok(start < end, "positive child lifecycle required");
  assert.ok(
    BigInt(member.parentSpawnedNs) <= start && end <= BigInt(member.parentExitDeliveredNs),
    "child receipt outside observed launch",
  );
  assert.equal(member.exitCode, 0, "fixed CLI workload member failed");
  return { start, end };
}
export function launchCli(launch, command, args, options) {
  const preloadSha256 = createHash("sha256").update(fs.readFileSync(preload)).digest("hex");
  assert.equal(
    preloadSha256,
    specification.harness["tools/windows-c15/cli-lifecycle-preload.mjs"],
    "preload substitution",
  );
  const binding = { nonce: randomUUID(), entry: args[0], cwd: options.cwd, preloadSha256 };
  const parentSpawnedNs = process.hrtime.bigint().toString();
  const child = launch(command, ["--import", preloadUrl.href, ...args], {
    ...options,
    env: { ...options.env, C15_CLI_LIFECYCLE: JSON.stringify(binding) },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  // The anonymous pipe is created by spawn exclusively for this child. There is
  // no receipt pathname to precreate, replace, poll late or reuse across demos.
  const completed = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0),
      ended = false,
      exited = false,
      member,
      stderr = Buffer.alloc(0),
      stderrBytes = 0;
    // Drain all stderr, retaining only its last 4 KiB for startup diagnostics.
    child.stderr.on("data", (data) => {
      stderrBytes += data.length;
      stderr = Buffer.concat([stderr, data.subarray(-4096)]).subarray(-4096);
    });
    const finish = () => {
      if (!ended || !exited || !member) return;
      try {
        assert.ok(bytes.length > 0, "empty child lifecycle receipt (preload/entry startup may have failed)");
        member.lifecycleReceipt = JSON.parse(bytes.toString("utf8"));
        validateLifecycle(member);
        resolve(member);
      } catch (error) {
        reject(
          new Error(
            `child lifecycle failed: ${error.message}; pid=${child.pid}; exit=${member.exitCode}; receiptBytes=${bytes.length}; stderrBytes=${stderrBytes}; stderrTail=${JSON.stringify(stderr.toString("utf8"))}`,
            { cause: error },
          ),
        );
      }
    };
    child.once("error", reject);
    child.stdio[3].on("error", reject);
    child.stdio[3].on("data", (data) => {
      if (bytes.length + data.length > 4096) {
        reject(Error("child lifecycle receipt oversized"));
        return;
      }
      bytes = Buffer.concat([bytes, data]);
    });
    child.stdio[3].once("end", () => {
      ended = true;
      finish();
    });
    child.once("exit", (exitCode, signal) => {
      member = {
        ...binding,
        pid: child.pid,
        parentSpawnedNs,
        parentExitDeliveredNs: process.hrtime.bigint().toString(),
        exitCode,
      };
      if (signal) {
        reject(Error("child lifecycle terminated by signal"));
        return;
      }
    });
    child.once("close", () => {
      exited = true;
      finish();
    });
  });
  return { child, completed };
}
