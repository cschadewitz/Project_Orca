import { expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { memoryStores, type Stores } from "@orca/store";
import {
  builtinExecutors,
  completed,
  LiveHumanInput,
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  runLeaseResource,
} from "@orca/engine";
import { ConfigurationGenerations } from "../src/configuration-generation.js";
import type { RunContext } from "../src/run-context.js";

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const workflow = (version = "1") =>
  parseWorkflow(`
id: continuation
name: Continuation
version: '${version}'
start: start
nodes:
  start: {type: start}
  gate: {type: gate, question: Go?, options: [go]}
  work: {type: 'custom:work'}
  end: {type: end}
edges:
  - {from: start, to: gate}
  - {from: gate, to: work}
  - {from: work, to: end}
`);
async function make(stores: Stores = memoryStores(), version = "1") {
  const entered = latch();
  const finish = latch();
  const seen: string[] = [];
  const definition = workflow(version);
  const config = parseOrcaConfig({ agents: [] });
  const executors = builtinExecutors().register({
    type: "custom:work",
    execute: async (ctx) => {
      seen.push(ctx.run.definition.version);
      entered.release();
      await finish.wait;
      return completed();
    },
  });
  const orc = new Orchestrator({
    stores,
    executors,
    agents: AgentRegistry.fromConfig(config),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: [definition], templates: [] }),
    admission: {
      validateStartRun: (opts, material) => orc.validateStartRun(opts, material),
      startRun: (opts, material) => orc.startRun(opts, material),
    },
    validateCustomNode: (node) => executors.validateNode(node),
  });
  await generations.initialize(config, version);
  orc.generations = generations;
  return { orc, stores, generations, entered, finish, seen };
}
async function park(app: Awaited<ReturnType<typeof make>>, parentRunId?: string) {
  const launch = await app.generations.captureLaunch({ purpose: "workflow", workflowId: "continuation" });
  const runId = await launch.startRun({
    actor: { principalId: "owner", credentialId: "credential" },
    ...(parentRunId ? { parentRunId } : {}),
  });
  expect((await app.orc.run(runId)).run.status).toBe("paused");
  return runId;
}
async function marker(rc: RunContext) {
  const input = Object.values(rc.state.humanInputs).at(-1)!;
  await rc.emitOwned({
    type: "continuation.recorded",
    payload: {
      continuationId: "continuation-test",
      state: "accepted",
      ...(input.answer === undefined
        ? {
            decision: {
              requestId: input.id,
              stepRunId: input.stepRunId,
              answer: "go",
              actor: { principalId: "owner" },
            },
          }
        : {}),
      entry: { dispatch: "attached" },
    },
  });
}

it("acknowledges durable attachment before blocked execution finishes and retains the run lease/running map", async () => {
  const app = await make();
  const runId = await park(app);
  const ack = await app.orc.attachContinuation(runId, { beforeExecute: marker });
  let settled = false;
  void ack.completion.then(() => {
    settled = true;
  });
  await app.entered.wait;
  expect(settled).toBe(false);
  expect(app.orc.run(runId)).toBe(ack.completion);
  expect(await app.stores.leases.get(runLeaseResource(runId))).toBeDefined();
  const events = await app.stores.events.read(runId);
  expect(events.findIndex((event) => event.type === "continuation.recorded")).toBeLessThan(
    events.findIndex((event) => event.type === "run.resumed"),
  );
  app.finish.release();
  expect((await ack.completion).run.status).toBe("completed");
  expect(await app.stores.leases.get(runLeaseResource(runId))).toBeUndefined();
});

it("does not resume or execute before current authority and durable marker both finish", async () => {
  const app = await make();
  const runId = await park(app);
  const authorizing = latch();
  const authorized = latch();
  const marking = latch();
  const marked = latch();
  const release = vi.fn();
  app.orc.liveInput = {
    port: new LiveHumanInput("test"),
    executionSignal: () => new AbortController().signal,
    prepareExecution: async () => {
      authorizing.release();
      await authorized.wait;
    },
    releaseExecution: release,
  };
  const attaching = app.orc.attachContinuation(runId, {
    beforeExecute: async (rc) => {
      marking.release();
      await marked.wait;
      await marker(rc);
    },
  });
  await authorizing.wait;
  expect((await app.stores.events.read(runId)).some((event) => event.type === "run.resumed")).toBe(false);
  expect(app.seen).toEqual([]);
  authorized.release();
  await marking.wait;
  expect((await app.stores.events.read(runId)).some((event) => event.type === "run.resumed")).toBe(false);
  expect(app.seen).toEqual([]);
  marked.release();
  const ack = await attaching;
  await app.entered.wait;
  expect(release).not.toHaveBeenCalled();
  app.finish.release();
  await ack.completion;
  expect(release).toHaveBeenCalledExactlyOnceWith(runId);
});

it("concurrent same-instance and separate-instance callers have one attachment winner", async () => {
  const app = await make();
  const other = await make(app.stores);
  const runId = await park(app);
  const entered = latch();
  const unblock = latch();
  const beforeExecute = vi.fn(async (rc: RunContext) => {
    entered.release();
    await unblock.wait;
    await marker(rc);
  });
  const first = app.orc.attachContinuation(runId, { beforeExecute });
  await expect(app.orc.attachContinuation(runId, { beforeExecute })).rejects.toMatchObject({ code: "RUN_LEASED" });
  await entered.wait;
  // A lease acquisition waits for the current mutation mutex, then sees its owner.
  const contender = other.orc.attachContinuation(runId, { beforeExecute });
  unblock.release();
  const ack = await first;
  await expect(contender).rejects.toMatchObject({ code: "RUN_LEASED" });
  expect(beforeExecute).toHaveBeenCalledTimes(1);
  app.finish.release();
  await ack.completion;
});

for (const phase of ["authority", "marker"] as const)
  it(`${phase} failure cleans up and permits a fresh attachment without execution effects`, async () => {
    const app = await make();
    const runId = await park(app);
    const fail = new Error(phase);
    const release = vi.fn();
    app.orc.liveInput = {
      port: new LiveHumanInput("test"),
      executionSignal: () => new AbortController().signal,
      prepareExecution: async () => {
        if (phase === "authority") throw fail;
      },
      releaseExecution: release,
    };
    const callback = vi.fn(async (rc: RunContext) => {
      if (phase === "marker") throw fail;
      await marker(rc);
    });
    await expect(app.orc.attachContinuation(runId, { beforeExecute: callback })).rejects.toBe(fail);
    expect(await app.stores.leases.get(runLeaseResource(runId))).toBeUndefined();
    expect((await app.stores.events.read(runId)).some((event) => event.type === "run.resumed")).toBe(false);
    expect(app.seen).toEqual([]);
    if (phase === "authority") expect(callback).not.toHaveBeenCalled();
    app.orc.liveInput = undefined;
    const ack = await app.orc.attachContinuation(runId, { beforeExecute: marker });
    app.finish.release();
    await ack.completion;
  });

it("restores the original workflow and generation after a newer configuration is published", async () => {
  const first = await make();
  const runId = await park(first);
  const original = (await first.orc.getState(runId)).run.provenance!.configGeneration;
  const second = await make(first.stores, "2");
  const beforeExecute = vi.fn(async (rc: RunContext) => {
    expect(rc.state.run.provenance!.configGeneration).toBe(original);
    expect(rc.definition.version).toBe("1");
    await marker(rc);
  });
  const ack = await second.orc.attachContinuation(runId, { beforeExecute });
  await second.entered.wait;
  expect(second.seen).toEqual(["1"]);
  second.finish.release();
  await ack.completion;
});

it("refuses child and terminal runs without climbing ancestors or calling the marker", async () => {
  const app = await make();
  const root = await park(app);
  const child = await park(app, root);
  const beforeExecute = vi.fn(marker);
  await expect(app.orc.attachContinuation(child, { beforeExecute })).rejects.toMatchObject({ code: "RUN_STATE" });
  expect((await app.orc.getState(root)).run.status).toBe("paused");
  expect(beforeExecute).not.toHaveBeenCalled();
  const ack = await app.orc.attachContinuation(root, { beforeExecute });
  app.finish.release();
  await ack.completion;
  beforeExecute.mockClear();
  await expect(app.orc.attachContinuation(root, { beforeExecute })).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(beforeExecute).not.toHaveBeenCalled();
  expect(await app.stores.leases.list()).toEqual([]);
});

it("accepts a decision already committed atomically by admission without answering it again", async () => {
  const app = await make();
  const runId = await park(app);
  const request = (await app.orc.pendingInputs(runId))[0]!;
  await app.orc.stores.events.append({
    type: "continuation.recorded",
    runId,
    payload: {
      continuationId: "prior",
      state: "accepted",
      entry: { dispatch: "needed" },
      decision: { requestId: request.id, stepRunId: request.stepRunId, answer: "go", actor: { principalId: "owner" } },
    },
  });
  const ack = await app.orc.attachContinuation(runId, { beforeExecute: marker });
  app.finish.release();
  expect((await ack.completion).run.status).toBe("completed");
  const events = await app.orc.stores.events.read(runId);
  expect(events.filter((event) => event.type === "continuation.recorded" && event.payload.decision)).toHaveLength(1);
  expect(events.some((event) => event.type === "human.answered")).toBe(false);
});

it("refuses unsealed legacy boundaries and live callback identities", async () => {
  const app = await make();
  app.orc.generations = undefined;
  const legacy = await app.orc.startRun({ workflowId: "continuation" });
  app.orc.generations = app.generations;
  await app.orc.run(legacy);
  const beforeExecute = vi.fn(marker);
  await expect(app.orc.attachContinuation(legacy, { beforeExecute })).rejects.toMatchObject({ code: "RUN_STATE" });
  const runId = await park(app);
  const request = (await app.orc.pendingInputs(runId))[0]!;
  await app.orc.stores.events.append({
    type: "human.requested",
    runId,
    payload: {
      requestId: request.id,
      stepRunId: request.stepRunId,
      kind: "decision",
      question: "Live",
      options: [{ id: "go", label: "Go" }],
      context: {},
      liveDecision: { instanceId: "test", sessionId: "session", turnId: "turn", invocationId: "invocation" },
    },
  });
  await expect(app.orc.attachContinuation(runId, { beforeExecute })).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(beforeExecute).not.toHaveBeenCalled();
  expect(app.seen).toEqual([]);
  expect(await app.stores.leases.list()).toEqual([]);
});

it("releases the lease and running-map reservation if execution rejects after acknowledgement", async () => {
  const app = await make();
  const runId = await park(app);
  const failure = new Error("execution persistence failed");
  const append = app.orc.stores.events.append.bind(app.orc.stores.events);
  const ack = await app.orc.attachContinuation(runId, {
    beforeExecute: async (rc) => {
      await marker(rc);
      vi.spyOn(app.orc.stores.events, "append").mockRejectedValue(failure);
    },
  });
  await expect(ack.completion).rejects.toBe(failure);
  expect(await app.stores.leases.get(runLeaseResource(runId))).toBeUndefined();
  app.orc.stores.events.append = append;
  const next = await app.orc.attachContinuation(runId, { beforeExecute: marker });
  app.finish.release();
  expect((await next.completion).run.status).toBe("completed");
});
