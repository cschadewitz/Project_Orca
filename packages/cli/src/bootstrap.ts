/**
 * Bootstrap: turn `orca.config.yaml` into a wired Orchestrator + ProgramService.
 * The CLI, the ACP facade and embedders all go through here.
 */
import { glob, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { AgentRegistry } from "@orca/agents";
import { consoleLogger, OrcaError, parseOrcaConfig, parsePromptTemplate, parseWorkflow, TemplateRegistry, validateWorkflow, WorkflowRegistry, type Logger, type OrcaConfig } from "@orca/core";
import { autoHumanInput, builtinExecutors, GitWorktreeProvider, LocalWorkspaceProvider, Orchestrator, PausingHumanInput, PlanService, ProgramService, type HumanInputPort, type OrcaPlugin, type PluginApi, type WorkspaceProvider } from "@orca/engine";
import { KeplerTaskWorkspaceProvider } from "@orca/integrations";
import { fileStores, memoryStores } from "@orca/store";
import { cliHumanInput } from "./human-input-cli.js";

export const CONFIG_FILENAMES = ["orca.config.yaml", "orca.config.yml", "orca.config.json"];

export interface BootstrapOptions {
  cwd?: string;
  configPath?: string;
  /** Use in-memory stores (demo/tests). */
  ephemeral?: boolean;
  logger?: Logger;
  logLevel?: "debug" | "info" | "warn" | "error";
  humanInput?: HumanInputPort;
  /** Programmatic config (skips file discovery). */
  config?: OrcaConfig;
  configDir?: string;
}

export interface OrcaApp {
  config: OrcaConfig;
  configDir: string;
  orchestrator: Orchestrator;
  program: ProgramService;
  plan: PlanService;
  workflows: WorkflowRegistry;
  templates: TemplateRegistry;
  agents: AgentRegistry;
  logger: Logger;
}

export async function findConfig(cwd: string): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const p = join(dir, name);
      if (await stat(p).then((s) => s.isFile(), () => false)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(cwd: string, configPath?: string): Promise<{ config: OrcaConfig; configDir: string }> {
  const file = configPath ?? (await findConfig(cwd));
  if (!file) return { config: parseOrcaConfig({}), configDir: resolve(cwd) };
  const text = await readFile(file, "utf8");
  const raw = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  try {
    return { config: parseOrcaConfig(raw), configDir: dirname(resolve(file)) };
  } catch (e) {
    throw new OrcaError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, {}, { cause: e });
  }
}

const GLOB_CHARS = /[*?[{]/;

/** Split an absolute glob into the longest literal directory prefix and the pattern below it. */
function splitGlob(pattern: string): { cwd: string; rest: string } {
  const parts = pattern.split(/[\\/]+/);
  const literal: string[] = [];
  while (parts.length && !GLOB_CHARS.test(parts[0]!)) literal.push(parts.shift()!);
  return { cwd: literal.join("/") || "/", rest: parts.join("/") };
}

async function expand(patterns: string[], baseDir: string): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const { cwd, rest } = isAbsolute(pattern) ? splitGlob(pattern) : { cwd: baseDir, rest: pattern };
    if (!rest || !GLOB_CHARS.test(rest)) {
      files.add(join(cwd, rest));
      continue;
    }
    for await (const f of glob(rest, { cwd })) files.add(join(cwd, f));
  }
  return [...files].sort();
}

export async function loadTemplates(patterns: string[], baseDir: string): Promise<TemplateRegistry> {
  const reg = new TemplateRegistry();
  for (const f of await expand(patterns, baseDir)) reg.register(parsePromptTemplate(await readFile(f, "utf8"), f));
  return reg;
}

export async function loadWorkflows(patterns: string[], baseDir: string): Promise<WorkflowRegistry> {
  const reg = new WorkflowRegistry();
  for (const f of await expand(patterns, baseDir)) reg.register(parseWorkflow(await readFile(f, "utf8"), f));
  return reg;
}

export function makeWorkspaceProvider(config: OrcaConfig, configDir: string, agents: AgentRegistry): WorkspaceProvider {
  const ws = config.workspace;
  switch (ws.provider) {
    case "local":
      return new LocalWorkspaceProvider(resolve(configDir, ws.root ?? "."), ws.hostId);
    case "git-worktree":
      return new GitWorktreeProvider({
        host: agents.host(ws.hostId),
        repo: isAbsolute(ws.repo) ? ws.repo : resolve(configDir, ws.repo),
        baseBranch: ws.baseBranch,
        branchPrefix: ws.branchPrefix,
        ...(ws.worktreeRoot ? { worktreeRoot: isAbsolute(ws.worktreeRoot) ? ws.worktreeRoot : resolve(configDir, ws.worktreeRoot) } : {}),
      });
    case "kepler":
      return new KeplerTaskWorkspaceProvider({ taskDir: ws.taskDir ?? process.env.KEPLER_TASK_DIR ?? configDir, hostId: ws.hostId });
  }
}

export function makeHumanInput(config: OrcaConfig): HumanInputPort {
  switch (config.humanInput.mode) {
    case "auto":
      return autoHumanInput(config.humanInput.option);
    case "cli":
      return cliHumanInput();
    case "pause":
      return new PausingHumanInput();
  }
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<OrcaApp> {
  const cwd = opts.cwd ?? process.cwd();
  const { config, configDir } = opts.config ? { config: opts.config, configDir: opts.configDir ?? cwd } : await loadConfig(cwd, opts.configPath);
  const logger = opts.logger ?? consoleLogger(opts.logLevel ?? "info");
  const agents = AgentRegistry.fromConfig(config);
  const templates = await loadTemplates(config.templates, configDir);
  const workflows = await loadWorkflows(config.workflows, configDir);
  const executors = builtinExecutors();
  let humanInput = opts.humanInput ?? makeHumanInput(config);
  let workspaceProvider = makeWorkspaceProvider(config, configDir, agents);
  const stores = opts.ephemeral ? memoryStores() : fileStores(resolve(configDir, config.storeDir));
  const plan = new PlanService({
    stores,
    logger: logger.child({ component: "plan" }),
    defaults: { planKey: config.planning.plan, planName: config.planning.planName, policy: stripUndefined(config.planning.policy), riskMatrix: stripUndefined(config.planning.riskMatrix) },
  });

  const api: PluginApi = {
    executors,
    templates,
    workflows,
    agents,
    plan,
    setHumanInput: (p) => (humanInput = p),
    setWorkspaceProvider: (p) => (workspaceProvider = p),
  };
  for (const spec of config.plugins) {
    const url = spec.startsWith(".") || isAbsolute(spec) ? pathToFileURL(resolve(configDir, spec)).href : spec;
    const mod = (await import(url)) as { default?: OrcaPlugin };
    if (!mod.default?.register) throw new OrcaError("CONFIG_INVALID", `plugin ${spec} has no default OrcaPlugin export`);
    await mod.default.register(api);
    logger.debug("plugin loaded", { plugin: mod.default.name });
  }

  const problems: string[] = [];
  for (const def of workflows.list()) {
    const r = validateWorkflow(def, { hasTemplate: (id) => templates.has(id), hasWorkflow: (id) => workflows.has(id), hasAgent: (s) => agents.canResolve(s) });
    for (const e of r.errors) problems.push(`${def.id}: ${e.path}: ${e.message}`);
    for (const w of r.warnings) logger.warn(`workflow ${def.id}: ${w.path}: ${w.message}`);
  }
  if (problems.length) throw new OrcaError("WORKFLOW_INVALID", `workflow validation failed:\n${problems.map((p) => "  - " + p).join("\n")}`, { problems });

  const orchestrator = new Orchestrator({ stores, agents, workflows, templates, executors, humanInput, workspaceProvider, plan, logger });
  return { config, configDir, orchestrator, program: new ProgramService(orchestrator, config.program.workflow), plan, workflows, templates, agents, logger };
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
