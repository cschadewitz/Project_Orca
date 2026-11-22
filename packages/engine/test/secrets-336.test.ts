/**
 * Secret references in a run (#336): the session factory is given the secrets catalog, and a
 * value a session read never reaches the run's events, its stored inputs or its log.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, TemplateRegistry, WorkflowRegistry, type Logger } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";

const VALUE = "ghp_value-that-must-not-be-written-0123";

const parent = `
id: parent
name: Parent
start: s
nodes:
  s: { type: start }
  inner:
    type: loop
    mode: until
    condition: 'true'
    maxIterations: 1
    body:
      graph:
        start: a
        nodes:
          a: { type: start }
          work: { type: agent, agent: { role: coder }, prompt: "do it" }
          z: { type: end }
        edges: [{ from: a, to: work }, { from: work, to: z }]
  e: { type: end }
edges: [{ from: s, to: inner }, { from: inner, to: e }]
`;

const single = `
id: single
name: Single
start: s
nodes:
  s: { type: start }
  work: { type: agent, agent: { role: coder }, prompt: "do it" }
  e: { type: end }
edges: [{ from: s, to: work }, { from: work, to: e }]
`;

function setup(workflow: string) {
  const config = parseOrcaConfig({
    secrets: { token: { host: "local", provider: "env", name: "ORCA_TOKEN" } },
    agents: [{ id: "claude", command: "unused", roles: ["coder"], env: { TOKEN: { secret: "token" } } }],
  });
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(workflow));
  const stores = memoryStores();
  const lines: string[] = [];
  const record = (m: string, f?: object) => lines.push(`${m} ${JSON.stringify(f ?? {})}`);
  const logger: Logger = {
    log: (_l, m, f) => record(m, f),
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
  };
  const given: OpenSessionOptions[] = [];
  const orchestrator = new Orchestrator({
    stores,
    logger,
    agents: AgentRegistry.fromConfig(config),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    sessionFactory: async (o: OpenSessionOptions) => {
      given.push(o);
      // What openAcpSession does once it has read the reference on the host.
      o.onSecretValues?.([VALUE]);
      o.logger?.info(`agent started with ${VALUE}`);
      let close!: () => void;
      const closed = new Promise<void>((r) => (close = r));
      const session: AgentSession = {
        id: "sess_1",
        agentId: o.agent.id,
        hostId: o.host.id,
        cwd: o.cwd,
        acpSessionId: "acp",
        closed,
        terminated: closed,
        configOptions: [],
        setConfigOption: async () => [],
        // An agent that echoes its credential into an error.
        prompt: async () => {
          throw new Error(`upstream rejected token ${VALUE} (401)`);
        },
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => close(),
      };
      return session;
    },
  });
  return { orchestrator, stores, lines, given };
}

async function everything(stores: ReturnType<typeof memoryStores>, runIds: string[]) {
  const out: unknown[] = [];
  for (const id of runIds) {
    out.push(await stores.events.read(id));
    out.push(await stores.execution.getInputs(id));
    out.push(await stores.artifacts.list({ runId: id }));
  }
  return JSON.stringify(out);
}

describe("secret references in a run", () => {
  it("hands the session factory the catalog, and keeps the value out of events, stored inputs and logs", async () => {
    const { orchestrator, stores, lines, given } = setup(single);
    const { run } = await orchestrator.startAndRun({ workflowId: "single" });
    expect(run.status).toBe("failed");
    expect(given[0]!.secrets).toEqual({ token: { host: "local", provider: "env", name: "ORCA_TOKEN" } });
    // The reference reaches the factory as a reference: resolving it is the host's job.
    expect(given[0]!.agent.env).toEqual({ TOKEN: { secret: "token" } });
    const written = await everything(stores, [run.id]);
    expect(written).not.toContain(VALUE);
    expect(written).toContain("upstream rejected token [REDACTED] (401)");
    expect(lines.join("\n")).not.toContain(VALUE);
  });

  it("redacts a child run's value from its parent's log too", async () => {
    const { orchestrator, stores, lines } = setup(parent);
    const { run } = await orchestrator.startAndRun({ workflowId: "parent" });
    expect(run.status).toBe("failed");
    const children = (await stores.events.read(run.id))
      .filter((e) => e.type === "child.spawned")
      .map((e) => (e.payload as { childRunId: string }).childRunId);
    expect(children.length).toBe(1);
    const written = await everything(stores, [run.id, ...children]);
    expect(written).not.toContain(VALUE);
    expect(lines.join("\n")).not.toContain(VALUE);
  });
});
