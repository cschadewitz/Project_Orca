/** Scoped capabilities (#335): skill digests, validation, launch preflight, provenance and session open. */
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentRegistry,
  mcpServerDefinitionDigest,
  secretHostBinding,
  type AgentSession,
  type CapabilityUse,
  type CapabilityUseCheck,
  type OpenSessionOptions,
} from "@orca/agents";
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

// The agent's own inline servers reach a session as configured; catalog servers reach one only
// through the run owner's use decision, once their command is found on the agent's host (#337).
const flow = `
id: flow
name: Flow
capabilities: { mcpServers: { disable: [files] } }
start: s
nodes:
  s: { type: start }
  plan: { type: agent, agent: { role: planner }, prompt: plan }
  build:
    type: agent
    agent: { role: planner }
    prompt: build
    capabilities: { mcpServers: { enable: [files] } }
  e: { type: end }
edges: [{ from: s, to: plan }, { from: plan, to: build }, { from: build, to: e }]
`;

const catalog = {
  mcpServers: {
    github: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_secretsecretsecretsecret" } },
    db: { command: "db-mcp" },
  },
  skills: {},
};
const inlineServers = [
  { name: "notes", command: "notes-mcp", env: { NOTES_TOKEN: "notes-credential" } },
  { name: "files", command: "files-mcp" },
  { name: "shell", command: "shell-mcp" },
];

function setup(
  configRaw: object,
  opts: {
    sessionMode?: "per-run" | "per-step";
    workflow?: string | string[];
    stores?: ReturnType<typeof memoryStores>;
    pause?: boolean;
    capabilityUse?: CapabilityUseCheck;
  } = {},
) {
  const config: OrcaConfig = parseOrcaConfig({
    capabilities: catalog,
    agents: [
      {
        id: "claude",
        command: "unused",
        roles: ["planner"],
        sessionMode: opts.sessionMode ?? "per-step",
        mcpServers: inlineServers,
        capabilities: { mcpServers: { available: ["github", "db"] } },
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
    ...(opts.capabilityUse ? { capabilityUse: opts.capabilityUse } : {}),
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

const materialOf = (made: ReturnType<typeof setup>) =>
  ({
    snapshot: { id: "gen", config: made.config },
    agents: made.registry,
    workflows: made.workflows,
    templates: new TemplateRegistry(),
  }) as unknown as GenerationMaterial;

describe("scoped capabilities at session open", () => {
  it("passes each step exactly its resolved servers, in session/new shape", async () => {
    const { orchestrator, opened } = setup({});
    const { run } = await orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("completed");
    // The workflow drops `files`; `build` turns it back on, which its agent permits.
    expect(opened.map((o) => o.mcp)).toEqual([
      ["notes", "shell"],
      ["notes", "shell", "files"],
    ]);
    expect(opened[0]!.envKeys).toEqual([["NOTES_TOKEN"], []]);
  });

  it("keeps a legacy-only agent's servers exactly as before", async () => {
    const { orchestrator, opened } = setup(
      {
        capabilities: undefined,
        agents: [{ id: "claude", command: "x", roles: ["planner"], mcpServers: inlineServers }],
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
    expect(opened.map((o) => o.mcp)).toEqual([["notes", "files", "shell"]]);
  });

  it("does not reuse a per-run session for a step with a different scope", async () => {
    const { orchestrator, opened } = setup({}, { sessionMode: "per-run" });
    const { run } = await orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("completed");
    expect(opened.map((o) => o.mcp)).toEqual([
      ["notes", "shell"],
      ["notes", "shell", "files"],
    ]);
  });

  it("reuses a per-run session when consecutive steps resolve the same", async () => {
    const { orchestrator, opened } = setup(
      {},
      {
        sessionMode: "per-run",
        workflow: flow.replace("    capabilities: { mcpServers: { enable: [files] } }\n", ""),
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
capabilities: { mcpServers: { disable: [files] } }
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
          b: { type: agent, agent: claude, prompt: b, capabilities: { mcpServers: { disable: [shell] } } }
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
    // Fresh inline child admission: the workflow's `disable: [files]` holds.
    expect(first.opened.map((o) => o.mcp)).toEqual([["notes", "shell"]]);

    // A new process over the same store reconstructs the child from the stored definition.
    const second = setup({}, { workflow: [nested, plain], stores });
    const [request] = await second.orchestrator.pendingInputs();
    await second.orchestrator.answer(request!.id, "approve", request!.runId);
    const done = await second.orchestrator.resume(request!.runId);
    expect(done.run.status).toBe("completed");
    expect(second.opened.map((o) => o.mcp)).toEqual([
      // `b` in the nested graph: the workflow scope still applies, and its own narrowing.
      ["notes"],
      // The registered `plain` child: its own (empty) scope, so `files` is back.
      ["notes", "files", "shell"],
    ]);
  });

  it("previews nested steps under qualified ids, and each matches what its child run prepares and records", async () => {
    const stores = memoryStores();
    const first = await withGenerations({}, { workflow: [nested, plain], stores, pause: true });
    const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "nested" });
    const id = await launch.startRun({});
    const root = await first.orchestrator.getState(id);
    const preview = Object.fromEntries(
      (root.run.provenance?.selections ?? []).map((s) => [s.nodeId, s.capabilities?.mcpServers.map((m) => m.id)]),
    );
    expect(preview).toEqual({ "loop::a": ["notes", "shell"], "loop::b": ["notes"] });

    expect((await first.orchestrator.run(id)).run.status).toBe("paused");
    expect(first.opened.map((o) => o.mcp)).toEqual([preview["loop::a"]]);
    const [request] = await first.orchestrator.pendingInputs();
    const child = await first.orchestrator.getState(request!.runId);
    expect(child.run.parentRunId).toBe(id);
    // The child's own launch record agrees with the root's preview of the same step.
    expect(child.run.provenance?.selections.find((s) => s.nodeId === "b")?.capabilities).toEqual(
      root.run.provenance?.selections.find((s) => s.nodeId === "loop::b")?.capabilities,
    );

    const second = await withGenerations({}, { workflow: [nested, plain], stores });
    await second.orchestrator.answer(request!.id, "approve", request!.runId);
    expect((await second.orchestrator.resume(request!.runId)).run.status).toBe("completed");
    expect(second.opened.map((o) => o.mcp)).toEqual([preview["loop::b"], ["notes", "files", "shell"]]);
  });
});

describe("scoped capabilities before agent work", () => {
  it("refuses a step that reaches outside the agent's permitted set, writing nothing", async () => {
    const made = setup(
      { agents: [{ id: "claude", command: "x", roles: ["planner"], mcpServers: inlineServers }] },
      { workflow: flow.replace("enable: [files]", "enable: [github]") },
    );
    await expect(made.orchestrator.startRun({ workflowId: "flow" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(
        /step 'build'.*workflow\.nodes\.build\.capabilities\.mcpServers\.enable\[0\].*not permitted/,
      ),
    });
    expect(await made.orchestrator.listRuns()).toEqual([]);
    expect(made.opened).toEqual([]);
  });

  it("refuses a permitted catalog server where there is no use decision, and names it", async () => {
    const made = setup({}, { workflow: flow.replace("enable: [files]", "enable: [github]") });
    await expect(made.orchestrator.startRun({ workflowId: "flow" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(
        /workflow\.nodes\.build\.capabilities\.mcpServers: selects catalog MCP server 'github'.*no server-verified use check/,
      ),
    });
    expect(await made.orchestrator.listRuns()).toEqual([]);
    expect(made.opened).toEqual([]);
    // The preview still shows what it would be, with the scope that chose it.
    const preview = launchProvenance(materialOf(made), made.workflows.get("flow"), {}, {});
    expect(preview.selections.find((s) => s.nodeId === "build")?.capabilities?.mcpServers).toContainEqual({
      id: "github",
      source: "workflow.nodes.build.capabilities",
    });
  });

  it("refuses a step that selects a skill, which cannot be delivered yet, and names it", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "review.md"), "review carefully");
    const { orchestrator } = setup({
      capabilities: { ...catalog, skills: { review: { path: join(dir, "review.md"), version: "1" } } },
      agents: [{ id: "claude", command: "x", roles: ["planner"], capabilities: { skills: { enable: ["review"] } } }],
    });
    await expect(orchestrator.startRun({ workflowId: "flow" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(/cannot deliver skills/),
    });
  });

  it("decides permission by the agent a role override selects", async () => {
    const workflow = flow.replace("enable: [files]", "enable: [github]");
    const { orchestrator } = setup(
      {
        agents: [
          {
            id: "claude",
            command: "x",
            roles: ["planner"],
            mcpServers: inlineServers,
            capabilities: { mcpServers: { available: ["github"] } },
          },
          { id: "codex", command: "y", mcpServers: inlineServers },
        ],
      },
      { workflow },
    );
    // claude permits github (refused only because this orchestrator has no use decision)...
    await expect(orchestrator.validateStartRun({ workflowId: "flow" })).rejects.toMatchObject({
      message: expect.stringMatching(/no server-verified use check/),
    });
    // ...while a caller who overrides the role to codex gets codex's ceiling, which does not.
    await expect(
      orchestrator.validateStartRun({ workflowId: "flow", overrides: { roles: { planner: "codex" } } }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/agent 'codex' is not permitted/) });
  });

  it("validates a workflow against the registry: errors under the node, undeliverable entries as warnings", async () => {
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

describe("delivering catalog MCP servers (#337)", () => {
  /** A catalog whose servers' commands are real executables in a temp dir (or not, for `missing`). */
  async function deliverable(opts: { missing?: boolean; sessionMode?: "per-run" | "per-step" } = {}) {
    const dir = await tempDir();
    const bin = join(dir, "gh-mcp");
    if (!opts.missing) {
      await writeFile(bin, "#!/bin/sh\nexit 0\n");
      await chmod(bin, 0o755);
    }
    const github = { command: bin, env: { GITHUB_TOKEN: "ghp_secretsecretsecretsecret" } };
    const asked: CapabilityUse[][] = [];
    let allow = true;
    const capabilityUse: CapabilityUseCheck = async ({ uses }) => {
      asked.push(uses);
      if (!allow) throw new Error("not granted");
    };
    const made = setup(
      { capabilities: { ...catalog, mcpServers: { ...catalog.mcpServers, github } } },
      {
        capabilityUse,
        ...(opts.sessionMode ? { sessionMode: opts.sessionMode } : {}),
        // Both steps select github, so a per-run session is shared by them.
        workflow: flow
          .replace(
            "capabilities: { mcpServers: { disable: [files] } }",
            "capabilities: { mcpServers: { enable: [github] } }",
          )
          .replace("enable: [files]", "enable: [github]"),
      },
    );
    return {
      ...made,
      asked,
      github,
      revoke: () => {
        allow = false;
      },
    };
  }

  it("gives a granted, present server to the session, asking about exactly it on the agent's host", async () => {
    const made = await deliverable();
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("completed");
    expect(made.opened.map((o) => o.mcp)).toEqual([
      ["notes", "files", "shell", "github"],
      ["notes", "files", "shell", "github"],
    ]);
    // Secret-bearing env stays in the session's hands; nothing of the value reaches the decision.
    expect(made.asked).toEqual([
      [
        {
          kind: "mcpServer",
          id: "github",
          hostId: "local",
          hostBinding: secretHostBinding({ id: "local", type: "local" }),
          definition: mcpServerDefinitionDigest({ args: [], ...made.github }),
        },
      ],
      expect.any(Array),
    ]);
    expect(JSON.stringify(made.asked)).not.toContain("ghp_");
  });

  it("refuses a step whose server is not granted, before anything starts", async () => {
    const made = await deliverable();
    made.revoke();
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(made.opened).toEqual([]);
  });

  it("refuses a step whose server's command is not on the agent's host, naming the step and server", async () => {
    const made = await deliverable({ missing: true });
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(made.opened).toEqual([]);
    const events = await made.orchestrator.events(run.id);
    expect(JSON.stringify(events)).toMatch(/step 'plan'.*MCP server 'github' cannot start on host 'local'/);
  });

  it("asks again at every step, so a pooled session does not outlive a revoked grant", async () => {
    const made = await deliverable({ sessionMode: "per-run" });
    let steps = 0;
    const factory = made.orchestrator.sessionFactory;
    made.orchestrator.sessionFactory = async (o) => {
      const session = await factory(o);
      const prompt = session.prompt.bind(session);
      session.prompt = async (...args) => {
        // The grant is revoked while the first step runs.
        if (++steps === 1) made.revoke();
        return prompt(...args);
      };
      return session;
    };
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(made.opened).toHaveLength(1);
    expect(made.asked).toHaveLength(2);
    expect(steps).toBe(1);
  });
});

describe("scoped capabilities in launch provenance", () => {
  it("records ids and sources per step, and never a command, argument or environment value", () => {
    const made = setup({ capabilities: { ...catalog, workspace: { mcpServers: { enable: ["github"] } } } });
    const provenance = launchProvenance(materialOf(made), made.workflows.get("flow"), {}, {});
    expect(provenance.selections.map((s) => [s.nodeId, s.capabilities])).toEqual([
      [
        "plan",
        {
          mcpServers: [
            { id: "github", source: "config.capabilities.workspace" },
            { id: "notes", source: "agents.claude.mcpServers" },
            { id: "shell", source: "agents.claude.mcpServers" },
          ],
          skills: [],
        },
      ],
      [
        "build",
        {
          mcpServers: [
            { id: "github", source: "config.capabilities.workspace" },
            { id: "notes", source: "agents.claude.mcpServers" },
            { id: "shell", source: "agents.claude.mcpServers" },
            { id: "files", source: "workflow.nodes.build.capabilities" },
          ],
          skills: [],
        },
      ],
    ]);
    const text = JSON.stringify(provenance);
    for (const leak of ["gh-mcp", "ghp_secret", "GITHUB_TOKEN", "notes-mcp", "notes-credential"])
      expect(text).not.toContain(leak);
  });

  it("treats catalog server credentials as configured secrets to redact", async () => {
    const { configuredGenerationSecrets } = await import("@orca/engine");
    expect(configuredGenerationSecrets(materialOf(setup({})))).toContain("ghp_secretsecretsecretsecret");
  });

  it("keeps the agents' registry catalog on a role-override view", () => {
    const { registry } = setup({});
    expect(registry.withOverrides({ roles: { planner: "claude" } }).capabilities().catalog).toBe(
      registry.capabilities().catalog,
    );
  });
});
