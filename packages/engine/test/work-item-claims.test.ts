/**
 * Two dispatchers over the same work items: whoever claims an item launches it, the other
 * records the branch as `claimed` instead of spawning a second child run for it.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry, type OrcaEvent } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, builtinExecutors, completed, definePlugin, type OrchestratorOptions } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";

/** Branch bodies block here until `release()` is called, so both dispatchers are in flight at once. */
let gate = { wait: Promise.resolve(), release: () => {} };
const openGate = () => {
  let release = () => {};
  const wait = new Promise<void>((r) => (release = r));
  gate = { wait, release };
};

const dispatch = `
id: dispatch
name: dispatch
vars:
  items: []
start: s
nodes:
  s: { type: start }
  fan:
    type: parallel
    name: "Run each work item"
    concurrency: 2
    join: all
    forEach:
      items: vars.items
      itemVar: item
      key: item.slug
      workItemId: item.id
      body:
        graph:
          start: b
          nodes:
            b: { type: start }
            work: { type: "custom:work" }
            e: { type: end, outcome: success }
          edges: [{ from: b, to: work }, { from: work, to: e }]
  e: { type: end, outcome: success }
edges: [{ from: s, to: fan }, { from: fan, to: e }]
`;

function make(overrides: Partial<OrchestratorOptions> = {}) {
  const workflows = new WorkflowRegistry().register(parseWorkflow(dispatch));
  const executors = builtinExecutors();
  definePlugin({
    name: "test",
    register: (api) => {
      api.executors.register({ type: "custom:work", execute: async () => (await gate.wait, completed()) });
    },
  }).register({ executors, templates: new TemplateRegistry(), workflows, agents: new AgentRegistry(), setHumanInput() {}, setWorkspaceProvider() {} });
  const stores = overrides.stores ?? memoryStores();
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    executors,
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock: new FakeClock(),
    ...overrides,
  });
  return { orchestrator, stores };
}

const items = [
  { id: "wi_api", slug: "api" },
  { id: "wi_ui", slug: "ui" },
];

/**
 * The work item of every *distinct* child run in the store. A re-attached child is spawned
 * once and re-recorded on resume, so this counts launches, not `child.spawned` events.
 */
async function launched(stores: Stores): Promise<string[]> {
  const byChild = new Map<string, string>();
  for (const runId of await stores.events.listRuns()) {
    for (const e of (await stores.events.read(runId)) as OrcaEvent[]) {
      if (e.type === "child.spawned" && e.payload.workItemId) byChild.set(e.payload.childRunId, e.payload.workItemId);
    }
  }
  return [...byChild.values()].sort();
}

const skips = (state: { stepOrder: string[]; steps: Record<string, { skippedBranches: { branch: string; reason: string }[] }> }) =>
  state.stepOrder.flatMap((id) => state.steps[id]!.skippedBranches.map((b) => `${b.branch}:${b.reason}`)).sort();

describe("work item claims", () => {
  it("two runs dispatching the same work items launch each item exactly once", async () => {
    gate = { wait: Promise.resolve(), release: () => {} };
    const first = make();
    // The second dispatcher is a different run in a different orchestrator, over the same store.
    const second = make({ stores: first.stores });
    openGate();
    const runs = [first.orchestrator.startAndRun({ workflowId: "dispatch", vars: { items } }), second.orchestrator.startAndRun({ workflowId: "dispatch", vars: { items } })];
    // Both fan-outs are past their schedule decision before either child finishes.
    await new Promise((r) => setTimeout(r, 20));
    gate.release();
    const [a, b] = await Promise.all(runs);

    expect(await launched(first.stores)).toEqual(["wi_api", "wi_ui"]);
    const loser = a!.run.status === "failed" ? a! : b!;
    const winner = loser === a! ? b! : a!;
    expect(winner.run.status).toBe("completed");
    expect(skips(winner)).toEqual([]);
    expect(skips(loser)).toEqual(["api:claimed", "ui:claimed"]);
    // The loser does not pretend the work happened: `join: all` cannot be met by branches it never ran.
    expect(loser.run.error?.message).toContain("2 claimed by another run");
  });

  it("a claimed item leaves the work item's status to the run that owns it", async () => {
    gate = { wait: Promise.resolve(), release: () => {} };
    const now = "2026-01-01T00:00:00.000Z";
    const { orchestrator, stores } = make();
    for (const item of items) {
      await stores.workItems.put({ id: item.id, requestId: "req_1", slug: item.slug, title: item.slug, description: "", kind: "task", acceptanceCriteria: [], dependsOn: [], status: "in-progress", runId: "run_owner", createdAt: now, updatedAt: now });
      await stores.claims.claim({ workItemId: item.id, runId: "run_owner", branch: item.slug, at: now });
    }
    const state = await orchestrator.startAndRun({ workflowId: "dispatch", vars: { items } });

    expect(state.run.status).toBe("failed");
    expect(await launched(stores)).toEqual([]);
    // Untouched: a `claimed` skip says "not mine", not "pending".
    for (const item of items) expect(await stores.workItems.get(item.id)).toMatchObject({ status: "in-progress", runId: "run_owner" });
  });

  it("a resumed run re-claims the items it already owns", async () => {
    gate = { wait: Promise.resolve(), release: () => {} };
    const first = make();
    openGate();
    const runId = await first.orchestrator.startRun({ workflowId: "dispatch", vars: { items } });
    void first.orchestrator.run(runId).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));

    // The process "dies" mid fan-out; a new one resumes the same run from its log.
    const second = make({ stores: first.stores });
    gate = { wait: Promise.resolve(), release: () => {} };
    const state = await second.orchestrator.run(runId);

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(skips(state)).toEqual([]);
    // Re-attached to the children the interrupted attempt spawned: one child run per item, still.
    expect(await launched(first.stores)).toEqual(["wi_api", "wi_ui"]);
    expect((await first.stores.events.listRuns()).length).toBe(3);
  });
});
