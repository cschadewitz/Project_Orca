/** #331 AC1: fresh real-service process races. AC3: boundary death/lost acknowledgements.
 * No claim about AC2/AC4/AC5, transport retries, startup sweeps or exactly-once execution.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { FileAdmissionStore } from "../src/program/submission-store.js";
import { faults, type AdmissionKind, type Boundary } from "./admission-retry-multiprocess/fixture.js";
import { Worker, type Result } from "./admission-retry-multiprocess/harness.js";

const workers: Worker[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.kill()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function spawn(
  dir: string,
  kind: AdmissionKind,
  boundary: Boundary | "none" = "none",
  mode = "normal",
  contenderLockMs?: number,
) {
  const worker = new Worker(dir, kind, boundary, mode, contenderLockMs);
  workers.push(worker);
  return worker;
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-admission-process-"));
  directories.push(dir);
  const stores = fileStores(dir);
  const ledger = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
  const admissions = new FileAdmissionStore(dir);
  return { dir, stores, ledger, admissions };
}
async function start(worker: Worker) {
  await worker.wait("ready");
  worker.release("ready");
  await worker.wait("claim");
  worker.release("claim");
}
async function retry(dir: string, kind: AdmissionKind) {
  const worker = spawn(dir, kind);
  await start(worker);
  const result = await worker.wait("result");
  expect(await worker.closed).toEqual({ code: 0, signal: null });
  return result;
}
function accepted(result: Result) {
  expect(result).toMatchObject({ state: "resolved", result: { state: "accepted" } });
  if (result.state !== "resolved" || result.result.state !== "accepted") throw new Error("Admission not accepted");
  return result.result;
}
async function assertDurable(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: AdmissionKind,
  result: Result,
  runs: number,
) {
  expect(await f.ledger.batch()).toEqual([result.operationId]);
  const ids = await f.stores.events.listRuns();
  expect(ids).toHaveLength(runs);
  for (const id of ids) {
    // Admission never drives execution. One and only one authenticated creation event.
    const events = await f.stores.events.readRange(id);
    expect(events.map((event) => event.type)).toEqual(["run.created"]);
    const original = await f.stores.events.synchronizeEvent!(events[0]!);
    expect(original.payload).toMatchObject({ actor: { principalId: "owner" } });
  }
  const requests = await f.stores.requests.list();
  expect(requests.length).toBeLessThanOrEqual(kind === "request" ? 1 : 0);
  if (result.state === "resolved" && result.result.state === "accepted") {
    const receipt = result.result;
    expect(ids).toEqual([receipt.runId]);
    expect(await f.stores.execution.getGeneration(`process-owner:${receipt.runId}`)).toEqual({ principalId: "owner" });
    if (kind === "request") {
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        id: "requestId" in receipt ? receipt.requestId : undefined,
        programRunId: receipt.runId,
      });
      expect(await f.admissions.records.list()).toEqual([
        expect.objectContaining({
          id: receipt.admissionId,
          requestId: requests[0]!.id,
          runId: receipt.runId,
          state: "accepted",
        }),
      ]);
    } else expect(await f.admissions.records.list()).toEqual([]);
  }
}

describe.each(["request", "direct"] as const)("real %s admission across processes", (kind) => {
  it.each(["accepted", "in-progress"])(
    "races fresh callers with contender %s, converging on the same identifiers",
    async (contendedState) => {
      const f = await fixture();
      // The in-progress case keeps the owner blocked until the contender's own bounded lock wait
      // runs out, so that wait is nearly all of its cost: the contender gives up after 250 ms
      // rather than the fixture's 5 s. The accepted case keeps 5 s, which the owner needs to finish.
      const contenderLockMs = contendedState === "in-progress" ? 250 : undefined;
      const pair = [
        spawn(f.dir, kind, "bound", "race", contenderLockMs),
        spawn(f.dir, kind, "bound", "race", contenderLockMs),
      ];
      expect(new Set(pair.map((worker) => worker.child.pid)).size).toBe(2);
      expect(pair.map((worker) => worker.child.pid)).not.toContain(process.pid);
      const ready = await Promise.all(pair.map((worker) => worker.wait("ready")));
      expect(ready).toEqual(Array.from({ length: 2 }, () => ({ operations: [], runs: [], starts: 0 })));
      for (const worker of pair) worker.release("ready");
      await Promise.all(pair.map((worker) => worker.wait("claim")));
      // Both service invocations reached claim before either can publish a key.
      expect(await f.ledger.batch()).toEqual([]);
      for (const worker of pair) worker.release("claim");
      const claims = await Promise.all(pair.map((worker) => worker.wait("claimed")));
      expect(claims.filter((claim) => claim.fresh)).toHaveLength(1);
      expect(claims[0]!.operationId).toBe(claims[1]!.operationId);
      const owner = pair[claims.findIndex((claim) => claim.fresh)]!;
      const contender = pair[claims.findIndex((claim) => !claim.fresh)]!;
      expect(await owner.wait("boundary")).toEqual({ name: "bound" });
      await contender.wait("contender");
      contender.release("contender");
      // The second real lock call is in flight before the owner can finish. For the
      // accepted case release now; for contention keep the owner blocked until the
      // store's own bounded lock result arrives (no test sleep decides either case).
      await contender.wait("locking");
      if (contendedState === "accepted") owner.release("boundary");
      const waiting = await contender.wait("result");
      if (contendedState === "in-progress") {
        expect(waiting).toEqual({
          starts: 0,
          result: {
            state: "in-progress",
            operationId: claims[0]!.operationId,
            recovery: "inspect-or-retry",
          },
        });
        owner.release("boundary");
      }
      expect(await contender.closed).toEqual({ code: 0, signal: null });
      const first = await owner.wait("result");
      expect(await owner.closed).toEqual({ code: 0, signal: null });
      accepted(first.result);
      expect(first.starts).toBe(1);
      expect(first.result).toMatchObject({ replayed: false });
      if (contendedState === "accepted")
        expect(waiting).toEqual({ starts: 0, result: { ...first.result, replayed: true } });
      const replay = await retry(f.dir, kind);
      expect(replay).toEqual({ starts: 0, result: { ...first.result, replayed: true } });
      await assertDurable(f, kind, replay.result, 1);
    },
  );

  // Expected behavior at each completed durable call, before its caller sees the ack.
  // A root without policy, or private inputs without a root, is deliberately uncertain.
  const cases: {
    boundary: Boundary;
    outcome: "in-progress" | "recoverable-failure" | "accepted";
    runs: number;
    starts: number;
  }[] = [
    { boundary: "claimed", outcome: "in-progress", runs: 0, starts: 0 },
    { boundary: "bound", outcome: "recoverable-failure", runs: 0, starts: 0 },
    { boundary: "material", outcome: "accepted", runs: 1, starts: 1 },
    { boundary: "inputs", outcome: "recoverable-failure", runs: 0, starts: 0 },
    { boundary: "created", outcome: "recoverable-failure", runs: 1, starts: 0 },
    { boundary: "policy", outcome: "accepted", runs: 1, starts: 0 },
    { boundary: "owner", outcome: "accepted", runs: 1, starts: 0 },
    { boundary: "receipt", outcome: "accepted", runs: 1, starts: 0 },
    { boundary: "response", outcome: "accepted", runs: 1, starts: 0 },
    ...(kind === "request"
      ? [
          { boundary: "request-document" as const, outcome: "accepted" as const, runs: 1, starts: 1 },
          { boundary: "linked" as const, outcome: "accepted" as const, runs: 1, starts: 0 },
          { boundary: "admission-accepted" as const, outcome: "accepted" as const, runs: 1, starts: 0 },
        ]
      : []),
  ];
  it.each(cases)(
    "after SIGKILL at $boundary, a new process returns $outcome without replacement",
    async ({ boundary, outcome, runs, starts }) => {
      const f = await fixture();
      const original = spawn(f.dir, kind, boundary);
      await start(original);
      const claim = await original.wait("claimed");
      expect(claim.fresh).toBe(true);
      expect(await original.wait("boundary")).toEqual({ name: boundary });
      expect(original.messages.some((message) => message.type === "result")).toBe(false);
      const before = await f.ledger.read(claim.operationId);
      const admissionId = before?.binding?.admissionId as string | undefined;
      const material = admissionId ? await f.stores.execution.getInputs(admissionId) : undefined;
      const reservation = material?.vars.admission as { reservedRunId: string } | undefined;
      const reservedRunId = before?.binding?.runId ?? reservation?.reservedRunId;
      // SIGKILL prevents finally blocks from releasing held admission/operation locks.
      expect(await original.kill()).toEqual({ code: null, signal: "SIGKILL" });
      const recovered = await retry(f.dir, kind);
      expect(recovered.starts).toBe(starts);
      expect(recovered.result.operationId).toBe(claim.operationId);
      if (outcome === "in-progress") {
        expect(recovered.result).toEqual({
          state: "in-progress",
          operationId: claim.operationId,
          recovery: "inspect-or-retry",
        });
        expect(await f.ledger.read(claim.operationId)).toEqual(before);
      } else {
        expect(recovered.result).toMatchObject({
          state: "resolved",
          replayed: true,
          result: { state: outcome, admissionId },
        });
        if (recovered.result.state !== "resolved") throw new Error("Missing receipt");
        if (kind === "request")
          expect(recovered.result.result).toMatchObject({ requestId: before!.binding!.requestId });
        if (reservedRunId && outcome === "accepted")
          expect(recovered.result.result).toMatchObject({ runId: reservedRunId });
        if (outcome === "recoverable-failure")
          expect(recovered.result.result).toMatchObject({ failure: { code: "RUN_STATE", recovery: "reconcile" } });
        expect((await f.ledger.read(claim.operationId))?.binding).toEqual(before?.binding);
      }
      if (boundary === "receipt" || boundary === "response") {
        expect(before).toMatchObject({ phase: "accepted", result: { state: "accepted" } });
        expect(recovered.result).toMatchObject({ result: before!.result });
      }
      // A further process must replay the same accepted OR explicitly uncertain result.
      const again = await retry(f.dir, kind);
      expect(again).toEqual({ result: recovered.result, starts: 0 });
      await assertDurable(f, kind, again.result, runs);
    },
  );
});
