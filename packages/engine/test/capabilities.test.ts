/** Scoped capabilities (#335): skill digests, validation, launch preflight, provenance and session open. */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRegistry, type AgentSession, type OpenSessionOptions } from "@orca/agents";
import {
  parseOrcaConfig,
  parseWorkflow,
  silentLogger,
  TemplateRegistry,
  validateWorkflow,
  WorkflowRegistry,
  type OrcaConfig,
} from "@orca/core";
import {
  capabilityChecker,
  ConfigurationGenerations,
  launchProvenance,
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  skillDigest,
  type GenerationMaterial,
} from "@orca/engine";
import { memoryStores } from "@orca/store";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-capabilities-"));
  dirs.push(dir);
  return dir;
};

describe("skillDigest", () => {
  it("hashes a directory by relative path, size and content, independent of where it lives", async () => {
    const a = await tempDir();
    const b = await tempDir();
    for (const root of [a, b]) {
      await mkdir(join(root, "skill", "refs"), { recursive: true });
      await writeFile(join(root, "skill", "SKILL.md"), "# Review\n");
      await writeFile(join(root, "skill", "refs", "checklist.md"), "- one\n");
    }
    const first = skillDigest({ path: "skill" }, a);
    expect(first).toEqual({ digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(skillDigest({ path: join(b, "skill") }, undefined)).toEqual(first);
    await writeFile(join(b, "skill", "refs", "checklist.md"), "- two\n");
    expect(skillDigest({ path: "skill" }, b)).not.toEqual(first);
  });

  it("hashes a single-file skill, and refuses links, missing paths and unanchored relative paths", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "style.md"), "be terse");
    expect(skillDigest({ path: "style.md" }, dir)).toHaveProperty("digest");
    await mkdir(join(dir, "linked"));
    await symlink(join(dir, "style.md"), join(dir, "linked", "SKILL.md"));
    expect(skillDigest({ path: "linked" }, dir)).toEqual({ error: expect.stringMatching(/symbolic link/) });
    expect(skillDigest({ path: "missing" }, dir)).toEqual({ error: "skill path 'missing' does not exist" });
    expect(skillDigest({ path: "style.md" }, undefined)).toEqual({ error: expect.stringMatching(/relative/) });
  });
});

const flow = `
id: flow
name: Flow
capabilities: { mcpServers: { disable: [docs] } }
start: s
nodes:
  s: { type: start }
  plan: { type: agent, agent: { role: planner }, prompt: plan }
  build:
    type: agent
    agent: { role: planner }
    prompt: build
    capabilities: { mcpServers: { enable: [db] } }
  e: { type: end }
edges: [{ from: s, to: plan }, { from: plan, to: build }, { from: build, to: e }]
`;

function setup(
  configRaw: object,
  opts: {
    sessionMode?: "per-run" | "per-step";
    workflow?: string | string[];
    stores?: ReturnType<typeof memoryStores>;
    pause?: boolean;
  } = {},
) {
  const config: OrcaConfig = parseOrcaConfig({
    capabilities: {
      mcpServers: {
        github: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_secretsecretsecretsecret" } },
        docs: { command: "docs-mcp" },
        db: { command: "db-mcp" },
      },
      skills: {},
      workspace: { mcpServers: { enable: ["github", "docs"] } },
    },
    agents: [
      {
        id: "claude",
        command: "unused",
        roles: ["planner"],
        sessionMode: opts.sessionMode ?? "per-step",
        mcpServers: [{ name: "inline", command: "inline-mcp" }],
        capabilities: { mcpServers: { available: ["db"] } },
      },
    ],
    ...configRaw,
  });
  const registry = AgentRegistry.fromConfig(config);
  const workflows = new WorkflowRegistry();
  for (const w of [opts.workflow ?? flow].flat()) workflows.register(parseWorkflow(w));
  const opened: { mcp: string[]; envKeys: string[][] }[] = [];
  let n = 0;
  const orchestrator = new Orchestrator({
    stores: opts.stores ?? memoryStores(),
    ...(opts.pause ? { humanInput: new PausingHumanInput() } : {}),
    logger: silentLogger,
    agents: registry,
    workflows,
    templates: new TemplateRegistry(),
    workspaceProvider: new LocalWorkspaceProvider(process.cwd()),
    sessionFactory: async (o: OpenSessionOptions) => {
      n++;
      opened.push({
        mcp: o.agent.mcpServers.map((m) => m.name),
        envKeys: o.agent.mcpServers.map((m) => Object.keys(m.env)),
      });
      let close!: () => void;
      const closed = new Promise<void>((r) => (close = r));
      const session: AgentSession = {
        id: `sess_${n}`,
        agentId: o.agent.id,
        hostId: o.host.id,
        cwd: o.cwd,
        acpSessionId: "acp",
        closed,
        terminated: closed,
        configOptions: [],
        setConfigOption: async () => [],
        prompt: async () => ({ stopReason: "end_turn" as const, durationMs: 1 }),
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => close(),
      };
      return session;
    },
  });
  return { orchestrator, registry, config, workflows, opened };
}

/** `setup` with configuration generations wired the way bootstrap wires them, so runs record provenance. */
async function withGenerations(
  configRaw: object,
  opts: Parameters<typeof setup>[1] & { stores: ReturnType<typeof memoryStores> },
) {
  const made = setup(configRaw, opts);
  const generations = new ConfigurationGenerations({
    store: opts.stores.execution,
    workflows: opts.stores.workflows,
    loadAssets: async () => ({ workflows: made.workflows.list(), templates: [] }),
    admission: {
      validateStartRun: (options, generation) => made.orchestrator.validateStartRun(options, generation),
      startRun: (options, generation) => made.orchestrator.startRun(options, generation),
    },
  });
  await generations.initialize(made.config, "rev", { workflows: made.workflows.list(), templates: [] });
  made.orchestrator.generations = generations;
  return { ...made, generations };
}

describe("scoped capabilities at session open", () => {
  it("passes each step exactly its resolved MCP servers, in session/new shape", async () => {
    const { orchestrator, opened } = setup({});
    const { run } = await orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("completed");
    // Workspace github+docs, legacy inline; the workflow drops docs; `build` opts in to db.
    expect(opened.map((o) => o.mcp)).toEqual([
      ["github", "inline"],
      ["github", "inline", "db"],
    ]);
    expect(opened[0]!.envKeys).toEqual([["GITHUB_TOKEN"], []]);
  });

  it("keeps a legacy-only agent's servers exactly as before", async () => {
    const { orchestrator, opened } = setup(
      {
        capabilities: undefined,
        agents: [{ id: "claude", command: "x", roles: ["planner"], mcpServers: [{ name: "inline", command: "i" }] }],
      },
      {
        workflow: `
id: flow
name: Flow
start: s
nodes: { s: { type: start }, a: { type: agent, agent: claude, prompt: hi }, e: { type: end } }
edges: [{ from: s, to: a }, { from: a, to: e }]
`,
      },
    );
    await orchestrator.startAndRun({ workflowId: "flow" });
    expect(opened.map((o) => o.mcp)).toEqual([["inline"]]);
  });

  it("does not reuse a per-run session for a step with a different scope", async () => {
    const { orchestrator, opened } = setup({}, { sessionMode: "per-run" });
    const { run } = await orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("completed");
    expect(opened).toHaveLength(2);
    expect(opened[1]!.mcp).toContain("db");
  });

  it("reuses a per-run session when consecutive steps resolve the same", async () => {
    const { orchestrator, opened } = setup(
      {},
      {
        sessionMode: "per-run",
        workflow: flow.replace("    capabilities: { mcpServers: { enable: [db] } }\n", ""),
      },
    );
    await orchestrator.startAndRun({ workflowId: "flow" });
    expect(opened).toHaveLength(1);
  });
});

// A nested graph is part of its workflow's file; a registered child workflow is not.
const nested = `
id: nested
name: Nested
capabilities: { mcpServers: { disable: [docs] } }
start: s
nodes:
  s: { type: start }
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
          a: { type: agent, agent: claude, prompt: a }
          g: { type: gate, question: go on? }
          b: { type: agent, agent: claude, prompt: b, capabilities: { mcpServers: { enable: [db] } } }
          e: { type: end }
        edges: [{ from: s, to: a }, { from: a, to: g }, { from: g, to: b }, { from: b, to: e }]
  sub: { type: subworkflow, workflow: plain }
  e: { type: end }
edges: [{ from: s, to: loop }, { from: loop, to: sub }, { from: sub, to: e }]
`;
const plain = `
id: plain
name: Plain
start: s
nodes: { s: { type: start }, c: { type: agent, agent: claude, prompt: c }, e: { type: end } }
edges: [{ from: s, to: c }, { from: c, to: e }]
`;

describe("scoped capabilities in child runs", () => {
  it("runs a nested graph under its workflow's scope, fresh and after resume, and a registered child under its own", async () => {
    const stores = memoryStores();
    const first = setup({}, { workflow: [nested, plain], stores, pause: true });
    const parked = await first.orchestrator.startAndRun({ workflowId: "nested" });
    expect(parked.run.status).toBe("paused");
    // Fresh inline child admission: the workflow's `disable: [docs]` holds.
    expect(first.opened.map((o) => o.mcp)).toEqual([["github", "inline"]]);

    // A new process over the same store reconstructs the child from the stored definition.
    const second = setup({}, { workflow: [nested, plain], stores });
    const [request] = await second.orchestrator.pendingInputs();
    await second.orchestrator.answer(request!.id, "approve", request!.runId);
    const done = await second.orchestrator.resume(request!.runId);
    expect(done.run.status).toBe("completed");
    expect(second.opened.map((o) => o.mcp)).toEqual([
      // `b` in the nested graph: the workflow scope still applies, plus the node's opt-in.
      ["github", "inline", "db"],
      // The registered `plain` child: its own (empty) scope, so docs is back.
      ["github", "docs", "inline"],
    ]);
  });
});

describe("scoped capabilities in child runs with recorded provenance", () => {
  it("admits a nested child under the enclosing scope, records it, and resumes it in another process", async () => {
    const stores = memoryStores();
    const first = await withGenerations({}, { workflow: [nested, plain], stores, pause: true });
    const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "nested" });
    const id = await launch.startRun({});
    expect((await first.orchestrator.run(id)).run.status).toBe("paused");
    expect(first.opened.map((o) => o.mcp)).toEqual([["github", "inline"]]);
    const [request] = await first.orchestrator.pendingInputs();
    const child = await first.orchestrator.getState(request!.runId);
    expect(child.run.parentRunId).toBe(id);
    // The child's own launch record carries the enclosing workflow's scope.
    expect(child.run.provenance?.selections.find((s) => s.nodeId === "b")?.capabilities?.mcpServers).toEqual([
      { id: "github", source: "config.capabilities.workspace" },
      { id: "inline", source: "agents.claude.mcpServers" },
      { id: "db", source: "workflow.nodes.b.capabilities" },
    ]);

    const second = await withGenerations({}, { workflow: [nested, plain], stores });
    await second.orchestrator.answer(request!.id, "approve", request!.runId);
    expect((await second.orchestrator.resume(request!.runId)).run.status).toBe("completed");
    expect(second.opened.map((o) => o.mcp)).toEqual([
      ["github", "inline", "db"],
      ["github", "docs", "inline"],
    ]);
  });
});

describe("scoped capabilities before agent work", () => {
  it("refuses a launch whose step reaches outside the agent's permitted set, writing nothing", async () => {
    const escalate = setup({ agents: [{ id: "claude", command: "x", roles: ["planner"] }] }, { workflow: flow });
    await expect(escalate.orchestrator.startRun({ workflowId: "flow" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(
        /step 'build'.*workflow\.nodes\.build\.capabilities\.mcpServers\.enable\[0\].*not permitted/,
      ),
    });
    expect(await escalate.orchestrator.listRuns()).toEqual([]);
    expect(escalate.opened).toEqual([]);
  });

  it("refuses a step that selects a skill, which cannot be delivered yet, and names it", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "review.md"), "review carefully");
    const { orchestrator } = setup(
      {
        capabilities: {
          mcpServers: { db: { command: "db-mcp" } },
          skills: { review: { path: join(dir, "review.md"), version: "1" } },
        },
        agents: [
          {
            id: "claude",
            command: "x",
            roles: ["planner"],
            capabilities: { skills: { enable: ["review"] }, mcpServers: { available: ["db"] } },
          },
        ],
      },
      { workflow: flow.replace("capabilities: { mcpServers: { disable: [docs] } }", "") },
    );
    await expect(orchestrator.startRun({ workflowId: "flow" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(/cannot deliver skills/),
    });
  });

  it("checks role overrides: the overriding agent's permissions decide", async () => {
    const { orchestrator } = setup({
      agents: [
        {
          id: "claude",
          command: "x",
          roles: ["planner"],
          capabilities: { mcpServers: { available: ["db"] } },
        },
        { id: "codex", command: "y" },
      ],
    });
    await expect(orchestrator.validateStartRun({ workflowId: "flow" })).resolves.toBeDefined();
    await expect(
      orchestrator.validateStartRun({ workflowId: "flow", overrides: { roles: { planner: "codex" } } }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("validates a workflow against the registry: errors under the node, undeliverable skills as warnings", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "review.md"), "review carefully");
    const config = parseOrcaConfig({
      capabilities: { skills: { review: { path: "review.md" } } },
      agents: [{ id: "claude", command: "x", capabilities: { skills: { available: ["review"] } } }],
    });
    const registry = AgentRegistry.fromConfig(config, { configDir: dir });
    const def = parseWorkflow(`
id: w
name: W
start: s
nodes:
  s: { type: start }
  a: { type: agent, agent: claude, prompt: hi, capabilities: { skills: { enable: [review] }, mcpServers: { enable: [ghost] } } }
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: e }]
`);
    const result = validateWorkflow(def, { checkCapabilities: capabilityChecker(registry) });
    expect(result.errors).toEqual([
      {
        path: "workflow(w).nodes.a.capabilities.mcpServers.enable[0]",
        message: expect.stringMatching(/no MCP server 'ghost'/),
      },
    ]);
    expect(result.warnings).toEqual([
      { path: "workflow(w).nodes.a.capabilities.skills", message: expect.stringMatching(/cannot deliver skills/) },
    ]);
  });
});

describe("scoped capabilities in launch provenance", () => {
  it("records ids and sources per step, and never a command, argument or environment value", () => {
    const { registry, config, workflows } = setup({});
    const material = {
      snapshot: { id: "gen", config },
      agents: registry,
      workflows,
      templates: new TemplateRegistry(),
    } as unknown as GenerationMaterial;
    const provenance = launchProvenance(material, workflows.get("flow"), {}, {});
    expect(provenance.selections.map((s) => [s.nodeId, s.capabilities])).toEqual([
      [
        "plan",
        {
          mcpServers: [
            { id: "github", source: "config.capabilities.workspace" },
            { id: "inline", source: "agents.claude.mcpServers" },
          ],
          skills: [],
        },
      ],
      [
        "build",
        {
          mcpServers: [
            { id: "github", source: "config.capabilities.workspace" },
            { id: "inline", source: "agents.claude.mcpServers" },
            { id: "db", source: "workflow.nodes.build.capabilities" },
          ],
          skills: [],
        },
      ],
    ]);
    const text = JSON.stringify(provenance);
    for (const leak of ["gh-mcp", "ghp_secret", "GITHUB_TOKEN", "inline-mcp"]) expect(text).not.toContain(leak);
  });

  it("treats catalog server credentials as configured secrets to redact", async () => {
    const { configuredGenerationSecrets } = await import("@orca/engine");
    const { registry, config, workflows } = setup({});
    const material = { snapshot: { id: "gen", config }, agents: registry, workflows } as unknown as GenerationMaterial;
    expect(configuredGenerationSecrets(material)).toContain("ghp_secretsecretsecretsecret");
  });

  it("keeps the agents' registry catalog on a role-override view", () => {
    const { registry } = setup({});
    expect(registry.withOverrides({ roles: { planner: "claude" } }).capabilities().catalog).toBe(
      registry.capabilities().catalog,
    );
  });
});
