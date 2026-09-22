/** A durable terminal result is recovered without invoking the executor again (#290). */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { builtinExecutors, completed, LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";

describe("terminal completion recovery", () => {
  for (const type of ["end", "custom:terminal"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      it(`recovers ${type} ${outcome} and its message`, async () => {
        const stores = memoryStores();
        let executions = 0;
        const orc = new Orchestrator({
          stores,
          agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
          templates: new TemplateRegistry(),
          workflows: new WorkflowRegistry().register(
            parseWorkflow(`
id: recover
name: recover
start: end
nodes:
  end: { type: "${type}" }
edges: []
`),
          ),
          workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
          executors: builtinExecutors().register({
            type: "custom:terminal",
            execute: async () => {
              executions++;
              return completed({ outcome: "failure" });
            },
          }),
        });
        const runId = await orc.startRun({ workflowId: "recover" });
        await stores.events.append({ type: "run.started", runId, payload: {} });
        await stores.events.append({
          type: "step.scheduled",
          runId,
          payload: { stepRunId: "step_end", nodeId: "end", nodeType: type, attempt: 1 },
        });
        await stores.events.append({
          type: "step.started",
          runId,
          payload: { stepRunId: "step_end", inputArtifactIds: [] },
        });
        await stores.events.append({
          type: "step.completed",
          runId,
          payload: {
            stepRunId: "step_end",
            result: { artifactIds: [], data: {}, outcome, message: "Recorded result" },
          },
        });
        const recovered = await orc.run(runId);
        expect(recovered.run).toMatchObject({ status: "completed", outcome });
        expect(executions).toBe(0);
        const events = await stores.events.read(runId);
        expect(events.at(-1)).toMatchObject({
          type: "run.completed",
          payload: { outcome, message: "Recorded result" },
        });
        expect(events.filter((e) => e.type === "step.scheduled")).toHaveLength(1);
        await orc.run(runId);
        expect(await stores.events.read(runId)).toHaveLength(events.length);
      });
    }
  }
});
