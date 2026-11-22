/**
 * #357 phase 2 review: a checkpoint attempt started from a step its source itself reused takes
 * the vars as they stood when that step completed in the run that ran it, not the vars the
 * source was seeded with at its own (later) checkpoint.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, silentLogger, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { memoryStores } from "@orca/store";
import { builtinExecutors, completed, failed, LocalWorkspaceProvider, Orchestrator } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const definition = parseWorkflow(`
id: flow
name: Flow
version: "1"
start: s
nodes:
  s: { type: start }
  a: { type: set, vars: { stage: a } }
  c: { type: set, vars: { stage: c } }
  b: { type: "custom:flaky" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: a }, { from: a, to: c }, { from: c, to: b }, { from: b, to: e }]
`);

it("reads an earlier reused checkpoint's vars from the attempt that ran it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-checkpoint-vars-"));
  dirs.push(dir);
  const stores = memoryStores();
  let failures = 2;
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(definition),
    templates: new TemplateRegistry(),
    executors: builtinExecutors().register({
      type: "custom:flaky",
      execute: async () => (failures-- > 0 ? failed("FLAKY", "not yet", {}, false, "none") : completed()),
    }),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    logger: silentLogger,
  });
  const source = await orc.startAndRun({ workflowId: "flow", vars: {} });
  expect(source.run.status).toBe("failed");
  expect(source.run.vars.stage).toBe("c");

  // First generation: from the latest checkpoint (c), seeded with stage c; it fails again.
  const first = await orc.run(await orc.startCheckpointAttempt({ runId: source.run.id }));
  expect(first.run.status).toBe("failed");
  const reusedA = first.stepOrder.map((id) => first.steps[id]!).find((s) => s.nodeId === "a")!;
  const sourceA = source.stepOrder.map((id) => source.steps[id]!).find((s) => s.nodeId === "a")!;
  expect(reusedA.reusedFrom).toEqual({ runId: source.run.id, stepRunId: sourceA.id });

  // Second generation, from the first attempt at a step it reused (a): stage is a, not c.
  const secondId = await orc.startCheckpointAttempt({ runId: first.run.id, checkpoint: "a" });
  const created = await orc.getState(secondId);
  expect(created.run.vars.stage).toBe("a");
  const reused = created.stepOrder.map((id) => created.steps[id]!);
  expect(reused.map((s) => [s.nodeId, s.reusedFrom?.runId])).toEqual([
    ["s", source.run.id],
    ["a", source.run.id],
  ]);

  const second = await orc.run(secondId);
  expect(second.run.status, JSON.stringify(second.run.error)).toBe("completed");
  expect(second.stepOrder.map((id) => [second.steps[id]!.nodeId, Boolean(second.steps[id]!.reusedFrom)])).toEqual([
    ["s", true],
    ["a", true],
    ["c", false],
    ["b", false],
    ["e", false],
  ]);
  expect(second.run.vars.stage).toBe("c");
});
