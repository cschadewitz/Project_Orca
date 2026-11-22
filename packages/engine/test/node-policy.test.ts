/** Retry budget and run termination are node-type agnostic: custom node types get both. */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import {
  FakeClock,
  needsEffectReview,
  parseWorkflow,
  TemplateRegistry,
  WorkflowRegistry,
  validateWorkflow,
} from "@orca/core";
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
        const node = ctx.node as unknown as { succeedOn?: number; mayAct?: boolean | "repeatable" };
        const succeedOn = node.succeedOn ?? 1;
        // Unless told otherwise, it states that a failed attempt did nothing outside ORCA.
        return n >= succeedOn
          ? completed()
          : failed(
              "FLAKY",
              `attempt ${n} failed`,
              {},
              true,
              node.mayAct === "repeatable" ? "repeatable" : node.mayAct ? undefined : "none",
            );
      },
    })
    // Stands in for the agent executor: attempt 1 fails before any prompt is sent, attempt 2
    // fails after sending one (the agent may have acted), attempt 3 would succeed.
    .register({
      type: "agent",
      execute: async (ctx) => {
        const n = (attempts.get(ctx.nodeId) ?? 0) + 1;
        attempts.set(ctx.nodeId, n);
        if (n === 1) return failed("AGENT_SPAWN", "could not start the agent", {}, true);
        if (n >= 3) return completed();
        await ctx.run.emit({
          type: "agent.turn.started",
          payload: { stepRunId: ctx.step.id, sessionId: "sess", promptHash: "h", promptPreview: "p", followUp: 0 },
        });
        return failed("AGENT_FAILED", "lost the session", {}, true);
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

const flaky = (opts: { succeedOn: number; maxAttempts?: number; mayAct?: boolean | "repeatable" }) => `
id: flaky
name: flaky
start: s
nodes:
  s: { type: start }
  work:
    type: "custom:flaky"
    succeedOn: ${opts.succeedOn}
    ${opts.mayAct ? `mayAct: ${opts.mayAct}` : ""}
    ${opts.maxAttempts === undefined ? "" : `maxAttempts: ${opts.maxAttempts}`}
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

describe("node-agnostic retry and termination", () => {
  it("retries any node type up to its maxAttempts", async () => {
    const { orchestrator } = make(flaky({ succeedOn: 3, maxAttempts: 3 }));
    const state = await orchestrator.startAndRun({ workflowId: "flaky" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(
      state.stepOrder.map((id) => `${state.steps[id]!.nodeId}:${state.steps[id]!.attempt}:${state.steps[id]!.status}`),
    ).toEqual(["s:1:completed", "work:1:failed", "work:2:failed", "work:3:completed", "e:1:completed"]);
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

  it("never repeats an attempt that may have acted outside ORCA, whatever its budget (#357)", async () => {
    const { orchestrator } = make(flaky({ succeedOn: 2, maxAttempts: 3, mayAct: true }));
    const state = await orchestrator.startAndRun({ workflowId: "flaky" });
    expect(state.run.status).toBe("failed");
    expect(attempts.get("work")).toBe(1);
    const failedEvent = (await orchestrator.events(state.run.id)).find((e) => e.type === "step.failed");
    expect(failedEvent?.payload).toMatchObject({ willRetry: false });
    expect(failedEvent?.payload).not.toHaveProperty("effect");
  });

  it("repeats a repeatable attempt within its budget, and leaves the last one for review (#357)", async () => {
    const { orchestrator } = make(flaky({ succeedOn: 5, maxAttempts: 2, mayAct: "repeatable" }));
    const state = await orchestrator.startAndRun({ workflowId: "flaky" });
    expect(state.run.status).toBe("failed");
    expect(attempts.get("work")).toBe(2);
    const work = state.stepOrder.map((id) => state.steps[id]!).filter((s) => s.nodeId === "work");
    expect(work.map((s) => s.noEffect)).toEqual([undefined, undefined]);
    expect(needsEffectReview(work[1]!)).toBe(true);
    const failures = (await orchestrator.events(state.run.id)).filter((e) => e.type === "step.failed");
    expect(failures.map((e) => e.payload)).not.toContainEqual(expect.objectContaining({ effect: expect.anything() }));
  });

  it("retries an agent step that failed before sending a prompt, but not one that sent it (#357)", async () => {
    const { orchestrator } = make(`
id: agentic
name: agentic
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: coder, prompt: go, completion: { maxAttempts: 3 } }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`);
    const state = await orchestrator.startAndRun({ workflowId: "agentic" });
    expect(state.run.status).toBe("failed");
    expect(state.run.error?.code).toBe("AGENT_FAILED");
    expect(attempts.get("work")).toBe(2);
    const work = state.stepOrder.map((id) => state.steps[id]!).filter((s) => s.nodeId === "work");
    expect(work.map((s) => [s.attempt, s.dispatched ?? false])).toEqual([
      [1, false],
      [2, true],
    ]);
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
