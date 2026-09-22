/** Request settlement follows the outcome, and returns the exact persisted document. */
import { expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, PausingHumanInput, ProgramService } from "@orca/engine";
import { memoryStores } from "@orca/store";

it.each([
  ["success", "completed"],
  ["failure", "failed"],
  ["execution", "failed"],
  ["cancelled", "cancelled"],
  ["paused", "decomposing"],
])("settles %s as %s", async (outcome, expected) => {
  const stores = memoryStores();
  const node =
    outcome === "execution"
      ? '{ type: agent, agent: missing, prompt: "work" }'
      : outcome === "paused"
        ? '{ type: gate, question: "Continue?", options: [yes, no] }'
        : `{ type: end, outcome: ${outcome === "failure" ? "failure" : "success"} }`;
  const workflows = new WorkflowRegistry().register(
    parseWorkflow(
      `id: program\nname: Program\nstart: s\nnodes:\n  s: { type: start }\n  end: ${node}\nedges: [{ from: s, to: end }]`,
    ),
  );
  const orchestrator = new Orchestrator({
    humanInput: new PausingHumanInput(),
    stores,
    agents: new AgentRegistry(),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
  });
  const program = new ProgramService(orchestrator);
  if (outcome === "cancelled") {
    const { request, runId } = await program.submit({ title: "Request", body: "Task" });
    await orchestrator.cancel(runId, "operator cancelled");
    const updated = await program.settle(await orchestrator.getState(runId));
    expect(updated?.status).toBe(expected);
    expect(updated).toEqual(await stores.requests.get(request.id));
  } else {
    const result = await program.submitAndRun({ title: "Request", body: "Task" });
    expect(result.request.status).toBe(expected);
    expect(result.request).toEqual(await stores.requests.get(result.request.id));
  }
});
