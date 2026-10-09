/** Actual authenticated maintenance drains over production stores/models; no install or native proof. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { RuntimeDrainResultSchema, RuntimeMaintenanceResultSchema } from "@orca/protocol";
import { barrier, runtimeMaintenanceFixture } from "./runtime-maintenance-fixture.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});
async function fixture(gated = false) {
  const f = await runtimeMaintenanceFixture({ gated });
  closers.push(f.close);
  const drain = (token = "update-owner", target = f.target) =>
    f.call("maintenance.runtime", { action: "drain", token, target });
  const defer = (token = "update-owner") => f.call("maintenance.runtime", { action: "defer", token, target: f.target });
  return { ...f, drain, defer };
}
it("seals a no-work drain, retains exact ownership on repetition and exposes existing idle proof", async () => {
  const f = await fixture();
  const result = await f.drain();
  expect(result).toMatchObject({
    ok: true,
    result: { proof: "runtime-drain-v1", outcome: "held", active: [], unfinished: [], truncated: false },
  });
  if (!result.ok) throw new Error("drain failed");
  expect(RuntimeDrainResultSchema.safeParse(result.result).success).toBe(true);
  expect(RuntimeMaintenanceResultSchema.safeParse(result.result).success).toBe(false);
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "held" } });
  expect(await f.prepare()).toMatchObject({ ok: true, result: { proof: "runtime-v1", outcome: "held" } });
  expect(await f.defer()).toMatchObject({ ok: false });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  expect(() => f.runtime.activity.enter("callback")).toThrow("closed");
  await f.resume();
});
it("reports active/stalled work, refuses new roots and permits owner defer without touching that work", async () => {
  const f = await fixture();
  const finish = f.runtime.activity.enter("execution");
  for (let i = 0; i < 2; i++)
    expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "draining", active: ["execution"] } });
  for (const [method, params] of [
    ["runs.start", { workflowId: "flow" }],
    ["runs.admit", { workflowId: "flow", idempotencyKey: "new" }],
    ["requests.submit", { title: "new", body: "body" }],
  ] as const)
    expect(await f.call(method, params)).toMatchObject({
      ok: false,
      error: { message: "Update admission is closed; retry later" },
    });
  expect(() => f.runtime.activity.enter("dispatch", true)).toThrow("closed");
  expect(await f.call("runs.list")).toMatchObject({ ok: true });
  expect(await f.prepare()).toMatchObject({ ok: false });
  expect(await f.resume()).toMatchObject({ ok: false });
  expect(await f.defer("foreign")).toMatchObject({ ok: false });
  expect(await f.defer()).toMatchObject({ ok: true, result: { outcome: "released", active: ["execution"] } });
  expect(f.runtime.activity.snapshot().active).toEqual(["execution"]);
  finish();
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: true });
});
it("keeps durable parked gates unfinished while allowing their authenticated answer and continuation", async () => {
  const f = await fixture(true);
  const started = await f.call("runs.start", { workflowId: "flow" });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const runId = (started.result as { runId: string }).runId;
  expect((await f.orc.getState(runId)).run.status).toBe("paused");
  expect(f.runtime.activity.snapshot().active).toEqual([]);
  expect(await f.drain()).toMatchObject({
    ok: true,
    result: { outcome: "draining", unfinished: [{ status: "paused", count: 1 }] },
  });
  const [input] = await f.orc.pendingInputs(runId);
  expect(await f.call("inputs.answer", { runId, requestId: input!.id, optionId: "finish" })).toMatchObject({
    ok: true,
  });
  expect((await f.orc.getState(runId)).run.status).toBe("completed");
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "held", unfinished: [] } });
  await f.resume();
});
it("rejects wrong targets and unauthorized owners before closing new-work admission", async () => {
  const f = await fixture();
  expect(await f.drain("owner", { ...f.target, instanceId: randomUUID() })).toMatchObject({ ok: false });
  expect(
    await f.call("maintenance.runtime", { action: "drain", token: "owner", target: f.target }, f.viewer.token),
  ).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: true });
});
it("does not seal from an inventory made stale by completed intervening activity", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const list = f.orc.listRuns.bind(f.orc);
  vi.spyOn(f.orc, "listRuns").mockImplementationOnce(async () => {
    entered.release();
    await finish.promise;
    return list();
  });
  const draining = f.drain();
  await entered.promise;
  f.runtime.activity.enter("continuation")();
  finish.release();
  expect(await draining).toMatchObject({ ok: true, result: { outcome: "draining", active: ["unavailable"] } });
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await f.resume();
});
it("deduplicates repeated pending observations and refuses a late result after defer", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const list = f.orc.listRuns.bind(f.orc);
  const observe = vi.spyOn(f.orc, "listRuns").mockImplementationOnce(async () => {
    entered.release();
    await finish.promise;
    return list();
  });
  const begin = vi.spyOn(f.runtime.activity, "beginDrain");
  const first = f.drain();
  await entered.promise;
  const second = f.drain();
  try {
    await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(2));
    expect(observe).toHaveBeenCalledTimes(1);
    expect(await f.defer()).toMatchObject({ ok: true, result: { outcome: "released" } });
  } finally {
    finish.release();
  }
  expect(await first).toMatchObject({ ok: false });
  expect(await second).toMatchObject({ ok: false });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: true });
});
it("retains draining admission on inventory failure or an oversized history", async () => {
  const f = await fixture();
  vi.spyOn(f.orc, "listRuns").mockRejectedValueOnce(new Error("store unavailable"));
  expect(await f.drain()).toMatchObject({
    ok: true,
    result: { outcome: "draining", active: ["unavailable"], truncated: true },
  });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  vi.spyOn(f.orc, "listRuns").mockResolvedValueOnce(Array.from({ length: 4097 }, (_, i) => `run-${i}`));
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "draining", truncated: true } });
  await f.defer();
});
it("bounds stuck inventory reads, allows defer, and never seals from a late completion", async () => {
  const f = await fixture();
  const finish = barrier(),
    settled = barrier();
  const list = f.orc.listRuns.bind(f.orc);
  const observe = vi.spyOn(f.orc, "listRuns").mockImplementationOnce(async () => {
    await finish.promise;
    const ids = await list();
    settled.release();
    return ids;
  });
  try {
    for (let i = 0; i < 2; i++)
      expect(await f.drain()).toMatchObject({
        ok: true,
        result: { outcome: "draining", active: ["unavailable"], truncated: true },
      });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(await f.defer()).toMatchObject({ ok: true, result: { outcome: "released" } });
  } finally {
    finish.release();
    await settled.promise;
  }
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: true });
});
it("lets a root admitted before drain finish through its later creation and execution awaits", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const direct = f.app.directAdmissions!;
  const admit = direct.admitRun.bind(direct);
  vi.spyOn(direct, "admitRun").mockImplementationOnce(async (...args) => {
    entered.release();
    await finish.promise;
    return admit(...args);
  });
  const started = f.call("runs.start", { workflowId: "flow" });
  await entered.promise;
  try {
    expect(await f.drain()).toMatchObject({
      ok: true,
      result: { outcome: "draining", active: expect.arrayContaining(["dispatch", "rpc"]) },
    });
    expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  } finally {
    finish.release();
  }
  expect(await started).toMatchObject({ ok: true, result: { run: { status: "succeeded" } } });
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await f.resume();
});
it("guards direct model admission entry before any underlying service read or write", async () => {
  const f = await fixture();
  const finish = f.runtime.activity.enter("execution");
  const authority = {
    workspaceId: f.identity.workspaceId,
    actor: { principalId: "runtime-owner", credentialId: f.owner.credential.id },
    authorize: async () => {},
    onRunAdmitted: async () => {},
    verifyRunAdmitted: async () => {},
  };
  const admit = vi.spyOn(f.app.directAdmissions!, "admitRun");
  const submit = vi.spyOn(f.app.program.submissions!, "submit");
  try {
    await f.drain();
    await expect(f.admissions.admitRetry({ workflowId: "flow" }, {}, authority)).rejects.toThrow("closed");
    await expect(f.requests.submit({ title: "new", body: "body" }, authority)).rejects.toThrow("closed");
    await expect(f.requests.submitRetry({ title: "new", body: "body" }, authority, {})).rejects.toThrow("closed");
    expect(admit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await f.defer();
  } finally {
    finish();
  }
});
it("never relabels the old idle-only lease as proof that parked work was inventoried", async () => {
  const f = await fixture(true);
  await f.call("runs.start", { workflowId: "flow" });
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["unavailable"] } });
  await f.resume();
  expect(await f.drain()).toMatchObject({
    ok: true,
    result: { outcome: "draining", unfinished: [{ status: "paused", count: 1 }] },
  });
  await f.defer();
});
it("keeps a live callback open during drain and lets its existing authorized answer settle it", async () => {
  const f = await fixture();
  const target = {
    runId: "synthetic-live-run",
    stepRunId: "step",
    requestId: "permission",
    instanceId: f.identity.instanceId,
    sessionId: "session",
    turnId: "turn",
    invocationId: "invocation",
  };
  // Explicit callback/owned-writer seam; the daemon admission and live registry are actual producers.
  const emitOwned = vi.fn(async () => {});
  const ask = f.runtime.port.ask({
    ...target,
    kind: "permission",
    question: "Continue?",
    context: {},
    options: [{ id: "allow", label: "Allow" }],
    live: {
      identity: target,
      signal: new AbortController().signal,
      withOwnership: (operation) => operation(),
      emitOwned,
    },
  });
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "draining", active: ["callback"] } });
  expect(f.runtime.port.inspect(target)).toBe("pending");
  expect(emitOwned).not.toHaveBeenCalled();
  expect(
    await f.runtime.port.answer(
      { target, optionId: "allow" },
      { actor: { principalId: "runtime-owner" }, authorize: async () => {} },
    ),
  ).toEqual({ answerRecorded: true, delivered: true });
  expect(await ask).toBe("allow");
  expect(emitOwned).toHaveBeenCalledOnce();
  expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await f.resume();
});
it("keeps an uncertain serving binding fenced and refuses defer until its proof is available", async () => {
  const f = await fixture();
  const finish = f.runtime.activity.enter("execution");
  try {
    await f.drain();
    delete f.orc.runtimeActivity;
    expect(await f.drain()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["unavailable"] } });
    expect(await f.defer()).toMatchObject({ ok: false });
    expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
    f.orc.runtimeActivity = f.runtime.activity;
    expect(await f.defer()).toMatchObject({ ok: true, result: { outcome: "released" } });
  } finally {
    f.orc.runtimeActivity = f.runtime.activity;
    finish();
  }
});
