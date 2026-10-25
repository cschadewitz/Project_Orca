/** Dedicated child pipe frames, bound to one launch; parent callback times are audit-only. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { specification } from "./manifest.mjs";
const preloadUrl = new URL("cli-lifecycle-preload.mjs", import.meta.url);
export const preload = fileURLToPath(preloadUrl);
export const CLI_LIMIT_MS = 50000;
function validateFrame(receipt, member, kind) {
  assert.equal(receipt?.schema, 2, "complete child lifecycle frame required");
  assert.equal(receipt.kind, kind, "child lifecycle frame order");
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "schema",
      "kind",
      "nonce",
      "entry",
      "cwd",
      "preloadSha256",
      "pid",
      "startedNs",
      ...(kind === "final" ? ["endedNs", "exitCode"] : []),
    ].sort(),
  );
  assert.match(member.nonce, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isSafeInteger(member.pid) && member.pid > 0);
  for (const key of ["nonce", "entry", "cwd", "pid", "preloadSha256"])
    assert.equal(receipt[key], member[key], `child lifecycle binding: ${key}`);
  assert.equal(receipt.preloadSha256, specification.harness["tools/windows-c15/cli-lifecycle-preload.mjs"]);
  assert.match(receipt.startedNs ?? "", /^[0-9]+$/, "child monotonic boundary required");
  assert.ok(BigInt(member.parentSpawnedNs) <= BigInt(receipt.startedNs), "stale child start");
}
export function validateLifecycle(member) {
  const receipt = member.lifecycleReceipt;
  validateFrame(member.startReceipt, member, "start");
  validateFrame(receipt, member, "final");
  assert.equal(receipt.startedNs, member.startReceipt.startedNs, "child start/final mismatch");
  assert.equal(receipt.exitCode, member.exitCode, "child lifecycle binding: exitCode");
  assert.match(receipt.endedNs ?? "", /^[0-9]+$/, "child monotonic boundary required");
  const start = BigInt(receipt.startedNs),
    end = BigInt(receipt.endedNs);
  assert.ok(start < end, "positive child lifecycle required");
  assert.ok(
    start <= BigInt(member.parentReadyDeliveredNs) && end <= BigInt(member.parentExitDeliveredNs),
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
  // Two newline-delimited frames, at most 4 KiB TOTAL, over the anonymous pipe
  // exclusively created for this launch. No pathname/poll/spawn-time inference.
  let resolveReady, rejectReady, resolveCompleted, rejectCompleted;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  // Either promise may reject while the caller awaits the other. Observe both
  // immediately, retaining the original rejected promises for callers.
  ready.catch(() => {});
  completed.catch(() => {});
  let pending = Buffer.alloc(0),
    receiptBytes = 0,
    ended = false,
    exited = false,
    closed = false,
    failed = false,
    startReceipt,
    lifecycleReceipt,
    parentReadyDeliveredNs,
    exitCode,
    parentExitDeliveredNs,
    stderr = Buffer.alloc(0),
    stderrBytes = 0;
  const expected = { ...binding, pid: child.pid, parentSpawnedNs };
  // One unchanged total deadline begins at launch, including readiness, final
  // receipt, EOF and close. Readiness never restarts the CLI's 50-second clock.
  const timer = setTimeout(
    () => fail(Error("cli-deadline")),
    Math.max(0, CLI_LIMIT_MS - Number(process.hrtime.bigint() - BigInt(parentSpawnedNs)) / 1e6),
  );
  function fail(error) {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    const failure = new Error(
      `child lifecycle failed: ${error.message}; pid=${child.pid}; exit=${exitCode}; receiptBytes=${receiptBytes}; stderrBytes=${stderrBytes}; stderrTail=${JSON.stringify(stderr.toString("utf8"))}`,
      { cause: error },
    );
    rejectReady(failure);
    rejectCompleted(failure);
  }
  // Drain all stderr, retaining only its last 4 KiB for startup diagnostics.
  child.stderr.on("data", (data) => {
    stderrBytes += data.length;
    stderr = Buffer.concat([stderr, data.subarray(-4096)]).subarray(-4096);
  });
  const finish = () => {
    if (failed || !ended || !closed) return;
    try {
      assert.ok(receiptBytes > 0, "empty child lifecycle receipt (preload/entry startup may have failed)");
      assert.equal(pending.length, 0, "unterminated child lifecycle frame");
      assert.ok(startReceipt && lifecycleReceipt, "both child lifecycle frames required");
      const member = {
        ...expected,
        startReceipt,
        parentReadyDeliveredNs,
        parentExitDeliveredNs,
        exitCode,
        lifecycleReceipt,
      };
      validateLifecycle(member);
      clearTimeout(timer);
      resolveCompleted(member);
    } catch (error) {
      fail(error);
    }
  };
  child.once("error", fail);
  child.stdio[3].on("error", fail);
  child.stdio[3].on("data", (data) => {
    if (failed) return;
    receiptBytes += data.length;
    if (receiptBytes > 4096) return fail(Error("child lifecycle receipt oversized"));
    pending = Buffer.concat([pending, data]);
    try {
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        const frame = JSON.parse(pending.subarray(0, newline).toString("utf8"));
        pending = pending.subarray(newline + 1);
        if (!startReceipt) {
          validateFrame(frame, expected, "start");
          parentReadyDeliveredNs = process.hrtime.bigint().toString();
          assert.ok(BigInt(frame.startedNs) <= BigInt(parentReadyDeliveredNs), "future child start");
          startReceipt = frame;
        } else {
          assert.equal(lifecycleReceipt, undefined, "duplicate child lifecycle frame");
          validateFrame(frame, expected, "final");
          assert.equal(frame.startedNs, startReceipt.startedNs, "child start/final mismatch");
          lifecycleReceipt = frame;
        }
      }
      // Parse the whole received chunk before releasing diagnostic work. A
      // duplicate/malformed/final frame coalesced with start cannot authorize it.
      if (startReceipt && !lifecycleReceipt && !exited && child.exitCode === null && child.signalCode === null)
        resolveReady({ ...expected, startReceipt, parentReadyDeliveredNs });
      else if (lifecycleReceipt || exited || child.exitCode !== null || child.signalCode !== null)
        rejectReady(Error("child finished before readiness delivery"));
    } catch (error) {
      fail(error);
    }
  });
  child.stdio[3].once("end", () => {
    ended = true;
    if (!startReceipt) rejectReady(Error("child pipe ended before readiness"));
    finish();
  });
  child.stdio[3].once("close", () => {
    if (!ended) fail(Error("child pipe closed without EOF"));
  });
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    parentExitDeliveredNs = process.hrtime.bigint().toString();
    if (!startReceipt) rejectReady(Error("child exited before readiness"));
    if (signal) fail(Error("child lifecycle terminated by signal"));
    else if (code !== 0 && startReceipt) fail(Error("fixed CLI workload member failed"));
  });
  child.once("close", () => {
    closed = true;
    if (!ended) return fail(Error("child closed before lifecycle EOF"));
    finish();
  });
  return { child, ready, completed };
}
