/**
 * A step tells its session when the task it hands over holds a value the run protects (#363):
 * a delegating session uses that to have the worker protect the task too, or not send it.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost, type AgentSession, type OpenSessionOptions, type TurnContext } from "@orca/agents";
import { AgentSpecSchema, FakeClock, parseWorkflow, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, type SessionFactory } from "@orca/engine";
import { memoryStores } from "@orca/store";

const SECRET = "launch-secret-363";

const workflow = (prompt: string) => `
id: deploy
name: deploy
version: "1"
inputSchema:
  fields:
    token: { type: string, sensitive: true }
    target: { type: string }
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: fake, prompt: ${JSON.stringify(prompt)} }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

async function turnFor(prompt: string): Promise<TurnContext> {
  const turns: TurnContext[] = [];
  const sessionFactory: SessionFactory = async (o: OpenSessionOptions) =>
    ({
      id: "sess",
      agentId: o.agent.id,
      hostId: o.host.id,
      cwd: o.cwd,
      acpSessionId: "acp",
      configOptions: [],
      setConfigOption: async () => [],
      closed: new Promise(() => {}),
      async prompt(_input, options) {
        if (options?.turn) turns.push(options.turn);
        return { stopReason: "end_turn", durationMs: 1 };
      },
      onUpdate: () => () => {},
      cancel: async () => {},
      close: async () => {},
    }) satisfies AgentSession;
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents: new AgentRegistry()
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "fake", command: "x", roles: ["builder"] })),
    workflows: new WorkflowRegistry().register(parseWorkflow(workflow(prompt))),
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock: new FakeClock(),
    sessionFactory,
  });
  const { run } = await orchestrator.startAndRun({ workflowId: "deploy", vars: { token: SECRET, target: "prod" } });
  expect(run.status).toBe("completed");
  expect(turns).toHaveLength(1);
  return turns[0]!;
}

describe("a turn that hands over a protected value (#363)", () => {
  it("is marked sensitive when the rendered task holds a sensitive launch input", async () => {
    const turn = await turnFor("deploy {{ vars.target }} with {{ vars.token }}");
    expect(turn.task).toContain(SECRET);
    expect(turn.sensitive).toBe(true);
  });

  it("is not marked when the task holds only ordinary inputs", async () => {
    const turn = await turnFor("deploy {{ vars.target }}");
    expect(turn.task).toBe("deploy prod");
    expect(turn.sensitive).toBeUndefined();
  });
});
