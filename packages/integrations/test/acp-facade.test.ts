/**
 * Proxy mode: an ACP *client* (standing in for Kepler / Zed / T3 Code) drives
 * ORCA as an ACP *agent*, in-process via the SDK's app-to-app connection. ORCA
 * in turn drives the scripted agent through a real subprocess.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { parsePromptTemplate, parseWorkflow, silentLogger, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, ProgramService } from "@orca/engine";
import { OrcaAcpAgent } from "@orca/integrations";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec } from "@orca/testing";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("ORCA as an ACP agent", () => {
  it("turns a prompt into a workflow run and streams plan / artifact / permission updates upstream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-facade-"));
    dirs.push(dir);
    const workflows = new WorkflowRegistry().register(
      parseWorkflow(`
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
`),
    );
    const templates = new TemplateRegistry();
    templates.register(parsePromptTemplate("---\nid: x\n---\nunused"));
    const orchestrator = new Orchestrator({
      stores: memoryStores(),
      agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })).addAgent(scriptedAgentSpec({ playbookJson: { kinds: { spec: [{ data: { status: "ready" }, body: "spec" }] } } })),
      workflows,
      templates,
      workspaceProvider: new LocalWorkspaceProvider(dir),
      logger: silentLogger,
    });
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
        const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        expect(init.agentInfo?.name).toBe("orca");
        const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: dir, mcpServers: [] });
        return ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/run mini" }] });
      });

    expect(result.stopReason).toBe("end_turn");
    // The gate was forwarded as a permission request with the real option labels.
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]!.options.map((o) => o.optionId)).toEqual(["ship", "hold"]);
    expect(permissionRequests[0]!.toolCall.title).toContain("Ship it?");
    // Plan updates mirror the workflow nodes; the final one shows both steps completed with the choice.
    const plans = updates.filter((u): u is Extract<acp.SessionUpdate, { sessionUpdate: "plan" }> => u.sessionUpdate === "plan");
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.at(-1)!.entries.map((e) => `${e.content}:${e.status}`)).toEqual(["write:completed", "gate → ship:completed"]);
    // The recorded artifact surfaced as a completed tool call pointing at the file.
    const artifactCalls = updates.filter((u) => u.sessionUpdate === "tool_call" && u.title.startsWith("artifact spec"));
    expect(artifactCalls).toHaveLength(1);
    expect((artifactCalls[0] as { locations?: { path: string }[] }).locations?.[0]?.path).toBe(join(dir, ".orca", "spec.md"));
    // Agent chatter was relayed as message chunks.
    const text = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => (u as { content: { text?: string } }).content.text ?? "").join("");
    expect(text).toContain("Starting Mini");
    expect(text).toContain("Wrote spec");
    expect(text).toMatch(/completed \(success\)/);
  }, 60_000);
});
