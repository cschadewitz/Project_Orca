/** Scoped capabilities (#335): the one resolver, table-driven over every scope. */
import { describe, expect, it } from "vitest";
import {
  parseOrcaConfig,
  parseWorkflow,
  resolveCapabilities,
  validateWorkflow,
  type CapabilitiesConfig,
  type ResolveCapabilitiesInput,
} from "../src/index.js";

const server = (command: string) => ({ command, args: [], env: {} });
const catalog: CapabilitiesConfig = {
  mcpServers: { github: server("gh-mcp"), docs: server("docs-mcp"), db: server("db-mcp") },
  skills: { review: { path: "skills/review", version: "2" }, style: { path: "skills/style.md" } },
};
const legacy = { name: "inline", command: "inline-mcp", args: ["--x"], env: { A: "1" } };

type Case = {
  name: string;
  input: Partial<ResolveCapabilitiesInput> & { agentScope?: ResolveCapabilitiesInput["agent"]["capabilities"] };
  mcp?: [string, string][];
  skills?: [string, string][];
  errors?: { path: string; message: RegExp }[];
  warnings?: RegExp[];
};

const run = (c: Case) =>
  resolveCapabilities({
    catalog: c.input.catalog ?? catalog,
    agent: {
      id: "claude",
      mcpServers: c.input.agent?.mcpServers ?? [],
      capabilities: c.input.agentScope ?? c.input.agent?.capabilities,
    },
    ...(c.input.workflow ? { workflow: c.input.workflow } : {}),
    ...(c.input.node ? { node: c.input.node } : {}),
    ...(c.input.skillDigest ? { skillDigest: c.input.skillDigest } : {}),
  });

const node = (scope: object) => ({ path: "workflow.nodes.n", source: "workflow.nodes.n.capabilities", scope });
const workflow = (scope: object) => ({ path: "workflow", scope });
const ws = (workspace: object): CapabilitiesConfig => ({ ...catalog, workspace });

const cases: Case[] = [
  { name: "nothing configured gives nothing", input: {}, mcp: [], skills: [] },
  {
    name: "legacy inline servers stay on, unchanged",
    input: { agent: { id: "claude", mcpServers: [legacy] } },
    mcp: [["inline", "agents.claude.mcpServers"]],
  },
  {
    name: "workspace scope is inherited by the agent",
    input: { catalog: ws({ mcpServers: { enable: ["github"] }, skills: { enable: ["review"] } }) },
    mcp: [["github", "config.capabilities.workspace"]],
    skills: [["review", "config.capabilities.workspace"]],
  },
  {
    name: "agent narrows the workspace",
    input: {
      catalog: ws({ mcpServers: { enable: ["github", "docs"] } }),
      agentScope: { mcpServers: { disable: ["docs"] } },
    },
    mcp: [["github", "config.capabilities.workspace"]],
  },
  {
    name: "agent replaces the workspace",
    input: {
      catalog: ws({ mcpServers: { enable: ["github", "docs"] } }),
      agentScope: { mcpServers: { replace: ["db"] } },
    },
    mcp: [["db", "agents.claude.capabilities"]],
  },
  {
    name: "workflow narrows, node narrows further",
    input: {
      agentScope: { mcpServers: { enable: ["github", "docs", "db"] } },
      workflow: workflow({ mcpServers: { disable: ["db"] } }),
      node: node({ mcpServers: { disable: ["docs"] } }),
    },
    mcp: [["github", "agents.claude.capabilities"]],
  },
  {
    name: "node replaces within the permitted set, and records itself as the source",
    input: {
      agentScope: { mcpServers: { enable: ["github", "docs"] } },
      node: node({ mcpServers: { replace: ["docs"] } }),
    },
    mcp: [["docs", "workflow.nodes.n.capabilities"]],
  },
  {
    name: "node may replace with an empty set",
    input: { agent: { id: "claude", mcpServers: [legacy] }, node: node({ mcpServers: { replace: [] } }) },
    mcp: [],
  },
  {
    name: "workflow opts in to what the agent lists as available",
    input: {
      agentScope: { mcpServers: { available: ["db"] }, skills: { available: ["style"] } },
      workflow: workflow({ mcpServers: { enable: ["db"] }, skills: { enable: ["style"] } }),
    },
    mcp: [["db", "workflow.capabilities"]],
    skills: [["style", "workflow.capabilities"]],
  },
  {
    name: "workspace 'available' is permitted too",
    input: { catalog: ws({ mcpServers: { available: ["docs"] } }), node: node({ mcpServers: { enable: ["docs"] } }) },
    mcp: [["docs", "workflow.nodes.n.capabilities"]],
  },
  {
    name: "a node may disable a legacy inline server",
    input: { agent: { id: "claude", mcpServers: [legacy] }, node: node({ mcpServers: { disable: ["inline"] } }) },
    mcp: [],
  },
  {
    name: "a workflow cannot turn on a catalog entry the agent was not given",
    input: { workflow: workflow({ mcpServers: { enable: ["github"] } }) },
    mcp: [],
    errors: [{ path: "workflow.capabilities.mcpServers.enable[0]", message: /not permitted/ }],
  },
  {
    name: "a node cannot replace its way to more than the agent permits",
    input: {
      agentScope: { mcpServers: { enable: ["github"] } },
      node: node({ mcpServers: { replace: ["github", "db"] } }),
    },
    mcp: [["github", "agents.claude.capabilities"]],
    errors: [{ path: "workflow.nodes.n.capabilities.mcpServers.replace[1]", message: /'db'.*not permitted/ }],
  },
  {
    name: "an agent's disable takes the workspace permission away",
    input: {
      catalog: ws({ mcpServers: { enable: ["github"] } }),
      agentScope: { mcpServers: { disable: ["github"] } },
      workflow: workflow({ mcpServers: { enable: ["github"] } }),
    },
    mcp: [],
    errors: [{ path: "workflow.capabilities.mcpServers.enable[0]", message: /not permitted/ }],
  },
  {
    name: "an agent's replace drops the workspace's 'available' entries",
    input: {
      catalog: ws({ mcpServers: { available: ["docs"] } }),
      agentScope: { mcpServers: { replace: ["github"] } },
      node: node({ mcpServers: { enable: ["docs"] } }),
    },
    mcp: [["github", "agents.claude.capabilities"]],
    errors: [{ path: "workflow.nodes.n.capabilities.mcpServers.enable[0]", message: /not permitted/ }],
  },
  {
    name: "unknown references are refused with the field that names them",
    input: {
      catalog: ws({ skills: { enable: ["nope"] } }),
      node: node({ mcpServers: { disable: ["missing"] } }),
    },
    errors: [
      { path: "capabilities.workspace.skills.enable[0]", message: /no skill 'nope' is defined in capabilities.skills/ },
      { path: "workflow.nodes.n.capabilities.mcpServers.disable[0]", message: /no MCP server 'missing'/ },
    ],
  },
  {
    name: "duplicate references in one list",
    input: { agentScope: { mcpServers: { enable: ["github", "github"] } } },
    mcp: [],
    errors: [{ path: "agents.claude.capabilities.mcpServers.enable[1]", message: /twice/ }],
  },
  {
    name: "conflicting enable and disable in one scope",
    input: { agentScope: { skills: { enable: ["review"], disable: ["review"] } } },
    skills: [],
    errors: [{ path: "agents.claude.capabilities.skills.disable", message: /both in 'enable' and 'disable'/ }],
  },
  {
    name: "replace cannot be combined with enable",
    input: {
      agentScope: { mcpServers: { enable: ["github"] } },
      workflow: workflow({ mcpServers: { replace: ["github"], enable: ["github"] } }),
    },
    mcp: [["github", "agents.claude.capabilities"]],
    errors: [{ path: "workflow.capabilities.mcpServers", message: /cannot be combined/ }],
  },
  {
    name: "an inline server named like a catalog entry is ambiguous",
    input: { agent: { id: "claude", mcpServers: [{ ...legacy, name: "github" }] } },
    mcp: [],
    errors: [{ path: "agents.claude.mcpServers[0]", message: /ambiguous/ }],
  },
  {
    name: "two inline servers with one name",
    input: { agent: { id: "claude", mcpServers: [legacy, legacy] } },
    mcp: [["inline", "agents.claude.mcpServers"]],
    errors: [{ path: "agents.claude.mcpServers[1]", message: /two MCP servers/ }],
  },
  {
    name: "disabling something not enabled is a warning, not an error",
    input: { agentScope: { mcpServers: { available: ["db"] } }, node: node({ mcpServers: { disable: ["db"] } }) },
    mcp: [],
    warnings: [/'db' is not enabled at this point/],
  },
];

describe("resolveCapabilities", () => {
  for (const c of cases)
    it(c.name, () => {
      const result = run(c);
      if (c.mcp) expect(result.manifest.mcpServers.map((m) => [m.id, m.source])).toEqual(c.mcp);
      if (c.skills) expect(result.manifest.skills.map((s) => [s.id, s.source])).toEqual(c.skills);
      expect(result.errors).toHaveLength(c.errors?.length ?? 0);
      for (const [i, e] of (c.errors ?? []).entries()) {
        expect(result.errors[i]!.path).toBe(e.path);
        expect(result.errors[i]!.message).toMatch(e.message);
      }
      expect(result.warnings.map((w) => w.message)).toEqual((c.warnings ?? []).map(() => expect.any(String)));
      for (const [i, w] of (c.warnings ?? []).entries()) expect(result.warnings[i]!.message).toMatch(w);
    });

  it("hands legacy and catalog servers over in session/new shape", () => {
    const result = resolveCapabilities({
      catalog: ws({ mcpServers: { enable: ["github"] } }),
      agent: { id: "claude", mcpServers: [legacy] },
    });
    expect(result.manifest.mcpServers.map((m) => m.server)).toEqual([
      { name: "github", command: "gh-mcp", args: [], env: {} },
      { name: "inline", command: "inline-mcp", args: ["--x"], env: { A: "1" } },
    ]);
  });

  it("digests the selected skills only, and refuses a digest that no longer matches its pin", () => {
    const asked: string[] = [];
    const pinned = `sha256:${"a".repeat(64)}`;
    const result = resolveCapabilities({
      catalog: { ...catalog, skills: { ...catalog.skills, style: { path: "s", digest: pinned } } },
      agent: { id: "claude", mcpServers: [], capabilities: { skills: { enable: ["review", "style"] } } },
      skillDigest: (id) => (asked.push(id), { digest: `sha256:${"b".repeat(64)}` }),
    });
    expect(asked).toEqual(["review", "style"]);
    expect(result.manifest.skills[0]).toMatchObject({ id: "review", version: "2", digest: `sha256:${"b".repeat(64)}` });
    expect(result.errors).toEqual([
      { path: "capabilities.skills.style.digest", message: expect.stringMatching(/pinned digest is sha256:a/) },
    ]);
  });

  it("reports a skill that cannot be read under the catalog entry", () => {
    const result = resolveCapabilities({
      catalog,
      agent: { id: "claude", mcpServers: [], capabilities: { skills: { enable: ["review"] } } },
      skillDigest: () => ({ error: "skill path 'skills/review' does not exist" }),
    });
    expect(result.errors).toEqual([
      { path: "capabilities.skills.review", message: expect.stringMatching(/not exist/) },
    ]);
  });
});

describe("capabilities in config and workflows", () => {
  it("parses the catalog, scopes and legacy servers together", () => {
    const config = parseOrcaConfig({
      capabilities: {
        mcpServers: { github: { command: "gh-mcp" } },
        skills: { review: { path: "skills/review" } },
        workspace: { mcpServers: { enable: ["github"] } },
      },
      agents: [
        { id: "claude", command: "x", mcpServers: [legacy], capabilities: { skills: { available: ["review"] } } },
      ],
    });
    expect(config.capabilities?.mcpServers.github).toEqual({ command: "gh-mcp", args: [], env: {} });
    expect(config.agents[0]!.capabilities).toEqual({ skills: { available: ["review"] } });
  });

  it("refuses a config whose own scopes name an unknown entry", () => {
    expect(() =>
      parseOrcaConfig({
        capabilities: { workspace: { mcpServers: { enable: ["github"] } } },
        agents: [{ id: "claude", command: "x", capabilities: { skills: { enable: ["nope"] } } }],
      }),
    ).toThrow(/no MCP server 'github'[\s\S]*no skill 'nope'/);
  });

  it("refuses unknown keys in a selection rather than ignoring them", () => {
    expect(() =>
      parseOrcaConfig({ agents: [{ id: "claude", command: "x", capabilities: { mcpServers: { enabled: [] } } }] }),
    ).toThrow();
    expect(() =>
      parseWorkflow(`
id: w
name: W
capabilities: { mcpServers: { available: [x] } }
start: s
nodes: { s: { type: start }, e: { type: end } }
edges: [{ from: s, to: e }]
`),
    ).toThrow();
  });

  it("validates each agent step through the checker with its own path, workflow scope included", () => {
    const def = parseWorkflow(`
id: w
name: W
capabilities: { mcpServers: { disable: [github] } }
start: s
nodes:
  s: { type: start }
  a: { type: agent, agent: claude, prompt: hi, capabilities: { skills: { enable: [review] } } }
  loop:
    type: loop
    mode: until
    condition: 'true'
    maxIterations: 1
    body:
      graph:
        start: s
        nodes:
          s: { type: start }
          b: { type: agent, agent: claude, prompt: hi }
          e: { type: end }
        edges: [{ from: s, to: b }, { from: b, to: e }]
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: loop }, { from: loop, to: e }]
`);
    const seen: { nodeId: string; nodePath: string; workflow: unknown; node: unknown }[] = [];
    const result = validateWorkflow(def, {
      checkCapabilities: (check) => {
        seen.push({ nodeId: check.nodeId, nodePath: check.nodePath, workflow: check.workflow, node: check.node });
        return {
          errors: [{ path: "workflow(w).capabilities.mcpServers", message: "same for every step" }],
          warnings: [],
        };
      },
    });
    expect(seen).toEqual([
      {
        nodeId: "a",
        nodePath: "workflow(w).nodes.a",
        workflow: { mcpServers: { disable: ["github"] } },
        node: { skills: { enable: ["review"] } },
      },
      {
        nodeId: "b",
        nodePath: "workflow(w).nodes.loop.body.nodes.b",
        workflow: { mcpServers: { disable: ["github"] } },
        node: undefined,
      },
    ]);
    // A workflow-scope problem found at every step is reported once.
    expect(result.errors).toEqual([{ path: "workflow(w).capabilities.mcpServers", message: "same for every step" }]);
  });
});
