/** Integration-only: included in the reserved-path handoff patch. */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { AgentRegistry } from "@orca/agents";
import { parseOrcaConfig, parseWorkflow, parsePromptTemplate, TemplateRegistry, WorkflowRegistry } from "@orca/core";
import { fileStores, memoryStores, type Stores } from "@orca/store";
import { builtinExecutors, completed, LocalWorkspaceProvider, Orchestrator, PausingHumanInput } from "@orca/engine";
import { ConfigurationGenerations } from "../src/configuration-generation.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const parent = parseWorkflow(`
id: parent
name: Parent
version: '1'
inputSchema:
  fields:
    token: {type: string, sensitive: true}
start: start
nodes:
  start: {type: start}
  gate: {type: gate, question: Go?, options: [go]}
  child: {type: subworkflow, workflow: child}
  done: {type: end}
edges:
  - {from: start, to: gate}
  - {from: gate, to: child}
  - {from: child, to: done}
`);
const child = parseWorkflow(`
id: child
name: Child
version: '1'
start: start
nodes:
  start: {type: start}
  trace: {type: custom:trace}
  done: {type: end}
edges:
  - {from: start, to: trace}
  - {from: trace, to: done}
`);
const config = (agent = "a") =>
  parseOrcaConfig({
    agents: [
      { id: "a", command: "unused", args: ["1"], env: { TOKEN: "credential-canary" } },
      { id: "b", command: "unused" },
    ],
    roles: { builder: agent },
  });
async function make(stores: Stores, role = "a", body = "old template") {
  const cfg = config(role);
  const workflows = new WorkflowRegistry().register(parent).register(child);
  const template = parsePromptTemplate(`---\nid: prompt\n---\n${body}`);
  const templates = new TemplateRegistry().register(template);
  const traces: string[] = [];
  const executors = builtinExecutors();
  executors.register({
    type: "custom:trace",
    execute: async (ctx) => {
      traces.push(`${ctx.agents.resolve({ role: "builder" }).agent.id}:${ctx.templates.get("prompt").body}`);
      await ctx.emit({ type: "vars.set", payload: { vars: { output: "credential-canary" } } });
      return completed();
    },
  });
  const orc = new Orchestrator({
    stores,
    workflows,
    templates,
    agents: AgentRegistry.fromConfig(cfg),
    executors,
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    humanInput: new PausingHumanInput(),
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async () => ({ workflows: [parent, child], templates: [template] }),
    admission: {
      validateStartRun: (opts, material) => orc.validateStartRun(opts, material),
      startRun: (opts, material) => orc.startRun(opts, material),
    },
    validateCustomNode: (node) => executors.validateNode(node),
  });
  await generations.initialize(cfg, role);
  orc.generations = generations;
  return { orc, generations, traces };
}
for (const disk of [false, true])
  it(`${disk ? "file" : "memory"}: pinned restart retains roles/templates in children and keeps provenance secret-free`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-generation-integration-"));
    dirs.push(dir);
    const stores = disk ? fileStores(dir) : memoryStores();
    const first = await make(stores);
    const captured = await first.generations.captureLaunch({ purpose: "workflow", workflowId: "parent" });
    const runId = await captured.startRun({ vars: { token: "sensitive-input-canary" } });
    const parked = await first.orc.run(runId);
    expect(parked.run.status).toBe("paused");
    const input = (await first.orc.pendingInputs(runId))[0]!;
    const second = await make(disk ? fileStores(dir) : stores, "b", "new template");
    await second.orc.answer(input.id, "go", runId);
    const result = await second.orc.resume(runId);
    expect(result.run.status).toBe("completed");
    expect(second.traces).toEqual(["a:old template"]);
    expect(result.run.provenance?.configGeneration).toBe(captured.generationId);
    const events = await stores.events.read(runId);
    expect(JSON.stringify(events)).not.toMatch(/credential-canary|sensitive-input-canary/);
    if (disk) {
      const names = await readdir(join(dir, "private-execution"));
      const bytes = await Promise.all(
        names
          .filter((name) => name.endsWith(".generation.json"))
          .map((name) => readFile(join(dir, "private-execution", name), "utf8")),
      );
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.join("")).not.toMatch(/credential-canary|old template/);
      await rm(join(dir, "private-execution", `${captured.generationId}.generation.json`));
      await expect(second.generations.restore(captured.generationId)).rejects.toMatchObject({ code: "RUN_STATE" });
    }
  });

it("configured literals protect public history even without sensitive launch inputs", async () => {
  const stores = memoryStores();
  const { orc, generations } = await make(stores);
  const launch = await generations.captureLaunch({ purpose: "workflow", workflowId: "child" });
  const id = await launch.startRun({});
  await orc.run(id);
  expect(JSON.stringify(await stores.events.read(id))).not.toContain("credential-canary");
  expect((await orc.getState(id)).run.vars.output).toBe("[REDACTED]");
});
