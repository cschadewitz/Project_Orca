/**
 * Bootstrap: config discovery, the workspace-provider and human-input choices
 * the config makes, plugin loading, and the two failures a user meets first -
 * an unparseable config and a workflow that does not validate.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, parseOrcaConfig, silentLogger, toGateOption, type OrcaConfig } from "@orca/core";
import { GitWorktreeProvider, LocalWorkspaceProvider, PausingHumanInput } from "@orca/engine";
import { KeplerTaskWorkspaceProvider } from "@orca/integrations";
import {
  AgentRegistry,
  LocalHost,
  openAcpSession,
  permissionPolicyPath,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";
import {
  bootstrap,
  CONFIG_FILENAMES,
  findConfig,
  loadConfig,
  makeHumanInput,
  makeSessionFactory,
  makeWorkspaceProvider,
} from "../src/bootstrap.js";

const dirs: string[] = [];
async function temp(prefix = "orca-bootstrap-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const WORKFLOW = `
id: tiny
name: Tiny
start: s
nodes:
  s: { type: start }
  done: { type: end }
edges:
  - { from: s, to: done }
`;

describe("findConfig", () => {
  it("walks up from cwd to the nearest config file", async () => {
    const root = await temp();
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "orca.config.yaml"), "version: 1\n", "utf8");
    expect(await findConfig(nested)).toBe(join(root, "orca.config.yaml"));
  });

  it("accepts every supported filename, and gives up at the filesystem root", async () => {
    for (const name of CONFIG_FILENAMES) {
      const dir = await temp();
      await writeFile(join(dir, name), name.endsWith(".json") ? "{}" : "version: 1\n", "utf8");
      expect(await findConfig(dir)).toBe(join(dir, name));
    }
    // A machine could have a config somewhere above tmpdir; all that is
    // guaranteed is that the walk terminates instead of looping at the root.
    const above = await findConfig(await temp());
    expect(above === undefined || above.endsWith(".yaml") || above.endsWith(".yml") || above.endsWith(".json")).toBe(
      true,
    );
  });
});

describe("loadConfig", () => {
  it("reads YAML and JSON, and reports the config directory", async () => {
    const dir = await temp();
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nstoreDir: .state\n", "utf8");
    expect(await loadConfig(dir)).toMatchObject({ config: { storeDir: ".state" }, configDir: resolve(dir) });

    const jsonDir = await temp();
    const jsonFile = join(jsonDir, "orca.config.json");
    await writeFile(jsonFile, JSON.stringify({ version: 1, storeDir: ".json-store" }), "utf8");
    expect(await loadConfig(jsonDir, jsonFile)).toMatchObject({ config: { storeDir: ".json-store" } });
  });

  it("falls back to the defaults when there is no config at all", async () => {
    const dir = await temp();
    const { config } = await loadConfig(dir, undefined);
    // findConfig may find a config above a temp dir on an odd machine; compare
    // against the defaults only when it genuinely found nothing.
    if (!(await findConfig(dir))) expect(config).toEqual(parseOrcaConfig({}));
  });

  it("names the offending file when the config does not parse", async () => {
    const dir = await temp();
    await writeFile(join(dir, "orca.config.yaml"), "version: 2\n", "utf8");
    await expect(loadConfig(dir)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("orca.config.yaml"),
    });
  });
});

describe("makeWorkspaceProvider", () => {
  const agents = () => new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" }));

  it("builds each provider the config can name, resolving relative paths against the config dir", () => {
    const local = makeWorkspaceProvider(
      parseOrcaConfig({ workspace: { provider: "local", root: "sub" } }),
      "/cfg",
      new AgentRegistry(),
    );
    expect(local).toBeInstanceOf(LocalWorkspaceProvider);

    const kepler = makeWorkspaceProvider(
      parseOrcaConfig({ workspace: { provider: "kepler", taskDir: "/tasks/x" } }),
      "/cfg",
      new AgentRegistry(),
    );
    expect(kepler).toBeInstanceOf(KeplerTaskWorkspaceProvider);
    expect(kepler.name).toBe("kepler");

    const worktree = makeWorkspaceProvider(
      parseOrcaConfig({ workspace: { provider: "git-worktree", repo: "repo", worktreeRoot: "wt" } }),
      "/cfg",
      agents(),
    );
    expect(worktree).toBeInstanceOf(GitWorktreeProvider);

    // Absolute paths are kept as they are.
    expect(
      makeWorkspaceProvider(
        parseOrcaConfig({ workspace: { provider: "git-worktree", repo: "/abs/repo", worktreeRoot: "/abs/wt" } }),
        "/cfg",
        agents(),
      ),
    ).toBeInstanceOf(GitWorktreeProvider);
  });

  it("uses KEPLER_TASK_DIR, then the config dir, when the kepler provider names no task dir", () => {
    const previous = process.env.KEPLER_TASK_DIR;
    try {
      process.env.KEPLER_TASK_DIR = "/tasks/from-env";
      expect(
        makeWorkspaceProvider(parseOrcaConfig({ workspace: { provider: "kepler" } }), "/cfg", new AgentRegistry()),
      ).toBeInstanceOf(KeplerTaskWorkspaceProvider);
      delete process.env.KEPLER_TASK_DIR;
      expect(
        makeWorkspaceProvider(parseOrcaConfig({ workspace: { provider: "kepler" } }), "/cfg", new AgentRegistry()),
      ).toBeInstanceOf(KeplerTaskWorkspaceProvider);
    } finally {
      if (previous === undefined) delete process.env.KEPLER_TASK_DIR;
      else process.env.KEPLER_TASK_DIR = previous;
    }
  });
});

describe("makeHumanInput", () => {
  it("maps each mode to its port", async () => {
    const auto = makeHumanInput(parseOrcaConfig({ humanInput: { mode: "auto", option: "hold" } }));
    await expect(
      auto.ask({
        runId: "r",
        stepRunId: "s",
        requestId: "hi",
        kind: "decision",
        question: "?",
        options: ["ship"].map(toGateOption),
        context: {},
      }),
    ).resolves.toBe("hold");
    expect(makeHumanInput(parseOrcaConfig({ humanInput: { mode: "pause" } }))).toBeInstanceOf(PausingHumanInput);
    // The CLI port only reads stdin once something asks it a question.
    expect(typeof makeHumanInput(parseOrcaConfig({ humanInput: { mode: "cli" } })).ask).toBe("function");
  });
});

describe("bootstrap", () => {
  it("wires an app from a config file on disk", async () => {
    const dir = await temp();
    await writeFile(join(dir, "tiny.yaml"), WORKFLOW, "utf8");
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: [tiny.yaml]\ntemplates: []\n", "utf8");
    const app = await bootstrap({ cwd: dir, logger: silentLogger });
    expect(app.configDir).toBe(resolve(dir));
    expect(app.workflows.has("tiny")).toBe(true);
    expect(app.program).toBeDefined();
    expect(await app.plan.listPlans()).toEqual([]);
  });

  it("takes a programmatic config and in-memory stores, skipping discovery entirely", async () => {
    const dir = await temp();
    await writeFile(join(dir, "tiny.yaml"), WORKFLOW, "utf8");
    const config: OrcaConfig = parseOrcaConfig({ version: 1, workflows: [join(dir, "tiny.yaml")], templates: [] });
    const app = await bootstrap({ config, configDir: dir, cwd: dir, ephemeral: true, logger: silentLogger });
    expect(app.config).toBe(config);
    expect(app.workflows.has("tiny")).toBe(true);
    // configDir defaults to cwd when a programmatic config does not name one.
    expect((await bootstrap({ config, cwd: dir, ephemeral: true, logger: silentLogger })).configDir).toBe(dir);
  });

  it("loads plugins by relative path and lets them register executors", async () => {
    const dir = await temp();
    await writeFile(join(dir, "tiny.yaml"), WORKFLOW, "utf8");
    await writeFile(
      join(dir, "plugin.mjs"),
      `export default { name: "test-plugin", register(api) { api.executors.register({ type: "custom:noop", async execute() { return { status: "completed" }; } }); } };\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "orca.config.yaml"),
      'version: 1\nworkflows: [tiny.yaml]\ntemplates: []\nplugins: ["./plugin.mjs"]\n',
      "utf8",
    );
    const app = await bootstrap({ cwd: dir, ephemeral: true, logLevel: "debug", logger: silentLogger });
    expect(app.workflows.has("tiny")).toBe(true);
  });

  it("refuses a module that is not a plugin", async () => {
    const dir = await temp();
    await writeFile(join(dir, "tiny.yaml"), WORKFLOW, "utf8");
    await writeFile(join(dir, "not-a-plugin.mjs"), "export default { name: 'nope' };\n", "utf8");
    await writeFile(
      join(dir, "orca.config.yaml"),
      'version: 1\nworkflows: [tiny.yaml]\ntemplates: []\nplugins: ["./not-a-plugin.mjs"]\n',
      "utf8",
    );
    await expect(bootstrap({ cwd: dir, ephemeral: true, logger: silentLogger })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("no default OrcaPlugin export"),
    });
  });

  /**
   * #271: the sidecar a run's session evaluates has to be the file the daemon's
   * `inputs.answer` appends to - `permissionPolicyPath(app.configDir)` - or an "allow
   * always" the person was told was recorded never decides anything.
   */
  it("binds the permission sidecar the daemon writes to every session it opens", async () => {
    const dir = await temp();
    let opened: OpenSessionOptions | undefined;
    const factory = makeSessionFactory(dir, async (options) => {
      opened = options;
      return undefined as unknown as AgentSession;
    });
    await factory({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({ id: "a", command: "x" }),
      cwd: dir,
    });
    // The workspace sidecar, first and alone: a user-scoped file layers under it later (ADR 0009).
    expect(opened?.permissionFiles).toEqual([permissionPolicyPath(dir)]);
    expect(permissionPolicyPath(dir)).toBe(join(dir, "orca.permissions.json"));

    // And an app over a real config directory gets that factory rather than the bare
    // `openAcpSession` an Orchestrator falls back to.
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    const app = await bootstrap({ cwd: dir, logger: silentLogger });
    expect(app.orchestrator.sessionFactory).not.toBe(openAcpSession);
    // Ephemeral is the one-shot (`orca agent ping`): no durable workspace state, no sidecar.
    const throwaway = await bootstrap({ cwd: dir, ephemeral: true, logger: silentLogger });
    expect(throwaway.orchestrator.sessionFactory).toBe(openAcpSession);
  });

  it("refuses to start when a workflow does not validate, listing every problem", async () => {
    const dir = await temp();
    await writeFile(
      join(dir, "broken.yaml"),
      "id: broken\nname: Broken\nstart: s\nnodes:\n  s: { type: start }\n  gone: { type: subworkflow, workflow: missing }\nedges:\n  - { from: s, to: gone }\n",
      "utf8",
    );
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: [broken.yaml]\ntemplates: []\n", "utf8");
    await expect(bootstrap({ cwd: dir, ephemeral: true, logger: silentLogger })).rejects.toMatchObject({
      code: "WORKFLOW_INVALID",
      details: { problems: expect.arrayContaining([expect.stringContaining("broken")]) },
    });
  });
});
