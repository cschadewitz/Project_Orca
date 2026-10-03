/** A pinned action ID restricts ordinary answers without reading or granting a revision boundary. */
import { afterEach, expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry, type WorkflowDefinition } from "@orca/core";
import { createRevisionRuntime, Orchestrator, workflowRevision } from "@orca/engine";
import { InMemoryEventStore, memoryStores, ProtectedEventStore } from "@orca/store";
import { HelloResultSchema, InputsListResultSchema, PROTOCOL_VERSION, type ResponseMessage } from "@orca/protocol";
import { CredentialStore, OwnershipStore, orchestratorResolver, type Permission } from "../src/auth/index.js";
import { ReadModel } from "../src/read-model.js";
import { startDaemon } from "../src/server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
function definition() {
  return parseWorkflow(`
id: restricted
name: Restricted
version: '1'
start: gate
nodes:
  gate:
    type: gate
    question: Continue?
    options: [changes, done]
    revision:
      actionId: changes
      destinationNodeId: agent
      payload: {kind: text, maxBytes: 1024}
      composition: replace-revision-slot
  agent: {type: agent, agent: worker, prompt: PRIVATE-PROMPT}
  end: {type: end}
edges:
  - {from: gate, to: agent, when: "choice == 'changes'"}
  - {from: gate, to: end, when: "choice == 'done'"}
  - {from: agent, to: end}
`);
}
async function fixture(
  options: { definition?: WorkflowDefinition; pinned?: boolean; provenance?: boolean; nodeType?: string } = {},
) {
  const def = options.definition ?? definition();
  // Plain public events isolate this new lookup from the protected facade's existing
  // integrity checks, so a denied row must perform zero private-definition reads here.
  const base = memoryStores();
  const stores = { ...base, events: new ProtectedEventStore(new InMemoryEventStore(), base.execution) };
  await stores.workflows.put(def);
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(def),
    templates: new TemplateRegistry(),
  });
  const reads = new ReadModel({ orchestrator: orc });
  const ownership = new OwnershipStore();
  const addRun = async (runId: string, workflowId = def.id, revision = workflowRevision(def)) => {
    await stores.events.append({
      runId,
      type: "run.created",
      payload: {
        workflowId,
        workflowVersion: def.version,
        ...(options.pinned === false ? {} : { workflowStored: true }),
        vars: {},
        workspace: { hostId: "local", cwd: "/tmp" },
        ...(options.provenance === false
          ? {}
          : {
              provenance: {
                configGeneration: "historical-generation",
                workflow: { id: workflowId, version: def.version, revision },
                inputs: [],
                selections: [],
              },
            }),
      },
    });
    await stores.events.append({ runId, type: "run.started", payload: {} });
    await stores.events.append({
      runId,
      type: "step.scheduled",
      payload: {
        stepRunId: `${runId}-step`,
        nodeId: "gate",
        nodeType: options.nodeType ?? "gate",
        attempt: 1,
      },
    });
    await stores.events.append({
      runId,
      type: "step.started",
      payload: { stepRunId: `${runId}-step`, inputArtifactIds: [] },
    });
    await stores.events.append({
      runId,
      type: "human.requested",
      payload: {
        requestId: `${runId}-ask`,
        stepRunId: `${runId}-step`,
        kind: "decision",
        question: "Continue?",
        options: [
          { id: "changes", label: "Changes" },
          { id: "done", label: "Done" },
        ],
        context: {},
      },
    });
    await stores.events.append({ runId, type: "step.waiting", payload: { stepRunId: `${runId}-step`, on: "human" } });
    await stores.events.append({ runId, type: "run.paused", payload: {} });
  };
  await addRun("run");
  ownership.record("run", "alice");
  const row = (await reads.inputsList({ runId: "run" })).inputs[0]!;
  const credentials = new CredentialStore();
  const issue = (permissions: Permission[] = ["runs.read"], principal = "alice") =>
    credentials.issue({
      principal,
      permissions,
      scope: { workflows: [def.id], runs: "owned" },
    });
  const reader = await issue();
  const daemon = await startDaemon({
    orcaVersion: "test",
    capabilities: ["runs.read"],
    reads,
    auth: { mode: "token", credentials, ownership, resolver: orchestratorResolver(orc) },
  });
  cleanups.push(daemon.close);
  const rpc = async (token = reader.token, method = "inputs.list", params: unknown = {}) => {
    const response = await fetch(`${daemon.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: 1, method, params }),
    });
    return (await response.json()) as ResponseMessage;
  };
  const list = async () => {
    const response = await rpc();
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (!response.ok) throw new Error("inputs.list failed");
    return InputsListResultSchema.parse(response.result);
  };
  return { def, stores, orc, reads, ownership, credentials, reader, issue, row, addRun, rpc, list };
}

it("projects only the authorized restriction while an execution lease remains held", async () => {
  const f = await fixture();
  const lease = await f.stores.leases.acquire({ resource: "run:run", holder: "interpreter" });
  try {
    const runtime = createRevisionRuntime({ stores: f.stores, authorizeExecution: async () => {} });
    await expect(runtime.readBoundaries("run")).resolves.toEqual([]);
    expect((await f.stores.leases.get("run:run"))?.guardedId).toBe(lease.guardedId);
    const page = await f.list();
    expect(page.inputs[0]).toMatchObject({ revisionActionId: "changes", id: "run-ask" });
    expect(page.inputs[0]!.revision).toBeUndefined();
    expect(page.waiting).toBe(1);
    expect(JSON.stringify(page)).not.toMatch(/PRIVATE-PROMPT|inputSchema|expectedRevision|destinationNodeId/);
    const hello = await f.rpc(f.reader.token, "hello", { protocol: PROTOCOL_VERSION, client: "restriction-test" });
    expect(hello.ok).toBe(true);
    if (hello.ok) expect(HelloResultSchema.parse(hello.result).methods).not.toContain("inputs.revise");
  } finally {
    await f.stores.leases.release(lease);
  }
});

it("filters denied rows before any private pin lookup and keeps waiting consistent", async () => {
  const f = await fixture();
  await f.addRun("denied", "private-flow");
  const lookup = vi.spyOn(f.stores.workflows, "get");
  const helper = vi.spyOn(f.reads, "inputRevisionActionId");
  const page = await f.list();
  expect(page.inputs.map((row) => row.runId)).toEqual(["run"]);
  expect(page.waiting).toBe(1);
  expect(helper.mock.calls.map(([row]) => row.runId)).toEqual(["run"]);
  expect(lookup.mock.calls).toEqual([["restricted", "1"]]);
  lookup.mockClear();
  helper.mockClear();
  const bob = await f.issue(["runs.read"], "bob");
  const response = await f.rpc(bob.token);
  expect(response).toMatchObject({ ok: true, result: { inputs: [], waiting: 0 } });
  expect(lookup).not.toHaveBeenCalled();
  expect(helper).not.toHaveBeenCalled();
});

it("denies missing read authority before any private projection", async () => {
  const f = await fixture();
  const lookup = vi.spyOn(f.stores.workflows, "get");
  const noRead = await f.issue(["inputs.answer"]);
  expect(await f.rpc(noRead.token)).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
  expect(lookup).not.toHaveBeenCalled();
});

it("rechecks revocation after the private lookup", async () => {
  const f = await fixture();
  const get = f.stores.workflows.get.bind(f.stores.workflows);
  vi.spyOn(f.stores.workflows, "get").mockImplementation(async (...args) => {
    const pinned = await get(...args);
    await f.credentials.revoke(f.reader.credential.id);
    return pinned;
  });
  expect(await f.rpc()).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
});

it("refuses changed ownership after projection without leaking rows or counts", async () => {
  const f = await fixture();
  const get = f.stores.workflows.get.bind(f.stores.workflows);
  vi.spyOn(f.stores.workflows, "get").mockImplementation(async (...args) => {
    const pinned = await get(...args);
    f.ownership.forget("run", "alice");
    return pinned;
  });
  expect(await f.rpc()).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
});

it("keeps historical pinned definitions despite different current defaults", async () => {
  const f = await fixture();
  f.orc.workflows.register({
    ...f.def,
    version: "2",
    nodes: { end: { type: "end", outcome: "success" } },
    start: "end",
    edges: [],
  });
  Object.defineProperty(f.orc, "generations", {
    value: {
      get current() {
        throw new Error("active generation unavailable");
      },
    },
  });
  const fallback = vi.spyOn(f.orc, "definitionFor");
  expect((await f.list()).inputs[0]!.revisionActionId).toBe("changes");
  expect(fallback).not.toHaveBeenCalled();
});

it.each(["missing", "id", "version", "revision", "node", "declaration", "membership"])(
  "fails closed on a %s stored pin instead of making the declared action ordinary",
  async (fault) => {
    const f = await fixture({ provenance: fault === "revision" });
    const changed = structuredClone(f.def);
    if (fault === "id") changed.id = "other";
    if (fault === "version") changed.version = "2";
    if (fault === "revision") changed.name = "changed";
    if (fault === "node") delete changed.nodes.gate;
    if (fault === "declaration" || fault === "membership") {
      const gate = changed.nodes.gate;
      if (gate?.type !== "gate" || !gate.revision) throw new Error("gate missing");
      gate.revision.actionId = fault === "declaration" ? "" : "undeclared";
    }
    vi.spyOn(f.stores.workflows, "get").mockResolvedValue(fault === "missing" ? undefined : changed);
    const response = await f.rpc();
    expect(response).toMatchObject({
      ok: false,
      error: { code: "RUN_STATE", message: "The pinned input declaration is unavailable" },
    });
    expect(JSON.stringify(response)).not.toMatch(/PRIVATE-PROMPT|undeclared|historical-generation/);
  },
);

it.each(["runId", "stepRunId", "id", "nodeId"] as const)(
  "rejects the wrong %s before a private lookup",
  async (key) => {
    const f = await fixture();
    const lookup = vi.spyOn(f.stores.workflows, "get");
    await expect(f.reads.inputRevisionActionId({ ...f.row, [key]: "wrong" })).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect(lookup).not.toHaveBeenCalled();
  },
);

it("rejects action membership mismatches in this exact request or row", async () => {
  const f = await fixture();
  await expect(
    f.reads.inputRevisionActionId({ ...f.row, options: [{ id: "done", label: "Done" }] }),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
});

it("preserves a restriction if the exact row is answered during the definition read", async () => {
  const f = await fixture();
  const get = f.stores.workflows.get.bind(f.stores.workflows);
  vi.spyOn(f.stores.workflows, "get").mockImplementation(async (...args) => {
    const pinned = await get(...args);
    await f.stores.events.append({
      runId: "run",
      type: "human.answered",
      payload: { requestId: "run-ask", stepRunId: "run-step", answer: "done" },
    });
    return pinned;
  });
  expect((await f.list()).inputs[0]!.revisionActionId).toBe("changes");
});

it("strips injected legacy scalars and proves ordinary and permission inputs gain no capability", async () => {
  const def = definition();
  const gate = def.nodes.gate;
  if (gate?.type !== "gate") throw new Error("gate missing");
  delete gate.revision;
  const f = await fixture({ definition: def });
  const inputList = f.reads.inputsList.bind(f.reads);
  vi.spyOn(f.reads, "inputsList").mockImplementation(async (params) => {
    const page = await inputList(params);
    return { ...page, inputs: page.inputs.map((input) => ({ ...input, revisionActionId: "injected" })) };
  });
  const row = (await f.list()).inputs[0]!;
  expect(row.revisionActionId).toBeUndefined();
  expect(row.revision).toBeUndefined();
  const lookup = vi.spyOn(f.stores.workflows, "get");
  await expect(f.reads.inputRevisionActionId({ ...f.row, kind: "permission" })).resolves.toBeUndefined();
  await expect(f.reads.inputRevisionActionId({ ...f.row, kind: "question" })).resolves.toBeUndefined();
  expect(lookup).not.toHaveBeenCalled();
});

it("supports stored older pins without provenance and refuses truly unpinned history", async () => {
  const oldPinned = await fixture({ provenance: false });
  expect((await oldPinned.list()).inputs[0]!.revisionActionId).toBe("changes");
  const unpinned = await fixture({ pinned: false, provenance: false });
  const lookup = vi.spyOn(unpinned.stores.workflows, "get");
  expect(await unpinned.rpc()).toMatchObject({ ok: false, error: { code: "RUN_STATE" } });
  expect(lookup).not.toHaveBeenCalled();
});

it("rechecks previously projected rows after a later row changes visibility", async () => {
  const f = await fixture();
  await f.addRun("second");
  f.ownership.record("second", "alice");
  const project = f.reads.inputRevisionActionId.bind(f.reads);
  vi.spyOn(f.reads, "inputRevisionActionId").mockImplementation(async (input) => {
    const result = await project(input);
    if (input.runId === "second") f.ownership.forget("run", "alice");
    return result;
  });
  expect(await f.rpc()).toMatchObject({ ok: false, error: { code: "AUTH_FORBIDDEN" } });
});

it("rechecks current read permission before looking up private definitions", async () => {
  const f = await fixture();
  const list = f.reads.inputsList.bind(f.reads);
  vi.spyOn(f.reads, "inputsList").mockImplementation(async (params) => {
    const result = await list(params);
    await f.credentials.revoke(f.reader.credential.id);
    return result;
  });
  const lookup = vi.spyOn(f.stores.workflows, "get");
  expect(await f.rpc()).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["loop", "parallel::branch", "each"])(
  "resolves %s only inside the exact stored enclosing root",
  async (path) => {
    const inner = definition();
    const graph = { start: inner.start, nodes: inner.nodes, edges: inner.edges };
    const def = definition();
    def.nodes.loop = {
      type: "loop",
      mode: "while",
      condition: "true",
      itemVar: "item",
      indexVar: "index",
      maxIterations: 1,
      body: { graph },
      breakOnFailure: true,
    };
    def.nodes.parallel = {
      type: "parallel",
      branches: { branch: { graph } },
      concurrency: 1,
      join: "all",
      failFast: true,
    };
    def.nodes.each = {
      type: "parallel",
      forEach: { items: "items", itemVar: "item", indexVar: "index", body: { graph } },
      concurrency: 1,
      join: "all",
      failFast: true,
    };
    const f = await fixture({ definition: def });
    const workflowId = `${def.id}::${path}`;
    const expected = { id: workflowId, name: workflowId, version: def.version, vars: {}, inputs: {}, ...graph };
    await f.addRun("child", workflowId, workflowRevision(expected));
    const row = (await f.reads.inputsList({ runId: "child" })).inputs[0]!;
    await expect(f.reads.inputRevisionActionId(row)).resolves.toBe("changes");
    await f.addRun("wrong-child", `${workflowId}::missing`, workflowRevision(expected));
    const wrong = (await f.reads.inputsList({ runId: "wrong-child" })).inputs[0]!;
    await expect(f.reads.inputRevisionActionId(wrong)).rejects.toMatchObject({ code: "RUN_STATE" });
  },
);

it.each([true, false])("leaves agent-origin decisions unaffected with pinned=%s", async (pinned) => {
  const def = definition();
  def.nodes.gate = def.nodes.agent!;
  const f = await fixture({ definition: def, nodeType: "agent", pinned });
  const input = (await f.list()).inputs[0]!;
  expect(input.revisionActionId).toBeUndefined();
  expect(input.revision).toBeUndefined();
});

it("rechecks the identity of valid ordinary pinned gates after the private read", async () => {
  const def = definition();
  const gate = def.nodes.gate;
  if (gate?.type !== "gate") throw new Error("gate missing");
  delete gate.revision;
  const f = await fixture({ definition: def });
  const original = f.orc.events.bind(f.orc);
  let reads = 0;
  vi.spyOn(f.orc, "events").mockImplementation(async (runId) => {
    const events = await original(runId);
    if (++reads === 2 && events[0]?.type === "run.created") events[0].payload.workflowVersion = "mismatched";
    return events;
  });
  await expect(f.reads.inputRevisionActionId(f.row)).rejects.toMatchObject({ code: "RUN_STATE" });
});

it.each([
  { human: true, declared: true },
  { human: false, declared: false },
  { human: false, declared: true },
])("validates decision-node declaration class: %j", async ({ human, declared }) => {
  const def = definition();
  const gate = def.nodes.gate;
  if (gate?.type !== "gate") throw new Error("gate missing");
  def.nodes.gate = {
    type: "decision",
    source: human ? { kind: "human", question: "Continue?" } : { kind: "expression", expr: "'done'" },
    options: gate.options,
    ...(declared ? { revision: gate.revision } : {}),
  };
  const f = await fixture({ definition: def, nodeType: "decision" });
  if (!human && declared)
    await expect(f.reads.inputRevisionActionId(f.row)).rejects.toMatchObject({ code: "RUN_STATE" });
  else await expect(f.reads.inputRevisionActionId(f.row)).resolves.toBe(human ? "changes" : undefined);
});
