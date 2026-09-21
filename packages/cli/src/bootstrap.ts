/**
 * Bootstrap: turn `orca.config.yaml` into a wired Orchestrator + ProgramService.
 * The CLI, the ACP facade and embedders all go through here.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { AgentRegistry, openAcpSession, permissionPolicyPath, type OpenSessionOptions } from "@orca/agents";
import {
  consoleLogger,
  loadTemplates,
  loadWorkflows,
  OrcaError,
  parseOrcaConfig,
  validateWorkflow,
  type Logger,
  type OrcaConfig,
  type TemplateRegistry,
  type WorkflowRegistry,
} from "@orca/core";
import {
  autoHumanInput,
  builtinExecutors,
  GitWorktreeProvider,
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  PlanService,
  ProgramService,
  type HumanInputPort,
  type OrcaPlugin,
  type PluginApi,
  type RunLeaseOptions,
  type SessionFactory,
  type WorkspaceProvider,
} from "@orca/engine";
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
  /**
   * Who this orchestrator is to the lease store. Omitted gives it a fresh id per instance,
   * which is right for a one-shot CLI invocation - nothing it leaves behind is worth
   * reclaiming. `orca serve` passes a stable one, so a lease in `orca leases list` names a
   * daemon somebody can go and look at.
   */
  lease?: RunLeaseOptions;
}

export interface OrcaApp {
  config: OrcaConfig;
  configDir: string;
  /**
   * The file `config` was read from, when it was read from one. Absent means discovery found
   * nothing and the schema's defaults are the whole configuration - which is a real state
   * (`orca serve` in a bare directory), not a failure.
   *
   * It is kept rather than discarded because the daemon serves the *file* as well as what it
   * parsed to: `config.get` returns its bytes and its path, and `config.set` writes it
   * (#174). Nothing else needs it, and nothing should read it in place of `config`.
   */
  configFile?: string | undefined;
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
      if (
        await stat(p).then(
          (s) => s.isFile(),
          () => false,
        )
      )
        return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(
  cwd: string,
  configPath?: string,
): Promise<{ config: OrcaConfig; configDir: string; configFile?: string }> {
  const file = configPath ?? (await findConfig(cwd));
  if (!file) return { config: parseOrcaConfig({}), configDir: resolve(cwd) };
  const text = await readFile(file, "utf8");
  const raw = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  try {
    // The path travels with the parsed config: `config.get`/`config.set` serve the file
    // itself, and rediscovering it in the daemon could find a different one (#174).
    return { config: parseOrcaConfig(raw), configDir: dirname(resolve(file)), configFile: resolve(file) };
  } catch (e) {
    throw new OrcaError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, {}, { cause: e });
  }
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
        ...(ws.worktreeRoot
          ? { worktreeRoot: isAbsolute(ws.worktreeRoot) ? ws.worktreeRoot : resolve(configDir, ws.worktreeRoot) }
          : {}),
      });
    case "kepler":
      return new KeplerTaskWorkspaceProvider({
        taskDir: ws.taskDir ?? process.env.KEPLER_TASK_DIR ?? configDir,
        hostId: ws.hostId,
      });
  }
}

/**
 * `openAcpSession` with the workspace permission sidecar bound to it (#271).
 *
 * This is the whole of the plumbing ADR 0009 was missing: the file the daemon's
 * `ControlModel` appends an "always" answer to is `permissionPolicyPath(configDir)`, and it
 * has to be the *same* path the session evaluating the next ask reads, or a recorded grant
 * never applies. Binding it here rather than on `OrchestratorOptions` keeps the knowledge in
 * one place — the engine has no config directory and should not learn about one — and it
 * covers every caller of `bootstrap` at once: `orca run`, `orca resume`, `orca serve` and
 * the ACP facade all get their sessions through the orchestrator this returns, including the
 * daemon's `agents.ping`, which goes through `Orchestrator.sessionFactory` too.
 *
 * `open` exists so a test can read the options this builds without spawning an agent; it is
 * `openAcpSession` everywhere else.
 */
export function makeSessionFactory(configDir: string, open: SessionFactory = openAcpSession): SessionFactory {
  const permissionFiles = [permissionPolicyPath(configDir)];
  return (options: OpenSessionOptions) => open({ ...options, permissionFiles });
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
  const { config, configDir, configFile } = opts.config
    ? { config: opts.config, configDir: opts.configDir ?? cwd, configFile: undefined }
    : await loadConfig(cwd, opts.configPath);
  const logger = opts.logger ?? consoleLogger(opts.logLevel ?? "info");
  const agents = AgentRegistry.fromConfig(config);
  const templates = await loadTemplates(config.templates, configDir);
  const workflows = await loadWorkflows(config.workflows, configDir);
  const executors = builtinExecutors();
  let humanInput = opts.humanInput ?? makeHumanInput(config);
  let workspaceProvider = makeWorkspaceProvider(config, configDir, agents);
  const stores = opts.ephemeral
    ? memoryStores()
    : fileStores(resolve(configDir, config.storeDir), undefined, logger.child({ component: "store" }));
  const plan = new PlanService({
    stores,
    logger: logger.child({ component: "plan" }),
    defaults: {
      planKey: config.planning.plan,
      planName: config.planning.planName,
      policy: stripUndefined(config.planning.policy),
      riskMatrix: stripUndefined(config.planning.riskMatrix),
    },
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
    if (!mod.default?.register)
      throw new OrcaError("CONFIG_INVALID", `plugin ${spec} has no default OrcaPlugin export`);
    await mod.default.register(api);
    logger.debug("plugin loaded", { plugin: mod.default.name });
  }

  const problems: string[] = [];
  for (const def of workflows.list()) {
    const r = validateWorkflow(def, {
      hasTemplate: (id) => templates.has(id),
      hasWorkflow: (id) => workflows.has(id),
      hasAgent: (s) => agents.canResolve(s),
    });
    for (const e of r.errors) problems.push(`${def.id}: ${e.path}: ${e.message}`);
    for (const w of r.warnings) logger.warn(`workflow ${def.id}: ${w.path}: ${w.message}`);
  }
  if (problems.length)
    throw new OrcaError(
      "WORKFLOW_INVALID",
      `workflow validation failed:\n${problems.map((p) => "  - " + p).join("\n")}`,
      { problems },
    );

  const orchestrator = new Orchestrator({
    stores,
    agents,
    workflows,
    templates,
    executors,
    humanInput,
    workspaceProvider,
    plan,
    logger,
    // An ephemeral bootstrap deliberately gets none: it is a one-shot over in-memory stores
    // (`orca agent ping`), and standing grants a workspace recorded for its real runs are
    // durable workspace state of exactly the kind `ephemeral` means to leave alone.
    ...(opts.ephemeral ? {} : { sessionFactory: makeSessionFactory(configDir) }),
    ...(opts.lease ? { lease: opts.lease } : {}),
  });
  return {
    config,
    configDir,
    ...(configFile ? { configFile } : {}),
    orchestrator,
    program: new ProgramService(orchestrator, config.program.workflow, config.program.itemWorkflow),
    plan,
    workflows,
    templates,
    agents,
    logger,
  };
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
