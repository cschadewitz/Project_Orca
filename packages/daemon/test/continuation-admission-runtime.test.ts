import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRegistry } from "@orca/agents";
import { OrcaError, parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { fileStores, executionEvents } from "@orca/store";
import { builtinExecutors, completed, LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { ConfigurationGenerations } from "../../engine/src/configuration-generation.js";
import { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import { FileRetryClaimStore } from "../../store/src/admission-retry-store.js";
import { FileContinuationLocatorStore } from "../../store/src/continuation-admission-store.js";
import { ContinuationAdmissionModel, type ContinuationAccess } from "../src/continuation-admission.js";
import { Authorizer } from "../src/auth/guard.js";
import { OwnershipStore } from "../src/auth/ownership.js";
import { orchestratorResolver } from "../src/auth/resources.js";
import type { Principal } from "../src/auth/principal.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const faults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "conflict"),
  limit: () => new OrcaError("RETRY_LIMIT", "limit"),
};
/** Real file stores, registered claims, generation capture and interpreter. Only credential runtime is a labelled fixture. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-continuation-runtime-"));
  dirs.push(dir);
  const stores = fileStores(dir);
  const finish = latch(),
    entered = latch();
  const effects = vi.fn();
  let wrapperActive = false;
  const definition = parseWorkflow(`
id: continuation
name: Continuation
version: '1'
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
  const config = parseOrcaConfig({ agents: [] });
  const executors = builtinExecutors().register({
    type: "custom:work",
    execute: async () => {
      effects(wrapperActive);
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
    workspaceProvider: new LocalWorkspaceProvider(dir),
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
  await generations.initialize(config, "test");
  orc.generations = generations;
  const launch = await generations.captureLaunch({ purpose: "workflow", workflowId: "continuation" });
  const runId = await launch.startRun({ actor: { principalId: "alice", credentialId: "credential" } });
  expect((await orc.run(runId)).run.status).toBe("paused");
  let principal: Principal = {
    id: "alice",
    kind: "credential",
    credentialId: "credential",
    permissions: new Set(["runs.read", "runs.control", "inputs.answer", "runs.start"]),
    scope: { workflows: ["continuation"], runs: "owned" },
  };
  const ownership = new OwnershipStore(join(dir, "ownership.json"));
  ownership.record(runId, "alice");
  await ownership.flush(runId);
  const access: ContinuationAccess = {
    current: async () => principal,
    workspaceId: "workspace",
    authorizer: new Authorizer({ ownership, resolver: orchestratorResolver(orc) }),
    executionAuthority: { actor: { principalId: "alice", credentialId: "credential" }, authorize: async () => {} },
  };
  const executionRuntime = {
    checkResumeAuthority: vi.fn(async () => {}),
    // Fixture isolates wrapper lifetime; production credential/revocation binding is tested separately.
    withResumeAuthority: vi.fn(async (_runId, _authority, operation) => {
      wrapperActive = true;
      try {
        return await operation();
      } finally {
        wrapperActive = false;
      }
    }) as ContinuationConstructor["executionRuntime"]["withResumeAuthority"],
  };
  const scheduled: (() => void)[] = [];
  const boot = (defaultScheduler = false) => {
    const retries = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
    return new ContinuationAdmissionModel({
      claims: new RegisteredRetryClaims(retries, faults),
      orchestrator: orc,
      locators: new FileContinuationLocatorStore({ storeDir: dir, execution: stores.execution, retries }),
      executionRuntime,
      ...(defaultScheduler
        ? {}
        : {
            schedule: (work: () => void) => {
              scheduled.push(work);
            },
          }),
    });
  };
  const model = boot();
  const token = await model.expectedBoundary(runId, access);
  if (!token) throw new Error("missing boundary");
  const input = Object.values((await orc.getState(runId)).humanInputs)[0]!;
  const command = {
    runId,
    expectedBoundary: token,
    decision: { requestId: input.id, optionId: "go", note: "private-rationale-SECRET" },
  };
  const admit = async (instance = model) => {
    const result = await instance.admit(command, { idempotencyKey: "intent" }, access);
    if (result.state !== "resolved") throw new Error("not resolved");
    return result.result;
  };
  return {
    dispatch: () => {
      for (const work of scheduled.splice(0)) work();
    },
    dir,
    stores,
    orc,
    access,
    command,
    model,
    boot,
    token,
    runId,
    admit,
    entered,
    finish,
    effects,
    executionRuntime,
    wrapperActive: () => wrapperActive,
    principal: (value: Principal) => {
      principal = value;
    },
    current: () => principal,
  };
}
type ContinuationConstructor = ConstructorParameters<typeof ContinuationAdmissionModel>[0];

it("commits one sealed answer and acceptance, and restart/retry returns the original identity", async () => {
  const f = await fixture();
  expect(await f.boot().expectedBoundary(f.runId, f.access)).toBe(f.token);
  const receipt = await f.admit();
  expect(receipt.state).toBe("accepted");
  expect(f.effects).not.toHaveBeenCalled();
  expect(await f.admit(f.boot())).toEqual(receipt);
  const publicEvents = await f.stores.events.read(f.runId);
  expect(publicEvents.filter((event) => event.type === "continuation.recorded")).toHaveLength(1);
  expect(JSON.stringify(publicEvents)).not.toContain("private-rationale-SECRET");
  const events = await executionEvents(publicEvents, f.stores.execution);
  expect(events.find((event) => event.type === "continuation.recorded")?.payload).toMatchObject({
    entry: { schemaVersion: 1, dispatch: "needed" },
    decision: { answer: "go" },
  });
  expect(await f.model.inspect(receipt.continuationId, f.access)).toEqual(receipt);
});

it("acknowledges fenced attachment before executor settlement and retains resume authority for its lifetime", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  expect((await f.model.reconcile(receipt.continuationId, f.access)).state).toBe("accepted");
  await f.entered.wait;
  expect(f.effects).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.wrapperActive()).toBe(true);
  expect(await f.stores.leases.get(`run:${f.runId}`)).toBeDefined();
  await expect(f.model.reconcile(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "RUN_LEASED" });
  expect(f.effects).toHaveBeenCalledTimes(1);
  f.finish.release();
  await f.model.drain();
  expect(f.wrapperActive()).toBe(false);
  expect((await f.model.inspect(receipt.continuationId, f.access)).state).toBe("settled");
  await f.model.reconcile(receipt.continuationId, f.access);
  expect(f.effects).toHaveBeenCalledTimes(1);
  const events = await executionEvents(await f.stores.events.read(f.runId), f.stores.execution);
  expect(events.filter((event) => event.type === "continuation.recorded" && event.payload.decision)).toHaveLength(1);
});

it("refuses stale tokens and exact input/option mismatches without answering", async () => {
  const f = await fixture();
  await expect(f.model.admit({ ...f.command, expectedBoundary: "forged" }, {}, f.access)).rejects.toMatchObject({
    code: "CONTINUATION_STALE",
  });
  await expect(
    f.model.admit({ ...f.command, decision: { requestId: "other", optionId: "go" } }, {}, f.access),
  ).rejects.toMatchObject({ code: "CONTINUATION_STALE" });
  expect((await f.orc.getState(f.runId)).humanInputs[f.command.decision.requestId]?.answer).toBeUndefined();
});

it("checks current grants and owner/workspace before receipt diagnostics; control does not imply input answer", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  f.principal({ ...f.current(), permissions: new Set(["runs.read"]) });
  expect((await f.model.inspect(receipt.continuationId, f.access)).state).toBe("accepted");
  await expect(f.model.reconcile(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  f.principal({ ...f.current(), permissions: new Set(["runs.control"]) });
  await expect(f.model.reconcile(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  await expect(f.model.inspect("missing", f.access)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  f.principal({ ...f.current(), permissions: new Set(["runs.read"]), id: "bob" });
  await expect(f.model.inspect(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
});

it("records missing execution authority as blocked without executing or answering again", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  f.executionRuntime.checkResumeAuthority.mockRejectedValueOnce(
    new OrcaError("RUN_STATE", "expired", { executionResumeRequired: true }),
  );
  expect(await f.model.reconcile(receipt.continuationId, f.access)).toMatchObject({
    state: "blocked",
    blockedReason: "authority-unavailable",
  });
  expect(f.effects).not.toHaveBeenCalled();
  expect(await f.boot().inspect(receipt.continuationId, f.access)).toMatchObject({ state: "blocked" });
});

it("recovers append-before-ack by re-syncing the same correlation, never a second answer", async () => {
  const f = await fixture();
  const original = f.stores.events.appendDurableUnique!.bind(f.stores.events);
  const synchronize = vi.spyOn(f.stores.events, "synchronizeJournal");
  let fail = true;
  const append = vi.fn(async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (fail) {
      fail = false;
      throw new Error("simulated lost durable acknowledgement");
    }
    return result;
  });
  f.stores.events.appendDurableUnique = append;
  await expect(f.admit()).rejects.toThrow("simulated lost");
  const receipt = await f.admit(f.boot());
  expect(receipt.state).toBe("accepted");
  expect(append).toHaveBeenCalledTimes(1);
  expect(synchronize).toHaveBeenCalled();
  const events = await f.stores.events.read(f.runId);
  expect(events.filter((event) => event.type === "continuation.recorded")).toHaveLength(1);
});

it("authorizes scoped read-only observers while rejecting cross-workspace and revoked receipt reads", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  const observer = {
    ...f.access,
    current: async (): Promise<Principal> => ({
      id: "observer",
      kind: "credential",
      permissions: new Set(["runs.read"]),
      scope: { workflows: ["continuation"], runs: "all" },
    }),
  };
  expect(await f.model.inspect(receipt.continuationId, observer)).toEqual(receipt);
  await expect(f.model.inspect(receipt.continuationId, { ...observer, workspaceId: "another" })).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  await expect(f.model.reconcile(receipt.continuationId, observer)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
});

it("checks revocation inside the commit fence and leaves the gate unanswered", async () => {
  const f = await fixture();
  const bind = f.stores.execution.addSensitivity.bind(f.stores.execution);
  f.stores.execution.addSensitivity = async (...args) => {
    await bind(...args);
    f.principal({ ...f.current(), permissions: new Set(["runs.read"]) });
  };
  await expect(f.admit()).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
  expect((await f.orc.getState(f.runId)).humanInputs[f.command.decision.requestId]?.answer).toBeUndefined();
  expect(await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 1 })).toHaveLength(0);
});

it("blocks stale accepted work after an unrelated journal change without executing", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  await f.stores.events.append({ runId: f.runId, type: "run.paused", payload: { reason: "operator intervention" } });
  expect(await f.model.reconcile(receipt.continuationId, f.access)).toMatchObject({
    state: "blocked",
    blockedReason: "unsafe-boundary",
  });
  expect(f.effects).not.toHaveBeenCalled();
});

it("does not dispatch after uncertain attached publication and recovers as ambiguous", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  const original = f.stores.events.appendDurableUnique!.bind(f.stores.events);
  let fail = true;
  f.stores.events.appendDurableUnique = async (...args) => {
    const result = await original(...args);
    if (fail) {
      fail = false;
      throw new Error("simulated attached acknowledgement loss");
    }
    return result;
  };
  expect(await f.model.reconcile(receipt.continuationId, f.access)).toMatchObject({
    state: "blocked",
    blockedReason: "unsafe-boundary",
  });
  await f.model.drain();
  expect(f.effects).not.toHaveBeenCalled();
  expect(await f.boot().reconcile(receipt.continuationId, f.access)).toMatchObject({
    state: "blocked",
    blockedReason: "unsafe-boundary",
  });
});

it("refuses competing run ownership without writing a receipt transition or dispatching", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  const lease = await f.stores.leases.acquire({ resource: `run:${f.runId}`, holder: "other-interpreter" });
  try {
    await expect(f.model.reconcile(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "RUN_LEASED" });
    expect(f.effects).not.toHaveBeenCalled();
    expect(await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 10 })).toHaveLength(1);
  } finally {
    await f.stores.leases.release(lease);
  }
});

it("strictly validates sealed entries before returning receipt fields", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  const get = f.stores.execution.getPayloads!.bind(f.stores.execution);
  f.stores.execution.getPayloads = async (references) => {
    const payloads = await get(references);
    return payloads.map((payload, index) =>
      references[index]!.type === "continuation.recorded"
        ? { ...payload, entry: { schemaVersion: 1, receipt: null } }
        : payload,
    );
  };
  await expect(f.model.inspect(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("refuses oversized histories before fetching history pages", async () => {
  const f = await fixture();
  const read = vi.spyOn(f.stores.events, "readRange");
  vi.spyOn(f.stores.events, "lastSeq").mockResolvedValue(100_000);
  expect(await f.model.expectedBoundary(f.runId, f.access)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it("schedules production reconciliation after durable admission without awaiting completion", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  expect(f.effects).not.toHaveBeenCalled();
  f.dispatch();
  await f.entered.wait;
  expect(f.effects).toHaveBeenCalledExactlyOnceWith(true);
  f.finish.release();
  await f.model.drain();
  expect((await f.model.inspect(receipt.continuationId, f.access)).state).toBe("settled");
});

it("startup discovery blocks missing credentials, then recovers the same intent with original current authority", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  const restarted = f.boot();
  await restarted.recoverBatch(async () => undefined);
  expect(await restarted.inspect(receipt.continuationId, f.access)).toMatchObject({
    state: "blocked",
    blockedReason: "authority-unavailable",
  });
  expect(f.effects).not.toHaveBeenCalled();
  await restarted.recoverBatch(async (entry) => {
    expect(entry.actor).toEqual({ principalId: "alice", credentialId: "credential" });
    return f.access;
  });
  await f.entered.wait;
  expect(f.effects).toHaveBeenCalledTimes(1);
  f.finish.release();
  await restarted.drain();
  expect((await restarted.inspect(receipt.continuationId, f.access)).state).toBe("settled");
});

it("startup cannot substitute the process owner or a different credential", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  await f
    .boot()
    .recoverBatch(async () => ({ ...f.access, current: async () => ({ ...f.current(), credentialId: "substitute" }) }));
  expect(await f.model.inspect(receipt.continuationId, f.access)).toMatchObject({
    state: "blocked",
    blockedReason: "authority-unavailable",
  });
  expect(f.effects).not.toHaveBeenCalled();
});

it("rebuilds a missing locator only from its verified authoritative marker", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  await rm(join(f.dir, "private-execution", `continuation-locator-${receipt.continuationId}.generation.json`));
  await expect(f.boot().inspect(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "RUN_STATE" });
  const restarted = f.boot();
  await restarted.recoverBatch(async () => undefined);
  expect(await restarted.inspect(receipt.continuationId, f.access)).toMatchObject({
    continuationId: receipt.continuationId,
    operationId: receipt.operationId,
    state: "blocked",
    blockedReason: "authority-unavailable",
  });
  const markers = await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 100 });
  expect(markers.filter((event) => event.type === "continuation.recorded" && event.payload.decision)).toHaveLength(1);
  expect(f.effects).not.toHaveBeenCalled();
});

it("default setImmediate scheduling dispatches without an explicit reconcile request", async () => {
  const f = await fixture();
  const model = f.boot(true);
  const receipt = await f.admit(model);
  expect(receipt.state).toBe("accepted");
  expect(f.effects).not.toHaveBeenCalled();
  await f.entered.wait;
  expect(f.effects).toHaveBeenCalledExactlyOnceWith(true);
  f.finish.release();
  await model.drain();
  expect((await model.inspect(receipt.continuationId, f.access)).state).toBe("settled");
});
