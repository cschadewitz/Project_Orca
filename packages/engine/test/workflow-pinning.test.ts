/**
 * #179: a run is pinned to the workflow version it started on. `startRun` keeps the definition
 * in the store's workflow-version store, and a resume - here by a second orchestrator whose
 * registry only has a newer version of the file - walks the stored one. A version that is
 * neither stored nor on disk refuses to resume; a run from before versioning resumes on the
 * current file.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { fileStores, memoryStores, type Stores } from "@orca/store";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function make(yaml: string, stores: Stores) {
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(yaml));
  return new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
    clock: new FakeClock(),
  });
}

/** v1: a gate, then two `set` nodes. The run parks on the gate, before either. */
const V1 = `
id: pinned
name: pinned
version: "1"
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Go?", options: [go, stop] }
  first: { type: set, vars: { first: true } }
  extra: { type: set, vars: { extra: true } }
  done: { type: end }
  stopped: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: first, when: "choice == 'go'" }
  - { from: gate, to: stopped }
  - { from: first, to: extra }
  - { from: extra, to: done }
`;

/** v2 removes `extra`, a node the parked run has not reached. */
const V2 = `
id: pinned
name: pinned
version: "2"
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Go?", options: [go, stop] }
  first: { type: set, vars: { first: true } }
  done: { type: end }
  stopped: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: first, when: "choice == 'go'" }
  - { from: gate, to: stopped }
  - { from: first, to: done }
`;

const nodes = (s: { stepOrder: string[]; steps: Record<string, { nodeId: string; status: string }> }) =>
  s.stepOrder.map((id) => `${s.steps[id]!.nodeId}:${s.steps[id]!.status}`);

async function park(stores: Stores) {
  const first = make(V1, stores);
  const parked = await first.startAndRun({ workflowId: "pinned" });
  expect(parked.run.status).toBe("paused");
  expect(parked.run.workflowVersion).toBe("1");
  const [query] = await first.pendingInputs(parked.run.id);
  return { runId: parked.run.id, queryId: query!.id };
}

describe("workflow version pinning (#179)", () => {
  for (const storage of ["memory", "file"] as const) {
    it(`${storage}: a run started on v1 resumes and completes on v1 after v2 replaces the file`, async () => {
      const dir = storage === "file" ? await mkdtemp(join(tmpdir(), "orca-pin-")) : undefined;
      if (dir) dirs.push(dir);
      const stores = dir ? fileStores(dir) : memoryStores();
      const { runId, queryId } = await park(stores);
      expect(await stores.workflows.versions("pinned")).toEqual(["1"]);

      // A second process whose registry only knows v2.
      const second = make(V2, stores);
      await second.breakLease(runId, { force: true }).catch(() => undefined);
      await second.answer(queryId, "go", runId);
      const state = await second.resume(runId);
      expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
      // `extra` exists only in v1: the run walked the definition it started on.
      expect(nodes(state).slice(-3)).toEqual(["first:completed", "extra:completed", "done:completed"]);
      expect(state.run.vars).toMatchObject({ first: true, extra: true });

      // A run started now is on v2, and v2 is kept alongside v1.
      const fresh = await second.startAndRun({ workflowId: "pinned" });
      expect(fresh.run.workflowVersion).toBe("2");
      expect(await stores.workflows.versions("pinned")).toEqual(["1", "2"]);
      const [q2] = await second.pendingInputs(fresh.run.id);
      await second.answer(q2!.id, "go", fresh.run.id);
      expect(nodes(await second.resume(fresh.run.id))).not.toContain("extra:completed");
    });
  }

  for (const storage of ["memory", "file"] as const) {
    it(`${storage}: resumes on its stored snapshot after a same-version edit of the file (#330)`, async () => {
      const dir = storage === "file" ? await mkdtemp(join(tmpdir(), "orca-pin-")) : undefined;
      if (dir) dirs.push(dir);
      const stores = dir ? fileStores(dir) : memoryStores();
      const { runId, queryId } = await park(stores);

      // v2's graph, but still labelled version 1: the edit a version bump should have marked.
      const second = make(V2.replace('version: "2"', 'version: "1"'), stores);
      await second.breakLease(runId, { force: true }).catch(() => undefined);
      await second.answer(queryId, "go", runId);
      const state = await second.resume(runId);
      expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
      expect(nodes(state).slice(-3)).toEqual(["first:completed", "extra:completed", "done:completed"]);

      // A new run cannot start on content the recorded version 1 does not have.
      await expect(second.startRun({ workflowId: "pinned" })).rejects.toMatchObject({ code: "WORKFLOW_INVALID" });
      // An unchanged file is the same revision as its stored round trip, so it still starts.
      await expect(make(V1, stores).startRun({ workflowId: "pinned" })).resolves.toMatch(/^run/);
    });
  }

  it("refuses an answer before effects when its recorded workflow is unavailable", async () => {
    const stores = memoryStores();
    const { runId, queryId } = await park(stores);
    // The stored copy goes away (a store copied without its workflows directory, say).
    const lost: Stores = {
      ...stores,
      workflows: { ...stores.workflows, get: async () => undefined, versions: async () => [] },
    };
    const second = make(V2, lost);
    const before = await stores.events.read(runId);
    await expect(second.answer(queryId, "go", runId)).rejects.toMatchObject({
      code: "WORKFLOW_VERSION_NOT_FOUND",
      message: expect.stringContaining("available: 2"),
      details: { id: "pinned", version: "1", available: ["2"] },
    });
    expect(await stores.events.read(runId)).toEqual(before);
    expect(await second.pendingInputs(runId)).toHaveLength(1);
  });

  it("a run from before versioning resumes on whatever file is current", async () => {
    const stores = memoryStores();
    const { runId, queryId } = await park(stores);
    // Rewrite the log's run.created as a pre-v0.6.0 one: no `workflowStored`, and nothing stored.
    const events = await stores.events.read(runId);
    const created = events[0]!;
    expect(created.type === "run.created" && created.payload.workflowStored).toBe(true);
    const legacy = memoryStores();
    for (const e of events) {
      const { id: _id, seq: _seq, at: _at, ...rest } = e;
      if (rest.type === "run.created") {
        const { workflowStored: _stored, ...payload } = rest.payload;
        await legacy.events.append({ ...rest, payload });
      } else await legacy.events.append(rest);
    }
    const second = make(V2, legacy);
    await second.answer(queryId, "go", runId);
    const state = await second.resume(runId);
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(nodes(state)).not.toContain("extra:completed");
  });
});
