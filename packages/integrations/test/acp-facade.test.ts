/**
 * Proxy mode: an ACP *client* (standing in for Kepler / Zed) drives
 * ORCA as an ACP *agent*, in-process via the SDK's app-to-app connection. ORCA
 * in turn drives the scripted agent through a real subprocess.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import {
  loadTemplates,
  parseOrcaConfig,
  parsePromptTemplate,
  parseWorkflow,
  readJsonl,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
  type SessionConfigOption,
} from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, ProgramService } from "@orca/engine";
import { OrcaAcpAgent } from "@orca/integrations";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec } from "@orca/testing";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const MINI = `
id: mini
name: Mini
start: s
nodes:
  s: { type: start }
  write:
    type: agent
    agent: scripted
    prompt: "Write the spec."
    produces: [{ kind: spec, path: ".orca/spec.md", validate: { requiredFields: [status] } }]
  gate: { type: gate, question: "Ship it?", options: [ship, hold] }
  done: { type: end }
  held: { type: end, outcome: failure }
edges:
  - { from: s, to: write }
  - { from: write, to: gate }
  - { from: gate, to: done, when: "choice == 'ship'" }
  - { from: gate, to: held }
`;

/** A gate raised inside a child run: the question carries the child's runId, not the one the session started. */
const NESTED = [
  `
id: nested-child
name: Nested child
start: s
nodes:
  s: { type: start }
  gate: { type: gate, question: "Ship child?", options: [ship, hold] }
  done: { type: end }
  held: { type: end, outcome: failure }
edges:
  - { from: s, to: gate }
  - { from: gate, to: done, when: "choice == 'ship'" }
  - { from: gate, to: held }
`,
  `
id: nested
name: Nested
start: s
nodes:
  s: { type: start }
  sub: { type: subworkflow, workflow: nested-child }
  done: { type: end }
edges:
  - { from: s, to: sub }
  - { from: sub, to: done }
`,
];

async function setup(
  configOptions?: SessionConfigOption[],
  promptLog?: string,
  shippedTemplates = false,
): Promise<{ dir: string; orchestrator: Orchestrator }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-facade-"));
  dirs.push(dir);
  const workflows = new WorkflowRegistry();
  for (const y of [MINI, ...NESTED]) workflows.register(parseWorkflow(y));
  const templates = shippedTemplates
    ? await loadTemplates(parseOrcaConfig({}).templates, REPO_ROOT)
    : new TemplateRegistry();
  if (!shippedTemplates) templates.register(parsePromptTemplate("---\nid: x\n---\nunused"));
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })).addAgent({
      ...scriptedAgentSpec({
        playbookJson: { kinds: { spec: [{ data: { status: "ready" }, body: "spec" }] } },
        ...(configOptions ? { configOptions } : {}),
        ...(promptLog ? { promptLog } : {}),
      }),
      roles: ["builder"],
    }),
    workflows,
    templates,
    workspaceProvider: new LocalWorkspaceProvider(dir),
    logger: silentLogger,
  });
  return { dir, orchestrator };
}

describe("ORCA as an ACP agent", () => {
  it("turns a prompt into a workflow run and streams plan / artifact / permission updates upstream", async () => {
    const { dir, orchestrator } = await setup();
    const facade = new OrcaAcpAgent({ orchestrator, program: new ProgramService(orchestrator) });
    const agentApp = facade.register(acp.agent({ name: "orca-under-test" }));

    const updates: acp.SessionUpdate[] = [];
    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const result = await acp
      .client({ name: "fake-kepler" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        permissionRequests.push(ctx.params);
        // The upstream "human" picks "ship".
        return { outcome: { outcome: "selected", optionId: "ship" } };
      })
      .connectWith(agentApp, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        expect(init.agentInfo?.name).toBe("orca");
        const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] });
        return ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "/run mini" }],
        });
      });

    expect(result.stopReason).toBe("end_turn");
    // The gate was forwarded as a permission request with the real option labels.
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]!.options.map((o) => o.optionId)).toEqual(["ship", "hold"]);
    expect(permissionRequests[0]!.toolCall.title).toContain("Ship it?");
    // Plan updates mirror the workflow nodes; the final one shows both steps completed with the choice.
    const plans = updates.filter(
      (u): u is Extract<acp.SessionUpdate, { sessionUpdate: "plan" }> => u.sessionUpdate === "plan",
    );
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.at(-1)!.entries.map((e) => `${e.content}:${e.status}`)).toEqual([
      "write:completed",
      "gate → ship:completed",
    ]);
    // The recorded artifact surfaced as a completed tool call pointing at the file.
    const artifactCalls = updates.filter((u) => u.sessionUpdate === "tool_call" && u.title.startsWith("artifact spec"));
    expect(artifactCalls).toHaveLength(1);
    const [summary] = await orchestrator.listRunSummaries();
    const state = await orchestrator.getState(summary!.id);
    const artifact = Object.values(state.artifacts).find((a) => a.kind === "spec")!;
    expect((artifactCalls[0] as { locations?: { path: string }[] }).locations?.[0]?.path).toBe(artifact.path);
    expect(artifact.path?.replaceAll("\\", "/")).toContain(
      `/.orca-attempts/${state.run.id}/${artifact.producedBy.stepRunId}/spec.md`,
    );
    // Agent chatter was relayed as message chunks.
    const text = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content: { text?: string } }).content.text ?? "")
      .join("");
    expect(text).toContain("Starting Mini");
    expect(text).toContain("Wrote spec");
    expect(text).toMatch(/completed \(success\)/);
  }, 60_000);

  it("routes each concurrent session's gates to its own client, including gates raised in child runs", async () => {
    const { dir, orchestrator } = await setup();
    const facade = new OrcaAcpAgent({ orchestrator, program: new ProgramService(orchestrator) });
    const agentApp = facade.register(acp.agent({ name: "orca-under-test" }));

    const permissionRequests: acp.RequestPermissionRequest[] = [];
    const textBySession = new Map<string, string>();
    const plansBySession = new Map<string, Extract<acp.SessionUpdate, { sessionUpdate: "plan" }>[]>();
    const sessions: { a?: string; b?: string } = {};
    const results = await acp
      .client({ name: "fake-kepler" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const u = ctx.params.update;
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text")
          textBySession.set(ctx.params.sessionId, (textBySession.get(ctx.params.sessionId) ?? "") + u.content.text);
        if (u.sessionUpdate === "plan") {
          const plans = plansBySession.get(ctx.params.sessionId) ?? [];
          plans.push(u);
          plansBySession.set(ctx.params.sessionId, plans);
        }
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        permissionRequests.push(ctx.params);
        return { outcome: { outcome: "selected", optionId: "ship" } };
      })
      .connectWith(agentApp, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        sessions.a = (await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] })).sessionId;
        sessions.b = (await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] })).sessionId;
        // A's gate comes after a real agent subprocess, so B is bound (and, being agent-free,
        // usually finished) by the time A asks. With one global target A's gate went to B, and
        // B finishing first unbound A altogether.
        return Promise.all([
          ctx.request(acp.methods.agent.session.prompt, {
            sessionId: sessions.a,
            prompt: [{ type: "text", text: "/run mini" }],
          }),
          ctx.request(acp.methods.agent.session.prompt, {
            sessionId: sessions.b,
            prompt: [{ type: "text", text: "/run nested" }],
          }),
        ]);
      });

    expect(results.map((r) => r.stopReason)).toEqual(["end_turn", "end_turn"]);
    const routed = permissionRequests
      .map((p) => ({ sessionId: p.sessionId, question: p.toolCall.title ?? "" }))
      .sort((x, y) => x.question.localeCompare(y.question));
    expect(routed).toEqual([
      { sessionId: sessions.b, question: "[orca decision] Ship child?" },
      { sessionId: sessions.a, question: "[orca decision] Ship it?" },
    ]);
    // Both runs took the "ship" branch their own client chose, and each session only heard about its own run.
    expect(textBySession.get(sessions.a!)).toMatch(/Starting Mini[\s\S]*completed \(success\)/);
    expect(textBySession.get(sessions.a!)).not.toContain("Nested");
    expect(textBySession.get(sessions.b!)).toMatch(/Starting Nested[\s\S]*completed \(success\)/);
    expect(textBySession.get(sessions.b!)).not.toContain("Mini");
    expect(
      plansBySession
        .get(sessions.b!)
        ?.at(-1)
        ?.entries.map((e) => `${e.content}:${e.status}`),
    ).toEqual(["sub:completed", "[nested-child] gate → ship:completed"]);
    expect(
      plansBySession
        .get(sessions.a!)
        ?.at(-1)
        ?.entries.some((e) => e.content.includes("nested-child")),
    ).toBe(false);
  }, 60_000);
});

describe("session config options (#188)", () => {
  type Ctx = { request: acp.ClientSideConnection["request"] };
  async function drive<T>(
    clientCapabilities: acp.ClientCapabilities,
    body: (ctx: Ctx, updates: acp.SessionUpdate[]) => Promise<T>,
    agent: { configOptions?: SessionConfigOption[]; promptLog?: string; shippedTemplates?: boolean } = {},
  ): Promise<{ result: T; orchestrator: Orchestrator; updates: acp.SessionUpdate[] }> {
    const { orchestrator } = await setup(agent.configOptions, agent.promptLog, agent.shippedTemplates);
    const agentApp = new OrcaAcpAgent({ orchestrator, program: new ProgramService(orchestrator) }).register(
      acp.agent({ name: "orca-under-test" }),
    );
    const updates: acp.SessionUpdate[] = [];
    const result = await acp
      .client({ name: "fake-kepler" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, () => ({
        outcome: { outcome: "selected" as const, optionId: "ship" },
      }))
      .connectWith(agentApp, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities });
        return body(ctx, updates);
      });
    return { result, orchestrator, updates };
  }
  const open = (ctx: Ctx, dir = tmpdir()) => ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] });
  const set = (ctx: Ctx, sessionId: string, configId: string, value: string) =>
    ctx.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
  const current = (options: acp.SessionConfigOption[]) =>
    Object.fromEntries(options.map((o) => [o.id, o.currentValue]));

  it("returns every option with its default in session/new, and no boolean without the capability", async () => {
    const { result } = await drive({}, async (ctx) => open(ctx));
    expect(current(result.configOptions ?? [])).toEqual({
      "orca/workflow": "orca:request",
      "orca/item-workflow": "orca:default",
      "orca/agent.builder": "orca:default",
      "orca/model": "orca:default",
      "orca/template-pack": "orca:default",
    });
    const workflow = result.configOptions!.find((o) => o.id === "orca/workflow")!;
    expect(workflow).toMatchObject({ category: "mode" });
    expect(workflow.type === "select" && workflow.options.map((o) => ("value" in o ? o.value : o.group))).toEqual([
      "orca:request",
      "mini",
      "nested-child",
      "nested",
    ]);
    expect(result.configOptions!.find((o) => o.id === "orca/model")).toMatchObject({ category: "model" });
    expect(workflow.description).toContain("applies to the next run");
  });

  it("offers boolean options only when the client advertises them", async () => {
    const { result } = await drive({ session: { configOptions: { boolean: {} } } }, async (ctx) => open(ctx));
    expect(result.configOptions?.find((o) => o.id === "orca/use-client-cwd")).toMatchObject({
      type: "boolean",
      currentValue: true,
    });
  });

  it("records each choice, returns the complete list, and starts the next run with those overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-facade-cfg-"));
    dirs.push(dir);
    const { result, orchestrator, updates } = await drive({}, async (ctx, seen) => {
      const { sessionId } = await open(ctx, dir);
      const lists = [
        await set(ctx, sessionId, "orca/item-workflow", "nested"),
        await set(ctx, sessionId, "orca/agent.builder", "scripted"),
        await set(ctx, sessionId, "orca/model", "orca:default"),
        await set(ctx, sessionId, "orca/template-pack", "orca:default"),
        await set(ctx, sessionId, "orca/workflow", "mini"),
      ];
      await expect(set(ctx, sessionId, "orca/workflow", "nope")).rejects.toMatchObject({
        data: { configId: "orca/workflow" },
      });
      await expect(set(ctx, sessionId, "orca/nope", "x")).rejects.toBeDefined();
      for (const list of lists) expect(list.configOptions).toHaveLength(5);
      await vi.waitFor(() =>
        expect(
          seen.some(
            (u) =>
              u.sessionUpdate === "available_commands_update" &&
              u.availableCommands.some((c) => c.input && "hint" in c.input && c.input.hint.startsWith("mini ")),
          ),
        ).toBe(true),
      );
      const prompted = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Write the spec" }],
      });
      return { lists, prompted };
    });
    expect(current(result.lists.at(-1)!.configOptions)).toEqual({
      "orca/workflow": "mini",
      "orca/item-workflow": "nested",
      "orca/agent.builder": "scripted",
      "orca/model": "orca:default",
      "orca/template-pack": "orca:default",
    });
    expect(result.prompted.stopReason).toBe("end_turn");
    const [summary] = await orchestrator.listRunSummaries();
    const state = await orchestrator.getState(summary!.id);
    expect(state.run.workflowId).toBe("mini");
    expect(state.run.vars).toMatchObject({ prompt: "Write the spec" });
    expect(state.run.overrides).toEqual({ roles: { builder: "scripted" }, itemWorkflow: "nested" });
    expect(updates.some((u) => u.sessionUpdate === "available_commands_update")).toBe(true);
  }, 60_000);

  it("gives a client that never sets an option today's behaviour: no overrides recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-facade-cfg-"));
    dirs.push(dir);
    const { orchestrator } = await drive({}, async (ctx) => {
      const { sessionId } = await open(ctx, dir);
      return ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/run mini" }],
      });
    });
    const [summary] = await orchestrator.listRunSummaries();
    const state = await orchestrator.getState(summary!.id);
    expect(state.run.overrides).toBeUndefined();
    expect(state.run.workspace.provider).toBe("acp-client");
  }, 60_000);

  it("discovers an agent's models from its first session and records the chosen one as overrides.model (#189)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-facade-models-"));
    dirs.push(dir);
    const promptLog = join(dir, ".orca-test", "prompts.jsonl");
    const downstream: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "fast",
        options: [
          { value: "fast", name: "Fast" },
          { value: "deep", name: "Deep" },
        ],
      },
      {
        type: "select",
        id: "effort",
        name: "Effort",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      {
        type: "select",
        id: "style",
        name: "Style",
        category: "_custom",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      },
    ];
    const run = (ctx: Ctx, sessionId: string) =>
      ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/run mini" }] });
    const { result, orchestrator } = await drive(
      {},
      async (ctx, seen) => {
        const { sessionId, configOptions } = await open(ctx, dir);
        const before = configOptions!.find((o) => o.id === "orca/model");
        await run(ctx, sessionId);
        await vi.waitFor(() => expect(seen.some((u) => u.sessionUpdate === "config_option_update")).toBe(true));
        const update = seen.find((u) => u.sessionUpdate === "config_option_update") as {
          configOptions: acp.SessionConfigOption[];
        };
        await set(ctx, sessionId, "orca/model", "scripted/deep");
        await set(ctx, sessionId, "orca/scripted/effort", "high");
        await run(ctx, sessionId);
        return { before, after: update.configOptions };
      },
      { configOptions: downstream, promptLog },
    );
    // Nothing declared, nothing run: only the placeholder.
    expect(result.before?.type === "select" && result.before.options).toEqual([
      { value: "orca:default", name: "Agent default" },
    ]);
    const model = result.after.find((o) => o.id === "orca/model");
    expect(model?.type === "select" && model.options.map((o) => ("value" in o ? o.value : o.group))).toEqual([
      "orca:default",
      "scripted/fast",
      "scripted/deep",
    ]);
    // Reserved categories are proxied under the agent's namespace; custom ones are not.
    expect(result.after.find((o) => o.id === "orca/scripted/effort")).toMatchObject({
      category: "thought_level",
      currentValue: "low",
    });
    expect(result.after.some((o) => o.id === "orca/scripted/style")).toBe(false);
    const runs = await orchestrator.listRunSummaries();
    const states = await Promise.all(runs.map((r) => orchestrator.getState(r.id)));
    expect(states.map((s) => s.run.overrides)).toContainEqual({ model: { scripted: "deep" } });
    expect(states.map((s) => s.run.overrides)).toContainEqual(undefined);
    // The engine applies overrides.model right after session/new (#187): the chosen model
    // reaches the scripted agent, and only on the second run - the first selected nothing.
    const sets = (await readJsonl(promptLog, { parse: (raw) => raw as { configId?: string; value?: unknown } }))
      .filter((l) => l.configId !== undefined)
      .map((l) => ({ configId: l.configId, value: l.value }));
    expect(sets).toEqual([{ configId: "model", value: "deep" }]);
  }, 60_000);

  it("advertises the shipped template packs and records the chosen one as overrides.templatePack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-facade-packs-"));
    dirs.push(dir);
    const { result, orchestrator } = await drive(
      {},
      async (ctx) => {
        const { sessionId, configOptions } = await open(ctx, dir);
        await set(ctx, sessionId, "orca/template-pack", "strict");
        await ctx.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "/run mini" }],
        });
        return configOptions!.find((o) => o.id === "orca/template-pack");
      },
      { shippedTemplates: true },
    );
    expect(result?.type === "select" && result.options.map((o) => ("value" in o ? o.value : o.group))).toContain(
      "strict",
    );
    const [summary] = await orchestrator.listRunSummaries();
    expect((await orchestrator.getState(summary!.id)).run.overrides).toEqual({ templatePack: "strict" });
  }, 60_000);
});
