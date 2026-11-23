/** Scoped capabilities (#335): skill digests, validation, launch preflight, provenance and session open. */
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  OrcaError,
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
  readSkillFiles,
  readSkillForDelivery,
  SKILL_DELIVERY_MAX_BYTES,
  SKILL_DELIVERY_MAX_FILES,
  skillDeliveryBudget,
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  skillDigest,
  type GenerationMaterial,
} from "@orca/engine";
import { memoryStores } from "@orca/store";
import type * as acp from "@agentclientprotocol/sdk";

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

describe("reading a skill for delivery (#337)", () => {
  it("reads within the byte budget, through the opened file, and refuses past it", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "s"));
    await writeFile(join(dir, "s", "a.md"), "12345");
    await writeFile(join(dir, "s", "b.md"), "67890");
    const read = readSkillFiles({ path: "s" }, dir, { maxBytes: 10 });
    expect(read).toMatchObject({ bytes: 10, entries: 3 });
    expect("files" in read && read.files.map((f) => f.bytes.toString())).toEqual(["12345", "67890"]);
    expect(readSkillFiles({ path: "s" }, dir, { maxBytes: 9 })).toEqual({
      error: expect.stringMatching(/larger than 9/),
      tooLarge: true,
    });
    // Delivery charges each file the block that names it too, before reading it.
    expect(readSkillForDelivery("s", { path: "s" }, dir, undefined, { bytes: 10, entries: 64 })).toMatchObject({
      tooLarge: true,
    });
  });

  it("spends one budget across all of a step's skills, files and names included", async () => {
    const dir = await tempDir();
    for (const name of ["a", "b"]) {
      await mkdir(join(dir, name));
      for (let i = 0; i < 20; i++) await writeFile(join(dir, name, `f${i}.md`), "");
    }
    const budget = skillDeliveryBudget();
    expect(readSkillForDelivery("a", { path: "a" }, dir, undefined, budget)).toHaveProperty("files");
    // 21 entries spent, and 20 empty files' blocks paid for in bytes.
    expect(budget.entries).toBe(SKILL_DELIVERY_MAX_FILES - 21);
    expect(budget.bytes).toBeLessThan(SKILL_DELIVERY_MAX_BYTES - 20 * 100);
    expect(readSkillForDelivery("b", { path: "b" }, dir, undefined, budget)).toHaveProperty("files");
    expect(budget.entries).toBe(SKILL_DELIVERY_MAX_FILES - 42);
    // A third of the same size no longer fits: refused, and nothing more is spent.
    await mkdir(join(dir, "c"));
    for (let i = 0; i < 30; i++) await writeFile(join(dir, "c", `f${i}.md`), "");
    expect(readSkillForDelivery("c", { path: "c" }, dir, undefined, budget)).toMatchObject({ tooLarge: true });
    expect(budget.entries).toBe(SKILL_DELIVERY_MAX_FILES - 42);
  });

  it("stops listing a directory once it holds more entries than the walk may visit", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "huge"));
    await Promise.all(Array.from({ length: 1100 }, (_, i) => writeFile(join(dir, "huge", `f${i}`), "")));
    expect(readSkillFiles({ path: "huge" }, dir)).toEqual({
      error: expect.stringMatching(/more than 1024 files and directories/),
      tooLarge: true,
    });
  });

  it("refuses a link at the top or inside, and anything that is not a regular file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "real.md"), "x");
    await symlink(join(dir, "real.md"), join(dir, "top.md"));
    expect(readSkillFiles({ path: "top.md" }, dir)).toEqual({ error: expect.stringMatching(/symbolic link/) });
    await mkdir(join(dir, "outer"));
    await symlink(dir, join(dir, "outer", "inner"));
    expect(readSkillFiles({ path: "outer" }, dir)).toEqual({ error: expect.stringMatching(/symbolic link/) });
    if (process.platform !== "win32") {
      await mkdir(join(dir, "piped"));
      spawnSync("mkfifo", [join(dir, "piped", "fifo")]);
      if (existsSync(join(dir, "piped", "fifo")))
        expect(readSkillFiles({ path: "piped" }, dir)).toEqual({ error: expect.stringMatching(/neither a file/) });
    }
  });

  it("bounds how many files a skill may bring, empty ones included", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "many"));
    for (let i = 0; i < 64; i++) await writeFile(join(dir, "many", `f${i}.md`), "");
    // 64 empty files and the directory itself: one entry too many for delivery.
    expect(readSkillForDelivery("many", { path: "many" }, dir, undefined)).toEqual({
      error: expect.stringMatching(/more than 64 files and directories/),
      tooLarge: true,
    });
    expect(readSkillFiles({ path: "many" }, dir)).toHaveProperty("files");
  });

  it("delivers only from under directories that only root or the daemon's account can change", async () => {
    if (process.platform === "win32") return;
    const dir = await tempDir();
    await mkdir(join(dir, "shared", "review"), { recursive: true });
    await writeFile(join(dir, "shared", "review", "SKILL.md"), "x");
    expect(readSkillForDelivery("review", { path: "shared/review" }, dir, undefined)).toHaveProperty("files");
    // Group-writable and not sticky: someone else could swap what is below it.
    await chmod(join(dir, "shared"), 0o775);
    expect(readSkillForDelivery("review", { path: "shared/review" }, dir, undefined)).toEqual({
      error: expect.stringMatching(/someone other than root or the daemon's account can change/),
    });
    // A sticky one is fine: others cannot rename or remove what they do not own.
    await chmod(join(dir, "shared"), 0o1777);
    expect(readSkillForDelivery("review", { path: "shared/review" }, dir, undefined)).toHaveProperty("files");
    // Reached through a link above it, it is read at its real place.
    await symlink(join(dir, "shared"), join(dir, "alias"));
    expect(readSkillForDelivery("review", { path: "alias/review" }, dir, undefined)).toHaveProperty("files");
  });

  it("keeps a leading byte-order mark, so the text sent is the bytes the digest names", async () => {
    const dir = await tempDir();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Review\n")]);
    await writeFile(join(dir, "bom.md"), bytes);
    const read = readSkillForDelivery("bom", { path: "bom.md" }, dir, undefined);
    if ("error" in read) throw new Error(read.error);
    expect(read.files[0]!.text.startsWith("\uFEFF")).toBe(true);
    expect(Buffer.from(read.files[0]!.text, "utf8")).toEqual(bytes);
    expect(skillDigest({ path: "bom.md" }, dir)).toEqual({ digest: read.digest });
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
    /** What sessions report for ACP `promptCapabilities.embeddedContext`; true by default. */
    embeddedContext?: boolean;
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
  const opened: { mcp: string[]; envKeys: string[][]; commands: string[] }[] = [];
  const prompts: (string | acp.ContentBlock[])[] = [];
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
        commands: o.agent.mcpServers.map((m) => m.command),
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
        promptCapabilities: { embeddedContext: opts.embeddedContext ?? true },
        prompt: async (input) => {
          prompts.push(input);
          return { stopReason: "end_turn" as const, durationMs: 1 };
        },
        onUpdate: () => () => {},
        cancel: async () => {},
        close: async () => close(),
      };
      return session;
    },
  });
  return { orchestrator, registry, config, workflows, opened, prompts };
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

  it("refuses a step that selects a skill where there is no use decision, and names it", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "review.md"), "review carefully");
    const { orchestrator } = setup({
      capabilities: { ...catalog, skills: { review: { path: join(dir, "review.md"), version: "1" } } },
      agents: [{ id: "claude", command: "x", roles: ["planner"], capabilities: { skills: { enable: ["review"] } } }],
    });
    await expect(orchestrator.startRun({ workflowId: "flow" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringMatching(/selects skill 'review', and this daemon has no server-verified use check/),
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

  it("validates a workflow against the registry: errors under the node, and a resolvable skill is no warning", async () => {
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
    // Whether a run may be given it, and whether its agent accepts it, is decided at session open.
    expect(result.warnings).toEqual([]);
  });
});

describe("a catalog MCP server's secret references against the step's host (#182)", () => {
  it("names a reference to a secret bound to another host where the step selects the server, by id only", () => {
    const config = parseOrcaConfig({
      hosts: [
        { id: "local", type: "local" },
        { id: "box", type: "ssh", host: "box.example" },
      ],
      secrets: {
        here: { host: "local", provider: "env", name: "HERE_TOKEN" },
        there: { host: "box", provider: "env", name: "THERE_TOKEN" },
      },
      capabilities: {
        mcpServers: {
          near: { command: "near-mcp", env: { TOKEN: { secret: "here" } } },
          far: { command: "far-mcp", env: { TOKEN: { secret: "there" }, MODE: "plain" } },
        },
      },
      agents: [{ id: "claude", command: "x", capabilities: { mcpServers: { available: ["near", "far"] } } }],
    });
    const registry = AgentRegistry.fromConfig(config);
    const def = parseWorkflow(`
id: w
name: W
start: s
nodes:
  s: { type: start }
  a: { type: agent, agent: claude, prompt: hi, capabilities: { mcpServers: { enable: [near, far] } } }
  e: { type: end }
edges: [{ from: s, to: a }, { from: a, to: e }]
`);
    const result = validateWorkflow(def, { checkCapabilities: capabilityChecker(registry) });
    expect(result.errors).toEqual([
      {
        path: "workflow(w).nodes.a.capabilities.mcpServers",
        message:
          "MCP server 'far' reads secret 'there' (TOKEN), which is bound to host 'box', but this step's agent runs on 'local'. A secret is only ever read on its own host",
      },
    ]);
  });
});

describe("delivering catalog MCP servers (#337)", () => {
  /** A catalog whose servers' commands are real executables in a temp dir (or not, for `missing`). */
  async function deliverable(opts: { missing?: boolean; bare?: boolean; sessionMode?: "per-run" | "per-step" } = {}) {
    const dir = await tempDir();
    const bin = join(dir, "gh-mcp");
    if (!opts.missing) {
      await writeFile(bin, "#!/bin/sh\nexit 0\n");
      await chmod(bin, 0o755);
    }
    const github = opts.bare
      ? { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_secretsecretsecretsecret", PATH: dir } }
      : { command: bin, env: { GITHUB_TOKEN: "ghp_secretsecretsecretsecret" } };
    const asked: CapabilityUse[][] = [];
    let allow = true;
    /** Called at each decision before it is made, so a test can revoke at that moment. */
    let onAsk: (n: number) => void = () => {};
    const capabilityUse: CapabilityUseCheck = async ({ uses }) => {
      asked.push(uses);
      onAsk(asked.length);
      if (!allow) throw new OrcaError("CONFIG_INVALID", "not granted", { reason: "unauthorized" });
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
      bin,
      revoke: () => {
        allow = false;
      },
      /** Revoke just before decision `n` (counting from 1). */
      revokeAt: (n: number) => {
        onAsk = (at) => {
          if (at === n) allow = false;
        };
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
    const asked = (trustedExecutable: boolean) => [
      {
        kind: "mcpServer",
        id: "github",
        hostId: "local",
        hostBinding: secretHostBinding({ id: "local", type: "local" }),
        definition: mcpServerDefinitionDigest({ args: [], ...made.github }),
        trustedExecutable,
      },
    ];
    // Per step: before probing (an absolute command taken at its word), then with what the
    // probe found (a temp file is not a trusted executable), after the slot wait, at
    // `session/new` (this factory has none), and before the prompt.
    const step = [asked(true), asked(false), asked(false), asked(false)];
    expect(made.asked).toEqual([...step, ...step]);
    expect(JSON.stringify(made.asked)).not.toContain("ghp_");
  });

  it("hands the agent the executable it resolved, not a name for it to search for again", async () => {
    const made = await deliverable({ bare: true });
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("completed");
    expect(made.opened[0]!.commands).toEqual(["notes-mcp", "files-mcp", "shell-mcp", made.bin]);
    // A name found on PATH is not an absolute command: only a "*" grant covers it.
    expect(made.asked[0]![0]).toMatchObject({ id: "github", trustedExecutable: false });
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
    // Four decisions for the first step; the second step's first one refuses it.
    expect(made.asked).toHaveLength(5);
    expect(steps).toBe(1);
  });

  it("asks again after the slot wait: authority revoked while waiting starts nothing", async () => {
    const made = await deliverable();
    // Decisions 1 and 2 come before the slot; 3 is right after it.
    made.revokeAt(3);
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(made.opened).toEqual([]);
    expect(made.asked).toHaveLength(3);
  });

  it("asks again immediately before session/new, and a denial there is not the agent's health", async () => {
    const made = await deliverable();
    const factory = made.orchestrator.sessionFactory;
    let delivered = 0;
    made.orchestrator.sessionFactory = async (o) => {
      // The process is up and initialized: revoked now, the servers are not handed over.
      made.revoke();
      await o.authorizeCapabilityDelivery!();
      delivered++;
      return factory(o);
    };
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(delivered).toBe(0);
    expect(made.opened).toEqual([]);
    expect(made.orchestrator.agents.health.get("claude").state).not.toBe("down");
  });

  it("asks again before a pooled session's next prompt, and retires it when refused", async () => {
    const made = await deliverable({ sessionMode: "per-run" });
    const closed: string[] = [];
    const factory = made.orchestrator.sessionFactory;
    made.orchestrator.sessionFactory = async (o) => {
      const session = await factory(o);
      const close = session.close.bind(session);
      session.close = async () => {
        closed.push(session.id);
        return close();
      };
      return session;
    };
    // The second step takes the pooled session (decisions 5 and 6), then is revoked before its
    // prompt (decision 7): it waited after taking the session, and must not use it.
    made.revokeAt(7);
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(made.opened).toHaveLength(1);
    expect(made.asked).toHaveLength(7);
    expect(closed).toHaveLength(1);
    const events = await made.orchestrator.events(run.id);
    expect(events.filter((e) => e.type === "agent.session.closed")).toHaveLength(1);
  });
});

describe("delivering skills (#337)", () => {
  async function withSkill(
    opts: { embeddedContext?: boolean; allow?: boolean; refuseFrom?: number; sessionMode?: "per-run" } = {},
  ) {
    const dir = await tempDir();
    await mkdir(join(dir, "review"));
    await writeFile(join(dir, "review", "SKILL.md"), "# Review\nreview carefully");
    await writeFile(join(dir, "review", "checklist.txt"), "- tests\n");
    const asked: CapabilityUse[][] = [];
    const made = setup(
      {
        capabilities: { ...catalog, skills: { review: { path: join(dir, "review"), version: "1" } } },
        agents: [
          {
            id: "claude",
            command: "x",
            roles: ["planner"],
            mcpServers: inlineServers,
            capabilities: { skills: { available: ["review"] } },
          },
        ],
      },
      {
        ...(opts.embeddedContext === undefined ? {} : { embeddedContext: opts.embeddedContext }),
        ...(opts.sessionMode ? { sessionMode: opts.sessionMode } : {}),
        workflow: flow.replace(
          "capabilities: { mcpServers: { enable: [files] } }",
          "capabilities: { skills: { enable: [review] } }",
        ),
        capabilityUse: async ({ uses }) => {
          asked.push(uses);
          if (opts.allow === false || (opts.refuseFrom !== undefined && asked.length >= opts.refuseFrom))
            throw new Error("not granted");
        },
      },
    );
    return { ...made, asked, dir };
  }

  it("puts a granted skill's files in each prompt of its step, inline and named by digest", async () => {
    const made = await withSkill();
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("completed");
    const digest = skillDigest({ path: join(made.dir, "review") }, undefined);
    if (!("digest" in digest)) throw new Error(digest.error);
    // `plan` selects no skill; `build` does.
    expect(typeof made.prompts[0]).toBe("string");
    const build = made.prompts[1] as acp.ContentBlock[];
    expect(build.slice(0, 2)).toEqual([
      {
        type: "resource",
        resource: {
          uri: `orca-skill://review/SKILL.md?digest=${digest.digest}`,
          mimeType: "text/markdown",
          text: "# Review\nreview carefully",
        },
      },
      {
        type: "resource",
        resource: {
          uri: `orca-skill://review/checklist.txt?digest=${digest.digest}`,
          mimeType: "text/plain",
          text: "- tests\n",
        },
      },
    ]);
    expect(build[2]).toMatchObject({ type: "text" });
    // Before and after the (empty) probe, after the slot wait, and before the prompt.
    const use = [{ kind: "skill", id: "review", digest: digest.digest }];
    expect(made.asked).toEqual([use, use, use, use]);
  });

  it("asks again before the prompt: a skill revoked while its step waits is not sent", async () => {
    // Decisions 1-3 open the session; the 4th is right before the prompt.
    const made = await withSkill({ refuseFrom: 4 });
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(made.asked).toHaveLength(4);
    // Only `plan`'s prompt was sent; `build` never sent its skill.
    expect(made.prompts).toHaveLength(1);
    expect(JSON.stringify(made.prompts)).not.toContain("review carefully");
  });

  it("refuses the step when its skill is not granted, before any session opens", async () => {
    const made = await withSkill({ allow: false });
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(made.opened).toHaveLength(1);
    expect(made.prompts).toHaveLength(1);
  });

  it("refuses the step when the agent does not accept embedded context, and never pastes the skill in", async () => {
    const made = await withSkill({ embeddedContext: false });
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    expect(JSON.stringify(await made.orchestrator.events(run.id))).toMatch(
      /agent 'claude' does not accept embedded context.*skill 'review'/,
    );
    expect(JSON.stringify(made.prompts)).not.toContain("review carefully");
  });

  it("asks ACP startup to refuse such an agent, and retires a pooled session that was not", async () => {
    const made = await withSkill({ embeddedContext: false, sessionMode: "per-run" });
    const required: boolean[] = [];
    const closed: string[] = [];
    const factory = made.orchestrator.sessionFactory;
    made.orchestrator.sessionFactory = async (o) => {
      required.push(o.requireEmbeddedContext !== undefined);
      // This factory ignores the requirement, as a non-ACP integration might.
      const session = await factory(o);
      const close = session.close.bind(session);
      session.close = async () => {
        closed.push(session.id);
        return close();
      };
      return session;
    };
    const { run } = await made.orchestrator.startAndRun({ workflowId: "flow" });
    expect(run.status).toBe("failed");
    // `plan` selects no skill; `build` does, so its open carries the requirement.
    expect(required).toEqual([false, true]);
    // Both pooled sessions were closed: plan's when build needed other capabilities, and
    // build's own when it could not take the skill, rather than kept in the pool.
    expect(closed).toHaveLength(2);
    // Closed as the step is refused, never kept pooled for another step.
    const events = (await made.orchestrator.events(run.id)).map((e) => e.type);
    expect(events.slice(events.lastIndexOf("agent.session.opened"))).toEqual([
      "agent.session.opened",
      "agent.session.closed",
      "step.failed",
      "run.failed",
    ]);
    expect(JSON.stringify(made.prompts)).not.toContain("review carefully");
  });

  it("refuses a skill that is not UTF-8 text rather than sending part of it", async () => {
    const made = await withSkill();
    await writeFile(join(made.dir, "review", "logo.bin"), Buffer.from([0xff, 0xfe, 0x00]));
    await expect(made.orchestrator.startAndRun({ workflowId: "flow" })).resolves.toMatchObject({
      run: { status: "failed" },
    });
    expect(JSON.stringify(made.prompts)).not.toContain("review carefully");
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
