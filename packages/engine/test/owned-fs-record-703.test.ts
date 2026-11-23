/**
 * The orchestrator writes ORCA's own file executor's record into the run's events (#703):
 * each authorization is appended, and awaited, before the session may start the I/O, then its
 * outcome. An authorization the run has no outcome for reads as execution-unknown.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import {
  AgentSpecSchema,
  FakeClock,
  ownedFsExecutions,
  parseWorkflow,
  TemplateRegistry,
  WorkflowRegistry,
} from "@orca/core";
import { autoHumanInput, LocalWorkspaceProvider, Orchestrator, type SessionFactory } from "@orca/engine";
import { memoryStores } from "@orca/store";

const workflow = `
id: fsrec
name: fsrec
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: fake, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

/** A session whose turn reports two file operations: one that finishes, one cut off after its authorization. */
function recordingSession(seen: { authorizedBeforeIo: boolean[] }): SessionFactory {
  return async (o: OpenSessionOptions) => {
    const session: AgentSession = {
      id: "sess_1",
      agentId: o.agent.id,
      hostId: o.host.id,
      cwd: o.cwd,
      acpSessionId: "acp",
      configOptions: [],
      setConfigOption: async () => [],
      closed: new Promise(() => {}),
      async prompt() {
        const record = o.recordFsOperation!;
        const done = await record({
          operationId: "op-1",
          turnId: "turn-1",
          access: "write",
          display: "a.ts",
          decision: "allow",
          rule: { basis: "default" },
        });
        seen.authorizedBeforeIo.push(true);
        await done("completed");
        // A second outcome for the same authorization is not recorded.
        await done("failed");
        // The second never gets an outcome: the daemon stopped mid-operation.
        await record({
          operationId: "op-2",
          turnId: "turn-1",
          access: "write",
          display: "b.ts",
          linked: true,
          decision: "ask:allow_once",
        });
        return { stopReason: "end_turn", durationMs: 1 };
      },
      onUpdate: () => () => {},
      cancel: async () => {},
      close: async () => {},
    };
    return session;
  };
}

describe("the run's record of ORCA's own file executor (#703)", () => {
  it("holds each authorization and outcome, and reads one with no outcome as execution-unknown", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(workflow));
    const agents = new AgentRegistry()
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "fake", command: "x", roles: ["builder"] }));
    const seen = { authorizedBeforeIo: [] as boolean[] };
    const orchestrator = new Orchestrator({
      stores: memoryStores(),
      agents,
      workflows,
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider("/tmp"),
      clock: new FakeClock(),
      humanInput: autoHumanInput("allow"),
      sessionFactory: recordingSession(seen),
    });
    const state = await orchestrator.startAndRun({ workflowId: "fsrec" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(seen.authorizedBeforeIo).toEqual([true]);
    const events = await orchestrator.events(state.run.id);
    const authorized = events.filter((e) => e.type === "agent.fs.authorized");
    expect(authorized.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        operationId: "op-1",
        turnId: "turn-1",
        access: "write",
        display: "a.ts",
        decision: "allow",
        rule: { basis: "default" },
      }),
      expect.objectContaining({ operationId: "op-2", linked: true, decision: "ask:allow_once" }),
    ]);
    const completed = events.filter((e) => e.type === "agent.fs.completed");
    expect(completed.map((e) => e.payload)).toEqual([
      {
        stepRunId: authorized[0]!.payload.stepRunId,
        sessionId: authorized[0]!.payload.sessionId,
        turnId: "turn-1",
        operationId: "op-1",
        outcome: "completed",
      },
    ]);
    expect(ownedFsExecutions(events).map((op) => [op.operationId, op.state])).toEqual([
      ["op-1", "completed"],
      ["op-2", "execution-unknown"],
    ]);
  });

  it("refuses a file authorization on a store that cannot make it durable, before appending it", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(parseWorkflow(workflow));
    const agents = new AgentRegistry()
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "fake", command: "x", roles: ["builder"] }));
    const stores = memoryStores();
    let refusal: unknown;
    const factory: SessionFactory = async (o: OpenSessionOptions) => ({
      id: "sess_1",
      agentId: o.agent.id,
      hostId: o.host.id,
      cwd: o.cwd,
      acpSessionId: "acp",
      configOptions: [],
      setConfigOption: async () => [],
      closed: new Promise(() => {}),
      async prompt() {
        // The turn record itself was made durable; then the store loses the barrier.
        // An own property shadows the store's method; deleting it restores the method.
        Object.defineProperty(stores.events, "synchronizeEvent", { value: undefined, configurable: true });
        await o.recordFsOperation!({
          operationId: "op-1",
          turnId: "t",
          access: "read",
          display: "a.ts",
          decision: "allow",
        }).catch((e: unknown) => {
          refusal = e;
        });
        delete (stores.events as { synchronizeEvent?: unknown }).synchronizeEvent;
        return { stopReason: "end_turn", durationMs: 1 };
      },
      onUpdate: () => () => {},
      cancel: async () => {},
      close: async () => {},
    });
    const orchestrator = new Orchestrator({
      stores,
      agents,
      workflows,
      templates: new TemplateRegistry(),
      workspaceProvider: new LocalWorkspaceProvider("/tmp"),
      clock: new FakeClock(),
      humanInput: autoHumanInput("allow"),
      sessionFactory: factory,
    });
    const state = await orchestrator.startAndRun({ workflowId: "fsrec" });
    expect(String(refusal)).toMatch(/cannot make a file authorization durable/);
    const events = await orchestrator.events(state.run.id);
    expect(events.filter((e) => e.type === "agent.fs.authorized")).toEqual([]);
  });
});
