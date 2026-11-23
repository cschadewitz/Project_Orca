/**
 * Dry run of a draft (#183): a simulated run tree, tagged throughout, in which no agent, person,
 * workspace, secret or plugin effect takes part - and which shows the branches never taken.
 */
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OrcaError, parseWorkflow, type WorkflowDefinition } from "@orca/core";
import {
  completed,
  dryRunReport,
  NodeExecutorRegistry,
  builtinExecutors,
  placeholderArtifact,
  startDryRun,
  type NodeExecutor,
  type Orchestrator,
} from "@orca/engine";
import { harness, loadShippedWorkflows, type TestHarness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const workItem = { slug: "dry", title: "Dry item", description: "Nothing real happens.", acceptance: [] };

/** A harness whose live side-effect paths are all spies: none of them may be reached. */
async function spied(executors?: NodeExecutorRegistry) {
  const sessionFactory = vi.fn(() => Promise.reject(new Error("a dry run opened a session")));
  const secretUse = vi.fn(() => Promise.resolve());
  const ask = vi.fn(() => Promise.resolve("approve"));
  const provision = vi.fn(() => Promise.reject(new Error("a dry run provisioned a workspace")));
  const h: TestHarness = await harness({ turns: [] } as never, {
    sessionFactory,
    secretUse,
    humanInput: { ask },
    workspaceProvider: { name: "spy", provision },
    ...(executors ? { executors } : {}),
  });
  dirs.push(h.dir);
  return { h, o: h.orchestrator, spies: { sessionFactory, secretUse, ask, provision } };
}

async function assertNothingReal(h: TestHarness, o: Orchestrator, spies: Record<string, ReturnType<typeof vi.fn>>) {
  for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  // No agent process wrote its prompt log, and nothing was written into the workspace.
  expect(existsSync(h.promptLog)).toBe(false);
  expect(await readdir(h.dir)).toEqual([]);
  // No Request, work item or plan record came of it.
  expect(await o.stores.requests.list()).toEqual([]);
  expect(await o.stores.workItems.list()).toEqual([]);
  expect(await o.stores.plan.plans.list()).toEqual([]);
  expect(await o.stores.plan.decisions.list()).toEqual([]);
}

async function aiSdlcWithFalseTests(): Promise<WorkflowDefinition> {
  const live = (await loadShippedWorkflows()).get("ai-sdlc");
  const nodes = structuredClone(live.nodes);
  // The draft edit under test: "did tests pass?" now reads an expression that is always false.
  nodes["tests-passed"] = {
    ...(nodes["tests-passed"] as object),
    source: { kind: "expression", expr: "false" },
  } as never;
  return { ...structuredClone(live), nodes };
}

describe("dry run (#183)", () => {
  it("shows the branch an always-false decision never takes, with no agent spawned and nothing written", async () => {
    const { h, o, spies } = await spied();
    const definition = await aiSdlcWithFalseTests();
    const handle = await startDryRun(o, { definition, vars: { workItem }, draftRevision: 7 });
    const state = await handle.done;

    expect(state.run.status).toBe("completed");
    expect(state.run.outcome).toBe("failure");
    expect(state.steps[state.stepOrder.at(-1)!]!.nodeId).toBe("exhausted");
    expect(state.run.dryRun).toMatchObject({ draftRevision: 7, definitionRevision: expect.stringMatching(/^sha256:/) });
    // Every event of it belongs to a run tagged as a dry run, and its version never meets a real one.
    const first = (await o.stores.events.read(handle.runId))[0]!;
    expect(first.type === "run.created" && first.payload.dryRun).toEqual(handle.dryRun);
    expect(state.run.workflowVersion).toMatch(/^1\+dryrun\.[0-9a-f]{16}$/);
    expect(await o.stores.workflows.get("ai-sdlc", "1")).toBeUndefined();
    // The simulated definition is never selectable or discoverable by a live launch.
    expect(await o.stores.workflows.versions("ai-sdlc")).toEqual([]);
    await expect(
      o.startRun({ workflowId: "ai-sdlc", workflowVersion: state.run.workflowVersion, vars: { workItem } }),
    ).rejects.toMatchObject({ code: "WORKFLOW_VERSION_NOT_FOUND" });
    await expect(
      o.validateStartRun({ workflowId: "ai-sdlc", workflowVersion: state.run.workflowVersion }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_VERSION_NOT_FOUND",
    });

    const report = await dryRunReport(o, handle.runId);
    expect(report.untakenOptions).toContainEqual({ runId: handle.runId, nodeId: "tests-passed", options: ["true"] });
    expect(report.untakenEdges).toContainEqual(
      expect.objectContaining({ from: "tests-passed", to: "bump-review", label: "passed" }),
    );
    expect(report.unreachedNodes[0]!.nodeIds).toEqual(
      expect.arrayContaining(["review", "review-verdict", "deploy", "done"]),
    );
    expect(report.choices.filter((c) => c.nodeId === "tests-passed").map((c) => [c.choice, c.source])).toEqual([
      ["false", "expression"],
      ["false", "expression"],
      ["false", "expression"],
    ]);
    // The spec gate decided itself on the placeholder's risk, as it would live.
    expect(report.choices).toContainEqual({
      runId: handle.runId,
      nodeId: "spec-gate",
      choice: "approve",
      source: "gate:auto",
    });
    expect(report.assumptions.filter((a) => a.nodeId === "build")).toHaveLength(3);
    expect(report.limits).toMatch(/not evidence/);

    await assertNothingReal(h, o, spies);
    // Nothing real may start from it.
    await expect(o.startCheckpointAttempt({ runId: handle.runId })).rejects.toMatchObject({ code: "RUN_STATE" });
  });

  it("takes fixture artifacts and simulated choices, recorded as fixtures", async () => {
    const { h, o, spies } = await spied();
    const definition = (await loadShippedWorkflows()).get("ai-sdlc");
    const spec =
      "---\nstatus: ready\nrisk: high\n---\n" + "A spec long enough to pass its validation rules. ".repeat(3);
    const handle = await startDryRun(o, {
      definition,
      vars: { workItem },
      fixtures: {
        agents: { design: { artifacts: { spec } } },
        choices: { "spec-gate": "reject" },
      },
    });
    const state = await handle.done;
    expect(state.run.outcome).toBe("failure");
    expect(state.steps[state.stepOrder.at(-1)!]!.nodeId).toBe("rejected");
    const report = await dryRunReport(o, handle.runId);
    expect(report.choices).toContainEqual({
      runId: handle.runId,
      nodeId: "spec-gate",
      choice: "reject",
      source: "dry-run:fixture",
    });
    expect(report.assumptions).toContainEqual(expect.objectContaining({ nodeId: "design", assumption: "fixture" }));
    expect(report.untakenOptions).toContainEqual({ runId: handle.runId, nodeId: "spec-gate", options: ["approve"] });
    await assertNothingReal(h, o, spies);
  });

  it("walks every visit of a fixture list, then the default branch", async () => {
    const { o } = await spied();
    const definition = (await loadShippedWorkflows()).get("ai-sdlc");
    const report = (passed: string) => `---\nstatus: done\npassed: ${passed}\n---\nReport.`;
    const review = (verdict: string) => `---\nstatus: done\nverdict: ${verdict}\n---\nReview.`;
    const handle = await startDryRun(o, {
      definition,
      vars: { workItem },
      fixtures: {
        agents: {
          test: [{ artifacts: { testReport: report("false") } }, { artifacts: { testReport: report("true") } }],
          review: [
            { artifacts: { review: review("changes-requested") } },
            { artifacts: { review: review("approve") } },
          ],
          deploy: { artifacts: { deployReport: "---\nstatus: done\n---\nShipped." } },
        },
      },
    });
    const state = await handle.done;
    expect(state.run.outcome).toBe("success");
    const r = await dryRunReport(o, handle.runId);
    expect(r.choices.filter((c) => c.nodeId === "review-verdict").map((c) => c.choice)).toEqual([
      "changes-requested",
      "approve",
    ]);
    expect(r.unreachedNodes[0]!.nodeIds.sort()).toEqual(["delivery-blocked", "exhausted", "rejected"]);
  });

  it("simulates a person's and an agent's choices by the documented default, asking nobody", async () => {
    const { h, o, spies } = await spied();
    const definition = parseWorkflow(`
id: asks
name: Asks
version: "1"
start: start
nodes:
  start: { type: start }
  approve:
    type: gate
    question: "Ship it?"
    options: [hold, ship]
  route:
    type: decision
    source: { kind: agent, agent: { role: reviewer }, prompt: "Pick one of {{ vars.options }}." }
    options: [left, right]
    defaultOption: right
  done: { type: end, outcome: success }
  stopped: { type: end, outcome: failure }
edges:
  - { from: start, to: approve }
  - { from: approve, to: route, when: "choice == 'hold'" }
  - { from: approve, to: stopped }
  - { from: route, to: done }
`);
    const handle = await startDryRun(o, { definition });
    const state = await handle.done;
    expect(state.run.outcome).toBe("success");
    const r = await dryRunReport(o, handle.runId);
    expect(r.choices.map((c) => [c.nodeId, c.choice, c.source])).toEqual([
      ["approve", "hold", "dry-run:default"],
      ["route", "right", "dry-run:default"],
    ]);
    // Nothing pending: a simulated gate creates no human input anyone could answer.
    expect(Object.keys(state.humanInputs)).toEqual([]);
    expect(await o.pendingInputs()).toEqual([]);
    await assertNothingReal(h, o, spies);
  });

  it("blocks and names an installed plugin's node, never running its code", async () => {
    const execute = vi.fn(() => Promise.resolve(completed()));
    const deploy: NodeExecutor = { type: "custom:deploy", execute } as never;
    const { h, o, spies } = await spied(builtinExecutors().register(deploy));
    const definition = parseWorkflow(`
id: plugin
name: Plugin
version: "1"
start: start
nodes:
  start: { type: start }
  deploy: { type: "custom:deploy" }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: deploy }
  - { from: deploy, to: done }
`);
    const handle = await startDryRun(o, { definition });
    const state = await handle.done;
    expect(state.run.status).toBe("failed");
    expect(execute).not.toHaveBeenCalled();
    const r = await dryRunReport(o, handle.runId);
    expect(r.failures).toEqual([
      expect.objectContaining({
        nodeId: "deploy",
        code: "DRY_RUN_UNSUPPORTED",
        message: expect.stringMatching(/plugin/),
      }),
    ]);
    await assertNothingReal(h, o, spies);
  });

  it("blocks the planning and program nodes that would act on real work", async () => {
    const { o } = await spied();
    const handle = await startDryRun(o, { definition: (await loadShippedWorkflows()).get("program") });
    const state = await handle.done;
    expect(state.run.status).toBe("failed");
    const r = await dryRunReport(o, handle.runId);
    expect(r.failures[0]).toMatchObject({ code: "DRY_RUN_UNSUPPORTED" });
    expect(await o.stores.workItems.list()).toEqual([]);
    expect(await o.stores.requests.list()).toEqual([]);
  });

  it("refuses fixtures that do not fit the definition before anything is written", async () => {
    const { o } = await spied();
    const definition = (await loadShippedWorkflows()).get("ai-sdlc");
    const refused = (fixtures: unknown) =>
      startDryRun(o, { definition, vars: { workItem }, fixtures: fixtures as never }).then(
        () => undefined,
        (e: unknown) => e,
      );
    for (const fixtures of [
      { agents: { nowhere: {} } },
      { agents: { "spec-gate": {} } },
      { agents: { design: { artifacts: { intent: "x" } } } },
      { choices: { "spec-gate": "maybe" } },
      { choices: { "tests-passed": "true" } },
      { surprise: true },
    ]) {
      const error = await refused(fixtures);
      expect(error).toBeInstanceOf(OrcaError);
      expect(error).toMatchObject({ code: "DRY_RUN_FIXTURE_INVALID" });
    }
    expect(await o.stores.events.listRuns()).toEqual([]);
  });

  it("fails the step, boundedly, on a fixture that breaks the step's own rules", async () => {
    const { o } = await spied();
    const definition = (await loadShippedWorkflows()).get("ai-sdlc");
    const handle = await startDryRun(o, {
      definition,
      vars: { workItem },
      fixtures: { agents: { design: { artifacts: { spec: "---\nstatus: ready\nrisk: extreme\n---\nshort" } } } },
    });
    const state = await handle.done;
    expect(state.run.status).toBe("failed");
    const r = await dryRunReport(o, handle.runId);
    expect(r.failures).toEqual([expect.objectContaining({ nodeId: "design", code: "DRY_RUN_FIXTURE_INVALID" })]);
  });

  it("stops a cycle that never exits at the step budget", async () => {
    const { o } = await spied();
    const definition = parseWorkflow(`
id: spin
name: Spin
version: "1"
vars: { n: 0 }
start: start
nodes:
  start: { type: start }
  again: { type: set, vars: { n: "=vars.n + 1" } }
edges:
  - { from: start, to: again }
  - { from: again, to: again }
`);
    const handle = await startDryRun(o, { definition, maxSteps: 25 });
    const state = await handle.done;
    expect(state.run.status).toBe("failed");
    const r = await dryRunReport(o, handle.runId);
    expect(r.failures.at(-1)).toMatchObject({ code: "DRY_RUN_LIMIT" });
    expect(state.stepOrder.length).toBeLessThanOrEqual(26);
    // The ordinary orchestrator will not drive it on: that would hand its fixtures to real agents.
    await expect(o.resume(handle.runId)).rejects.toThrow(/is a dry run/);
  });

  it("runs nested graphs as dry runs too, and can be cancelled", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { o } = await spied();
    // Hold the branch's simulated agent step at its artifact write, so the tree is mid-flight.
    const put = o.stores.artifacts.put.bind(o.stores.artifacts);
    vi.spyOn(o.stores.artifacts, "put").mockImplementation(async (...args) => {
      await held;
      return put(...args);
    });
    const definition = parseWorkflow(`
id: nested
name: Nested
version: "1"
start: start
nodes:
  start: { type: start }
  fan:
    type: parallel
    branches:
      a: { graph: { start: s, nodes: { s: { type: start }, w: { type: agent, agent: { role: builder }, prompt: "Simulated.", produces: [{ kind: note, path: note.md }] }, e: { type: end, outcome: success } }, edges: [{ from: s, to: w }, { from: w, to: e }] } }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: fan }
  - { from: fan, to: done }
`);
    const handle = await startDryRun(o, { definition });
    await vi.waitFor(async () => {
      const root = await o.getState(handle.runId);
      expect(root.steps[root.stepOrder.at(-1)!]?.childRunIds.length).toBe(1);
    });
    const root = await o.getState(handle.runId);
    const child = await o.getState(root.steps[root.stepOrder.at(-1)!]!.childRunIds[0]!);
    expect(child.run.dryRun).toEqual(handle.dryRun);
    await handle.cancel();
    release();
    const state = await handle.done;
    expect(state.run.status).toBe("cancelled");
  });

  it("reads each run's exact definition from its own snapshot, even after a registered child changes", async () => {
    const { o } = await spied();
    const child = parseWorkflow(`
id: child-flow
name: Child
version: "1"
start: start
nodes:
  start: { type: start }
  pick: { type: gate, question: "Which?", options: [left, right] }
  left: { type: end, outcome: success }
  right: { type: end, outcome: failure }
edges:
  - { from: start, to: pick }
  - { from: pick, to: left, when: "choice == 'left'" }
  - { from: pick, to: right }
`);
    o.workflows.register(child);
    const definition = parseWorkflow(`
id: parent-flow
name: Parent
version: "1"
start: start
nodes:
  start: { type: start }
  call: { type: subworkflow, workflow: child-flow }
  done: { type: end, outcome: success }
edges:
  - { from: start, to: call }
  - { from: call, to: done }
`);
    const handle = await startDryRun(o, { definition });
    await handle.done;
    const report = async () => dryRunReport(o, handle.runId);
    const before = await report();
    // The registered child is edited at the same version, then removed, after the dry run.
    o.workflows.register({ ...child, nodes: { start: child.nodes.start!, left: child.nodes.left! }, edges: [] });
    o.workflows.register({ ...child, id: "elsewhere" });
    (o.workflows as unknown as { defs: Map<string, unknown> }).defs.delete("child-flow");
    expect(await report()).toEqual(before);
    const childRun = before.runs[1]!.runId;
    expect(before.runs[1]!.workflowId).toBe("child-flow");
    expect(before.untakenOptions).toContainEqual({ runId: childRun, nodeId: "pick", options: ["right"] });
    expect(before.unreachedNodes).toContainEqual({ runId: childRun, nodeIds: ["right"] });
    // None of it is in the live catalog.
    expect(await o.stores.workflows.versions("child-flow")).toEqual([]);
    expect(await o.stores.workflows.versions("parent-flow")).toEqual([]);
  });

  it("leaves no run behind when the definition snapshot cannot be written", async () => {
    const { o } = await spied();
    vi.spyOn(o.stores.execution, "putGeneration").mockRejectedValue(new OrcaError("RUN_STATE", "store refused"));
    const definition = (await loadShippedWorkflows()).get("ai-sdlc");
    await expect(startDryRun(o, { definition, vars: { workItem } })).rejects.toThrow(/store refused/);
    expect(await o.stores.events.listRuns()).toEqual([]);
  });

  it("writes a placeholder that satisfies the step's validation", () => {
    const text = placeholderArtifact(
      {
        kind: "spec",
        path: "spec.md",
        required: true,
        validate: { requiredFields: ["status", "risk"], fieldValues: { risk: ["low", "high"] }, minBodyLength: 200 },
      },
      "design",
    );
    expect(text).toMatch(/"risk": "low"/);
    expect(text).toMatch(/"status": "dry-run"/);
    expect(text.split("---\n")[2]!.trim().length).toBeGreaterThan(200);
  });
});
