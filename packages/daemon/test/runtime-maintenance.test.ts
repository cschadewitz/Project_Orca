/** Real authenticated runtime proof; synthetic local execution is not signed Mac acceptance. */
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { barrier, runtimeMaintenanceFixture } from "./runtime-maintenance-fixture.js";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture(options?: Parameters<typeof runtimeMaintenanceFixture>[0]) {
  const f = await runtimeMaintenanceFixture(options);
  closers.push(f.close);
  return f;
}
it("durable closure blocks new admission before runtime drain while existing completion remains usable", async () => {
  let admission = true,
    existing = true;
  const f = await fixture({ gated: true, newAdmissionOpen: () => admission, existingWorkOpen: () => existing });
  const started = await f.call("runs.start", { workflowId: "flow" });
  if (!started.ok) throw new Error("Start failed");
  const runId = (started.result as { runId: string }).runId;
  admission = false;
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  expect(await f.call("runs.get", { runId })).toMatchObject({ ok: true });
  const [input] = await f.orc.pendingInputs(runId);
  expect(await f.call("inputs.answer", { runId, requestId: input!.id, optionId: "finish" })).toMatchObject({
    ok: true,
  });
  existing = false;
  expect(await f.call("runs.get", { runId })).toMatchObject({ ok: false });
  expect(await f.hello()).toMatchObject({ ok: true });
});

it("a failed durable admission observer refuses new work without breaking completion", async () => {
  const f = await fixture({
    newAdmissionOpen: () => {
      throw new Error("Lost root authority");
    },
  });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  expect(await f.call("runs.list", {})).toMatchObject({ ok: true });
});
it("advertises only complete authenticated serving bindings and rejects incomplete or mismatched composition", async () => {
  const full = await fixture();
  expect(await full.hello()).toMatchObject({
    ok: true,
    result: { methods: expect.arrayContaining(["maintenance.runtime"]) },
  });
  for (const options of [
    { omitRequests: true },
    { wrongControl: true },
    { wrongCredentials: true },
    { invalidIdentity: true },
  ]) {
    const f = await fixture(options);
    const hello = await f.hello();
    if (!hello.ok) throw new Error("hello failed");
    expect((hello.result as { methods: string[] }).methods).not.toContain("maintenance.runtime");
    expect(await f.prepare()).toMatchObject({ ok: false });
  }
});
it("binds UUID workspace/instance/PID and the existing owner grant, refusing legacy or foreign resume", async () => {
  const f = await fixture();
  for (const expected of [
    { ...f.target, processId: process.pid + 1 },
    { ...f.target, instanceId: randomUUID() },
    { ...f.target, workspaceId: randomUUID() },
  ])
    expect(await f.prepare("owner", expected)).toMatchObject({ ok: false });
  expect(
    await f.call("maintenance.runtime", { action: "prepare", token: "owner", target: f.target }, f.viewer.token),
  ).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
  expect(await f.prepare()).toMatchObject({
    ok: true,
    result: { proof: "runtime-v1", target: f.target, outcome: "held", active: [] },
  });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  expect(await f.call("maintenance", { action: "resume", token: "update-owner" })).toMatchObject({ ok: false });
  expect(await f.resume("foreign")).toMatchObject({ ok: false });
  expect(await f.resume()).toMatchObject({ ok: true, result: { outcome: "released" } });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: true });
});
it("counts attached execution before its first await and fences every new execution after acquisition", async () => {
  const f = await fixture();
  const id = await f.orc.startRun({ workflowId: "flow" });
  const entered = barrier(),
    finish = barrier();
  const original = f.orc.getSummary.bind(f.orc);
  vi.spyOn(f.orc, "getSummary").mockImplementation(async (...args) => {
    entered.release();
    await finish.promise;
    return original(...args);
  });
  const run = f.orc.run(id);
  try {
    await entered.promise;
    expect(await f.prepare()).toMatchObject({
      ok: true,
      result: { outcome: "blocked", active: expect.arrayContaining(["execution"]) },
    });
  } finally {
    finish.release();
    await run;
  }
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  expect(() => f.orc.run(id)).toThrow("closed");
  await expect(f.orc.attachContinuation(id, { beforeExecute: async () => {} })).rejects.toThrow("closed");
  expect(await f.resume()).toMatchObject({ ok: true, result: { outcome: "released" } });
});
it("retains renewal activity through the full current-origin operation and its late completion", async () => {
  const f = await fixture();
  const id = await f.orc.startRun({
    workflowId: "flow",
    actor: { principalId: "runtime-owner", credentialId: f.owner.credential.id },
  });
  f.ownership.record(id, "runtime-owner");
  await f.ownership.flush(id);
  const entered = barrier(),
    finish = barrier();
  const operation = f.runtime.withResumeAuthority(id, undefined, async () => {
    entered.release();
    await finish.promise;
    return f.orc.getState(id);
  });
  try {
    await entered.promise;
    expect(await f.prepare()).toMatchObject({
      ok: true,
      result: { outcome: "blocked", active: expect.arrayContaining(["renewal"]) },
    });
  } finally {
    finish.release();
    await operation;
  }
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await expect(f.runtime.checkResumeAuthority(id, undefined)).rejects.toThrow("closed");
  expect(await f.resume()).toMatchObject({ ok: true, result: { outcome: "released" } });
});
it("counts queued receipt verification separately from detached execution after verification settles", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const run = f.orc.run.bind(f.orc);
  vi.spyOn(f.orc, "run").mockImplementation(async (...args) => {
    entered.release();
    await finish.promise;
    return run(...args);
  });
  const authority = {
    workspaceId: f.identity.workspaceId,
    actor: { principalId: f.owner.credential.principal, credentialId: f.owner.credential.id },
    authorize: async () => {},
    onRunAdmitted: async (id: string) => {
      f.ownership.record(id, "runtime-owner");
      await f.ownership.flush(id);
    },
    verifyRunAdmitted: (id: string) => f.ownership.verify(id, "runtime-owner"),
  };
  // Immediately after admit resolves, dispatch is still queued for setImmediate.
  await f.admissions.admitRetry({ workflowId: "flow" }, { idempotencyKey: "runtime-queue" }, authority);
  expect(f.runtime.activity.snapshot().active).toContain("dispatch");
  try {
    await entered.promise;
    await nextTurn();
    expect(await f.prepare()).toMatchObject({
      ok: true,
      result: { outcome: "blocked", active: expect.arrayContaining(["execution"]) },
    });
  } finally {
    finish.release();
  }
  await f.admissions.close();
  // The execution lifetime is distinct from #534 verification shutdown drainage.
  await vi.waitFor(() => expect(f.runtime.activity.snapshot().active).toEqual([]));
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await f.resume();
});
it("counts continuation recovery before asynchronous discovery and defers timer entry while fenced", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const discovery = vi.spyOn(f.locators, "batch").mockImplementation(async () => {
    entered.release();
    await finish.promise;
    return [];
  });
  const recovery = f.daemon.recoverContinuations!();
  try {
    await entered.promise;
    expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["recovery"] } });
  } finally {
    finish.release();
    await recovery;
  }
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await f.daemon.recoverContinuations!();
  expect(discovery).toHaveBeenCalledTimes(1);
  await expect(f.continuations.recoverBatch(async () => undefined)).rejects.toThrow("closed");
  await f.resume();
});
it("refuses release when a serving producer binding changes, keeping admissions fenced", async () => {
  const f = await fixture();
  await f.prepare();
  const prior = f.orc.runtimeActivity!;
  delete f.orc.runtimeActivity;
  expect(await f.resume()).toMatchObject({ ok: false });
  expect(await f.call("runs.start", { workflowId: "flow" })).toMatchObject({ ok: false });
  f.orc.runtimeActivity = prior;
  expect(await f.resume()).toMatchObject({ ok: true, result: { outcome: "released" } });
});
it("counts live callbacks and keeps an answer counted after cancellation removes the pending prompt", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const target = {
    runId: "synthetic-run",
    stepRunId: "step",
    requestId: "permission",
    instanceId: f.identity.instanceId,
    sessionId: "session",
    turnId: "turn",
    invocationId: "invocation",
  };
  const ask = f.runtime.port.ask({
    ...target,
    kind: "permission",
    question: "Continue?",
    context: {},
    options: [{ id: "allow", label: "Allow" }],
    live: {
      identity: target,
      signal: abort.signal,
      withOwnership: (operation) => operation(),
      emitOwned: async () => {},
    },
  });
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["callback"] } });
  const entered = barrier(),
    finish = barrier();
  const answer = f.runtime.port.answer(
    { target, optionId: "allow" },
    {
      actor: { principalId: "runtime-owner" },
      authorize: async () => {
        entered.release();
        await finish.promise;
      },
    },
  );
  const refused = expect(answer).rejects.toThrow();
  try {
    await entered.promise;
    abort.abort();
    await ask;
    expect(f.runtime.port.pendingCount).toBe(0);
    expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["callback"] } });
  } finally {
    finish.release();
    await refused;
  }
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await expect(
    f.runtime.port.answer(
      { target, optionId: "allow" },
      { actor: { principalId: "runtime-owner" }, authorize: async () => {} },
    ),
  ).rejects.toThrow("closed");
  await f.resume();
});
it("counts request dispatch through post-execution settlement after its RPC has returned", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const settle = f.app.program.settle.bind(f.app.program);
  vi.spyOn(f.app.program, "settle").mockImplementation(async (...args) => {
    entered.release();
    await finish.promise;
    return settle(...args);
  });
  expect(await f.call("requests.submit", { title: "Request", body: "Task" })).toMatchObject({
    ok: true,
    result: { state: "accepted" },
  });
  try {
    await entered.promise;
    expect(f.orc.attachedExecutionCount).toBe(0);
    expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["dispatch"] } });
  } finally {
    finish.release();
  }
  await vi.waitFor(() => expect(f.runtime.activity.snapshot().active).toEqual([]));
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  await f.resume();
});
it("refuses acquisition while an application handler is already admitted and denies arrivals behind the fence", async () => {
  const f = await fixture();
  const entered = barrier(),
    finish = barrier();
  const list = f.orc.listRuns.bind(f.orc);
  vi.spyOn(f.orc, "listRuns").mockImplementation(async (...args) => {
    entered.release();
    await finish.promise;
    return list(...args);
  });
  const request = f.call("runs.list");
  try {
    await entered.promise;
    expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "blocked", active: ["rpc"] } });
  } finally {
    finish.release();
    await request;
  }
  expect(await f.prepare()).toMatchObject({ ok: true, result: { outcome: "held" } });
  expect(await f.call("runs.list")).toMatchObject({ ok: false });
  await f.resume();
});
