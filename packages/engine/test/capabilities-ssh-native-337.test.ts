/**
 * Catalog MCP server delivery over a real SSH connection (#337): a throwaway loopback sshd,
 * the real `ssh` client and the default remote shell, with the scripted agent started on the
 * SSH host. The agent records each `session/new` it gets, so the test sees exactly which
 * servers reached it, with which command. Skipped without `/usr/sbin/sshd`, unless
 * ORCA_REQUIRE_SSHD=1 (the Two daemons workflow sets it).
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRegistry, type CapabilityUse } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, silentLogger, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec } from "@orca/testing";
import { loopbackSshd, type LoopbackSshd } from "@orca/testing/two-daemons";

let sshd: LoopbackSshd | undefined;
let dir: string;
beforeAll(async () => {
  sshd = await loopbackSshd({ commands: true });
  dir = await mkdtemp(join(tmpdir(), "orca-ssh-capabilities-"));
}, 60_000);
afterAll(async () => {
  await sshd?.close();
  await rm(dir, { recursive: true, force: true });
});

const workflow = `
id: flow
name: Flow
start: s
nodes:
  s: { type: start }
  a:
    type: agent
    agent: { role: builder }
    prompt: build
    capabilities: { mcpServers: { enable: [tool] } }
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: e }]
`;

async function run(command: string, env: Record<string, string> = { TOOL_MODE: "test" }) {
  const sessionLog = join(dir, `sessions-${Math.random().toString(36).slice(2)}.jsonl`);
  const agent = scriptedAgentSpec({ id: "remote", hostId: "box", roles: ["builder"], sessionLog });
  const config = parseOrcaConfig({
    hosts: [
      { id: "local", type: "local" },
      { id: "box", type: "ssh", host: "127.0.0.1", user: sshd!.user, sshArgs: sshd!.sshArgs.slice(0, -1) },
    ],
    capabilities: { mcpServers: { tool: { command, env }, unused: { command } } },
    agents: [
      {
        ...agent,
        mcpServers: [{ name: "inline", command: "inline-mcp" }],
        capabilities: { mcpServers: { available: ["tool", "unused"] } },
      },
    ],
  });
  const workflows = new WorkflowRegistry();
  workflows.register(parseWorkflow(workflow));
  const asked: CapabilityUse[][] = [];
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    logger: silentLogger,
    agents: AgentRegistry.fromConfig(config),
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    capabilityUse: async ({ uses }) => {
      asked.push(uses);
    },
  });
  const { run: state } = await orchestrator.startAndRun({ workflowId: "flow" });
  const sessions = await readFile(sessionLog, "utf8").then(
    (text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown),
    () => [],
  );
  return { state, sessions, asked, events: await orchestrator.events(state.id) };
}

describe("catalog MCP servers over a real sshd", () => {
  it("gives the agent on the SSH host exactly its resolved servers, checked on that host", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const tool = join(dir, "tool-mcp");
    await writeFile(tool, "#!/bin/sh\nexit 0\n");
    await chmod(tool, 0o755);
    const { state, sessions, asked } = await run(tool);
    expect(state.status).toBe("completed");
    expect(sessions).toEqual([
      {
        cwd: dir,
        mcpServers: [
          { name: "inline", command: "inline-mcp", args: [], env: [] },
          { name: "tool", command: tool, args: [], env: ["TOOL_MODE"] },
        ],
      },
    ]);
    const use = (trustedExecutable: boolean) => [
      expect.objectContaining({ kind: "mcpServer", id: "tool", hostId: "box", trustedExecutable }),
    ];
    // Taken at its word before the probe; then, as the SSH host found it, a file under a
    // world-writable temp directory is not a trusted executable (#337). Asked again after the
    // slot, at session/new and before the prompt.
    expect(asked).toEqual([use(true), use(false), use(false), use(false), use(false)]);
  }, 60_000);

  it("finds an administrator-owned absolute command a trusted executable on the SSH host", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const { state, asked } = await run("/usr/bin/env");
    expect(state.status).toBe("completed");
    expect(asked.at(-1)).toEqual([expect.objectContaining({ id: "tool", trustedExecutable: true })]);
    // Its own canonical spelling only.
    const other = await run("/usr/bin/../bin/env");
    expect(other.asked.at(-1)).toEqual([expect.objectContaining({ id: "tool", trustedExecutable: false })]);
  }, 60_000);

  it("refuses the step when the command is not on the SSH host, before the agent starts", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const { state, sessions, events } = await run(join(dir, "not-installed-mcp"));
    expect(state.status).toBe("failed");
    expect(sessions).toEqual([]);
    expect(JSON.stringify(events)).toMatch(/MCP server 'tool' cannot start on host 'box'/);
  }, 60_000);

  it("hands the agent the absolute executable it found on the SSH host's PATH", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const tool = join(dir, "tool-mcp");
    await writeFile(tool, "#!/bin/sh\nexit 0\n");
    await chmod(tool, 0o755);
    const { state, sessions } = await run("tool-mcp", { PATH: dir });
    expect(state.status).toBe("completed");
    expect(sessions).toEqual([
      {
        cwd: dir,
        mcpServers: [
          { name: "inline", command: "inline-mcp", args: [], env: [] },
          { name: "tool", command: tool, args: [], env: ["PATH"] },
        ],
      },
    ]);
  }, 60_000);
});
