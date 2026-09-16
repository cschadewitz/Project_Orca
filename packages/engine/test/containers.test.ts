/** Loops, parallel branches, sub-workflows, set/decision nodes, cancellation and resume - no agents involved. */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, definePlugin, builtinExecutors, completed } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";

/** How often each custom node ran, across every orchestrator created by `make`. Reset per `make`. */
const calls = { record: 0, hang: 0 };

/**
 * `stores` may be shared with an earlier orchestrator to simulate a process that died and was
 * replaced: the old orchestrator's promises simply never settle, the new one resumes from the log.
 */
function make(yaml: string[], stores: Stores = memoryStores()) {
  calls.record = 0;
  calls.hang = 0;
  let onHang = () => {};
  const hung = new Promise<void>((r) => (onHang = r));
  const workflows = new WorkflowRegistry();
  for (const y of yaml) workflows.register(parseWorkflow(y));
  const executors = builtinExecutors();
  // Custom node types registered through the plugin API.
  definePlugin({
    name: "test",
    register: (api) => {
      api.executors.register({
        type: "custom:record",
        execute: async (ctx) => {
          calls.record++;
          await ctx.emit({ type: "vars.set", payload: { vars: { log: [...((ctx.run.state.run.vars.log as unknown[]) ?? []), (ctx.node as unknown as { value: string }).value] } } });
          return completed();
        },
      });
      // Never returns on its first attempt when `when` is truthy - a step the process "died" in.
      api.executors.register({
        type: "custom:hang",
        execute: async (ctx) => {
          calls.hang++;
          if (ctx.step.attempt === 1 && (await ctx.evaluate((ctx.node as unknown as { when: string }).when))) {
            onHang();
            await new Promise<never>(() => {});
          }
          return completed();
        },
      });
    },
  }).register({ executors, templates: new TemplateRegistry(), workflows, agents: new AgentRegistry(), setHumanInput() {}, setWorkspaceProvider() {} });
  const orchestrator = new Orchestrator({ stores, agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })), workflows, templates: new TemplateRegistry(), executors, workspaceProvider: new LocalWorkspaceProvider("/tmp"), clock: new FakeClock() });
  return { orchestrator, stores, hung };
}

const stepSummary = (s: { stepOrder: string[]; steps: Record<string, { nodeId: string; attempt: number; status: string }> }) => s.stepOrder.map((id) => `${s.steps[id]!.nodeId}:${s.steps[id]!.attempt}:${s.steps[id]!.status}`);

describe("container nodes", () => {
  it("while loop runs a nested graph as child runs and exposes iteration vars", async () => {
    const { orchestrator } = make([`
id: loops
name: loops
vars: { n: 0 }
start: s
nodes:
  s: { type: start }
  loop:
    type: loop
    mode: while
    condition: "iteration < 3"
    body:
      graph:
        start: s
        nodes:
          s: { type: start }
          rec: { type: "custom:record", value: "=iteration" }
          e: { type: end }
        edges: [{ from: s, to: rec }, { from: rec, to: e }]
  e: { type: end }
edges: [{ from: s, to: loop }, { from: loop, to: e }]
`]);
    const state = await orchestrator.startAndRun({ workflowId: "loops" });
    expect(state.run.status).toBe("completed");
    const loopStep = state.steps[state.stepOrder[1]!]!;
    expect(loopStep.childRunIds).toHaveLength(3);
    expect(loopStep.result?.data).toMatchObject({ iterations: 3, ok: true });
    const child = await orchestrator.getState(loopStep.childRunIds[2]!);
    expect(child.run.workflowId).toBe("loops::loop");
    expect(child.run.vars).toMatchObject({ iteration: 2, index: 2 });
  });

  it("forEach parallel + subworkflow + decision routing + set", async () => {
    const { orchestrator } = make([
      `
id: child
name: child
start: s
nodes:
  s: { type: start }
  d:
    type: decision
    source: { kind: expression, expr: "item.ok ? 'yes' : 'no'" }
    options: [yes, no]
  ok: { type: end, outcome: success }
  bad: { type: end, outcome: failure }
edges:
  - { from: s, to: d }
  - { from: d, to: ok, when: "choice == 'yes'" }
  - { from: d, to: bad }
`,
      `
id: parent
name: parent
vars: { items: [{ ok: true }, { ok: true }] }
start: s
nodes:
  s: { type: start }
  init: { type: set, vars: { count: "=len(vars.items)" } }
  par:
    type: parallel
    forEach: { items: "vars.items", body: { workflow: child } }
    concurrency: 2
  sub: { type: subworkflow, workflow: child, vars: { item: "=first(vars.items)" } }
  e: { type: end }
edges: [{ from: s, to: init }, { from: init, to: par }, { from: par, to: sub }, { from: sub, to: e }]
`,
    ]);
    const state = await orchestrator.startAndRun({ workflowId: "parent" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    const par = state.steps[state.stepOrder[2]!]!;
    expect(par.childRunIds).toHaveLength(2);
    const sub = state.steps[state.stepOrder[3]!]!;
    expect(sub.result?.data).toMatchObject({ ok: true });

    // A failing branch fails the parallel node with join: all.
    const failing = await orchestrator.startAndRun({ workflowId: "parent", vars: { items: [{ ok: true }, { ok: false }] } });
    expect(failing.run.status).toBe("failed");
    expect(failing.run.error?.message).toMatch(/1 of 2 branches did not succeed/);
  });

  it("resumes an interrupted run from its event log", async () => {
    const { orchestrator, stores } = make([`
id: resumable
name: resumable
start: s
nodes:
  s: { type: start }
  a: { type: "custom:record", value: a }
  b: { type: "custom:record", value: b }
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: b }, { from: b, to: e }]
`]);
    // Simulate a crash after step 'a' completed: hand-craft the log up to that point.
    const runId = await orchestrator.startRun({ workflowId: "resumable" });
    await stores.events.append({ type: "run.started", runId, payload: {} });
    await stores.events.append({ type: "step.scheduled", runId, payload: { stepRunId: "step_x", nodeId: "a", nodeType: "custom:record", attempt: 1 } });
    await stores.events.append({ type: "step.started", runId, payload: { stepRunId: "step_x", inputArtifactIds: [] } });
    await stores.events.append({ type: "step.completed", runId, payload: { stepRunId: "step_x", result: { artifactIds: [], data: {} } } });
    const state = await orchestrator.run(runId);
    expect(state.run.status).toBe("completed");
    expect(state.stepOrder.map((id) => state.steps[id]!.nodeId)).toEqual(["a", "b", "e"]);
    // A run interrupted mid-step is retried as a new attempt.
    const runId2 = await orchestrator.startRun({ workflowId: "resumable" });
    await stores.events.append({ type: "run.started", runId: runId2, payload: {} });
    await stores.events.append({ type: "step.scheduled", runId: runId2, payload: { stepRunId: "step_y", nodeId: "b", nodeType: "custom:record", attempt: 1 } });
    await stores.events.append({ type: "step.started", runId: runId2, payload: { stepRunId: "step_y", inputArtifactIds: [] } });
    const s2 = await orchestrator.run(runId2);
    expect(s2.steps.step_y?.status).toBe("cancelled");
    expect(s2.stepOrder.map((id) => `${s2.steps[id]!.nodeId}:${s2.steps[id]!.attempt}`)).toEqual(["b:1", "b:2", "e:1"]);
  });

  it("resume re-attaches an interrupted loop to its child runs instead of respawning them", async () => {
    const yaml = [`
id: crashy-loop
name: crashy-loop
start: s
nodes:
  s: { type: start }
  loop:
    type: loop
    mode: while
    condition: "iteration < 3"
    body:
      graph:
        start: s
        nodes:
          s: { type: start }
          rec: { type: "custom:record", value: "=iteration" }
          hang: { type: "custom:hang", when: "iteration == 1" }
          e: { type: end }
        edges: [{ from: s, to: rec }, { from: rec, to: hang }, { from: hang, to: e }]
  e: { type: end }
edges: [{ from: s, to: loop }, { from: loop, to: e }]
`];
    // Process 1: iteration 0 completes, iteration 1 dies inside 'hang'.
    const first = make(yaml);
    const runId = await first.orchestrator.startRun({ workflowId: "crashy-loop" });
    void first.orchestrator.run(runId);
    await first.hung;
    const before = await first.orchestrator.getState(runId);
    const interruptedStep = before.steps[before.stepOrder[1]!]!;
    expect(interruptedStep.status).toBe("running");
    expect(interruptedStep.children.map((c) => c.branch)).toEqual(["0", "1"]);
    const recordsBeforeResume = calls.record;

    // Process 2: a fresh orchestrator over the same logs resumes the parent.
    const second = make(yaml, first.stores);
    const state = await second.orchestrator.run(runId);
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(stepSummary(state)).toEqual(["s:1:completed", "loop:1:cancelled", "loop:2:completed", "e:1:completed"]);

    const resumedStep = state.steps[state.stepOrder[2]!]!;
    expect(resumedStep.childRunIds.slice(0, 2)).toEqual(interruptedStep.childRunIds);
    expect(resumedStep.children.map((c) => [c.branch, c.resumed ?? false, c.status, c.outcome])).toEqual([
      ["0", true, "completed", "success"],
      ["1", true, "completed", "success"],
      ["2", false, "completed", "success"],
    ]);
    expect(resumedStep.result?.data).toMatchObject({ iterations: 3, ok: true });
    // Iteration 0 was not re-run and iteration 1 only re-attempted the step it died in.
    expect(calls.record).toBe(1); // iteration 2 only (process 2 counts from zero)
    expect(recordsBeforeResume).toBe(2);
    const it0 = await second.orchestrator.getState(resumedStep.childRunIds[0]!);
    expect(stepSummary(it0)).toEqual(["s:1:completed", "rec:1:completed", "hang:1:completed", "e:1:completed"]);
    const it1 = await second.orchestrator.getState(resumedStep.childRunIds[1]!);
    expect(stepSummary(it1)).toEqual(["s:1:completed", "rec:1:completed", "hang:1:cancelled", "hang:2:completed", "e:1:completed"]);
    expect(it1.run.parentStepRunId).toBe(interruptedStep.id);
    // Only three child runs exist in total: nothing was respawned.
    expect((await second.stores.events.listRuns()).length).toBe(4);
  });

  it("resume re-attaches an interrupted parallel step to finished, in-flight and not-yet-started branches", async () => {
    const branch = (value: string, hang: boolean) =>
      `{ graph: { start: s, nodes: { s: { type: start }, ${hang ? 'hang: { type: "custom:hang", when: "true" }, ' : ""}rec: { type: "custom:record", value: ${value} }, e: { type: end } }, edges: [${hang ? "{ from: s, to: hang }, { from: hang, to: rec }" : "{ from: s, to: rec }"}, { from: rec, to: e }] } }`;
    const yaml = [`
id: crashy-par
name: crashy-par
start: s
nodes:
  s: { type: start }
  par:
    type: parallel
    concurrency: 1
    branches:
      a: ${branch("a", false)}
      b: ${branch("b", true)}
      c: ${branch("c", false)}
  e: { type: end }
edges: [{ from: s, to: par }, { from: par, to: e }]
`];
    const first = make(yaml);
    const runId = await first.orchestrator.startRun({ workflowId: "crashy-par" });
    void first.orchestrator.run(runId);
    await first.hung;
    const interruptedStep = (await first.orchestrator.getState(runId)).steps[(await first.orchestrator.getState(runId)).stepOrder[1]!]!;
    expect(interruptedStep.children.map((c) => c.branch)).toEqual(["a", "b"]);

    const second = make(yaml, first.stores);
    const state = await second.orchestrator.run(runId);
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(stepSummary(state)).toEqual(["s:1:completed", "par:1:cancelled", "par:2:completed", "e:1:completed"]);
    const resumedStep = state.steps[state.stepOrder[2]!]!;
    expect(resumedStep.children.map((c) => [c.branch, c.resumed ?? false, c.runId])).toEqual([
      ["a", true, interruptedStep.childRunIds[0]],
      ["b", true, interruptedStep.childRunIds[1]],
      ["c", false, resumedStep.childRunIds[2]],
    ]);
    expect(calls.record).toBe(2); // b (after its hang step was re-attempted) and c
    expect(calls.hang).toBe(1); // b's second attempt only
    expect((await second.stores.events.listRuns()).length).toBe(4);
  });

  it("does not re-attach children across a back-edge revisit of the same node", async () => {
    const { orchestrator } = make([`
id: revisit
name: revisit
vars: { round: 0 }
start: s
nodes:
  s: { type: start }
  sub:
    type: loop
    mode: while
    condition: "iteration < 1"
    body:
      graph:
        start: s
        nodes: { s: { type: start }, rec: { type: "custom:record", value: x }, e: { type: end } }
        edges: [{ from: s, to: rec }, { from: rec, to: e }]
  bump: { type: set, vars: { round: "=vars.round + 1" } }
  e: { type: end }
edges:
  - { from: s, to: sub }
  - { from: sub, to: bump }
  - { from: bump, to: sub, when: "vars.round < 2" }
  - { from: bump, to: e }
`]);
    const state = await orchestrator.startAndRun({ workflowId: "revisit" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    const loops = state.stepOrder.map((id) => state.steps[id]!).filter((s) => s.nodeId === "sub");
    expect(loops.map((s) => s.attempt)).toEqual([1, 1]);
    expect(loops[0]!.childRunIds).not.toEqual(loops[1]!.childRunIds);
    expect(loops.every((s) => s.children.every((c) => !c.resumed))).toBe(true);
    expect(calls.record).toBe(2);
  });

  it("cancels a running loop", async () => {
    const { orchestrator } = make([`
id: forever
name: forever
start: s
nodes:
  s: { type: start }
  loop:
    type: loop
    mode: while
    condition: "true"
    maxIterations: 100000
    body:
      graph:
        start: s
        nodes: { s: { type: start }, r: { type: "custom:record", value: x }, e: { type: end } }
        edges: [{ from: s, to: r }, { from: r, to: e }]
  e: { type: end }
edges: [{ from: s, to: loop }, { from: loop, to: e }]
`]);
    const runId = await orchestrator.startRun({ workflowId: "forever" });
    const done = orchestrator.run(runId);
    await new Promise((r) => setTimeout(r, 50));
    await orchestrator.cancel(runId, "test");
    const state = await done;
    expect(state.run.status).toBe("cancelled");
  });
});
