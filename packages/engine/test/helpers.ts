import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { loadTemplates, loadWorkflows, parseOrcaConfig, silentLogger, type TemplateRegistry, type WorkflowRegistry } from "@orca/core";
import { LocalWorkspaceProvider, Orchestrator, type OrchestratorOptions } from "@orca/engine";
import { memoryStores } from "@orca/store";
import { scriptedAgentSpec, type PlaybookInput } from "@orca/testing";

export const repoRoot = join(new URL(".", import.meta.url).pathname, "..", "..", "..");

/** Same glob patterns `orca run` uses by default, so the tests exercise the file set the CLI does. */
const shipped = parseOrcaConfig({});

export function loadShippedWorkflows(): Promise<WorkflowRegistry> {
  return loadWorkflows(shipped.workflows, repoRoot);
}

export function loadShippedTemplates(): Promise<TemplateRegistry> {
  return loadTemplates(shipped.templates, repoRoot);
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
