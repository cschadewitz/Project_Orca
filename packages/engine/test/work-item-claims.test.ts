/**
 * Two dispatchers over the same work items: whoever claims an item launches it, the other
 * records the branch as `claimed` instead of spawning a second child run for it.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry, type OrcaEvent } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PlanService, builtinExecutors, completed, definePlugin, type OrchestratorOptions } from "@orca/engine";
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
  const stores = overrides.stores ?? memoryStores();
  definePlugin({
    name: "test",
    register: (api) => {
      api.executors.register({ type: "custom:work", execute: async () => (await gate.wait, completed()) });
    },
  }).register({ executors, templates: new TemplateRegistry(), workflows, agents: new AgentRegistry(), plan: new PlanService({ stores }), setHumanInput() {}, setWorkspaceProvider() {} });
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
      await stores.workItems.put({ id: item.id, requestId: "req_1", slug: item.slug, title: item.slug, description: "", kind: "task", acceptanceCriteria: [], dependsOn: [], status: "in-progress", runId: "run_owner", priority: "normal", produced: {}, createdAt: now, updatedAt: now });
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

/**
 * The same guarantee for `custom:plan-dispatch`, whose own scheduling loop asks the plan for a
 * ready set and writes `in-progress` only inside the launch it then performs (the shape issue
 * #72 described): two dispatchers over one plan both see an item ready.
 */
const planDispatch = `
id: plan-dispatch-test
name: plan-dispatch-test
vars:
  itemWorkflow: item
start: s
nodes:
  s: { type: start }
  dispatch: { type: "custom:plan-dispatch", scope: plan, concurrency: 2 }
  e: { type: end, outcome: success }
edges: [{ from: s, to: dispatch }, { from: dispatch, to: e }]
`;

const itemWorkflow = `
id: item
name: item
start: b
nodes:
  b: { type: start }
  work: { type: "custom:work" }
  e: { type: end, outcome: success }
edges: [{ from: b, to: work }, { from: work, to: e }]
`;

describe("work item claims: plan-dispatch", () => {
  const setup = async () => {
    gate = { wait: Promise.resolve(), release: () => {} };
    const stores = memoryStores();
    const plan = new PlanService({ stores, defaults: { planKey: "roadmap", planName: "Roadmap" } });
    const p = await plan.ensurePlan({ requestId: "req_1" }, { kind: "human", actor: "test" });
    await plan.registerWorkItems(p.id, { requestId: "req_1", items: [{ slug: "core", title: "Core" }, { slug: "api", title: "API" }] }, { kind: "decomposition" });
    const dispatcher = () => {
      const workflows = new WorkflowRegistry().register(parseWorkflow(planDispatch)).register(parseWorkflow(itemWorkflow));
      const executors = builtinExecutors();
      definePlugin({
        name: "test",
        register: (api) => {
          api.executors.register({ type: "custom:work", execute: async () => (await gate.wait, completed()) });
        },
      }).register({ executors, templates: new TemplateRegistry(), workflows, agents: new AgentRegistry(), plan, setHumanInput() {}, setWorkspaceProvider() {} });
      return new Orchestrator({ stores, agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })), workflows, templates: new TemplateRegistry(), executors, plan, workspaceProvider: new LocalWorkspaceProvider("/tmp"), clock: new FakeClock() });
    };
    return { stores, plan, dispatcher };
  };

  it("does not launch a ready item another dispatcher already owns", async () => {
    const { stores, dispatcher } = await setup();
    // The scheduler will offer both items - they have no dependencies and are still `pending`,
    // which is exactly the state the losing dispatcher of the race sees.
    for (const item of await stores.workItems.list()) {
      await stores.claims.claim({ workItemId: item.id, runId: "run_owner", branch: item.slug, at: "2026-01-01T00:00:00.000Z" });
    }
    const state = await dispatcher().startAndRun({ workflowId: "plan-dispatch-test", requestId: "req_1" });

    expect(state.run.status).toBe("completed");
    expect(await launched(stores)).toEqual([]);
    const dispatched = (state.run.vars.dispatched as { slug: string; status: string; reason: string }[]) ?? [];
    expect(dispatched.map((d) => `${d.slug}:${d.status}`).sort()).toEqual(["api:claimed", "core:claimed"]);
    expect(dispatched[0]!.reason).toBe("claimed by run run_owner");
    // The owner's item documents are left alone: not started, not deferred, no runId.
    for (const item of await stores.workItems.list()) {
      expect(item.status).toBe("pending");
      expect(item.runId).toBeUndefined();
      expect(item.deferredReason).toBeUndefined();
    }
  });

  it("two dispatchers over one plan launch each ready item at most once", async () => {
    const { stores, dispatcher } = await setup();
    openGate();
    const runs = [dispatcher().startAndRun({ workflowId: "plan-dispatch-test", requestId: "req_1" }), dispatcher().startAndRun({ workflowId: "plan-dispatch-test", requestId: "req_1" })];
    gate.release();
    const states = await Promise.all(runs);

    // Whichever way the two loops interleave, an item is run by one of them - never by both.
    expect(await launched(stores)).toHaveLength(2);
    for (const s of states) expect(s.run.status).toBe("completed");
    for (const item of await stores.workItems.list()) expect(item.status).toBe("done");
  });
});
