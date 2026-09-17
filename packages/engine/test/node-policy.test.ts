/** Retry budget and run termination are node-type agnostic: custom node types get both. */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry, validateWorkflow } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, builtinExecutors, completed, failed } from "@orca/engine";
import { memoryStores } from "@orca/store";

/** Attempts each `custom:flaky` node has taken, by node id. */
const attempts = new Map<string, number>();

function make(yaml: string) {
  attempts.clear();
  const workflows = new WorkflowRegistry().register(parseWorkflow(yaml));
  const executors = builtinExecutors()
    // Fails (retryably) until it has been attempted `succeedOn` times.
    .register({
      type: "custom:flaky",
      execute: async (ctx) => {
        const n = (attempts.get(ctx.nodeId) ?? 0) + 1;
        attempts.set(ctx.nodeId, n);
        const succeedOn = (ctx.node as unknown as { succeedOn?: number }).succeedOn ?? 1;
        return n >= succeedOn ? completed() : failed("FLAKY", `attempt ${n} failed`, {}, true);
      },
    })
    // A plugin-provided terminal node: returning an outcome ends the run.
    .register({
      type: "custom:finish",
      execute: async (ctx) => {
        const n = ctx.node as unknown as { outcome?: "success" | "failure" | "cancelled"; message?: string };
        return completed({ outcome: n.outcome ?? "success", ...(n.message ? { message: n.message } : {}) });
      },
    });
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    executors,
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock: new FakeClock(),
  });
  return { orchestrator, workflows };
}

const flaky = (opts: { succeedOn: number; maxAttempts?: number }) => `
id: flaky
name: flaky
start: s
nodes:
  s: { type: start }
  work:
    type: "custom:flaky"
    succeedOn: ${opts.succeedOn}
    ${opts.maxAttempts === undefined ? "" : `maxAttempts: ${opts.maxAttempts}`}
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

describe("node-agnostic retry and termination", () => {
  it("retries any node type up to its maxAttempts", async () => {
    const { orchestrator } = make(flaky({ succeedOn: 3, maxAttempts: 3 }));
    const state = await orchestrator.startAndRun({ workflowId: "flaky" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.stepOrder.map((id) => `${state.steps[id]!.nodeId}:${state.steps[id]!.attempt}:${state.steps[id]!.status}`)).toEqual([
      "s:1:completed",
      "work:1:failed",
      "work:2:failed",
      "work:3:completed",
      "e:1:completed",
    ]);
    expect(attempts.get("work")).toBe(3);
  });

  it("gives up once the budget is spent, and defaults to a single attempt", async () => {
    const spent = await make(flaky({ succeedOn: 4, maxAttempts: 2 })).orchestrator.startAndRun({ workflowId: "flaky" });
    expect(spent.run.status).toBe("failed");
    expect(spent.run.error?.code).toBe("FLAKY");
    expect(attempts.get("work")).toBe(2);

    const once = await make(flaky({ succeedOn: 2 })).orchestrator.startAndRun({ workflowId: "flaky" });
    expect(once.run.status).toBe("failed");
    expect(attempts.get("work")).toBe(1);
  });

  it("ends the run on any step that returns an outcome, with no end node in the graph", async () => {
    const yaml = `
id: terminal
name: terminal
start: s
nodes:
  s: { type: start }
  done: { type: "custom:finish", outcome: failure, message: "nothing to do" }
edges: [{ from: s, to: done }]
`;
    expect(validateWorkflow(parseWorkflow(yaml)).errors).toEqual([]);
    const { orchestrator } = make(yaml);
    const state = await orchestrator.startAndRun({ workflowId: "terminal" });
    expect(state.run.status).toBe("completed");
    expect(state.run.outcome).toBe("failure");
    const completedEvent = (await orchestrator.events(state.run.id)).find((e) => e.type === "run.completed");
    expect(completedEvent?.payload).toMatchObject({ outcome: "failure", message: "nothing to do" });
  });
});
