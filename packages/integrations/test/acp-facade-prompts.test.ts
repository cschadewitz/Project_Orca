/**
 * The facade's prompt grammar and session bookkeeping, driven without a real
 * coding agent: `/status`, `/run <id> k=v`, plain text as a Request, an unknown
 * session, cancellation, and a run that fails. `acp-facade.test.ts` covers the
 * same agent with a real subprocess behind it.
 */
import { PassThrough } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parsePromptTemplate, parseWorkflow, silentLogger, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, ProgramService, builtinExecutors, paused } from "@orca/engine";
import { OrcaAcpAgent, serveAcpFacade } from "@orca/integrations";
import { memoryStores } from "@orca/store";

const WORKFLOWS = [
  `id: parked
name: Parked
start: s
nodes:
  s: { type: "custom:park" }
edges: []`,
  `id: rejected
name: Rejected
start: s
nodes:
  s: { type: start }
  done: { type: end, outcome: failure }
edges: [{ from: s, to: done }]
`,
  `
id: mini
name: Mini
start: s
nodes:
  s: { type: start }
  note: { type: set, vars: { seen: "{{ vars.topic }}" } }
  done: { type: end }
edges:
  - { from: s, to: note }
  - { from: note, to: done }
`,
  `
id: program
name: Program
start: s
nodes:
  s: { type: start }
  done: { type: end }
edges:
  - { from: s, to: done }
`,
  `
id: doomed
name: Doomed
start: s
nodes:
  s: { type: start }
  boom: { type: agent, agent: ghost, prompt: "nobody is home" }
  done: { type: end }
edges:
  - { from: s, to: boom }
  - { from: boom, to: done }
`,
  // A gate with nobody to answer it: the run parks instead of completing.
  `
id: gated
name: Gated
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  done: { type: end }
edges:
  - { from: s, to: gate }
  - { from: gate, to: done }
`,
];

function setup(programWorkflow = "program") {
  const workflows = new WorkflowRegistry();
  for (const y of WORKFLOWS) workflows.register(parseWorkflow(y));
  const templates = new TemplateRegistry();
  templates.register(parsePromptTemplate("---\nid: x\n---\nunused"));
  const executors = builtinExecutors();
  executors.register({ type: "custom:park", execute: async () => paused("Waiting for external input") });
  const orchestrator = new Orchestrator({
    executors,
    stores: memoryStores(),
    agents: new AgentRegistry(),
    workflows,
    templates,
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    logger: silentLogger,
  });
  return { orchestrator, program: new ProgramService(orchestrator, programWorkflow) };
}

/** Drive the facade as an ACP client, collecting the updates it pushes back. */
async function withClient<T>(
  opts: {
    useClientCwd?: boolean;
    answerGates?: boolean;
    programWorkflow?: string;
    gateSeen?: () => void;
  } = {},
  body: (ctx: ClientCtx, updates: acp.SessionUpdate[]) => Promise<T>,
): Promise<{ result: T; updates: acp.SessionUpdate[]; orchestrator: Orchestrator }> {
  const { orchestrator, program } = setup(opts.programWorkflow);
  const agentApp = new OrcaAcpAgent({
    orchestrator,
    program,
    ...(opts.useClientCwd === undefined ? {} : { useClientCwd: opts.useClientCwd }),
  }).register(acp.agent({ name: "orca-under-test" }));
  const updates: acp.SessionUpdate[] = [];
  const result = await acp
    .client({ name: "fake-kepler" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
    })
    // answerGates: false stands in for a human who has not replied yet - the request stays open.
    .onRequest(acp.methods.client.session.requestPermission, () => {
      opts.gateSeen?.();
      return opts.answerGates === false
        ? new Promise<never>(() => {})
        : Promise.resolve({ outcome: { outcome: "selected" as const, optionId: "ship" } });
    })
    .connectWith(agentApp, (ctx) => body(ctx as never, updates));
  return { result, updates, orchestrator };
}

type ClientCtx = { request: acp.ClientSideConnection["request"]; notify: acp.ClientSideConnection["notify"] };

const newSession = async (ctx: ClientCtx): Promise<string> => {
  await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  return (await ctx.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })).sessionId;
};

const prompt = (ctx: ClientCtx, sessionId: string, text: string) =>
  ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });

const said = (updates: acp.SessionUpdate[]) =>
  updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (u as { content: { text?: string } }).content.text ?? "")
    .join("");

describe("the facade's prompt grammar", () => {
  it.each([
    ["program", "completed"],
    ["rejected", "failed"],
    ["doomed", "failed"],
    ["parked", "decomposing"],
  ])("settles request-backed %s as %s", async (programWorkflow, expected) => {
    const { orchestrator } = await withClient({ programWorkflow }, async (ctx) =>
      prompt(ctx, await newSession(ctx), "Requested task"),
    );
    const [request] = await orchestrator.stores.requests.list(() => true);
    expect(request?.status).toBe(expected);
    const state = await orchestrator.getState(request!.programRunId!);
    expect(state.run.status).toBe(
      expected === "decomposing" ? "paused" : programWorkflow === "doomed" ? "failed" : "completed",
    );
  });

  it("settles a cancelled request after the client cancels at a confirmed open gate", async () => {
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { orchestrator } = await withClient(
      { programWorkflow: "gated", answerGates: false, gateSeen: reached },
      async (ctx) => {
        const sessionId = await newSession(ctx);
        const running = prompt(ctx, sessionId, "Requested task");
        await gate;
        await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
        return running;
      },
    );
    expect((await orchestrator.stores.requests.list(() => true))[0]?.status).toBe("cancelled");
  });

  it("deduplicates plans and labels a failed step explicitly", async () => {
    const { updates } = await withClient({}, async (ctx) => prompt(ctx, await newSession(ctx), "/run doomed"));
    const plans = updates.filter((u) => u.sessionUpdate === "plan");
    expect(plans.at(-1)?.entries).toContainEqual(
      expect.objectContaining({ content: "boom → failed", status: "completed" }),
    );
    for (let i = 1; i < plans.length; i++) expect(plans[i]?.entries).not.toEqual(plans[i - 1]?.entries);
  });
  it("answers /status with nothing before the session has run anything, and with each run afterwards", async () => {
    const { updates } = await withClient({}, async (ctx) => {
      const sessionId = await newSession(ctx);
      const empty = await prompt(ctx, sessionId, "/status");
      expect(empty.stopReason).toBe("end_turn");
      await prompt(ctx, sessionId, "/run mini");
      return prompt(ctx, sessionId, "/status");
    });
    const text = said(updates);
    expect(text).toContain("No runs in this session yet.");
    expect(text).toMatch(/- run_\S+ mini: completed\/success/);
  });

  it("parses /run's key=value pairs into run vars, keeping '=' inside the value", async () => {
    const { orchestrator } = await withClient({}, async (ctx) => {
      const sessionId = await newSession(ctx);
      return prompt(ctx, sessionId, "/run mini topic=auth query=a=b bare");
    });
    const [summary] = await orchestrator.listRunSummaries();
    const state = await orchestrator.getState(summary!.id);
    expect(state.run.vars).toMatchObject({ topic: "auth", query: "a=b", bare: "" });
  });

  it("submits anything else as a Request: first line the title, the rest the body", async () => {
    const { orchestrator, updates } = await withClient({}, async (ctx) => {
      const sessionId = await newSession(ctx);
      return prompt(ctx, sessionId, "Add authentication\nUsers must be able to log in.");
    });
    const requests = await orchestrator.stores.requests.list(() => true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      title: "Add authentication",
      body: "Users must be able to log in.",
      source: { kind: "acp-session" },
    });
    expect(said(updates)).toContain("Starting Program");
  });

  it("titles an empty prompt rather than submitting a nameless request", async () => {
    const { orchestrator } = await withClient({}, async (ctx) => prompt(ctx, await newSession(ctx), "   "));
    expect((await orchestrator.stores.requests.list(() => true))[0]).toMatchObject({
      title: "Untitled request",
      body: "",
    });
  });

  it("leaves the workspace to ORCA's own provider when useClientCwd is off", async () => {
    const { orchestrator } = await withClient({ useClientCwd: false }, async (ctx) =>
      prompt(ctx, await newSession(ctx), "/run mini"),
    );
    const [summary] = await orchestrator.listRunSummaries();
    expect((await orchestrator.getState(summary!.id)).run.workspace.provider).not.toBe("acp-client");
  });

  it("rejects a prompt for a session it never opened", async () => {
    await expect(withClient({}, async (ctx) => prompt(ctx, "sess_nope", "/run mini"))).rejects.toMatchObject({
      data: { sessionId: "sess_nope", reason: "unknown session" },
    });
  });

  it("relays a failed run's error upstream", async () => {
    const { result, updates } = await withClient({}, async (ctx) => prompt(ctx, await newSession(ctx), "/run doomed"));
    expect(result.stopReason).toBe("end_turn");
    expect(said(updates)).toMatch(/run failed: /);
  });

  it("cancels the session's active run when the client says so", async () => {
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { orchestrator, updates } = await withClient({ answerGates: false, gateSeen: reached }, async (ctx) => {
      const sessionId = await newSession(ctx);
      const running = prompt(ctx, sessionId, "/run gated");
      // Let the run reach the gate (nothing answers it) before cancelling.
      await gate;
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      return running;
    });
    expect(said(updates)).toMatch(/Run run_\S+ (cancelled|paused)/);
    const [summary] = await orchestrator.listRunSummaries();
    expect(["cancelled", "paused"]).toContain(summary!.status);

    // Cancelling a session with no active run is a no-op, not an error.
    await withClient({}, async (ctx) => {
      const sessionId = await newSession(ctx);
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      return ctx.notify(acp.methods.agent.session.cancel, { sessionId: "sess_nope" });
    });
  });
});

describe("serveAcpFacade", () => {
  it("speaks ACP over the streams it is given and returns when they close", async () => {
    const { orchestrator, program } = setup();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: string[] = [];
    stdout.on("data", (c: Buffer) => lines.push(...c.toString().split("\n").filter(Boolean)));

    const served = serveAcpFacade({ orchestrator, program }, { stdin, stdout });
    stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: acp.methods.agent.initialize,
        params: { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} },
      }) + "\n",
    );
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, result: { agentInfo: { name: "orca" } } });

    stdin.end();
    await served;
  });
});
