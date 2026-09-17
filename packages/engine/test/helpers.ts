import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry, silentLogger, parsePromptTemplate } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, type OrchestratorOptions } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec, type PlaybookInput } from "@orca/testing";

export const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..", "..");

export async function loadShippedWorkflows(): Promise<WorkflowRegistry> {
  const reg = new WorkflowRegistry();
  for (const f of await readdir(join(repoRoot, "workflows"))) if (f.endsWith(".yaml")) reg.register(parseWorkflow(await readFile(join(repoRoot, "workflows", f), "utf8"), f));
  return reg;
}

export async function loadShippedTemplates(): Promise<TemplateRegistry> {
  const reg = new TemplateRegistry();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith(".md")) reg.register(parsePromptTemplate(await readFile(p, "utf8"), p));
    }
  };
  await walk(join(repoRoot, "templates"));
  return reg;
}

export interface TestHarness {
  dir: string;
  orchestrator: Orchestrator;
  promptLog: string;
  prompts(): Promise<{ text: string; turn: number }[]>;
}

export async function harness(playbook: PlaybookInput, overrides: Partial<OrchestratorOptions> = {}, opts: { sessionMode?: "per-step" | "per-run"; turnTimeoutMs?: number; cancelGraceMs?: number } = {}): Promise<TestHarness> {
  const dir = await mkdtemp(join(tmpdir(), "orca-e2e-"));
  const promptLog = join(dir, ".orca-test", "prompts.jsonl");
  const agents = new AgentRegistry()
    .addHost(new LocalHost({ id: "local", type: "local" }))
    .addAgent(scriptedAgentSpec({ playbookJson: playbook, stateFile: join(dir, ".orca-test", "state.json"), promptLog, ...opts }));
  const orchestrator = new Orchestrator({
    stores: memoryStores(),
    agents,
    workflows: await loadShippedWorkflows(),
    templates: await loadShippedTemplates(),
    workspaceProvider: new LocalWorkspaceProvider(dir),
    logger: silentLogger,
    ...overrides,
  });
  return {
    dir,
    orchestrator,
    promptLog,
    prompts: async () =>
      (await readFile(promptLog, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { text: string; turn: number }),
  };
}
