/**
 * evalContext() runs for every render, condition, route and input resolution. These tests pin the
 * two caches that keep it cheap: terminal child runs are not re-reduced from their event log, and
 * an artifact's body is read from the blob store once per RunContext. See issue #17.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, builtinExecutors, completed } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";

interface Counts {
  read: number;
  content: number;
}

/** memoryStores() with call counters on the two reads the caches are meant to eliminate. */
function countingStores(): { stores: Stores; counts: Counts } {
  const base = memoryStores();
  const counts: Counts = { read: 0, content: 0 };
  const stores: Stores = {
    ...base,
    events: Object.assign(
      Object.create(Object.getPrototypeOf(base.events) as object) as typeof base.events,
      base.events,
      {
        read: (runId: string) => {
          counts.read++;
          return base.events.read(runId);
        },
      },
    ),
    artifacts: {
      put: (a, c) => base.artifacts.put(a, c),
      get: (id) => base.artifacts.get(id),
      list: (q) => base.artifacts.list(q),
      content: (id) => {
        counts.content++;
        return base.artifacts.content(id);
      },
    },
  };
  return { stores, counts };
}

const BRANCHES = 5;

/** A parent that fans out to `BRANCHES` artifact-producing children, then walks four more nodes. */
function make(stores: Stores) {
  const workflows = new WorkflowRegistry();
  workflows.register(
    parseWorkflow(`
id: producer
name: producer
start: s
nodes:
  s: { type: start }
  prod: { type: "custom:produce" }
  e: { type: end }
edges: [{ from: s, to: prod }, { from: prod, to: e }]
`),
  );
  workflows.register(
    parseWorkflow(`
id: fanout
name: fanout
vars: { items: [0, 1, 2, 3, 4] }
start: s
nodes:
  s: { type: start }
  par:
    type: parallel
    forEach: { items: "vars.items", body: { workflow: producer } }
    concurrency: 5
  a: { type: set, vars: { seen: "=len(vars.items)" } }
  b: { type: set, vars: { again: "=len(vars.items)" } }
  c: { type: set, vars: { third: "=len(vars.items)" } }
  e: { type: end }
edges:
  - { from: s, to: par }
  - { from: par, to: a }
  - { from: a, to: b, when: "artifacts['spec-0'].content == 'body-0'" }
  - { from: b, to: c, when: "artifacts['spec-4'].content == 'body-4'" }
  - { from: c, to: e }
`),
  );
  const executors = builtinExecutors().register({
    type: "custom:produce",
    execute: async (ctx) => {
      const i = ctx.run.state.run.vars.index as number;
      await ctx.recordArtifact({ kind: "spec", name: `spec-${i}`, path: `spec-${i}.md`, required: true }, `body-${i}`);
      return completed();
    },
  });
  return new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    executors,
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock: new FakeClock(),
  });
}

describe("eval context caching", () => {
  it("reads each artifact body once per run context, not once per evalContext call", async () => {
    const { stores, counts } = countingStores();
    const state = await make(stores).startAndRun({ workflowId: "fanout" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    // The parent evaluates its context for two edge conditions and three `set` nodes at minimum;
    // without the per-content-hash cache that alone was >= 5 x BRANCHES blob reads.
    expect(await stores.artifacts.list()).toHaveLength(BRANCHES);
    expect(counts.content).toBeLessThanOrEqual(2 * BRANCHES);
  });

  it("serves a terminal run's state from cache instead of re-reducing its log", async () => {
    const { stores, counts } = countingStores();
    const orchestrator = make(stores);
    const state = await orchestrator.startAndRun({ workflowId: "fanout" });
    const childId = state.steps[state.stepOrder[1]!]!.childRunIds[0]!;
    counts.read = 0;
    for (let i = 0; i < 5; i++) expect((await orchestrator.getState(childId)).run.status).toBe("completed");
    expect(counts.read).toBeLessThanOrEqual(1);
  });

  it("re-reads a cached run when it is resumed, so the stale projection is never served", async () => {
    const { stores } = countingStores();
    const orchestrator = make(stores);
    const runId = await orchestrator.startRun({ workflowId: "fanout" });
    await orchestrator.cancel(runId);
    expect((await orchestrator.getState(runId)).run.status).toBe("cancelled");
    // Hand-craft a continuation of the log; the cached terminal projection must not win.
    await stores.events.append({ type: "run.started", runId, payload: {} });
    expect((await orchestrator.getState(runId)).run.status).toBe("running");
  });
});
