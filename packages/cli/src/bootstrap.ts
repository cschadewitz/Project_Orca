/**
 * Bootstrap: turn `orca.config.yaml` into a wired Orchestrator + ProgramService.
 * The CLI, the ACP facade and embedders all go through here.
 */
import type { StoreStatus } from "@orca/protocol";
import { enterFirstRunWriter, type FirstRunWriterHold } from "@orca/protocol/first-run-fence";
import { assertNoUnownedTypedWorkspace } from "./typed-workspace-gate.js";
import {
  enterConfiguredUpdateBootstrap,
  isClosedUpdateBootstrap,
  closedUpdateOwnsConfiguredRoots,
} from "./update-bootstrap.js";
import { enterClosedFirstRunInspection } from "@orca/protocol/update-window";
import { admissionRetryFaults, CONFIG_FILENAMES, LEGACY_CONFIG_FILENAMES } from "@orca/core";
import { DIAGNOSTICS_DIR, FileRetryClaimStore, HOOK_SESSION_DIR, STORE_FORMAT_BACKUP_DIR } from "@orca/store";
import { enterDaemonStoreFormat } from "./desktop-carryover.js";
import {
  desktopSqliteSwitch,
  parseStoreSwitchRequest,
  STORE_SWITCH_ENV,
  type DesktopSqliteSwitchOutcome,
} from "./desktop-sqlite-switch.js";
import { readOrcaVersion } from "./version.js";
import {
  CheckpointAdmissionService,
  RegisteredRetryClaims,
  DirectAdmissionService,
  RetrySafeAdmissionService,
} from "@orca/engine";

import { createHash, randomUUID } from "node:crypto";

import { readFile, stat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  AgentRegistry,
  admitCodexExecGateSession,
  claudePreToolHookScript,
  codexExecGateRequested,
  hostIpcCaveat,
  hostIpcInventory,
  CLAUDE_ADAPTER_NAMES,
  claudeModePin,
  nativeToolHookNotQualified,
  nativeToolHookRequested,
  nativeToolHookSession,
  sweepHookTelemetrySpools,
  openAcpSession,
  withProviderGuards,
  permissionPolicyPath,
  permissionPolicyPaths,
  type AgentSession,
  type CodexExecGateAdmission,
  type HostIpcInventory,
  type OpenSessionOptions,
  type ProtectedPaths,
} from "@orca/agents";
import {
  consoleLogger,
  literalEnv,
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
  capabilityChecker,
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
import { delegatingSessionFactory, RemoteCapacity, validateRemotes } from "@orca/daemon";
import {
  adoptLegacyStoreDir,
  fileStores,
  holdStoreWriter,
  memoryStores,
  recordedStoreBackend,
  sqliteStores,
  workspaceIdentity,
  type StoreBackend,
  type StoreWriterHold,
  type Stores,
} from "@orca/store";
import { bindLocalAdmissionExecution } from "./admission-execution-authority.js";
import { cliHumanInput } from "./human-input-cli.js";
import { localCapabilityUse, localSecretUse } from "./local-secret-use.js";
import {
  captureRuntimeObjects,
  capturePluginRestoration,
  restorePluginExecutors,
  type LoadedRestorationPlugin,
} from "./plugin-runtime.js";

import {
  loadInstalledPluginRelease,
  type InstalledPluginRelease,
  type VerifiedPluginRelease,
} from "./plugin-release.js";

/**
 * The config names discovery looks for, and the names from before the rename to Orrery, which
 * it takes when a directory has none of the current ones, with a warning, until 0.10. Until the
 * codemod runs the two lists are equal, and `findConfig` reads each name once.
 */
export { CONFIG_FILENAMES, LEGACY_CONFIG_FILENAMES };

export interface BootstrapOptions {
  /** Trusted composition supplies an independently approved closed-bundle release pin; never read from config/RPC/env. */
  installedPluginRelease?: InstalledPluginRelease;
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
  /** Retry-safe checkpoint attempts of failed runs (#357). */
  checkpointAdmissions?: CheckpointAdmissionService | undefined;
  submissionAuthority?: SubmissionAuthority | undefined;
  plan: PlanService;
  workflows: WorkflowRegistry;
  templates: TemplateRegistry;
  agents: AgentRegistry;
  logger: Logger;
  /** Existing store owners, read-only and conservative; no retry cursor or reconciliation. */
  closedWorkState(): Promise<"empty" | "parked" | "unsupported-generation">;
  /** How the switch to SQLite the desktop app asked for on this launch ended (#339). */
  storeSwitch?: DesktopSqliteSwitchOutcome | undefined;
  /** The store's backend and whether the app may switch it to SQLite (#339), for `hello`. */
  storeStatus?: StoreStatus | undefined;
  /**
   * This process's hold on a first-run workspace's writer fence, when the desktop app launched it
   * for one (checks only, no release). Writes the daemon makes to such a workspace on a client's
   * behalf, such as enrolling a remote (#1206), require it to be still held.
   */
  firstRunWriter?: FirstRunWriterHold | undefined;
}

export async function findConfig(
  cwd: string,
  warn: (message: string) => void = (message) => void process.stderr.write(`${message}\n`),
): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of new Set([...CONFIG_FILENAMES, ...LEGACY_CONFIG_FILENAMES])) {
      const p = join(dir, name);
      if (
        await stat(p).then(
          (s) => s.isFile(),
          () => false,
        )
      ) {
        if (!CONFIG_FILENAMES.includes(name))
          warn(`warning: reading ${p}; rename it to ${CONFIG_FILENAMES[0]} (the old name is read until 0.10)`);
        return p;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(
  cwd: string,
  configPath?: string,
  options: { adoptStoreDir?: boolean } = {},
): Promise<{ config: OrcaConfig; configDir: string; configFile?: string }> {
  assertNoUnownedTypedWorkspace([cwd, ...(configPath ? [dirname(resolve(configPath))] : [])]);
  const file = configPath ?? (await findConfig(cwd));
  if (!file) {
    const configDir = resolve(cwd);
    const config = await withAdoptedStoreDir(parseOrcaConfig({}), configDir, options.adoptStoreDir);
    await enterConfiguredUpdateBootstrap(configDir, resolve(configDir, config.storeDir));
    return { config, configDir };
  }
  const text = await readFile(file, "utf8");
  const raw = parseConfigFile(file, text);
  let parsed: OrcaConfig;
  try {
    parsed = parseOrcaConfig(raw);
  } catch (e) {
    throw new OrcaError("CONFIG_INVALID", `${file}: ${(e as Error).message}`, {}, { cause: e });
  }
  // The path travels with the parsed config: `config.get`/`config.set` serve the file
  // itself, and rediscovering it in the daemon could find a different one (#174).
  const configDir = dirname(resolve(file));
  const config = await withAdoptedStoreDir(parsed, configDir, options.adoptStoreDir);
  await enterConfiguredUpdateBootstrap(configDir, resolve(configDir, config.storeDir));
  return { config, configDir, configFile: resolve(file) };
}

/**
 * Before anything opens or fences the store: a workspace from before the rename to Orrery has
 * its store under the old default name, which `adoptLegacyStoreDir` moves to the new one once
 * (until 0.10). When it cannot, the store is opened where it is, so `storeDir` names
 * that directory and every `resolve(configDir, config.storeDir)` after this reaches it. Not on a
 * closed update start, which only checks, and not when `adopt` is false (an ephemeral start).
 */
async function withAdoptedStoreDir(config: OrcaConfig, configDir: string, adopt = true): Promise<OrcaConfig> {
  if (!adopt || isClosedUpdateBootstrap()) return config;
  const storeDir = resolve(configDir, config.storeDir);
  const opened = await adoptLegacyStoreDir(storeDir, { appVersion: storeWriterVersion() });
  return opened === storeDir ? config : { ...config, storeDir: opened };
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
        ...(ws.fetchRemote !== undefined ? { fetchRemote: ws.fetchRemote } : {}),
        ...(ws.allowedRefs !== undefined ? { allowedRefs: ws.allowedRefs } : {}),
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
 * It binds ORCA's own files beside the sidecar, for the same reason and in the same place:
 * the config directory is the default workspace, so every session has to know what in it is
 * not the agent's to touch (`orcaProtectedPaths`, C4-01).
 *
 * `open` exists so a test can read the options this builds without spawning an agent; it is
 * `openAcpSession` everywhere else.
 */
/**
 * What every hooked session logs when it opens. No agent is guard-qualified (the support
 * matrix gives every one tier none), and the checks ORCA makes are made when the session opens.
 */
export const NATIVE_TOOL_HOOK_EXPERIMENTAL =
  "nativeToolHook: experimental is not guard-qualified: ORCA checked the agent's runtime and hook when " +
  "this session opened, not afterwards, and the calls outside the hook are listed in docs/agent-hook-coverage.md";

export function makeSessionFactory(
  layout: OrcaFileLayout,
  open: SessionFactory = openAcpSession,
  hook: {
    runtime: string;
    script: string | undefined;
    platform?: NodeJS.Platform | undefined;
    arch?: string | undefined;
    imageDigest?:
      ((pid: number, agentPid: number | undefined) => Promise<{ sha256: string } | { error: string }>) | undefined;
    codexProcess?: ((agentPid: number | undefined) => Promise<{ pid: number } | { error: string }>) | undefined;
    codexEnvironment?: ((pid: number) => Promise<NodeJS.ProcessEnv | { error: string }>) | undefined;
    codexShell?: (() => { program: string; args: string[] } | { error: string }) | undefined;
    /** The single deadline for a Codex session's admission checks (`CODEX_ADMISSION_DEADLINE_MS`). */
    codexAdmissionDeadlineMs?: number | undefined;
    /** Potential host communication endpoints, for the Codex IPC caveat; `hostIpcInventory` unless given. */
    ipcInventory?:
      | ((env: Readonly<Record<string, string | undefined>>, signal: AbortSignal) => Promise<HostIpcInventory>)
      | undefined;
  } = {
    runtime: process.execPath,
    script: claudePreToolHookScript(),
  },
  /** For tests: the host and path resolution the Codex gate route reads. */
  gate?: Pick<CodexExecGateAdmission, "host" | "real">,
): SessionFactory {
  const permissionFiles = [permissionPolicyPath(layout.configDir)];
  const protectedPaths = orcaProtectedPaths(layout);
  // Provider-specific launch checks and session guards (#709, #710, #711): Copilot CLI, OpenCode, Cline.
  const guarded = withProviderGuards(open);
  // Left out of every store copy (backups, carryover, conversion): see HOOK_SESSION_DIR.
  const contextDir = join(resolve(layout.configDir, layout.storeDir), ...HOOK_SESSION_DIR.split("/"));
  // Telemetry spools a stopped process left behind (#1000) are discarded, never ingested,
  // once, before the first hooked session.
  let swept: Promise<void> | undefined;
  const sweep = () =>
    (swept ??= sweepHookTelemetrySpools({ dir: contextDir, protectedPaths }).then(
      () => undefined,
      () => undefined,
    ));
  return async (options: Parameters<SessionFactory>[0]) => {
    const bound = { ...options, permissionFiles, protectedPaths };
    // ORCA's gate in Codex's executor path (#1026): its own route, which refuses every session
    // for now, with the reasons. Nothing falls back to the hook or to no gate.
    if (codexExecGateRequested(options.agent)) {
      if (nativeToolHookRequested(options.agent))
        throw new OrcaError(
          "NOT_SUPPORTED",
          `agent ${options.agent.id} has both codexExecGate and nativeToolHook; they are separate routes, and an agent takes one of them.`,
          { agentId: options.agent.id },
        );
      if (options.host.spec.type !== "local")
        throw new OrcaError(
          "NOT_SUPPORTED",
          `agent ${options.agent.id} has codexExecGate: experimental, but it runs on ${options.host.spec.type} host ${options.host.spec.id}; ` +
            `the gate route applies only to agents on ORCA's own machine. Remove codexExecGate to run it without the gate.`,
          { agentId: options.agent.id, host: options.host.spec.id },
        );
      return admitCodexExecGateSession({
        agentId: options.agent.id,
        layout: {
          configDir: layout.configDir,
          storeDir: layout.storeDir,
          configFile: layout.configFile,
          workspace: options.cwd,
          additionalDirectories: options.additionalDirectories,
        },
        ...(gate ?? {}),
      });
    }
    // ORCA's pre-tool hook (#704, #705): prepared before the agent starts, decided once it
    // says who it is, and the session refused wherever it cannot be put in force.
    // Claude runs in Manual mode, where its calls reach ORCA's policy (see claude-mode.ts).
    const modePin = claudeModePin();
    if (!nativeToolHookRequested(options.agent))
      return modePin.guard(await guarded({ ...bound, sessionMeta: modePin.sessionMeta(bound.sessionMeta) }));
    // `on` waits for a guard-qualified hook; only the explicit `experimental` installs this one.
    const unqualified = nativeToolHookNotQualified(options.agent);
    if (unqualified) throw unqualified;
    await sweep();
    // The hook runs where the agent does; ORCA installs it only on its own host.
    if (options.host.spec.type !== "local")
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${options.agent.id} has nativeToolHook: experimental, but it runs on ${options.host.spec.type} host ${options.host.spec.id}, where ORCA cannot install its hook. ` +
          `ORCA refuses the session rather than run it unguarded; remove nativeToolHook to run it without the hook.`,
        { agentId: options.agent.id, host: options.host.spec.id },
      );
    const agentEnv = { ...process.env, ...literalEnv(options.agent.env), ...(options.env ?? {}) };
    const installed = nativeToolHookSession({
      agentId: options.agent.id,
      permissions: options.agent.permissions,
      permissionFiles,
      workspaceCwd: options.cwd,
      additionalDirectories: options.additionalDirectories,
      protectedPaths,
      contextDir,
      runtime: hook.runtime,
      script: hook.script,
      platform: hook.platform,
      arch: hook.arch,
      imageDigest: hook.imageDigest,
      codexProcess: hook.codexProcess,
      codexEnvironment: hook.codexEnvironment,
      codexShell: hook.codexShell,
      codexAdmissionDeadlineMs: hook.codexAdmissionDeadlineMs,
      // A cancelled run stops the hook's admission checks too.
      signal: options.origin?.signal,
      agentEnv,
      toolCallTelemetry: options.agent.diagnostics?.toolCalls,
      // In the desktop app ORCA's runtime is the Electron binary, which runs a script as Node
      // only with this set; the hooks the agent starts inherit it from the agent.
      runtimeEnv: process.versions["electron"] !== undefined ? { ELECTRON_RUN_AS_NODE: "1" } : undefined,
    });
    let hookEnv: Record<string, string>;
    try {
      ({ env: hookEnv } = await installed.prepare());
    } catch (error) {
      await installed.cleanup();
      throw error;
    }
    // ORCA's host services wait for this: settled once the session's runtime is admitted,
    // and rejected, so that each held request is refused, on every way the open fails.
    let admit!: () => void;
    let refuseAdmission!: (reason: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => {
      admit = resolve;
      refuseAdmission = reject;
    });
    // A refusal is an answer to whoever waits on it; with nobody waiting it is not an error.
    admission.catch(() => undefined);
    let session: AgentSession;
    try {
      session = await guarded({
        ...bound,
        env: { ...(options.env ?? {}), ...hookEnv },
        sessionMeta: modePin.sessionMeta(installed.sessionMeta),
        admission,
        // Claude Code would start its MCP servers itself, before ORCA has admitted the runtime
        // it runs, and would hold their secrets; ORCA runs them instead and serves them over
        // ACP. Codex keeps its servers: its runtime is admitted before `session/new` hands
        // them over.
        relayMcpServers: (agentInfo) => agentInfo !== undefined && CLAUDE_ADAPTER_NAMES.includes(agentInfo.name),
      });
    } catch (error) {
      refuseAdmission(error);
      await installed.cleanup();
      throw error;
    }
    // The session has started but has no work yet: the Claude Code it runs must be verified.
    try {
      await installed.verifyRuntime();
    } catch (error) {
      refuseAdmission(error);
      await session.close().catch(() => undefined);
      await installed.cleanup();
      throw error;
    }
    admit();
    // Said on every hooked session: the hook is an experimental, unqualified layer (#704 review).
    options.logger?.warn(NATIVE_TOOL_HOOK_EXPERIMENTAL, { agent: options.agent.id });
    void session.closed.then(installed.cleanup, installed.cleanup);
    const close = session.close.bind(session);
    session.close = async (...args: Parameters<AgentSession["close"]>) => {
      try {
        return await close(...args);
      } finally {
        await installed.cleanup();
      }
    };
    // The Codex IPC caveat (#1026): potential host communication endpoints, observed from the
    // daemon once the session's cleanup is in place. Off the open's path: nothing waits on it, it
    // stops at its own deadline or when the session ends, and a failure is an incomplete result.
    // Only where the warning has somewhere to go; it grants and takes away nothing.
    const logger = options.logger;
    if (installed.status() === "codex" && logger !== undefined) {
      const ended = new AbortController();
      void session.closed.then(
        () => ended.abort(),
        () => ended.abort(),
      );
      void (hook.ipcInventory ?? ((env, signal) => hostIpcInventory(env, { signal })))(agentEnv, ended.signal)
        .catch((error: unknown): HostIpcInventory => ({
          endpoints: [],
          pipesSearched: [],
          incomplete: [`the inventory failed (${error instanceof Error ? error.message : String(error)})`],
        }))
        .then((inventory) =>
          logger.warn(hostIpcCaveat(inventory), {
            agent: options.agent.id,
            ipcEndpoints: inventory.endpoints.length,
            ipcIncomplete: inventory.incomplete.length,
          }),
        )
        .catch(() => undefined);
    }
    // The engine drains it while the session runs (#1000); `cleanup` reads it a last time.
    const telemetry = installed.telemetry();
    if (telemetry !== undefined) Object.defineProperty(session, "hookTelemetry", { value: telemetry });
    return modePin.guard(session);
  };
}

/** Where one config directory keeps ORCA's own files. */
export interface OrcaFileLayout {
  configDir: string;
  /** The store; relative to `configDir` when it is not absolute, as `storeDir` in the config is. */
  storeDir: string;
  /** The config file that was loaded, which `--config` can put outside `configDir`. */
  configFile?: string | undefined;
}

/**
 * ORCA's own files in a config directory, as every session refuses them to its agent (C4-01).
 *
 * Read-only to an agent: every config filename ORCA would load from `configDir` — not just the
 * one there now, since an agent that could create `orca.config.yaml` beside a project with
 * none would choose the next start's policy, and until 0.10 the names from before the rename
 * too — the file actually loaded, the permission sidecar under either name, and the store — all of it but `work/` and `program/`, where the shipped `ai-sdlc`
 * and `program` workflows have agents write their deliverables (`.orca/work/…`,
 * `.orca/program/…` from the workspace, which is the store when the workspace is the config
 * directory). Not even readable: `auth/`, where `orca serve` keeps the local owner token, and
 * the store's two private directories, which hold its encryption keys and the payloads they
 * protect (`private-execution` and `private-workflows` in `@orca/store`), and the whole-store
 * format backups, which copy them (`format-backups`), and the tool-call diagnostics ORCA keeps
 * about the agent's own calls (`diagnostics`, #1000).
 */
export function orcaProtectedPaths(layout: OrcaFileLayout): ProtectedPaths {
  const configDir = resolve(layout.configDir);
  const storeDir = resolve(configDir, layout.storeDir);
  return {
    readOnly: [
      ...[...new Set([...CONFIG_FILENAMES, ...LEGACY_CONFIG_FILENAMES])].map((name) => join(configDir, name)),
      ...(layout.configFile ? [resolve(layout.configFile)] : []),
      ...permissionPolicyPaths(configDir),
      storeDir,
    ],
    noAccess: [
      join(configDir, "auth"),
      join(storeDir, "private-execution"),
      join(storeDir, "private-workflows"),
      // Whole-store copies (#566), private directories included.
      join(storeDir, STORE_FORMAT_BACKUP_DIR),
      // Tool-call telemetry (#1000): what hooks reported about the agent's own calls.
      join(storeDir, DIAGNOSTICS_DIR),
    ],
    agentAreas: [join(storeDir, "work"), join(storeDir, "program")],
  };
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

/** The version recorded in the store marker; a bundle without the root manifest records "unknown". */
function storeWriterVersion(): string {
  try {
    return readOrcaVersion();
  } catch {
    return "unknown";
  }
}

/**
 * The stores, holding `hold` (this process's writer registration) until they are closed or the
 * process exits; released at once when they cannot be opened.
 */
function registeredUntilClosed(hold: StoreWriterHold | undefined, open: () => Stores): Stores {
  if (!hold) return open();
  let stores: Stores;
  try {
    stores = open();
  } catch (error) {
    hold.release();
    throw error;
  }
  return {
    ...stores,
    close: () => {
      try {
        stores.close?.();
      } finally {
        hold.release();
      }
    },
  };
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<OrcaApp> {
  const cwd = opts.cwd ?? process.cwd();
  const { config, configDir, configFile } = opts.config
    ? {
        config: await withAdoptedStoreDir(opts.config, opts.configDir ?? cwd, !opts.ephemeral),
        configDir: opts.configDir ?? cwd,
        configFile: undefined,
      }
    : await loadConfig(cwd, opts.configPath, { adoptStoreDir: !opts.ephemeral });
  const firstRunLaunch = process.env.ORCA_FIRST_RUN_LAUNCH;
  delete process.env.ORCA_FIRST_RUN_LAUNCH;
  // The desktop app asks for its store's switch to SQLite on one launch (#339); never inherited.
  const storeSwitch = parseStoreSwitchRequest(process.env[STORE_SWITCH_ENV]);
  delete process.env[STORE_SWITCH_ENV];
  await enterConfiguredUpdateBootstrap(resolve(configDir), resolve(configDir, config.storeDir));
  if (isClosedUpdateBootstrap() && config.plugins.length)
    throw new OrcaError("CONFIG_INVALID", "Closed replacement cannot execute uncertified plugin initialization");
  if (isClosedUpdateBootstrap())
    await enterClosedFirstRunInspection(resolve(configDir), resolve(configDir, config.storeDir), () =>
      closedUpdateOwnsConfiguredRoots(configDir, resolve(configDir, config.storeDir)),
    );
  const writer = isClosedUpdateBootstrap()
    ? undefined
    : await enterFirstRunWriter(resolve(configDir), resolve(configDir, config.storeDir), firstRunLaunch);
  // Before any store reader or writer (#566): refuse a store this build cannot open, including
  // an older format, which only `orca store carry-forward` converts, or the desktop app's daemon
  // on the first start after an update while it holds the store's writer fence (#897). Closed
  // update validation only checks; an ephemeral bootstrap never opens the store at all.
  let backend: StoreBackend = "file";
  // A writer registers for as long as it has the store open (#339, store-writers.ts), so a
  // switch of the store's metadata backend never runs beside it, idle or not. Registered after
  // the format check, then the backend is read again: a switch that finished in between is seen
  // in the marker, one still running in its announcement.
  let writerHold: StoreWriterHold | undefined;
  let storeSwitchOutcome: DesktopSqliteSwitchOutcome | undefined;
  if (!opts.ephemeral) {
    const storeDir = resolve(configDir, config.storeDir);
    ({ backend } = await enterDaemonStoreFormat(
      storeDir,
      writer,
      storeWriterVersion(),
      isClosedUpdateBootstrap() ? "read" : "write",
    ));
    // Before this process registers as a writer: the switch refuses while any writer is alive.
    // Only from the backend the store is on: a request for where it already is changes nothing.
    if (storeSwitch && !isClosedUpdateBootstrap() && backend === (storeSwitch.to === "sqlite" ? "file" : "sqlite")) {
      storeSwitchOutcome = await desktopSqliteSwitch(storeDir, writer, storeWriterVersion(), storeSwitch);
      backend = recordedStoreBackend(storeDir) ?? "file";
    }
    if (!isClosedUpdateBootstrap()) {
      writerHold = holdStoreWriter(storeDir, { appVersion: storeWriterVersion(), purpose: "orca" });
      if ((recordedStoreBackend(storeDir) ?? "file") !== backend) {
        writerHold.release();
        throw new OrcaError(
          "STORE_FORMAT",
          `${storeDir} was switched to another metadata backend while ORCA was starting; start again.`,
          { reason: "OTHER_BACKEND", storeDir },
        );
      }
    }
  }
  // Only the app's own workspace (its writer fence held) may be switched in place, never on
  // Windows (#947): to SQLite while it is on files, back to files while it is on SQLite.
  const switchable = Boolean(writer) && process.platform !== "win32";
  const storeStatus: StoreStatus | undefined =
    opts.ephemeral || isClosedUpdateBootstrap()
      ? undefined
      : {
          backend,
          sqliteSwitch: switchable && backend === "file" ? "available" : "unavailable",
          filesSwitch: switchable && backend === "sqlite" ? "available" : "unavailable",
          ...(storeSwitchOutcome ? { lastSwitch: storeSwitchOutcome } : {}),
        };
  const logger = opts.logger ?? consoleLogger(opts.logLevel ?? "info");
  if (storeSwitchOutcome?.status === "refused")
    logger.warn(
      storeSwitchOutcome.to === "sqlite"
        ? `store stays on files, not switched to SQLite (${storeSwitchOutcome.reason}): ${storeSwitchOutcome.message}`
        : `store stays on SQLite, not switched back to files (${storeSwitchOutcome.reason}): ${storeSwitchOutcome.message}`,
    );
  else if (storeSwitchOutcome?.status === "switched")
    logger.info(
      storeSwitchOutcome.to === "sqlite" ? "store switched to SQLite metadata" : "store switched back to files",
    );
  const agents = AgentRegistry.fromConfig(config, { configDir: resolve(configDir) });
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
  // The store's own marker says which metadata backend it runs on (#339, store-backend.ts):
  // files, or SQLite once `orca store sqlite switch` has moved it. Closed update validation
  // opens a SQLite store read-only, as it opens everything else.
  const stores = registeredUntilClosed(writerHold, () =>
    opts.ephemeral
      ? memoryStores()
      : backend === "sqlite"
        ? sqliteStores(resolve(configDir, config.storeDir), {
            logger: logger.child({ component: "store" }),
            ...(isClosedUpdateBootstrap() ? { readOnly: true } : {}),
          })
        : fileStores(resolve(configDir, config.storeDir), undefined, logger.child({ component: "store" })),
  );
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
  if (opts.installedPluginRelease && opts.verifyPluginRestorationIdentity)
    throw pluginRestorationRefusal("identity_unverified");
  const installedRelease = opts.installedPluginRelease
    ? await loadInstalledPluginRelease(opts.installedPluginRelease, pluginEntries ?? [])
    : undefined;
  const verifyPluginIdentity = installedRelease?.verify ?? opts.verifyPluginRestorationIdentity;
  const loadedPlugins = await loadPlugins(config, configDir, api, logger, installedRelease, pluginEntries);
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
  const pluginRestoration = await capturePluginRestoration(loadedPlugins, unsupportedRestoration, verifyPluginIdentity);
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
      checkCapabilities: capabilityChecker(agents),
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

  for (const problem of validateRemotes(config)) problems.push(problem);
  if (problems.length)
    throw new OrcaError("CONFIG_INVALID", `remote validation failed:\n${problems.map((p) => "  - " + p).join("\n")}`, {
      problems,
    });
  // `type: orca-daemon` agents open a session on their remote daemon (#883); every other agent
  // goes to the ACP factory unchanged. The remotes are read at each open, so an applied config
  // edit reaches the next session.
  let currentRemotes = () => config.remotes;
  // Each remote daemon's session cap, as its hello reports it (#884), for the slot queue.
  const remoteCapacity = new RemoteCapacity();
  const delegating = (base: SessionFactory): SessionFactory =>
    delegatingSessionFactory(base, {
      remotes: () => currentRemotes(),
      configDir,
      receiptsDir: resolve(configDir, config.storeDir, "delegations"),
      workspaceId: () => workspaceIdentity(resolve(configDir, config.storeDir)),
      capacity: remoteCapacity,
    });
  const openSession = delegating(makeSessionFactory({ configDir, storeDir: config.storeDir, configFile }));
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
    remoteSessionCap: (remoteId) => remoteCapacity.cap(remoteId),
    // An ephemeral bootstrap deliberately gets none: it is a one-shot over in-memory stores
    // (`orca agent ping`), and standing grants a workspace recorded for its real runs are
    // durable workspace state of exactly the kind `ephemeral` means to leave alone.
    ...(opts.ephemeral
      ? // The bare ACP factory, no sidecar; delegating only when there is a remote to go to.
        config.remotes.length
        ? { sessionFactory: delegating(openAcpSession) }
        : {}
      : {
          sessionFactory: (options: OpenSessionOptions) => {
            const current = agents.resolve(options.agent.id).agent;
            return openSession({
              ...options,
              agent: { ...options.agent, permissions: current.permissions },
            });
          },
        }),
    ...(opts.lease ? { lease: opts.lease } : {}),
  });
  remoteCapacity.onChange(() => orchestrator.sessionSlots.pump());
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
      return restorePluginExecutors(snapshot.pluginRestoration, loadedPlugins, verifyPluginIdentity);
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
  currentRemotes = () => generations.current.snapshot.config.remotes;
  // Session caps are read from the current generation (#873): an applied edit that raises
  // one lets the steps queued for it go now rather than at the next release.
  generations.onChange(() => orchestrator.sessionSlots.pump());
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
  // Secret references (#336): every local path - run, submit, resume, answer - decides from
  // the root owner's durable record and current credentials. `orca serve` replaces it with
  // the daemon's own. An ephemeral orchestrator (`orca agent ping`) has none: it never delivers.
  // Catalog MCP servers (#337) are decided the same way, from the same files.
  if (!opts.ephemeral) {
    const local = { configDir, storeDir: resolve(configDir, config.storeDir), orchestrator };
    orchestrator.secretUse = localSecretUse(local);
    orchestrator.capabilityUse = localCapabilityUse(local);
  }
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
  const checkpointAdmissions = retryClaims
    ? new CheckpointAdmissionService({ orchestrator, retries: retryClaims })
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
    async closedWorkState() {
      try {
        const retry = retryClaimStore ? await retryClaimStore.closedWorkState() : "unsupported-generation";
        if (retry !== "empty") return retry;
        const admissions = await submission.admissions.records.list();
        if (admissions.length) return "parked";
        const ids = await orchestrator.listRuns();
        // Retained runs may carry generations, continuations or protected input.
        // This initial native binding supports empty work only, without replay/restoration.
        return ids.length ? "parked" : "empty";
      } catch {
        return "unsupported-generation";
      }
    },
    directAdmissions,
    checkpointAdmissions,
    retrySafeAdmissions:
      directAdmissions && program.submissions
        ? new RetrySafeAdmissionService({ requests: program.submissions, direct: directAdmissions })
        : undefined,
    configDir,
    ...(configFile ? { configFile } : {}),
    ...(storeSwitchOutcome ? { storeSwitch: storeSwitchOutcome } : {}),
    ...(storeStatus ? { storeStatus } : {}),
    ...(writer ? { firstRunWriter: writer } : {}),
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
  installedRelease?: VerifiedPluginRelease,
  entries?: readonly { spec: string; url: string; digest: string }[],
): Promise<LoadedRestorationPlugin[]> {
  const loaded: LoadedRestorationPlugin[] = [];
  for (const spec of config.plugins) {
    const identity = installedRelease?.identityFor(spec);
    const entry = entries?.find((candidate) => candidate.spec === spec);
    if (installedRelease && (!identity || !entry)) throw pluginRestorationRefusal("identity_unverified");
    // A digest-qualified URL cannot adopt an earlier module-cache entry after bytes change at the same path.
    const importUrl =
      installedRelease && entry ? `${entry.url}?orca-plugin-release=${entry.digest}` : pluginSpecifier(spec, configDir);
    const mod = (await import(importUrl)) as { default?: OrcaPlugin };
    if (!mod.default?.register)
      throw new OrcaError("CONFIG_INVALID", `plugin ${spec} has no default OrcaPlugin export`);
    const before = new Map(api.executors.types().map((type) => [type, api.executors.get(type)]));
    const pluginApi = installedRelease ? { ...api } : api;
    if (identity) Object.defineProperty(pluginApi, "restorationIdentity", { value: identity, enumerable: true });
    await mod.default.register(pluginApi);
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
