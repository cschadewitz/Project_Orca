/**
 * Bootstrap: turn `orca.config.yaml` into a wired Orchestrator + ProgramService.
 * The CLI, the ACP facade and embedders all go through here.
 */
import { assertNoPendingFirstRunRecovery } from "./first-run-recovery-fence.js";
import { admissionRetryFaults } from "@orca/core";
import { FileRetryClaimStore } from "@orca/store";
import { RegisteredRetryClaims, DirectAdmissionService, RetrySafeAdmissionService } from "@orca/engine";

import { createHash, randomUUID } from "node:crypto";

import { readFile, stat, realpath } from "node:fs/promises";
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
  type SubmissionAuthority,
  type RetryClaimStore,
  type TemplateRegistry,
  type WorkflowRegistry,
} from "@orca/core";
import {
  ConfigurationGenerations,
  FileAdmissionStore,
  MemoryAdmissionStore,
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
  type OrchestratorOptions,
  type SessionFactory,
  type WorkspaceProvider,
  type RequestSubmissionOptions,
  pluginRestorationRefusal,
  type PluginRestorationIdentityVerifier,
} from "@orca/engine";
import { KeplerTaskWorkspaceProvider } from "@orca/integrations";
import { fileStores, memoryStores, type Stores } from "@orca/store";
import { bindLocalAdmissionExecution } from "./admission-execution-authority.js";
import { cliHumanInput } from "./human-input-cli.js";
import {
  captureRuntimeObjects,
  capturePluginRestoration,
  restorePluginExecutors,
  type LoadedRestorationPlugin,
} from "./plugin-runtime.js";

export const CONFIG_FILENAMES = ["orca.config.yaml", "orca.config.yml", "orca.config.json"];

export interface BootstrapOptions {
  /** Required for plugin restart opt-in. Verify full code/dependency identities using trusted installed release evidence. */
  verifyPluginRestorationIdentity?: PluginRestorationIdentityVerifier;
  /** Trusted production composition, created over these exact stores before any interpreter runs. */
  revisionRuntime?: (stores: Stores) => NonNullable<OrchestratorOptions["revisionRuntime"]>;
  /** Bound by integration to #332 CaptureLaunch, durable admissions and verified local authority. */
  submissionAuthority?: (app: {
    config: OrcaConfig;
    configDir: string;
    orchestrator: Orchestrator;
  }) => Promise<SubmissionAuthority>;
  requestSubmission?: (app: {
    orchestrator: Orchestrator;
    config: OrcaConfig;
    configDir: string;
  }) => Promise<Omit<RequestSubmissionOptions, "orchestrator"> & { authority?: SubmissionAuthority }>;
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
  generations: ConfigurationGenerations;
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
  retrySafeAdmissions?: RetrySafeAdmissionService | undefined;
  retryClaims?: RegisteredRetryClaims | undefined;
  retryClaimStore?: RetryClaimStore | undefined;
  directAdmissions?: DirectAdmissionService | undefined;
  submissionAuthority?: SubmissionAuthority | undefined;
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
  const raw = parseConfigFile(file, text);
  try {
    // The path travels with the parsed config: `config.get`/`config.set` serve the file
    // itself, and rediscovering it in the daemon could find a different one (#174).
    return { config: parseOrcaConfig(raw), configDir: dirname(resolve(file)), configFile: resolve(file) };
  } catch (e) {
    throw new OrcaError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, {}, { cause: e });
  }
}

/** Match the initial loader when checking startup bytes too (JSON permits duplicate keys). */
function parseConfigFile(file: string, text: string): unknown {
  return file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
}

export function makeWorkspaceProvider(
  config: OrcaConfig,
  configDir: string,
  agents: AgentRegistry,
  keplerTaskDir?: string,
): WorkspaceProvider {
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
        ...(ws.isolateRoots !== undefined ? { isolateRoots: ws.isolateRoots } : {}),
        ...(ws.worktreeRoot
          ? { worktreeRoot: isAbsolute(ws.worktreeRoot) ? ws.worktreeRoot : resolve(configDir, ws.worktreeRoot) }
          : {}),
      });
    case "kepler":
      return new KeplerTaskWorkspaceProvider({
        taskDir: keplerTaskDir ?? ws.taskDir ?? process.env.KEPLER_TASK_DIR ?? configDir,
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
  assertNoPendingFirstRunRecovery(cwd, configDir, resolve(configDir, config.storeDir));
  const logger = opts.logger ?? consoleLogger(opts.logLevel ?? "info");
  const agents = AgentRegistry.fromConfig(config);
  const assets = await releaseAssets(config);
  const templates = await loadTemplates(assets.templates, configDir);
  const workflows = await loadWorkflows(assets.workflows, configDir);
  const executors = builtinExecutors();
  // Built-ins are module-level objects. Give plugins bootstrap-local registrations so an
  // in-place callback replacement cannot contaminate another app in this same process.
  for (const type of executors.types()) executors.register({ ...executors.get(type)! });
  let humanInput = opts.humanInput ?? makeHumanInput(config);
  let explicitHumanInput = opts.humanInput !== undefined;
  const workspaceInputs = {
    configDir: resolve(configDir),
    ...(config.workspace.provider === "kepler"
      ? {
          keplerTaskDir: resolve(configDir, config.workspace.taskDir ?? process.env.KEPLER_TASK_DIR ?? configDir),
        }
      : {}),
  };
  let workspaceProvider = makeWorkspaceProvider(
    config,
    workspaceInputs.configDir,
    agents,
    workspaceInputs.keplerTaskDir,
  );
  let pluginWorkspaceProvider = false;
  let pluginHumanInput = false;
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
    setHumanInput: (p) => {
      pluginHumanInput = true;
      explicitHumanInput = true;
      humanInput = p;
    },
    setWorkspaceProvider: (p) => {
      pluginWorkspaceProvider = true;
      workspaceProvider = p;
    },
  };
  const configuredHosts = new Map(agents.listHosts().map((host) => [host.id, host]));
  const configuredExecutors = new Map(executors.types().map((type) => [type, executors.get(type)]));
  let pluginPlanCallbacks = false;
  const addSignalExtractor = plan.addSignalExtractor.bind(plan);
  plan.addSignalExtractor = (extractor) => {
    pluginPlanCallbacks = true;
    addSignalExtractor(extractor);
  };
  // Include the planning service's behavior graph after installing our own tracking wrapper.
  // Direct method/prototype/nested replacements are unsupported even without extractor registration.
  const runtimeMutated = captureRuntimeObjects([...agents.listHosts(), ...configuredExecutors.values(), plan]);
  const pluginEntries = await pluginEntryDigests(config, configDir);
  const loadedPlugins = await loadPlugins(config, configDir, api, logger);
  for (const loaded of loadedPlugins) {
    const entry = pluginEntries?.find((entry) => entry.spec === loaded.spec);
    if (entry) loaded.entry = entry;
  }
  // Declarative agents/roles are restored from the encrypted snapshot. Arbitrary executable
  // hosts/providers may close over configuration or unrecorded ambient state, so they are
  // bootstrap-bound until plugins offer a restoration contract. No-op/declarative plugins
  // retain verified-entry restart compatibility. This digest stays private, with no raw secrets.
  const pluginHosts = agents
    .listHosts()
    .filter((host) => configuredHosts.get(host.id) !== host)
    .map((host) => host.id)
    .sort();
  const pluginExecutors = executors.types().filter((type) => configuredExecutors.get(type) !== executors.get(type));
  const bootstrapBound =
    pluginWorkspaceProvider ||
    pluginHumanInput ||
    pluginHosts.length > 0 ||
    pluginExecutors.length > 0 ||
    pluginPlanCallbacks ||
    runtimeMutated();
  const unsupportedRestoration =
    pluginWorkspaceProvider ||
    pluginHosts.length > 0 ||
    pluginPlanCallbacks ||
    runtimeMutated() ||
    pluginHumanInput ||
    pluginExecutors.some((type) => !type.startsWith("custom:"));
  const pluginRestoration = await capturePluginRestoration(
    loadedPlugins,
    unsupportedRestoration,
    opts.verifyPluginRestorationIdentity,
  );
  const runtimeFingerprint = pluginEntries
    ? createHash("sha256")
        .update(
          JSON.stringify({
            plugins: pluginEntries,
            workspaceProvider: pluginWorkspaceProvider,
            pluginHosts,
            ...(bootstrapBound ? { runtimeLifetime: randomUUID() } : {}),
          }),
        )
        .digest("hex")
    : undefined;

  const problems: string[] = [];
  for (const def of workflows.list()) {
    const r = validateWorkflow(def, {
      hasTemplate: (id) => templates.has(id),
      hasWorkflow: (id) => workflows.has(id),
      hasAgent: (s) => agents.canResolve(s),
      validateCustomNode: (n) => executors.validateNode(n),
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
    ...(opts.revisionRuntime ? { revisionRuntime: opts.revisionRuntime(stores) } : {}),
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
    ...(opts.ephemeral
      ? {}
      : {
          sessionFactory: (options: OpenSessionOptions) => {
            const current = agents.resolve(options.agent.id).agent;
            return makeSessionFactory(configDir)({
              ...options,
              agent: { ...options.agent, permissions: current.permissions },
            });
          },
        }),
    ...(opts.lease ? { lease: opts.lease } : {}),
  });
  const generations = new ConfigurationGenerations({
    store: stores.execution,
    workflows: stores.workflows,
    loadAssets: async (candidate) => {
      if (candidate.plugins.length) throw new OrcaError("NOT_SUPPORTED", "plugin asset refresh requires restart");
      const paths = await releaseAssets(candidate);
      const loadedWorkflows = await loadWorkflows(paths.workflows, configDir);
      const loadedTemplates = await loadTemplates(paths.templates, configDir);
      return { workflows: loadedWorkflows.list(), templates: loadedTemplates.list(), workspaceInputs };
    },
    admission: {
      validateStartRun: (options, generation) => orchestrator.validateStartRun(options, generation),
      startRun: (options, generation) => orchestrator.startRun(options, generation),
    },
    validateCustomNode: (node) => executors.validateNode(node),
    restorePluginExecutors: (snapshot) => {
      if (unsupportedRestoration) throw pluginRestorationRefusal("unsupported_registration");
      return restorePluginExecutors(snapshot.pluginRestoration, loadedPlugins, opts.verifyPluginRestorationIdentity);
    },
  });
  // Verify bytes still represent the config bootstrap loaded before labelling them active.
  const saved = configFile ? await readFile(configFile, "utf8") : "";
  if (configFile && JSON.stringify(parseOrcaConfig(parseConfigFile(configFile, saved))) !== JSON.stringify(config))
    throw new OrcaError("CONFIG_STALE", "configuration changed during startup; restart bootstrap");
  await generations.initialize(config, configFile ? createHash("sha256").update(saved).digest("hex") : "", {
    workflows: workflows.list(),
    templates: templates.list(),
    workspaceInputs,
    ...(config.plugins.length ? { agents, executors } : {}),
    ...(pluginRestoration ? { pluginRestoration } : {}),
    ...(config.plugins.length && runtimeFingerprint ? { runtimeFingerprint } : {}),
    ...(bootstrapBound ? { runtimeBootstrapBound: true } : {}),
  });
  orchestrator.generations = generations;
  // Explicit embedder/plugin ports and later facade replacements stay live. Only the
  // configured gate policy is restored; permission requests still use the live port.
  orchestrator.generationHumanInput = (generation) =>
    explicitHumanInput || orchestrator.humanInput !== humanInput
      ? orchestrator.humanInput
      : makeHumanInput(generation.snapshot.config);
  const bootGeneration = generations.current.snapshot.id;
  orchestrator.generationWorkspaceProvider = (generation) => {
    if (pluginWorkspaceProvider) {
      // Restoring a plugin-bound generation already matched this boot's runtime fingerprint,
      // which includes the non-restorable executable provider lifetime.
      const sameRuntime =
        runtimeFingerprint !== undefined && generation.snapshot.runtimeFingerprint === runtimeFingerprint;
      if (generation.snapshot.id !== bootGeneration && !sameRuntime)
        throw new OrcaError("RUN_STATE", "plugin workspace provider cannot be restored for a different plugin runtime");
      return workspaceProvider;
    }
    const inputs = generation.snapshot.workspaceInputs;
    if (!inputs?.configDir)
      throw new OrcaError("RUN_STATE", "recorded workspace configuration directory is unavailable");
    if (generation.snapshot.config.workspace.provider === "kepler" && !inputs.keplerTaskDir)
      throw new OrcaError("RUN_STATE", "recorded Kepler workspace inputs are unavailable");
    return makeWorkspaceProvider(
      generation.snapshot.config,
      inputs.configDir,
      generation.agents,
      inputs?.keplerTaskDir,
    );
  };
  const provided = await opts.requestSubmission?.({ orchestrator, config, configDir });
  const authority = provided?.authority ?? (await opts.submissionAuthority?.({ orchestrator, config, configDir }));
  if (authority) bindLocalAdmissionExecution(orchestrator, "request", authority);
  const retryClaimStore = opts.ephemeral
    ? undefined
    : new FileRetryClaimStore({
        storeDir: resolve(configDir, config.storeDir),
        execution: orchestrator.stores.execution,
        faults: admissionRetryFaults,
        limits: config.admissionRetry ?? {},
      });
  const retryClaims = retryClaimStore ? new RegisteredRetryClaims(retryClaimStore, admissionRetryFaults) : undefined;
  const directAdmissions = retryClaims
    ? new DirectAdmissionService({
        orchestrator,
        retries: retryClaims,
        captureLaunch: generations.captureLaunch,
        restoreLaunch: generations.restoreDirectLaunch,
      })
    : undefined;
  const submission = {
    ...(retryClaims ? { retries: retryClaims } : {}),
    admissions: opts.ephemeral
      ? new MemoryAdmissionStore()
      : new FileAdmissionStore(resolve(configDir, config.storeDir)),
    captureLaunch: generations.captureLaunch.bind(generations),
    restoreLaunch: generations.restoreLaunch.bind(generations),
    ...provided,
    ...(authority ? { authority } : {}),
  };
  const program = new ProgramService(orchestrator, config.program.workflow, config.program.itemWorkflow, submission);
  return {
    config,
    generations,
    submissionAuthority: submission?.authority,
    retryClaims,
    retryClaimStore,
    directAdmissions,
    retrySafeAdmissions:
      directAdmissions && program.submissions
        ? new RetrySafeAdmissionService({ requests: program.submissions, direct: directAdmissions })
        : undefined,
    configDir,
    ...(configFile ? { configFile } : {}),
    orchestrator,
    program,
    plan,
    workflows,
    templates,
    agents,
    logger,
  };
}

/**
 * Import and register `config.plugins`, in order. A relative or absolute spec is a file next
 * to the config; anything else is a package specifier. Shared by `bootstrap` and
 * `orca validate`, which loads them so a plugin's node validators are registered (#308).
 */
export async function loadPlugins(
  config: OrcaConfig,
  configDir: string,
  api: PluginApi,
  logger: Logger,
): Promise<LoadedRestorationPlugin[]> {
  const loaded: LoadedRestorationPlugin[] = [];
  for (const spec of config.plugins) {
    const mod = (await import(pluginSpecifier(spec, configDir))) as { default?: OrcaPlugin };
    if (!mod.default?.register)
      throw new OrcaError("CONFIG_INVALID", `plugin ${spec} has no default OrcaPlugin export`);
    const before = new Map(api.executors.types().map((type) => [type, api.executors.get(type)]));
    await mod.default.register(api);
    loaded.push({
      spec,
      plugin: mod.default,
      executors: api.executors.types().filter((type) => before.get(type) !== api.executors.get(type)),
    });
    logger.debug("plugin loaded", { plugin: mod.default.name });
  }
  return loaded;
}

function pluginSpecifier(spec: string, configDir: string): string {
  return spec.startsWith(".") || isAbsolute(spec) ? pathToFileURL(resolve(configDir, spec)).href : spec;
}

/**
 * The resolved entry module and its SHA-256 for each plugin, read before import. Plugin code
 * is not snapshotted; this only lets a later bootstrap prove it loads the same entry bytes.
 * A plugin that does not resolve to a local file yields none, so its generations stay
 * bound to the bootstrap that admitted them.
 */
async function pluginEntryDigests(
  config: OrcaConfig,
  configDir: string,
): Promise<{ spec: string; url: string; digest: string }[] | undefined> {
  const entries: { spec: string; url: string; digest: string }[] = [];
  for (const spec of config.plugins) {
    let url: URL;
    try {
      url = new URL(import.meta.resolve(pluginSpecifier(spec, configDir)));
    } catch {
      return undefined;
    }
    if (url.protocol !== "file:") return undefined;
    const bytes = await readFile(url).catch(() => undefined);
    if (!bytes) return undefined;
    entries.push({ spec, url: url.href, digest: createHash("sha256").update(bytes).digest("hex") });
  }
  return entries;
}

function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** Resolve shipped paths once; a running process never follows the moving release pointer. */
export async function releaseAssets(
  config: Pick<OrcaConfig, "templates" | "workflows">,
): Promise<Pick<OrcaConfig, "templates" | "workflows">> {
  const release = process.env.ORCA_RELEASE ? await realpath(process.env.ORCA_RELEASE) : undefined;
  const paths = (items: string[]) =>
    items.map((path) => {
      if (!path.includes("${ORCA_RELEASE}")) return path;
      if (!release) throw new Error("ORCA_RELEASE must name a concrete managed release");
      return path.replaceAll("${ORCA_RELEASE}", release);
    });
  return { templates: paths(config.templates), workflows: paths(config.workflows) };
}
