/**
 * Agent health comes from the sessions runs already open - no poller. Every session the
 * interpreter opens is a completed ACP handshake; every one that throws is a failed one,
 * and the node's retry budget is what turns a failure followed by a success into `degraded`.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost, type AgentSession } from "@orca/agents";
import { AgentSpecSchema, FakeClock, OrcaError, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, type SessionFactory } from "@orca/engine";
import { memoryStores } from "@orca/store";

const HANDSHAKE_MS = 250;

/**
 * A session factory that costs `HANDSHAKE_MS` on the clock and fails its first
 * `failures` handshakes, the way an agent that is slow to come up does.
 */
function fakeSessions(clock: FakeClock, failures: number) {
  let opened = 0;
  const factory: SessionFactory = async (o) => {
    clock.advance(HANDSHAKE_MS);
    if (opened++ < failures)
      throw new OrcaError("AGENT_TRANSPORT", `initialize timed out after 30000ms`, { stderr: "" });
    const session: AgentSession = {
      id: `sess_${opened}`,
      agentId: o.agent.id,
      hostId: o.host.id,
      cwd: o.cwd,
      acpSessionId: "acp",
      closed: new Promise(() => {}),
      prompt: async () => ({ stopReason: "end_turn", durationMs: 1 }),
      onUpdate: () => () => {},
      cancel: async () => {},
      close: async () => {},
    };
    return session;
  };
  return { factory, opened: () => opened };
}

const workflow = (maxAttempts: number) => `
id: health
name: health
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: fake, prompt: "do it", maxAttempts: ${maxAttempts} }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

function make(opts: { failures: number; maxAttempts?: number }) {
  const clock = new FakeClock();
  // The registry's tracker runs on the same clock as the interpreter, so last contact
  // and round trip are the interpreter's times, not the wall clock's.
  const agents = new AgentRegistry(clock)
    .addHost(new LocalHost({ id: "local", type: "local" }))
    .addAgent(AgentSpecSchema.parse({ id: "fake", command: "x", hostId: "local" }));
  const sessions = fakeSessions(clock, opts.failures);
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents,
    workflows: new WorkflowRegistry().register(parseWorkflow(workflow(opts.maxAttempts ?? 1))),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock,
    sessionFactory: sessions.factory,
  });
  return { orchestrator, agents, clock, sessions };
}

describe("handshake health per agent", () => {
  it("reports a configured agent nothing has contacted as unknown", async () => {
    const { agents } = make({ failures: 0 });
    expect(agents.listHealth()).toEqual([{ agentId: "fake", state: "unknown", consecutiveFailures: 0 }]);
  });

  it("records a session the interpreter opened as ok, with last contact and round trip", async () => {
    const { orchestrator, agents, clock } = make({ failures: 0 });
    const state = await orchestrator.startAndRun({ workflowId: "health" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(agents.listHealth()).toEqual([
      { agentId: "fake", state: "ok", lastContact: clock.isoNow(), roundTripMs: HANDSHAKE_MS, consecutiveFailures: 0 },
    ]);
  });

  it("records a handshake that only succeeded on the retry as degraded", async () => {
    const { orchestrator, agents, sessions } = make({ failures: 1, maxAttempts: 2 });
    const state = await orchestrator.startAndRun({ workflowId: "health" });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(sessions.opened()).toBe(2);
    expect(agents.health.get("fake")).toMatchObject({
      state: "degraded",
      roundTripMs: HANDSHAKE_MS,
      consecutiveFailures: 0,
    });
    expect(agents.health.get("fake").lastError).toBeUndefined();
  });

  it("records a handshake that never came up as down, with why", async () => {
    const { orchestrator, agents } = make({ failures: 1 });
    const state = await orchestrator.startAndRun({ workflowId: "health" });
    expect(state.run.status).toBe("failed");
    expect(agents.health.get("fake")).toMatchObject({
      state: "down",
      consecutiveFailures: 1,
      lastError: { code: "AGENT_TRANSPORT" },
    });
    // It has never answered, so there is no round trip to claim.
    expect(agents.health.get("fake").roundTripMs).toBeUndefined();
  });

  it("brings a down agent back to degraded on the next success, then to ok on a clean one", async () => {
    const { orchestrator, agents } = make({ failures: 1 });
    await orchestrator.startAndRun({ workflowId: "health" });
    expect(agents.health.get("fake").state).toBe("down");

    // A second run: the handshake works this time, but it only worked after a failure.
    expect((await orchestrator.startAndRun({ workflowId: "health" })).run.status).toBe("completed");
    expect(agents.health.get("fake").state).toBe("degraded");

    // A third, with nothing wrong before it.
    expect((await orchestrator.startAndRun({ workflowId: "health" })).run.status).toBe("completed");
    expect(agents.health.get("fake")).toMatchObject({ state: "ok", consecutiveFailures: 0 });
  });

  it("forgets health with the process: a new registry starts from unknown", async () => {
    const { orchestrator, agents } = make({ failures: 0 });
    await orchestrator.startAndRun({ workflowId: "health" });
    expect(agents.health.get("fake").state).toBe("ok");
    // Health is in-process only and nothing in the store holds it, so a restart is a reset.
    expect(make({ failures: 0 }).agents.listHealth()).toEqual([
      { agentId: "fake", state: "unknown", consecutiveFailures: 0 },
    ]);
  });
});
