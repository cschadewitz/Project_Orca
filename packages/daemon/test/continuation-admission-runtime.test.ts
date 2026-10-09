import { RuntimeActivity } from "../src/runtime-activity.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import { authForbidden } from "../src/auth/errors.js";
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
async function fixture(runtimeActivity?: RuntimeActivity) {
  const dir = await mkdtemp(join(tmpdir(), "orca-continuation-runtime-"));
  dirs.push(dir);
  const stores = fileStores(dir);
  const finish = latch(),
    entered = latch();
  const effects = vi.fn();
  let activeWrappers = 0;
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
      effects(activeWrappers > 0);
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
      activeWrappers++;
      try {
        return await operation();
      } finally {
        activeWrappers--;
      }
    }) as ContinuationConstructor["executionRuntime"]["withResumeAuthority"],
  };
  const scheduled: (() => void)[] = [];
  const boot = (defaultScheduler = false, orchestrator = orc) => {
    const retries = new FileRetryClaimStore({ storeDir: dir, execution: stores.execution, faults });
    return new ContinuationAdmissionModel({
      runtimeActivity,
      claims: new RegisteredRetryClaims(retries, faults),
      orchestrator,
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
  if (runtimeActivity) orc.runtimeActivity = runtimeActivity;
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
    otherOrchestrator: () => {
      const other = new Orchestrator({
        stores: fileStores(dir),
        executors,
        agents: orc.agents,
        workflows: orc.workflows,
        templates: orc.templates,
        workspaceProvider: new LocalWorkspaceProvider(dir),
        humanInput: new PausingHumanInput(),
      });
      other.generations = generations;
      return other;
    },
    token,
    runId,
    admit,
    entered,
    finish,
    effects,
    executionRuntime,
    wrapperActive: () => activeWrappers > 0,
    principal: (value: Principal) => {
      principal = value;
    },
    current: () => principal,
  };
}
type ContinuationConstructor = ConstructorParameters<typeof ContinuationAdmissionModel>[0];

/** Independent disk oracle: include sealed retry material, lookup/quota records and run markers. */
async function intentFiles(dir: string) {
  const files: Record<string, string> = {};
  for (const area of ["admission-retries", "private-execution", "runs"]) {
    let entries;
    try {
      entries = await readdir(join(dir, area), { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        files[path] = (await readFile(path)).toString("base64");
      }
    }
  }
  return files;
}

/** Read sealed operations through an independent store; never use a refused client projection. */
async function reservations(dir: string) {
  const records = new FileRetryClaimStore({ storeDir: dir, execution: fileStores(dir).execution, faults });
  const files = (await readdir(join(dir, "admission-retries"))).filter((name) =>
    /^retry_[a-f0-9-]{36}\.json$/.test(name),
  );
  return Promise.all(
    files.sort().map(async (name) => {
      const record = await records.read(name.slice(0, -5));
      return {
        operationId: record!.operationId,
        phase: record!.phase,
        continuationId: record!.binding?.continuationId,
      };
    }),
  );
}

it("revalidates a fresh boundary after waiting for run ownership without reserving stale intent", async () => {
  const f = await fixture();
  const waiting = latch(),
    release = latch();
  const acquire = f.stores.leases.acquire.bind(f.stores.leases);
  vi.spyOn(f.stores.leases, "acquire").mockImplementationOnce(async (...args) => {
    waiting.release();
    await release.wait;
    return acquire(...args);
  });
  const admission = expect(f.admit()).rejects.toMatchObject({ code: "CONTINUATION_STALE" });
  try {
    await waiting.wait;
    // The lookup miss has released its catalog mutex and published no operation.
    expect(await readdir(join(f.dir, "admission-retries"))).toEqual([]);
    await f.orc.cancel(f.runId);
    expect((await f.orc.getState(f.runId)).run.status).toBe("cancelled");
    const before = await intentFiles(f.dir);
    release.release();
    await admission;
    expect(await intentFiles(f.dir)).toEqual(before);
    expect(f.effects).not.toHaveBeenCalled();
    expect(f.executionRuntime.withResumeAuthority).not.toHaveBeenCalled();
  } finally {
    release.release();
    await admission;
  }
});

it.each(["same-key", "different-key"] as const)(
  "preserves %s semantics when another caller accepts and attaches before fresh ownership acquisition",
  async (kind) => {
    const f = await fixture();
    const winner = f.boot();
    const waiting = latch(),
      release = latch();
    const acquire = f.stores.leases.acquire.bind(f.stores.leases);
    vi.spyOn(f.stores.leases, "acquire").mockImplementationOnce(async (...args) => {
      waiting.release();
      await release.wait;
      return acquire(...args);
    });
    const request = f.model.admit(
      f.command,
      { idempotencyKey: kind === "same-key" ? "intent" : "other-intent" },
      f.access,
    );
    const observed =
      kind === "same-key"
        ? expect(request).resolves.toMatchObject({ state: "resolved", replayed: true })
        : expect(request).rejects.toMatchObject({ code: "RUN_LEASED" });
    try {
      await waiting.wait;
      const receipt = await f.admit(winner);
      await winner.reconcile(receipt.continuationId, f.access);
      await f.entered.wait;
      const before = await intentFiles(f.dir);
      release.release();
      await observed;
      if (kind === "same-key") expect(await request).toMatchObject({ result: receipt });
      expect(await intentFiles(f.dir)).toEqual(before);
      expect(f.effects).toHaveBeenCalledTimes(1);
    } finally {
      release.release();
      f.finish.release();
      await observed;
      await winner.drain();
      await f.model.drain();
    }
  },
);

it.each(["keyed", "unkeyed"] as const)(
  "rejects fresh %s terminal intent without durable reservation, publication, attachment or execution",
  async (kind) => {
    const f = await fixture();
    const original = await f.admit();
    await f.model.reconcile(original.continuationId, f.access);
    await f.entered.wait;
    f.finish.release();
    await f.model.drain();
    expect((await f.orc.getState(f.runId)).run.status).toBe("completed");
    expect(await f.model.inspect(original.continuationId, f.access)).toEqual({ ...original, state: "settled" });
    const before = await intentFiles(f.dir);
    const operations = await reservations(f.dir);
    const state = await f.orc.getState(f.runId);
    const retry = kind === "keyed" ? { idempotencyKey: "fresh-terminal" } : {};
    const resume = vi.mocked(f.executionRuntime.withResumeAuthority).mock.calls.length;
    for (const model of [f.model, f.boot()]) {
      await expect(model.admit(f.command, retry, f.access)).rejects.toMatchObject({ code: "CONTINUATION_STALE" });
      expect(await reservations(f.dir)).toEqual(operations);
      expect(await intentFiles(f.dir)).toEqual(before);
      expect(await f.orc.getState(f.runId)).toEqual(state);
      expect(await f.stores.leases.get(`run:${f.runId}`)).toBeUndefined();
      expect(model.taskCount).toBe(0);
    }
    expect(f.effects).toHaveBeenCalledTimes(1);
    expect(f.executionRuntime.withResumeAuthority).toHaveBeenCalledTimes(resume);
    // A retained successful intent still returns its original acceptance on a completed run.
    expect(await f.admit(f.boot())).toEqual(original);
    expect(await intentFiles(f.dir)).toEqual(before);
  },
);

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

it("refuses stale tokens and exact input/option mismatches without answering or consuming the key", async () => {
  const f = await fixture();
  const retry = { idempotencyKey: "invalid-then-corrected" };
  for (const command of [
    { ...f.command, expectedBoundary: "forged" },
    { ...f.command, decision: { requestId: "other", optionId: "go" } },
    { ...f.command, decision: { requestId: f.command.decision.requestId, optionId: "other" } },
    { runId: f.runId, expectedBoundary: f.token },
  ]) {
    await expect(f.model.admit(command, retry, f.access)).rejects.toMatchObject({ code: "CONTINUATION_STALE" });
    expect(await readdir(join(f.dir, "admission-retries"))).toEqual([]);
  }
  expect((await f.orc.getState(f.runId)).humanInputs[f.command.decision.requestId]?.answer).toBeUndefined();
  expect(await f.model.admit(f.command, retry, f.access)).toMatchObject({ state: "resolved", replayed: false });
  expect(f.effects).not.toHaveBeenCalled();
});

it("refuses fresh intent with a missing boundary key without provisioning replacement authority", async () => {
  const f = await fixture();
  const read = f.stores.execution.getGeneration.bind(f.stores.execution);
  const missing = vi.spyOn(f.stores.execution, "getGeneration").mockImplementation(async (id) => {
    return id.startsWith("continuation-boundary-key-") ? undefined : read(id);
  });
  const writes = vi.spyOn(f.stores.execution, "putGeneration");
  try {
    await expect(f.admit()).rejects.toMatchObject({ code: "CONTINUATION_STALE" });
    expect(writes.mock.calls.filter(([id]) => id.startsWith("continuation-boundary-key-"))).toEqual([]);
    expect(await readdir(join(f.dir, "admission-retries"))).toEqual([]);
    expect((await f.orc.getState(f.runId)).humanInputs[f.command.decision.requestId]?.answer).toBeUndefined();
  } finally {
    missing.mockRestore();
  }
  expect((await f.admit()).state).toBe("accepted");
  expect(f.effects).not.toHaveBeenCalled();
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

it("preserves accepted intent when a real lease incumbent releases before the refusal is handled", async () => {
  const f = await fixture();
  const receipt = await f.admit();
  const lease = await f.stores.leases.acquire({ resource: `run:${f.runId}`, holder: "other-interpreter" });
  const acquire = f.stores.leases.acquire.bind(f.stores.leases);
  const intercepted = vi.spyOn(f.stores.leases, "acquire").mockImplementationOnce(async (...args) => {
    expect(args[0].holder).toBe(f.orc.leaseHolder);
    const incumbent = await acquire(...args); // The actual file lease refuses execution.
    expect(incumbent.holder).toBe("other-interpreter");
    await f.stores.leases.release(lease); // Publication would now be able to take its fence.
    return incumbent;
  });
  try {
    await expect(f.model.reconcile(receipt.continuationId, f.access)).rejects.toMatchObject({ code: "RUN_LEASED" });
    expect(await f.stores.leases.get(`run:${f.runId}`)).toBeUndefined();
    expect(await f.model.inspect(receipt.continuationId, f.access)).toEqual(receipt);
    expect(await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 10 })).toHaveLength(1);
    expect(f.effects).not.toHaveBeenCalled();
    intercepted.mockRestore();
    expect(await f.model.reconcile(receipt.continuationId, f.access)).toEqual(receipt);
    await f.entered.wait;
    f.finish.release();
    await f.model.drain();
    expect(await f.model.inspect(receipt.continuationId, f.access)).toEqual({ ...receipt, state: "settled" });
    expect(f.effects).toHaveBeenCalledTimes(1);
  } finally {
    intercepted.mockRestore();
    await f.stores.leases.release(lease);
    f.finish.release();
    await f.model.drain();
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

it.each(["same", "separate"] as const)(
  "preserves the winning receipt when a %s-model scheduled replay loses before execution lease acquisition",
  async (instance) => {
    const f = await fixture();
    const loser = instance === "same" ? f.model : f.boot();
    const reserved = latch(),
      releaseReservation = latch(),
      replayFinished = latch();
    const outcomes: unknown[] = [];
    const summary = f.orc.getSummary.bind(f.orc);
    // attachContinuation has reserved its running slot when it requests this summary.
    vi.spyOn(f.orc, "getSummary").mockImplementationOnce(async (...args) => {
      reserved.release();
      await releaseReservation.wait;
      return summary(...args);
    });
    for (const model of new Set([f.model, loser])) {
      const reconcile = model.reconcile.bind(model);
      vi.spyOn(model, "reconcile").mockImplementation(async (...args) => {
        try {
          const result = await reconcile(...args);
          outcomes.push(result);
          return result;
        } catch (error) {
          outcomes.push(error);
          throw error;
        } finally {
          replayFinished.release();
        }
      });
    }
    try {
      const receipt = await f.admit();
      expect(await f.admit(loser)).toEqual(receipt);
      f.dispatch(); // Both retained-key responses schedule real reconciliation.
      await reserved.wait;
      await replayFinished.wait; // The winner remains behind the pre-lease barrier.
      expect(await f.stores.leases.get(`run:${f.runId}`)).toBeUndefined();
      const before = await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 10 });
      expect(before.map((event) => event.type === "continuation.recorded" && event.payload.state)).toEqual([
        "accepted",
      ]);
      expect(outcomes).toEqual([expect.objectContaining({ code: "RUN_LEASED" })]);
      expect(await f.model.inspect(receipt.continuationId, f.access)).toEqual(receipt);
      expect(f.effects).not.toHaveBeenCalled();
      releaseReservation.release();
      await f.entered.wait;
      f.finish.release();
      await f.model.drain();
      await loser.drain();
      expect(await f.model.inspect(receipt.continuationId, f.access)).toEqual({ ...receipt, state: "settled" });
      const events = await executionEvents(await f.stores.events.read(f.runId), f.stores.execution);
      const markers = events.filter((event) => event.type === "continuation.recorded");
      expect(markers.map((event) => event.payload.continuationId)).toEqual(Array(3).fill(receipt.continuationId));
      expect(markers.map((event) => event.payload.state)).toEqual(["accepted", "accepted", "settled"]);
      expect(markers.filter((event) => event.payload.decision)).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
      expect(f.effects).toHaveBeenCalledExactlyOnceWith(true);
      const lastSeq = await f.stores.events.lastSeq(f.runId);
      await expect(f.model.admit(f.command, { idempotencyKey: "fresh-terminal" }, f.access)).rejects.toMatchObject({
        code: "CONTINUATION_STALE",
      });
      expect(await f.stores.events.lastSeq(f.runId)).toBe(lastSeq);
    } finally {
      releaseReservation.release();
      f.finish.release();
      await f.model.drain();
      await loser.drain();
    }
  },
);

it("separate interpreters contend on the real execution lease without changing the winning receipt", async () => {
  const f = await fixture();
  const other = f.otherOrchestrator();
  const loser = f.boot(false, other);
  const reserved = latch(),
    releaseReservation = latch();
  const summary = other.getSummary.bind(other);
  vi.spyOn(other, "getSummary").mockImplementationOnce(async (...args) => {
    const paused = await summary(...args);
    reserved.release();
    await releaseReservation.wait;
    return paused;
  });
  try {
    const receipt = await f.admit();
    const acquire = vi.spyOn(other.stores.leases, "acquire");
    const replay = expect(loser.reconcile(receipt.continuationId, f.access)).rejects.toMatchObject({
      code: "RUN_LEASED",
    });
    await reserved.wait; // The separate interpreter has read dispatch=needed and a paused summary.
    await f.model.reconcile(receipt.continuationId, f.access);
    await f.entered.wait;
    releaseReservation.release();
    await replay;
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ holder: other.leaseHolder }));
    expect(await f.model.inspect(receipt.continuationId, f.access)).toEqual(receipt);
    expect(await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 10 })).toHaveLength(2);
    f.finish.release();
    await f.model.drain();
    await loser.drain();
    expect(await loser.reconcile(receipt.continuationId, f.access)).toEqual({ ...receipt, state: "settled" });
    expect(f.effects).toHaveBeenCalledTimes(1);
  } finally {
    releaseReservation.release();
    f.finish.release();
    await f.model.drain();
    await loser.drain();
  }
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

it.each(["replay", "startup"] as const)(
  "does not turn a %s lease refusal into an authority failure during original settlement",
  async (path) => {
    const f = await fixture();
    const settling = latch(),
      releaseSettlement = latch(),
      leaseRefused = latch(),
      releaseRefusal = latch();
    const wrapper = vi.mocked(f.executionRuntime.withResumeAuthority);
    const runtime = wrapper.getMockImplementation()!;
    wrapper.mockImplementation(async (...args) => {
      const state = await runtime(...args);
      settling.release();
      await releaseSettlement.wait;
      return state;
    });
    const reconcile = f.model.reconcile.bind(f.model);
    vi.spyOn(f.model, "reconcile").mockImplementation(async (...args) => {
      try {
        return await reconcile(...args);
      } catch (error) {
        if (error instanceof OrcaError && error.code === "RUN_LEASED") {
          leaseRefused.release();
          await releaseRefusal.wait;
        }
        throw error;
      }
    });
    const tasks = (f.model as unknown as { tasks: Set<Promise<void>> }).tasks;
    try {
      const receipt = await f.admit();
      f.dispatch();
      await f.entered.wait;
      let recoveryTask: Promise<void> | undefined;
      if (path === "startup") {
        recoveryTask = f.model.recoverBatch(async () => f.access);
      } else {
        const before = new Set(tasks);
        expect(await f.admit()).toEqual(receipt);
        f.dispatch();
        recoveryTask = [...tasks].find((task) => !before.has(task));
      }
      expect(recoveryTask).toBeDefined();
      await leaseRefused.wait;
      f.finish.release();
      await settling.wait;
      expect((await f.orc.getState(f.runId)).run.status).toBe("completed");
      expect(await f.stores.leases.get(`run:${f.runId}`)).toBeUndefined();
      releaseRefusal.release();
      await recoveryTask;
      expect(await f.model.inspect(receipt.continuationId, f.access)).toMatchObject({ state: "accepted" });
      releaseSettlement.release();
      await f.model.drain();
      expect(await f.model.inspect(receipt.continuationId, f.access)).toMatchObject({ state: "settled" });
      expect(f.effects).toHaveBeenCalledTimes(1);
    } finally {
      f.finish.release();
      releaseRefusal.release();
      releaseSettlement.release();
      await f.model.drain();
    }
  },
);

it.each([
  ["unknown journal failure", new OrcaError("RUN_STATE", "uncertain journal"), "accepted"],
  ["current authority refusal", authForbidden(), "blocked"],
  [
    "current execution authority refusal",
    new OrcaError("RUN_STATE", "resume unavailable", { executionResumeRequired: true }),
    "blocked",
  ],
] as const)("classifies scheduled %s without inventing authority loss", async (_name, error, expected) => {
  const f = await fixture();
  const receipt = await f.admit();
  vi.spyOn(f.model, "reconcile").mockRejectedValue(error);
  f.dispatch();
  await f.model.drain();
  expect(await f.model.inspect(receipt.continuationId, f.access)).toMatchObject({
    state: expected,
    ...(expected === "blocked" ? { blockedReason: "authority-unavailable" } : {}),
  });
  expect(f.effects).not.toHaveBeenCalled();
});

it.each(["same", "separate"] as const)(
  "preserves completed settlement when a %s-instance replay read needed before attachment",
  async (instance) => {
    const f = await fixture();
    const loser = instance === "same" ? f.model : f.boot();
    const preflight = latch(),
      releasePreflight = latch(),
      settling = latch(),
      releaseSettlement = latch();
    f.executionRuntime.checkResumeAuthority.mockImplementationOnce(async () => {
      preflight.release();
      await releasePreflight.wait;
    });
    const wrapper = vi.mocked(f.executionRuntime.withResumeAuthority);
    const runtime = wrapper.getMockImplementation()!;
    wrapper.mockImplementation(async (...args) => {
      const state = await runtime(...args);
      settling.release();
      await releaseSettlement.wait;
      return state;
    });
    try {
      const receipt = await f.admit();
      const replay = loser.reconcile(receipt.continuationId, f.access);
      await preflight.wait; // Loser has read dispatch=needed and the paused boundary.
      await f.model.reconcile(receipt.continuationId, f.access);
      await f.entered.wait;
      f.finish.release();
      await settling.wait;
      expect((await f.orc.getState(f.runId)).run.status).toBe("completed");
      expect(await f.stores.leases.get(`run:${f.runId}`)).toBeUndefined();
      releasePreflight.release(); // Its stale attachment now enters inner recovery.
      expect(await replay).toMatchObject({ state: "settled" });
      releaseSettlement.release();
      await f.model.drain();
      await loser.drain();
      expect(await f.model.inspect(receipt.continuationId, f.access)).toMatchObject({ state: "settled" });
      const events = await executionEvents(await f.stores.events.read(f.runId), f.stores.execution);
      const markers = events.filter((event) => event.type === "continuation.recorded");
      expect(markers.map((event) => event.payload.state)).toEqual(["accepted", "accepted", "settled"]);
      expect(markers.filter((event) => event.payload.decision)).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
      expect(f.effects).toHaveBeenCalledTimes(1);
    } finally {
      releasePreflight.release();
      releaseSettlement.release();
      f.finish.release();
      await f.model.drain();
      await loser.drain();
    }
  },
);

it.each(["fence", "store", "store-after-append"] as const)(
  "does not classify successful execution as unsafe after settlement %s refusal",
  async (failure) => {
    const f = await fixture();
    const receipt = await f.admit();
    await f.model.reconcile(receipt.continuationId, f.access);
    await f.entered.wait;
    const refused = vi.fn();
    if (failure === "fence") {
      const acquire = f.stores.leases.acquire.bind(f.stores.leases);
      vi.spyOn(f.stores.leases, "acquire")
        .mockImplementationOnce(async () => {
          refused();
          throw new OrcaError("RUN_LEASED", "settlement fence refused");
        })
        .mockImplementation(acquire);
    } else {
      const append = f.stores.events.appendDurableUnique!.bind(f.stores.events);
      vi.spyOn(f.stores.events, "appendDurableUnique").mockImplementationOnce(async (...args) => {
        refused();
        if (failure === "store-after-append") await append(...args);
        throw new OrcaError("RUN_STATE", "settlement publication uncertain");
      });
    }
    f.finish.release();
    await f.model.drain();
    expect(refused).toHaveBeenCalledTimes(1);
    expect((await f.orc.getState(f.runId)).run.status).toBe("completed");
    expect(await f.model.inspect(receipt.continuationId, f.access)).toMatchObject({
      state: failure === "store-after-append" ? "settled" : "accepted",
    });
    const restarted = f.boot();
    expect(await restarted.reconcile(receipt.continuationId, f.access)).toMatchObject({ state: "settled" });
    expect(f.effects).toHaveBeenCalledTimes(1);
    const markers = await f.stores.events.readRange(f.runId, { types: ["continuation.recorded"], limit: 10 });
    expect(markers.map((event) => event.type === "continuation.recorded" && event.payload.state)).toEqual([
      "accepted",
      "accepted",
      "settled",
    ]);
  },
);

it("uses terminal history when the execution wrapper rejects after completion", async () => {
  const f = await fixture();
  const wrapper = vi.mocked(f.executionRuntime.withResumeAuthority);
  const runtime = wrapper.getMockImplementation()!;
  wrapper.mockImplementation(async (...args) => {
    await runtime(...args);
    throw new OrcaError("RUN_STATE", "wrapper cleanup refused after completion");
  });
  const receipt = await f.admit();
  await f.model.reconcile(receipt.continuationId, f.access);
  await f.entered.wait;
  f.finish.release();
  await f.model.drain();
  expect((await f.orc.getState(f.runId)).run.status).toBe("completed");
  expect(await f.model.inspect(receipt.continuationId, f.access)).toMatchObject({ state: "settled" });
  expect(f.effects).toHaveBeenCalledTimes(1);
});

it("holds runtime activity from queued continuation admission through detached settlement", async () => {
  const activity = new RuntimeActivity();
  const f = await fixture(activity);
  activity.bind(
    () => ({ available: true, active: f.orc.attachedExecutionCount ? ["execution"] : [] }),
    () => false,
  );
  const receipt = await f.admit();
  expect(receipt.state).toBe("accepted");
  expect(activity.prepare("owner")).toEqual({ held: false, active: ["continuation"] });
  f.dispatch();
  try {
    await f.entered.wait;
    expect(activity.prepare("owner").held).toBe(false);
    expect(activity.snapshot().active).toEqual(expect.arrayContaining(["continuation", "execution"]));
  } finally {
    f.finish.release();
    await f.model.drain();
  }
  expect(activity.prepare("owner")).toEqual({ held: true, active: [] });
  expect(() => activity.enter("continuation")).toThrow("closed");
  activity.resume("owner");
});
