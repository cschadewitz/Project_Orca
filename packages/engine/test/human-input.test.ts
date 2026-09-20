/** Persisted human input: `pause` mode parks a run (and its parents), `answer()` + `resume()` continue it. */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, toGateOption, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { memoryStores } from "@orca/store";

function make(yaml: string[]) {
  const workflows = new WorkflowRegistry();
  for (const y of yaml) workflows.register(parseWorkflow(y));
  const stores = memoryStores();
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
    clock: new FakeClock(),
  });
  return { orchestrator, stores };
}

const GATED = `
id: gated
name: gated
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  shipped: { type: end }
  held: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: shipped, when: "choice == 'ship'" }
  - { from: gate, to: held }
`;

const nodes = (s: {
  stepOrder: string[];
  steps: Record<string, { nodeId: string; status: string; attempt: number }>;
}) => s.stepOrder.map((id) => `${s.steps[id]!.nodeId}:${s.steps[id]!.status}`);

describe("pause mode", () => {
  it("parks the run at a gate, records the answer in the log and resumes as a new attempt", async () => {
    const { orchestrator } = make([GATED]);
    const parked = await orchestrator.startAndRun({ workflowId: "gated" });
    expect(parked.run.status).toBe("paused");
    expect(nodes(parked)).toEqual(["s:completed", "gate:waiting"]);

    const pending = await orchestrator.pendingInputs();
    expect(pending).toHaveLength(1);
    // A workflow declares gate options as words; they are stored as options whose id is that word.
    expect(pending[0]).toMatchObject({
      runId: parked.run.id,
      question: "Ship it?",
      options: [
        { id: "ship", label: "ship" },
        { id: "hold", label: "hold" },
      ],
    });
    const requestId = pending[0]!.id;

    await expect(orchestrator.answer("hi_nope", "ship")).rejects.toThrow(/no pending human input/);
    await expect(orchestrator.answer(requestId, "maybe")).rejects.toThrow(/not one of: ship, hold/);

    const answered = await orchestrator.answer(requestId, "ship");
    expect(answered.answer).toBe("ship");
    expect(await orchestrator.pendingInputs(parked.run.id)).toEqual([]);
    await expect(orchestrator.answer(requestId, "ship")).rejects.toThrow(/no pending human input/);

    const done = await orchestrator.resume(parked.run.id);
    expect(done.run.status).toBe("completed");
    expect(done.run.outcome).toBe("success");
    expect(nodes(done)).toEqual(["s:completed", "gate:cancelled", "gate:completed", "shipped:completed"]);
    expect(done.steps[done.stepOrder[2]!]!.result?.choice).toBe("ship");
    // One request in total: the re-attempted gate reused the recorded answer instead of asking again.
    expect(Object.values(done.humanInputs)).toHaveLength(1);
    const types = (await orchestrator.events(parked.run.id)).map((e) => e.type);
    expect(types).toContain("run.paused");
    expect(types).toContain("run.resumed");
    expect(types.filter((t) => t === "human.requested")).toHaveLength(1);
  });

  it("re-parks with a fresh request when resumed without an answer; the stale request is no longer pending", async () => {
    const { orchestrator } = make([GATED]);
    const first = await orchestrator.startAndRun({ workflowId: "gated" });
    const [old] = await orchestrator.pendingInputs(first.run.id);
    const again = await orchestrator.resume(first.run.id);
    expect(again.run.status).toBe("paused");
    const pending = await orchestrator.pendingInputs(first.run.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).not.toBe(old!.id);
    await expect(orchestrator.answer(old!.id, "ship")).rejects.toThrow(/no pending/);
    await orchestrator.answer(pending[0]!.id, "hold");
    const done = await orchestrator.resume(first.run.id);
    expect(done.run.status).toBe("completed");
    expect(done.run.outcome).toBe("failure");
  });

  it("works for human-sourced decision nodes", async () => {
    const { orchestrator } = make([
      `
id: ask
name: ask
start: s
nodes:
  s: { type: start }
  d: { type: decision, source: { kind: human, question: "Which?" }, options: [a, b] }
  a: { type: end }
  b: { type: end, outcome: failure }
edges:
  - { from: s, to: d }
  - { from: d, to: a, when: "choice == 'a'" }
  - { from: d, to: b }
`,
    ]);
    const parked = await orchestrator.startAndRun({ workflowId: "ask" });
    expect(parked.run.status).toBe("paused");
    const [req] = await orchestrator.pendingInputs(parked.run.id);
    await orchestrator.answer(req!.id, "b");
    const done = await orchestrator.resume(parked.run.id);
    expect(done.run.outcome).toBe("failure");
    expect(nodes(done)).toEqual(["s:completed", "d:cancelled", "d:completed", "b:completed"]);
  });

  it("pauses the parent when children park, and re-attaches to the same children on resume", async () => {
    const { orchestrator } = make([
      GATED,
      `
id: parent
name: parent
vars: { items: [1, 2] }
start: s
nodes:
  s: { type: start }
  par:
    type: parallel
    forEach: { items: "vars.items", body: { workflow: gated } }
    concurrency: 2
  e: { type: end }
edges: [{ from: s, to: par }, { from: par, to: e }]
`,
    ]);
    const parked = await orchestrator.startAndRun({ workflowId: "parent" });
    expect(parked.run.status).toBe("paused");
    expect(nodes(parked)).toEqual(["s:completed", "par:waiting"]);
    const children = parked.steps[parked.stepOrder[1]!]!.childRunIds;
    expect(children).toHaveLength(2);
    // Own state has no questions; the tree does.
    expect(await orchestrator.pendingInputs()).toHaveLength(2);
    const pending = await orchestrator.pendingInputs(parked.run.id);
    expect(pending.map((h) => h.runId).sort()).toEqual([...children].sort());

    await orchestrator.answer(pending[0]!.id, "ship");
    // Resuming from a child climbs to the paused parent, which re-attaches; the other child parks again.
    const again = await orchestrator.resume(pending[0]!.runId);
    expect(again.run.status).toBe("paused");
    expect(nodes(again)).toEqual(["s:completed", "par:cancelled", "par:waiting"]);
    expect([...again.steps[again.stepOrder[2]!]!.childRunIds].sort()).toEqual([...children].sort());
    const [left] = await orchestrator.pendingInputs(parked.run.id);
    expect(left!.runId).toBe(pending[1]!.runId);

    await orchestrator.answer(left!.id, "ship");
    const done = await orchestrator.resume(parked.run.id);
    expect(done.run.status).toBe("completed");
    expect(done.run.outcome).toBe("success");
    expect([...done.steps[done.stepOrder[3]!]!.childRunIds].sort()).toEqual([...children].sort());
    // No child was re-spawned: the store holds exactly the parent and its two children.
    expect(await orchestrator.listRuns()).toHaveLength(3);
    for (const c of children) expect((await orchestrator.getState(c)).run.status).toBe("completed");
  });

  it("resumes a loop at the parked iteration without re-running finished ones", async () => {
    const { orchestrator } = make([
      GATED,
      `
id: looped
name: looped
start: s
nodes:
  s: { type: start }
  loop: { type: loop, mode: while, condition: "iteration < 2", body: { workflow: gated } }
  e: { type: end }
edges: [{ from: s, to: loop }, { from: loop, to: e }]
`,
    ]);
    let state = await orchestrator.startAndRun({ workflowId: "looped" });
    for (let round = 0; round < 2; round++) {
      expect(state.run.status).toBe("paused");
      const pending = await orchestrator.pendingInputs(state.run.id);
      expect(pending).toHaveLength(1);
      await orchestrator.answer(pending[0]!.id, "ship");
      state = await orchestrator.resume(state.run.id);
    }
    expect(state.run.status).toBe("completed");
    const loopStep = state.steps[state.stepOrder[state.stepOrder.length - 2]!]!;
    expect(loopStep.nodeId).toBe("loop");
    expect(loopStep.result?.data).toMatchObject({ iterations: 2, ok: true });
    expect(await orchestrator.listRuns()).toHaveLength(3);
  });

  it("cancels a parked run tree", async () => {
    const { orchestrator } = make([
      GATED,
      `
id: sub
name: sub
start: s
nodes:
  s: { type: start }
  child: { type: subworkflow, workflow: gated }
  e: { type: end }
edges: [{ from: s, to: child }, { from: child, to: e }]
`,
    ]);
    const parked = await orchestrator.startAndRun({ workflowId: "sub" });
    expect(parked.run.status).toBe("paused");
    await orchestrator.cancel(parked.run.id, "changed my mind");
    expect((await orchestrator.getState(parked.run.id)).run.status).toBe("cancelled");
    const [childId] = parked.steps[parked.stepOrder[1]!]!.childRunIds;
    expect((await orchestrator.getState(childId!)).run.status).toBe("cancelled");
    expect(await orchestrator.pendingInputs()).toEqual([]);
  });

  it("carries a workflow's consequence clauses and destructive flag through to the answer", async () => {
    // The authoring shape, widened by #247: what a gate *says*, not only what it offers.
    const { orchestrator } = make([
      `
id: rich
name: rich
start: s
nodes:
  s: { type: start }
  gate:
    type: gate
    question: "Ship it?"
    options:
      - id: ship
        label: "Ship it"
        consequence: "The release goes out to everyone."
      - id: abandon
        label: "Abandon the release"
        consequence: "The run ends and the branch is left where it is."
        destructive: true
  shipped: { type: end }
  gone: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: shipped, when: "choice == 'ship'" }
  - { from: gate, to: gone }
`,
    ]);
    const parked = await orchestrator.startAndRun({ workflowId: "rich" });
    const [request] = await orchestrator.pendingInputs(parked.run.id);
    // Workflow -> `human.requested` -> what a card reads, with nothing dropped on the way.
    expect(request!.options).toEqual([
      { id: "ship", label: "Ship it", consequence: "The release goes out to everyone." },
      {
        id: "abandon",
        label: "Abandon the release",
        consequence: "The run ends and the branch is left where it is.",
        destructive: true,
      },
    ]);

    // The answer is the id, and a label is never one: #161's safety properties are only
    // real if the two cannot be confused.
    await expect(orchestrator.answer(request!.id, "Ship it")).rejects.toThrow(/not one of: ship, abandon/);
    await orchestrator.answer(request!.id, "ship");
    const done = await orchestrator.resume(parked.run.id);
    expect(done.run.outcome).toBe("success");
    // The edge compares the id too, so `when: choice == 'ship'` routed it.
    expect(nodes(done)).toEqual(["s:completed", "gate:cancelled", "gate:completed", "shipped:completed"]);
  });

  it("does exactly what it did before when the options are bare words (#247's compatibility claim)", async () => {
    // GATED declares `options: [ship, hold]`. Nothing about that workflow changes: the words
    // are the ids, the answer is the word, and the edge still routes on it.
    const { orchestrator } = make([GATED]);
    const parked = await orchestrator.startAndRun({ workflowId: "gated" });
    const [request] = await orchestrator.pendingInputs(parked.run.id);
    expect(request!.options).toEqual([
      { id: "ship", label: "ship" },
      { id: "hold", label: "hold" },
    ]);
    // No consequence and no flag invented for an author who wrote neither.
    expect(request!.options.every((o) => o.consequence === undefined && o.destructive === undefined)).toBe(true);
    await orchestrator.answer(request!.id, "hold");
    const done = await orchestrator.resume(parked.run.id);
    expect(done.run.outcome).toBe("failure");
  });

  it("records the note beside the answer, and only when there is one (#238)", async () => {
    const { orchestrator } = make([GATED]);
    const parked = await orchestrator.startAndRun({ workflowId: "gated" });
    const [request] = await orchestrator.pendingInputs(parked.run.id);
    await orchestrator.answer(request!.id, "hold", undefined, "the staging soak is still red");

    const answered = (await orchestrator.events(parked.run.id)).filter((e) => e.type === "human.answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]!.payload).toMatchObject({ answer: "hold", note: "the staging soak is still red" });

    // The run still branches on the answer alone; the note is the record of why.
    const done = await orchestrator.resume(parked.run.id);
    expect(done.run.outcome).toBe("failure");
  });

  it("writes no `note` field at all when none was given", async () => {
    const { orchestrator } = make([GATED]);
    const parked = await orchestrator.startAndRun({ workflowId: "gated" });
    const [request] = await orchestrator.pendingInputs(parked.run.id);
    await orchestrator.answer(request!.id, "ship");
    const answered = (await orchestrator.events(parked.run.id)).find((e) => e.type === "human.answered")!;
    // Absent, not an empty string: a card must not draw a note nobody wrote.
    expect(answered.payload).not.toHaveProperty("note");
  });

  it("cancels agent permission asks instead of parking (the agent session cannot be resumed)", async () => {
    await expect(
      new PausingHumanInput().ask({
        runId: "r",
        stepRunId: "s",
        requestId: "hi",
        kind: "permission",
        question: "rm -rf?",
        options: ["allow", "reject"].map(toGateOption),
        context: {},
      }),
    ).resolves.toBeUndefined();
  });
});
