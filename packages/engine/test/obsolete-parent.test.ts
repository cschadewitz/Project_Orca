/** A fenced parent must not create a child run or workspace after an awaited prerequisite. */
import { expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { builtinExecutors, completed, LocalWorkspaceProvider, Orchestrator, runLeaseResource } from "@orca/engine";
import { memoryStores } from "@orca/store";

it("refuses child creation by an obsolete parent before provisioning or appending run.created", async () => {
  const stores = memoryStores();
  let arrived!: () => void;
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const executors = builtinExecutors().register({
    type: "custom:parent",
    execute: async (ctx) => {
      arrived();
      await barrier;
      await ctx.runChild({ workflow: "child" }, { branch: "child" });
      return completed();
    },
  });
  const workflows = new WorkflowRegistry()
    .register(
      parseWorkflow(`
id: parent
name: parent
start: parent
nodes: { parent: { type: "custom:parent" } }
edges: []
`),
    )
    .register(
      parseWorkflow(`
id: child
name: child
start: done
nodes: { done: { type: end } }
edges: []
`),
    );
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry(),
    templates: new TemplateRegistry(),
    workflows,
    executors,
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    lease: { ttlMs: 60_000, renewMs: 30_000 },
  });
  const runId = await orchestrator.startRun({ workflowId: "parent" });
  const running = orchestrator.run(runId);
  const rejected = expect(running).rejects.toMatchObject({ code: "RUN_LEASED" });
  await entered;
  await stores.leases.forceRelease(runLeaseResource(runId));
  const successor = await stores.leases.acquire({ resource: runLeaseResource(runId), holder: "successor" });
  const before = await stores.events.read(runId);
  finish();
  await rejected;
  expect(await stores.events.listRuns()).toEqual([runId]);
  expect(await stores.events.read(runId)).toEqual(before);
  expect(await stores.leases.get(successor.resource)).toEqual(successor);
});
