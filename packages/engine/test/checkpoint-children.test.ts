/**
 * #357 phase 2 review: a checkpoint attempt shows the children its reused steps had as history,
 * but owns none of them. Cancelling, resuming or asking the attempt for its pending inputs
 * never reaches a child of the source.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, silentLogger, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { memoryStores } from "@orca/store";
import { builtinExecutors, failed, LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const parent = parseWorkflow(`
id: parent
name: Parent
version: "1"
start: s
nodes:
  s: { type: start }
  sub: { type: subworkflow, workflow: child }
  b: { type: "custom:fail" }
  e: { type: end, outcome: success }
edges: [{ from: s, to: sub }, { from: sub, to: b }, { from: b, to: e }]
`);
const child = parseWorkflow(`
id: child
name: Child
version: "1"
start: s
nodes:
  s: { type: start }
  e: { type: end, outcome: success }
edges: [{ from: s, to: e }]
`);
const waiter = parseWorkflow(`
id: waiter
name: Waiter
version: "1"
start: s
nodes:
  s: { type: start }
  ask: { type: gate, question: Go?, options: [go] }
  e: { type: end, outcome: success }
edges: [{ from: s, to: ask }, { from: ask, to: e }]
`);

it("keeps the source's children out of the attempt's ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-checkpoint-children-"));
  dirs.push(dir);
  const stores = memoryStores();
  const orc = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry().register(parent).register(child).register(waiter),
    templates: new TemplateRegistry(),
    executors: builtinExecutors().register({
      type: "custom:fail",
      execute: async () => failed("FAIL", "no", {}, false, "none"),
    }),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    humanInput: new PausingHumanInput(),
    logger: silentLogger,
  });
  const source = await orc.startAndRun({ workflowId: "parent", vars: {} });
  expect(source.run.status).toBe("failed");
  const sub = source.stepOrder.map((id) => source.steps[id]!).find((s) => s.nodeId === "sub")!;
  expect(sub.childRunIds).toHaveLength(1);

  // A child of the source that is still open (waiting for an answer), linked from its step.
  const open = await orc.startAndRun({ workflowId: "waiter", vars: {} });
  expect(open.run.status).toBe("paused");
  await stores.events.append({
    type: "child.spawned",
    runId: source.run.id,
    payload: { stepRunId: sub.id, childRunId: open.run.id },
  });
  const openLog = (await orc.events(open.run.id)).length;

  const attemptId = await orc.startCheckpointAttempt({ runId: source.run.id, checkpoint: "sub" });
  const attempt = await orc.getState(attemptId);
  const reused = attempt.stepOrder.map((id) => attempt.steps[id]!).find((s) => s.nodeId === "sub")!;
  // History, for display: the children the source's step had.
  expect(reused.reusedChildren?.map((c) => c.runId)).toEqual([...sub.childRunIds, open.run.id]);
  // Ownership: none.
  expect(reused.childRunIds).toEqual([]);
  expect(reused.children).toEqual([]);
  expect(await orc.pendingInputs(attemptId)).toEqual([]);

  await orc.cancel(attemptId, "not now");
  expect((await orc.getState(attemptId)).run.status).toBe("cancelled");
  // The source's open child was not touched.
  expect(await orc.events(open.run.id)).toHaveLength(openLog);
  expect((await orc.getState(open.run.id)).run.status).toBe("paused");

  // A second generation (from a failed attempt) still carries the history, and still owns nothing.
  const failedAttempt = await orc.run(await orc.startCheckpointAttempt({ runId: source.run.id, checkpoint: "sub" }));
  expect(failedAttempt.run.status).toBe("failed");
  const second = await orc.getState(
    await orc.startCheckpointAttempt({ runId: failedAttempt.run.id, checkpoint: "sub" }),
  );
  const again = second.stepOrder.map((id) => second.steps[id]!).find((s) => s.nodeId === "sub")!;
  expect(again.reusedChildren?.map((c) => c.runId)).toEqual([...sub.childRunIds, open.run.id]);
  expect(again.childRunIds).toEqual([]);
  expect(await orc.events(open.run.id)).toHaveLength(openLog);
});
