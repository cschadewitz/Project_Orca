/** Production binding reads sealed ancestry independently of the current responder. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, RequestSchema, TemplateRegistry, WorkflowRegistry, type MutationActor } from "@orca/core";
import { HumanInputPending, LocalWorkspaceProvider, Orchestrator, type LiveDecisionTarget } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { CredentialStore, OwnershipStore, type IssueOptions, type Permission } from "../src/auth/index.js";
import { ControlModel } from "../src/control.js";
import { ReadModel } from "../src/read-model.js";
import { daemonExecutionRuntime } from "../src/execution-runtime.js";
const close: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of close.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});
async function fixture(credential: Partial<IssueOptions> = {}) {
  const stores = memoryStores();
  const credentials = new CredentialStore();
  const original = await credentials.issue({
    principal: "alice",
    permissions: ["runs.start", "runs.read", "runs.control", "inputs.answer"],
    scope: { workflows: ["visible"], runs: "owned" },
    ...credential,
  });
  const actor: MutationActor = { principalId: "alice", credentialId: original.credential.id };
  const ownership = new OwnershipStore();
  const workflows = new WorkflowRegistry()
    .register(
      parseWorkflow(`
id: visible
name: Visible
start: s
nodes:
  s: {type: start}
  gate: {type: gate, question: Continue?, options: [yes, no]}
  end: {type: end}
edges: [{from: s, to: gate}, {from: gate, to: end}]
`),
    )
    .register(
      parseWorkflow(`
id: private-child
name: Child
start: end
nodes: {end: {type: end}}
edges: []
`),
    );
  const options = {
    stores,
    agents: new AgentRegistry(),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
  };
  const orchestrator = new Orchestrator(options);
  const runtime = daemonExecutionRuntime({
    instanceId: "boot",
    orchestrator,
    credentials,
    ownership,
    revalidateMs: 60_000,
  });
  close.push(() => runtime.close());
  const root = async (rootActor: MutationActor = actor) => {
    const runId = await orchestrator.startRun({ workflowId: "visible", actor: rootActor });
    ownership.record(runId, rootActor.principalId);
    return runId;
  };
  return { stores, credentials, original, actor, ownership, options, orchestrator, runtime, root };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function liveAsk(f: Fixture, runId: string, requestId = "permission") {
  const target: LiveDecisionTarget = {
    runId,
    stepRunId: "step",
    requestId,
    instanceId: "boot",
    sessionId: "session",
    turnId: "turn",
    invocationId: requestId,
  };
  const emitOwned = vi.fn(async () => {});
  const query = {
    runId,
    stepRunId: "step",
    requestId,
    kind: "permission" as const,
    question: "Execute?",
    context: {},
    options: [{ id: "allow", label: "Allow" }],
    live: {
      identity: target,
      signal: f.runtime.executionSignal(runId),
      withOwnership: <T>(operation: () => Promise<T>) => operation(),
      emitOwned,
    },
  };
  return { target, query, result: f.runtime.port.ask(query), emitOwned };
}
it("restores the protected root actor before binding instead of trusting a substituted public projection", async () => {
  const f = await fixture();
  const id = await f.root();
  const [created] = await f.stores.events.readRange(id, { limit: 1 });
  expect(created).toMatchObject({ type: "run.created", payload: { actor: f.actor, executionInputsStored: true } });
  expect(created?.executionPayloadRef).toBeTruthy();
  const restore = vi.spyOn(f.stores.execution, "getPayload");
  const read = f.stores.events.readRange.bind(f.stores.events);
  vi.spyOn(f.stores.events, "readRange").mockImplementation(async (...args) =>
    (await read(...args)).map((event) =>
      event.type === "run.created"
        ? {
            ...event,
            payload: { ...event.payload, actor: { principalId: "substituted", credentialId: "substituted" } },
          }
        : event,
    ),
  );
  await f.runtime.prepareExecution(id);
  expect(restore).toHaveBeenCalledWith(id, created!.executionPayloadRef, "run.created");
  expect(f.runtime.executionSignal(id).aborted).toBe(false);
  const pending = liveAsk(f, id);
  f.runtime.close();
  expect(await pending.result).toBeUndefined();
  expect(pending.emitOwned).not.toHaveBeenCalled();
});
it("children and grandchildren inherit the sealed root actor, owner, workflow scope and revocation", async () => {
  const f = await fixture();
  const root = await f.root();
  const child = await f.orchestrator.startRun({
    workflowId: "private-child",
    parentRunId: root,
    parentStepRunId: "spawn",
    actor: { principalId: "untrusted-child", credentialId: "unknown" },
  });
  const grandchild = await f.orchestrator.startRun({
    workflowId: "private-child",
    parentRunId: child,
    parentStepRunId: "spawn-again",
  });
  expect(f.ownership.owner(child)).toBeUndefined();
  expect(f.ownership.owner(grandchild)).toBeUndefined();
  for (const id of [root, child, grandchild]) {
    await f.runtime.prepareExecution(id);
    expect(f.runtime.executionSignal(id).aborted).toBe(false);
  }
  const pending = liveAsk(f, grandchild);
  const expired = vi.fn();
  f.runtime.port.onInvalidated(expired);
  await f.credentials.revoke(f.original.credential.id);
  for (const id of [root, child, grandchild]) expect(f.runtime.executionSignal(id).aborted).toBe(true);
  expect(await pending.result).toBeUndefined();
  expect(expired).toHaveBeenCalledExactlyOnceWith(pending.target);
  expect(pending.emitOwned).not.toHaveBeenCalled();
});
it.each(["revoked", "other owner", "missing owner", "wrong principal", "wrong scope", "missing start grant"])(
  "refuses execution attachment and fresh live callbacks with %s",
  async (reason) => {
    const f = await fixture(
      reason === "wrong scope"
        ? { scope: { workflows: ["other"], runs: "owned" } }
        : reason === "missing start grant"
          ? { permissions: ["runs.read"] }
          : {},
    );
    const id = await f.root(reason === "wrong principal" ? { ...f.actor, principalId: "bob" } : f.actor);
    if (reason === "revoked") await f.credentials.revoke(f.original.credential.id);
    if (reason === "other owner" || reason === "missing owner") {
      f.ownership.forget(id, "alice");
      if (reason === "other owner") f.ownership.record(id, "bob");
    }
    await expect(f.runtime.prepareExecution(id)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.runtime.executionSignal(id).aborted).toBe(true);
    const refused = liveAsk(f, id);
    expect(await refused.result).toBeUndefined();
    expect(f.runtime.port.inspect(refused.target)).toBe("expired");
    expect(refused.emitOwned).not.toHaveBeenCalled();
    await expect(f.runtime.port.ask({ ...refused.query, kind: "decision" })).rejects.toBeInstanceOf(HumanInputPending);
  },
);
it.each(["scope", "grant"])(
  "revalidates a live origin's changed %s immediately without waiting for polling",
  async (change) => {
    const f = await fixture();
    const id = await f.root();
    await f.runtime.prepareExecution(id);
    const pending = liveAsk(f, id);
    const current = f.credentials.current(f.original.credential.id);
    if (!current.ok) throw new Error("fixture credential missing");
    vi.spyOn(f.credentials, "current").mockReturnValue({
      ok: true,
      principal: {
        ...current.principal,
        ...(change === "scope"
          ? { scope: { workflows: ["other"], runs: "owned" } as const }
          : { permissions: new Set<Permission>(["runs.read"]) }),
      },
    });
    expect(f.runtime.executionSignal(id).aborted).toBe(true);
    expect(await pending.result).toBeUndefined();
    expect(pending.emitOwned).not.toHaveBeenCalled();
  },
);
it("attributes an answer to its responder without replacing the original execution identity", async () => {
  const f = await fixture();
  const bob = await f.credentials.issue({ principal: "bob", preset: "operator" });
  const id = await f.root();
  await f.runtime.prepareExecution(id);
  const first = liveAsk(f, id, "first");
  const responder = { principalId: "bob", credentialId: bob.credential.id };
  await f.runtime.port.answer(
    { target: first.target, optionId: "allow" },
    { actor: responder, authorize: async () => {} },
  );
  expect(await first.result).toBe("allow");
  expect(first.emitOwned).toHaveBeenCalledWith(
    expect.objectContaining({ type: "human.answered", payload: expect.objectContaining({ actor: responder }) }),
  );
  const next = liveAsk(f, id, "next");
  await f.credentials.revoke(bob.credential.id);
  expect(f.runtime.executionSignal(id).aborted).toBe(false);
  expect(f.runtime.port.inspect(next.target)).toBe("pending");
  await f.credentials.revoke(f.original.credential.id);
  expect(f.runtime.executionSignal(id).aborted).toBe(true);
  expect(await next.result).toBeUndefined();
  expect(next.emitOwned).not.toHaveBeenCalled();
});
it("requires plan.write only for Request-admitted origins, restoring the protected correlation", async () => {
  const f = await fixture();
  const ordinary = await f.root();
  await f.runtime.prepareExecution(ordinary);
  expect(f.runtime.executionSignal(ordinary).aborted).toBe(false);
  const request = RequestSchema.parse({ id: "request", title: "Task", body: "", createdAt: "now", updatedAt: "now" });
  await f.stores.requests.put(request);
  const requestRun = await f.orchestrator.startRun({
    workflowId: "visible",
    actor: f.actor,
    requestId: "request",
    requestAdmissionId: "admission",
  });
  f.ownership.record(requestRun, "alice");
  await expect(f.runtime.prepareExecution(requestRun)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.runtime.executionSignal(requestRun).aborted).toBe(true);
  const operator = await fixture({ permissions: ["runs.start", "plan.write"], scope: { workflows: "*", runs: "all" } });
  await operator.stores.requests.put(request);
  const permitted = await operator.orchestrator.startRun({
    workflowId: "visible",
    actor: operator.actor,
    requestId: "request",
    requestAdmissionId: "admission",
  });
  operator.ownership.record(permitted, "alice");
  await operator.runtime.prepareExecution(permitted);
  expect(operator.runtime.executionSignal(permitted).aborted).toBe(false);
});
it("keeps actorless legacy work conservative without borrowing the current responder's authority", async () => {
  const f = await fixture();
  const id = await f.orchestrator.startRun({ workflowId: "visible" });
  f.ownership.record(id, "alice");
  await f.runtime.prepareExecution(id);
  const refused = liveAsk(f, id);
  expect(await refused.result).toBeUndefined();
  expect(f.runtime.executionSignal(id).aborted).toBe(true);
  const runner = new Orchestrator({ ...f.options, liveInput: f.runtime });
  expect((await runner.run(id)).run.status).toBe("paused");
  const [gate] = await runner.pendingInputs(id);
  const control = new ControlModel({ orchestrator: runner, reads: new ReadModel({ orchestrator: runner }) });
  await control.answerInput({ runId: id, requestId: gate!.id, optionId: "yes", resume: true }, f.actor);
  expect((await runner.getState(id)).run.status).toBe("completed");
  expect((await runner.events(id)).filter((event) => event.type === "run.cancelled")).toEqual([]);
});
it("prepares under the real lease, releases after parking, and recovers a durable gate after bootstrap rotation", async () => {
  const f = await fixture({ scope: { workflows: "*", runs: "all" }, bootstrap: true });
  const id = await f.root();
  const signals: boolean[] = [];
  const prepareExecution = vi.fn(async (runId: string) => {
    expect((await f.orchestrator.listLeases()).some((lease) => lease.runId === runId && !lease.lapsed)).toBe(true);
    await f.runtime.prepareExecution(runId);
    signals.push(f.runtime.executionSignal(runId).aborted);
  });
  const releaseExecution = vi.fn((runId: string) => f.runtime.releaseExecution(runId));
  const runner = new Orchestrator({ ...f.options, liveInput: { ...f.runtime, prepareExecution, releaseExecution } });
  expect((await runner.run(id)).run.status).toBe("paused");
  expect(prepareExecution).toHaveBeenCalledExactlyOnceWith(id);
  expect(releaseExecution).toHaveBeenCalledExactlyOnceWith(id);
  expect(await runner.listLeases()).toEqual([]);
  const [gate] = await runner.pendingInputs(id);
  expect(gate?.kind).toBe("decision");
  const directory = await mkdtemp(join(tmpdir(), "orca-execution-bootstrap-"));
  close.push(() => rm(directory, { recursive: true, force: true }));
  const next = await f.credentials.bootstrap({ principal: "alice", preset: "owner" }, join(directory, "token"));
  expect(f.credentials.current(next.credentialId).ok).toBe(true);
  const resumedActor = { principalId: "alice", credentialId: next.credentialId };
  expect((await runner.events(id)).some((event) => event.type === "human.answered")).toBe(false);
  const control = new ControlModel({ orchestrator: runner, reads: new ReadModel({ orchestrator: runner }) });
  await expect(
    control.answerInput({ runId: id, requestId: gate!.id, optionId: "yes", resume: true }, resumedActor),
  ).rejects.toMatchObject({ code: "RUN_STATE", details: { answerRecorded: true, executionResumeRequired: true } });
  expect((await runner.getState(id)).run.status).toBe("paused");
  const authorize = vi.fn(async () => {});
  await control.resumeRun({ runId: id }, { actor: resumedActor, authorize });
  expect(authorize).toHaveBeenCalledTimes(2);
  expect((await runner.getState(id)).run.status).toBe("completed");
  expect(signals).toEqual([false, false]);
  expect(prepareExecution).toHaveBeenCalledTimes(2);
  expect(releaseExecution).toHaveBeenCalledTimes(2);
  expect(await runner.listLeases()).toEqual([]);
  const events = await runner.events(id);
  expect(events.filter((event) => event.type === "human.answered")).toMatchObject([
    { payload: { actor: resumedActor, answer: "yes" } },
  ]);
  expect(events.filter((event) => event.type === "run.cancelled")).toEqual([]);
  expect(events[0]).toMatchObject({ payload: { actor: f.actor } });
});
it("refuses a missing protected origin rather than trusting its public actor", async () => {
  const f = await fixture();
  const id = await f.root();
  vi.spyOn(f.stores.execution, "getPayload").mockRejectedValue(new Error("protected payload unavailable"));
  await expect(f.runtime.prepareExecution(id)).rejects.toThrow("protected payload unavailable");
  expect(f.runtime.executionSignal(id).aborted).toBe(true);
});
it("releases binding and the held lease when preparation fails without starting or cancelling work", async () => {
  const f = await fixture();
  const id = await f.root();
  const before = await f.orchestrator.events(id);
  const prepareExecution = vi.fn(async (runId: string) => {
    await f.runtime.prepareExecution(runId);
    throw new Error("preparation interrupted");
  });
  const releaseExecution = vi.fn((runId: string) => f.runtime.releaseExecution(runId));
  const runner = new Orchestrator({ ...f.options, liveInput: { ...f.runtime, prepareExecution, releaseExecution } });
  await expect(runner.run(id)).rejects.toThrow("preparation interrupted");
  expect(prepareExecution).toHaveBeenCalledExactlyOnceWith(id);
  expect(releaseExecution).toHaveBeenCalledExactlyOnceWith(id);
  expect(f.runtime.executionSignal(id).aborted).toBe(true);
  expect(await runner.listLeases()).toEqual([]);
  expect(await runner.events(id)).toEqual(before);
});

it.each([true, false])(
  "refuses protected-origin reference loss even with creation marker retained=%s",
  async (retainMarker) => {
    const f = await fixture();
    const id = await f.root();
    const read = f.stores.events.readRange.bind(f.stores.events);
    vi.spyOn(f.stores.events, "readRange").mockImplementation(async (...args) =>
      (await read(...args)).map((event) => {
        if (event.type !== "run.created") return event;
        const { executionPayloadRef: _ref, ...withoutRef } = event;
        const { executionInputsStored: _marker, ...payload } = event.payload;
        return {
          ...withoutRef,
          payload: { ...payload, ...(retainMarker ? { executionInputsStored: true as const } : {}) },
        };
      }),
    );
    await expect(f.runtime.prepareExecution(id)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(f.runtime.executionSignal(id).aborted).toBe(true);
  },
);
it("does not follow unverified parent metadata or bind an unsealed public actor", async () => {
  const f = await fixture();
  const legacy = await f.orchestrator.startRun({ workflowId: "visible" });
  const read = f.stores.events.readRange.bind(f.stores.events);
  vi.spyOn(f.stores.events, "readRange").mockImplementation(async (...args) =>
    (await read(...args)).map((event) =>
      event.type === "run.created"
        ? { ...event, payload: { ...event.payload, actor: f.actor, parentRunId: "public-only-parent" } }
        : event,
    ),
  );
  await f.runtime.prepareExecution(legacy);
  expect(f.runtime.executionSignal(legacy).aborted).toBe(true);
});
it("requires authenticated material at an intermediate parent hop", async () => {
  const f = await fixture();
  const root = await f.root();
  const child = await f.orchestrator.startRun({ workflowId: "private-child", parentRunId: root });
  const grandchild = await f.orchestrator.startRun({ workflowId: "private-child", parentRunId: child });
  const read = f.stores.events.readRange.bind(f.stores.events);
  vi.spyOn(f.stores.events, "readRange").mockImplementation(async (...args) =>
    (await read(...args)).map((event) => {
      if (event.runId !== child) return event;
      const { executionPayloadRef: _ref, ...withoutRef } = event;
      return withoutRef;
    }),
  );
  await expect(f.runtime.prepareExecution(grandchild)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(f.runtime.executionSignal(grandchild).aborted).toBe(true);
});
