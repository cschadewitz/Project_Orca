/** Reserved integration regressions: exercise the production bootstrap composition. */
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseOrcaConfig, RequestSchema, silentLogger } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const tiny = `id: tiny
name: Tiny
start: s
nodes:
  s: { type: start }
  done: { type: end }
edges:
  - { from: s, to: done }
`;
async function fixture(plugin: string, workflow = tiny) {
  const dir = await mkdtemp(join(tmpdir(), "orca-generation-bootstrap-"));
  dirs.push(dir);
  await writeFile(join(dir, "flow.yaml"), workflow);
  await writeFile(join(dir, "plugin.mjs"), `export default { name: "test", register(api) { ${plugin} } };`);
  const config = parseOrcaConfig({ workflows: ["flow.yaml"], templates: [], plugins: ["./plugin.mjs"] });
  return { config, configDir: dir, logger: silentLogger };
}
// Same registrations, different entry bytes: the module cache would even keep running the old
// code in this process, so only the recorded digest can tell the runtimes apart.
const changePlugin = (dir: string) => appendFile(join(dir, "plugin.mjs"), "\n// changed\n");
it("retains captured providers within their bootstrap and refuses unrecorded callback state on restart", async () => {
  const opts = await fixture(`api.setWorkspaceProvider({ name: "sandbox", async provision() {
    return { cwd: "/tmp/plugin-sandbox", hostId: "local", provider: "sandbox" };
  } });`);
  const first = await bootstrap(opts);
  const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" });
  const id = await launch.startRun({});
  expect((await first.orchestrator.getState(id)).run.workspace).toMatchObject({
    cwd: "/tmp/plugin-sandbox",
    provider: "sandbox",
  });
  const second = await bootstrap(opts);
  await expect(second.orchestrator.startRun({ workflowId: "tiny" }, first.generations.current)).rejects.toMatchObject({
    code: "RUN_STATE",
  });
  const again = await launch.startRun({});
  expect((await first.orchestrator.getState(again)).run.workspace).toMatchObject({
    cwd: "/tmp/plugin-sandbox",
    provider: "sandbox",
  });
  await changePlugin(opts.configDir);
  const changed = await bootstrap(opts);
  await expect(changed.orchestrator.startRun({ workflowId: "tiny" }, first.generations.current)).rejects.toMatchObject({
    code: "RUN_STATE",
  });
});
it("resumes a parked run across bootstrap with an unchanged plugin and fails closed once it changes", async () => {
  const opts = await fixture(
    "",
    tiny
      .replace("  done:", "  gate: { type: gate, question: Go?, options: [go] }\n  done:")
      .replace("  - { from: s, to: done }", "  - { from: s, to: gate }\n  - { from: gate, to: done }"),
  );
  const config = parseOrcaConfig({ ...opts.config, humanInput: { mode: "pause" } });
  const first = await bootstrap({ ...opts, config });
  const id = await (await first.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" })).startRun({});
  expect((await first.orchestrator.run(id)).run.status).toBe("paused");
  const input = (await first.orchestrator.pendingInputs(id))[0]!;
  const second = await bootstrap({ ...opts, config });
  await second.orchestrator.answer(input.id, "go", id);
  expect((await second.orchestrator.resume(id)).run.status).toBe("completed");

  const parked = await (
    await second.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" })
  ).startRun({});
  expect((await second.orchestrator.run(parked)).run.status).toBe("paused");
  await changePlugin(opts.configDir);
  await expect((await bootstrap({ ...opts, config })).orchestrator.resume(parked)).rejects.toMatchObject({
    code: "RUN_STATE",
  });
});
it("captures plugin agents, hosts and roles without sharing mutable registrations", async () => {
  const agent = parseOrcaConfig({
    agents: [{ id: "plugin-agent", command: "unused", hostId: "plugin-host", env: { TOKEN: "plugin-secret" } }],
  }).agents[0]!;
  const opts = await fixture(
    `
    const host = Object.create(api.agents.host("local"));
    Object.defineProperty(host, "id", { value: "plugin-host" });
    api.agents.addHost(host);
    api.agents.addAgent(${JSON.stringify(agent)});
    api.agents.mapRole("plugin-role", "plugin-agent");
  `,
    tiny
      .replace("  done:", "  agent: { type: agent, agent: { role: plugin-role }, prompt: work }\n  done:")
      .replace("  - { from: s, to: done }", "  - { from: s, to: agent }\n  - { from: agent, to: done }"),
  );
  const first = await bootstrap(opts);
  const generation = first.generations.current;
  expect(generation.agents.resolve({ role: "plugin-role" })).toMatchObject({
    agent: { id: "plugin-agent" },
    host: { id: "plugin-host" },
  });
  first.orchestrator.agents.mapRole("plugin-role", "missing");
  expect(
    (await first.generations.restore(generation.snapshot.id)).agents.resolve({ role: "plugin-role" }).agent.id,
  ).toBe("plugin-agent");
  const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" });
  const id = await launch.startRun({});
  expect((await first.orchestrator.getState(id)).run.provenance?.selections[0]?.agent).toEqual({
    value: "plugin-agent",
    source: "plugin.roles",
  });
  const second = await bootstrap(opts);
  second.orchestrator.agents.mapRole("plugin-role", "missing");
  await expect(second.generations.restore(generation.snapshot.id)).rejects.toMatchObject({ code: "RUN_STATE" });
  await changePlugin(opts.configDir);
  const changed = await bootstrap(opts);
  await expect(changed.generations.restore(generation.snapshot.id)).rejects.toMatchObject({ code: "RUN_STATE" });
});
it.each(["configured", "explicit", "replaced"] as const)(
  "restores admitted gate policy while retaining %s callback behavior",
  async (mode) => {
    const opts = await fixture(
      "",
      `id: tiny
name: Tiny
start: s
nodes:
  s: { type: start }
  gate1: { type: gate, question: First?, options: [go] }
  gate2: { type: gate, question: Second?, options: [go] }
  done: { type: end }
edges:
  - { from: s, to: gate1 }
  - { from: gate1, to: gate2 }
  - { from: gate2, to: done }
`,
    );
    const config = parseOrcaConfig({ ...opts.config, plugins: [], humanInput: { mode: "pause" } });
    const first = await bootstrap({ ...opts, config });
    const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" });
    const id = await launch.startRun({});
    expect((await first.orchestrator.run(id)).run.status).toBe("paused");
    const input = (await first.orchestrator.pendingInputs(id))[0]!;
    const { autoHumanInput } = await import("@orca/engine");
    const second = await bootstrap({
      ...opts,
      config: parseOrcaConfig({ ...config, humanInput: { mode: "auto" } }),
      ...(mode === "explicit" ? { humanInput: autoHumanInput() } : {}),
    });
    if (mode === "replaced") second.orchestrator.humanInput = autoHumanInput();
    await second.orchestrator.answer(input.id, "go", id);
    expect((await second.orchestrator.resume(id)).run.status).toBe(mode === "configured" ? "paused" : "completed");
    if (mode === "configured")
      expect(await second.orchestrator.pendingInputs(id)).toMatchObject([{ question: "Second?" }]);
  },
);

it("refuses a restored provider closed over changed registration config before provisioning", async () => {
  const opts = await fixture(`const cwd=api.agents.resolve("worker").agent.env.PLUGIN_ROOT;
    api.setWorkspaceProvider({ name: "sandbox", async provision(){return {hostId:"local",cwd,provider:"sandbox"}} });`);
  const config = (root: string) =>
    parseOrcaConfig({
      ...opts.config,
      agents: [{ id: "worker", command: "unused", env: { PLUGIN_ROOT: root } }],
      program: { workflow: "tiny", itemWorkflow: "tiny" },
    });
  const first = await bootstrap({ ...opts, config: config("old-sandbox") });
  const launch = await first.generations.captureLaunch({ purpose: "request" });
  const second = await bootstrap({ ...opts, config: config("new-sandbox") });
  await expect(
    second.generations.restoreLaunch({
      requestId: "original",
      generationId: launch.generationId,
      workflow: launch.workflow,
    }),
  ).rejects.toMatchObject({ code: "RUN_STATE" });
  expect(await second.orchestrator.stores.events.listRuns()).toEqual([]);
  expect(JSON.stringify(second.generations.status(config("new-sandbox"), ""))).not.toContain("old-sandbox");
});
it.each(["", 'api.agents.mapRole("worker-role", "worker");'])(
  "restores unchanged no-op/declarative plugins despite unrelated current agent config changes: %s",
  async (plugin) => {
    const opts = await fixture(plugin);
    const config = (model: string) =>
      parseOrcaConfig({
        ...opts.config,
        agents: [{ id: "worker", command: "unused", defaultModel: model }],
        program: { workflow: "tiny" },
      });
    const first = await bootstrap({ ...opts, config: config("old") });
    const launch = await first.generations.captureLaunch({ purpose: "request" });
    const second = await bootstrap({ ...opts, config: config("new") });
    const restored = await second.generations.restoreLaunch({
      requestId: "original",
      generationId: launch.generationId,
      workflow: launch.workflow,
    });
    await second.orchestrator.stores.requests.put(
      RequestSchema.parse({
        id: "original",
        title: "original",
        body: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const id = await restored.startRun({});
    expect((await second.orchestrator.run(id)).run.status).toBe("completed");
    expect((await second.generations.restore(launch.generationId)).agents.resolve("worker").agent.defaultModel).toBe(
      "old",
    );
  },
);
it("does not mistake matching plugin/config bytes for restorable ambient provider state", async () => {
  const key = "ORCA_TEST_PLUGIN_AMBIENT_ROOT",
    old = process.env[key];
  const opts = await fixture(
    `const cwd=process.env.${key}; api.setWorkspaceProvider({ name:"ambient", async provision(){return {hostId:"local",cwd}} });`,
  );
  try {
    process.env[key] = "old-ambient-root";
    const first = await bootstrap(opts),
      launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" });
    process.env[key] = "new-ambient-root";
    const second = await bootstrap(opts);
    await expect(second.generations.restore(launch.generationId)).rejects.toMatchObject({ code: "RUN_STATE" });
    const id = await launch.startRun({});
    expect((await first.orchestrator.getState(id)).run.workspace.cwd).toBe("old-ambient-root");
    expect(await second.orchestrator.stores.events.listRuns()).toEqual([id]);
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
});

it.each([
  'api.agents.host("local").exec = async () => ({ code: 0, stdout: value, stderr: "" });',
  'api.agents.host("local").fs.readTextFile = async () => value;',
  'api.executors.register({ type: "custom:captured", execute: async () => ({ kind: "completed", result: { artifactIds: [], data: { value } } }) });',
  'api.executors.get("custom:plan-register").execute = async () => ({ kind: "completed", result: { artifactIds: [], data: { value } } });',
  "api.plan.addSignalExtractor(() => []);",
])("refuses historical behavior-bearing plugin registrations after restart: %s", async (registration) => {
  const opts = await fixture(`const value = api.agents.resolve("worker").agent.env.ROOT; ${registration}`);
  const config = (value: string) =>
    parseOrcaConfig({ ...opts.config, agents: [{ id: "worker", command: "unused", env: { ROOT: value } }] });
  const first = await bootstrap({ ...opts, config: config("old-target") });
  const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" });
  const id = await launch.startRun({});
  const second = await bootstrap({ ...opts, config: config("new-target") });
  await expect(second.generations.restore(launch.generationId)).rejects.toMatchObject({ code: "RUN_STATE" });
  await expect(second.orchestrator.run(id)).rejects.toMatchObject({ code: "RUN_STATE" });
  expect((await first.orchestrator.run(id)).run.status).toBe("completed");
});

it("pins the resolved Kepler task directory across ambient changes and restart", async () => {
  const opts = await fixture("");
  const config = parseOrcaConfig({ ...opts.config, plugins: [], workspace: { provider: "kepler" } });
  const previous = process.env.KEPLER_TASK_DIR;
  try {
    const original = join(opts.configDir, "original-task");
    process.env.KEPLER_TASK_DIR = original;
    const first = await bootstrap({ ...opts, config });
    const launch = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "tiny" });
    process.env.KEPLER_TASK_DIR = join(opts.configDir, "other-task");
    const sameBoot = await launch.startRun({});
    expect((await first.orchestrator.getState(sameBoot)).run.workspace.cwd).toBe(original);
    const second = await bootstrap({ ...opts, config });
    const material = await second.generations.restore(launch.generationId);
    const restored = await second.orchestrator.startRun({ workflowId: "tiny" }, material);
    expect((await second.orchestrator.getState(restored)).run.workspace.cwd).toBe(original);
    expect(second.generations.current.snapshot.config.workspace).toEqual(config.workspace);
  } finally {
    if (previous === undefined) delete process.env.KEPLER_TASK_DIR;
    else process.env.KEPLER_TASK_DIR = previous;
  }
});

it("refuses incomplete recorded Kepler context rather than falling back to current environment", async () => {
  const opts = await fixture("");
  const app = await bootstrap({
    ...opts,
    config: parseOrcaConfig({ ...opts.config, plugins: [], workspace: { provider: "kepler" } }),
  });
  const material = app.generations.current;
  const incomplete = {
    ...material,
    snapshot: { ...material.snapshot, workspaceInputs: { configDir: opts.configDir } },
  };
  expect(() => app.orchestrator.generationWorkspaceProvider!(incomplete)).toThrow(/recorded Kepler workspace inputs/);
});
