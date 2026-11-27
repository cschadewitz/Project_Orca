/**
 * The Claude Agent SDK session driver (#1120, tracking #1153).
 *
 * One ORCA session is one streaming-input `query()` of the Claude Agent SDK, which runs the
 * person's own `claude` (already resolved and checked by `claudeSdkPreflight`, #1118) with
 * `--input-format stream-json`. ORCA owns that process: it is spawned here, in its own process
 * group, so closing the session ends Claude and everything it started.
 *
 * - **Turns.** `prompt` sends one user message and settles on the turn's `result` message.
 *   `cancel` (or the prompt's signal or timeout) asks the SDK to `interrupt()`; a turn that
 *   still has not ended `cancelGraceMs` later is failed and the process stopped.
 * - **Updates.** Assistant text and thinking blocks, tool uses, tool results and `TodoWrite`
 *   plans are mapped to the ACP session updates every other ORCA session reports.
 * - **Model and effort.** The models Claude Code lists at `initialize` become a `model` option
 *   (`setModel`), and a model's effort levels an `effort` option (`applyFlagSettings`), so a
 *   run's model selection (#187) reaches Claude.
 * - **Fixed setup.** No settings files (`settingSources: []`), no MCP servers, Claude Code's own
 *   system prompt, permission mode `default`.
 * - **Resume (#1121).** Claude Code keeps each session's transcript where it always does (its
 *   own config directory), under the id ORCA chose for it, which is the session's
 *   `acpSessionId`. `resumeSessionId` opens that transcript again (`resume`), with the same
 *   guarantees as the ACP route's `session/load`: when recovery is required a failed or timed-out
 *   resume is refused and no fresh session is opened; otherwise it falls back to a fresh session
 *   and `onSessionContinuity` says so. Only a UUID is passed on: Claude Code would also resume
 *   a session by its title, which ORCA never asks for.
 * - **Tools (#1122).** Every tool call is decided by ORCA's permission policy, its people and
 *   the run's answerer, in a `PreToolUse` hook and in `canUseTool` (`permission-bridge.ts`).
 *   An allow is for one call only: Claude is never told to remember it.
 *
 * Nothing Claude prints reaches an ORCA error: the CLI's output is untrusted, and its stderr is
 * not read at all.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import {
  query,
  type Query,
  type SDKControlInitializeResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  configOptionValues,
  newId,
  OrcaError,
  silentLogger,
  systemClock,
  type AgentSpec,
  type Clock,
  type HookTelemetryLine,
  type JudgedDecision,
  type Logger,
  type SessionConfigOption,
} from "@orca/core";
import { contextRecoveryFailure, type PermissionInvocation, type SessionContinuity } from "../acp-session.js";
import { redactError, redactingLogger } from "../secrets.js";
import { redactSecretValues } from "@orca/core";
import type { AgentHost } from "../host.js";
import { createMcpRelay, type McpRelay, type RelayedMcpServer } from "../mcp-relay.js";
import { ORCA_CLIENT_INFO } from "../acp-session.js";
import { checkClaudeSdkMcpServers, claudeSdkMcpServers } from "./mcp-servers.js";
import type { PermissionRuleRecord, ProtectedPaths } from "../permissions.js";
import {
  startupTermination,
  summarizeUpdate,
  withStartupTermination,
  type AgentSession,
  type PromptOptions,
  type SessionUpdateEvent,
  type TurnResult,
} from "../session.js";
import {
  CLAUDE_SDK_DEFAULT_EFFORT,
  CLAUDE_SDK_MODEL_OPTION,
  claudeModelChoices,
  claudeSdkConfigOptions,
  effortFits,
  initialModel,
  type ClaudeEffort,
} from "./config-options.js";
import type { ClaudeSdkPreflight } from "./launch.js";
import { claudeSdkPermissionBridge } from "./permission-bridge.js";
import { inProcessHookTelemetry } from "./tool-telemetry.js";
import { attestClaudeSdkRuntime, type ClaudeSdkRuntimeAttestation, type ClaudeSdkVerifiedPair } from "./attestation.js";

export interface ClaudeSdkSessionOptions {
  agent: Pick<AgentSpec, "id" | "cancelGraceMs"> & Partial<Pick<AgentSpec, "permissions">>;
  hostId: string;
  cwd: string;
  /** What `claudeSdkPreflight` found: the executable to run and the environment to run it with. */
  preflight: Pick<ClaudeSdkPreflight, "executable" | "env"> & Partial<Pick<ClaudeSdkPreflight, "version">>;
  /**
   * Which Claude Code the session runs (#1124), attested from ORCA's own side once it has
   * answered `initialize`. `required`: the session is refused, before any work, unless the
   * image is the one pinned for this SDK and Claude Code version; otherwise a mismatch is only
   * logged. `pairs` replaces the pinned pairs (tests). `onResult` receives the outcome.
   */
  runtimeAttestation?:
    | {
        required?: boolean | undefined;
        pairs?: readonly ClaudeSdkVerifiedPair[] | undefined;
        onResult?: ((result: ClaudeSdkRuntimeAttestation) => void) | undefined;
      }
    | undefined;
  /** ORCA's own files, which no rule opens to a tool call (C4-01). */
  protectedPaths?: ProtectedPaths | undefined;
  /** Permission sidecars layered under the agent's configured rules, read again for every call. */
  permissionFiles?: readonly string[] | undefined;
  /** The run's answerer for a call ORCA's policy asks about; absent, such a call is denied. */
  askPermission?:
    | ((
        req: acp.RequestPermissionRequest,
        invocation?: PermissionInvocation,
        judged?: JudgedDecision,
      ) => Promise<string | undefined>)
    | undefined;
  /** Each permission decision, for the run log. */
  onPermission?:
    ((info: { toolCallId?: string; title: string; decision: string; rule?: PermissionRuleRecord }) => void) | undefined;
  /** The `acpSessionId` of an earlier session to continue (#1121). Explicit opt-in only. */
  resumeSessionId?: string | undefined;
  /** Refuse to open at all unless `resumeSessionId` is resumed; never fall back to a fresh session. */
  requireContextRecovery?: boolean | undefined;
  /** Whether the session continued an earlier one, told once it is open. */
  onSessionContinuity?: ((state: SessionContinuity) => void) | undefined;
  /** More directories Claude may work in beside `cwd` (Claude Code's `additionalDirectories`). */
  additionalDirectories?: readonly string[] | undefined;
  /**
   * The values the agent's secret references were delivered (`claudeSdkSecrets`, #1126): taken
   * out of everything this session logs or throws. Never logged or shown.
   */
  secretValues?: readonly string[] | undefined;
  /**
   * The agent's MCP servers, their secrets filled in (#1125). ORCA runs each one itself through
   * its MCP relay, on `host`, and Claude is given only an in-process SDK server by that name.
   */
  mcpServers?: readonly RelayedMcpServer[] | undefined;
  /** Where ORCA runs the MCP servers: the session's own host (ORCA's machine). */
  host?: AgentHost | undefined;
  /** Variables of ORCA's environment kept from Claude, and so from its MCP servers. */
  withheldEnv?: readonly string[] | undefined;
  /**
   * `keep`: the in-process hook records one line per decided call (#1123), which the session
   * offers as `hookTelemetry` for the engine to store (`diagnostics.toolCalls`). Off by default.
   */
  toolCallTelemetry?: "off" | "keep" | undefined;
  /** Aborts the open while it is starting. */
  signal?: AbortSignal | undefined;
  logger?: Logger | undefined;
  clock?: Clock | undefined;
  /** How long `claude` has to answer the SDK's `initialize`. */
  startupTimeoutMs?: number | undefined;
  /** How long a turn has to end after an interrupt. Default: the agent's `cancelGraceMs`. */
  cancelGraceMs?: number | undefined;
  /** How long `claude` has to exit after its input ends before its process group is killed. */
  exitGraceMs?: number | undefined;
}

export const CLAUDE_SDK_STARTUP_TIMEOUT_MS = 30_000;
export const CLAUDE_SDK_EXIT_GRACE_MS = 5_000;
/** How long cleanup waits for the exit after the kill before it gives up observing it. */
const KILL_SETTLE_MS = 1_000;

interface ActiveTurn {
  /** Which turn a permission ask belongs to. */
  id: string;
  /** Aborted when the turn ends or is cancelled: its asks are retired. */
  abort: AbortController;
  started: number;
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  cancelReason?: string;
  grace?: ReturnType<typeof setTimeout>;
}

/**
 * The refusal on Windows. A session owns Claude and everything it starts through a POSIX process
 * group; Windows has no tested equivalent yet (a job object), so nothing is launched there.
 */
export function claudeSdkPlatformUnsupported(agentId: string): OrcaError {
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agentId} has driver: claude-agent-sdk, which runs only on Linux and macOS for now: ` +
      `on Windows ORCA cannot yet stop everything Claude starts. Leave driver out to run Claude over ACP.`,
    { agentId, platform: process.platform },
  );
}

/** A Claude Code session id: what ORCA gives Claude Code and the only thing it resumes. */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Open a session that runs Claude through the Claude Agent SDK, continuing one when asked (#1121).
 * With `secretValues` (#1126), as on the ACP route, every error the open or a later call throws
 * and everything the session logs has those values taken out, so a caller can return or write it
 * as it is.
 */
export async function openClaudeSdkSession(options: ClaudeSdkSessionOptions): Promise<AgentSession> {
  const values = [...(options.secretValues ?? [])].filter((v) => v.length > 0);
  if (values.length === 0) return openClaudeSdkContinuing(options);
  const redacted = <T>(work: () => Promise<T>) =>
    work().catch((error: unknown) => {
      throw redactError(error, values);
    });
  const session = await redacted(() =>
    openClaudeSdkContinuing({
      ...options,
      logger: redactingLogger(options.logger ?? silentLogger, () => values),
    }),
  );
  for (const method of ["prompt", "setConfigOption", "cancel", "close"] as const) {
    const original = session[method].bind(session) as (...args: unknown[]) => Promise<unknown>;
    (session as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => redacted(() => original(...args));
  }
  return session;
}

async function openClaudeSdkContinuing(options: ClaudeSdkSessionOptions): Promise<AgentSession> {
  const resume = options.resumeSessionId?.trim() ? options.resumeSessionId : undefined;
  const required = options.requireContextRecovery === true;
  if (required && !resume) throw contextRecoveryFailure("missing-session-id");
  // The open decides the session and its continuity; only then is the observer told, outside the
  // load and its fallback. An observer that throws fails the open: the session it was told about
  // is closed and its process awaited, and the error is the caller's, never a load failure.
  const opened = async (session: AgentSession, continuity: SessionContinuity): Promise<AgentSession> => {
    try {
      options.onSessionContinuity?.(continuity);
    } catch (error) {
      await session.close().catch(() => undefined);
      throw withStartupTermination(
        error instanceof Error ? error : new OrcaError("INTERNAL", "the session continuity observer failed"),
        session.terminated ?? Promise.resolve(),
      );
    }
    return session;
  };
  if (!resume) return opened(await openClaudeSdkProcess(options, undefined), { mode: "fresh", reason: "new" });
  if (CLAUDE_SESSION_ID.test(resume)) {
    let resumed: AgentSession | undefined;
    try {
      resumed = await openClaudeSdkProcess(options, resume);
    } catch (error) {
      // A cancelled open, or one refused before Claude Code started, is the open's own failure.
      if (error instanceof OrcaError && error.code === "CANCELLED") throw error;
      if (error instanceof OrcaError && error.code === "NOT_SUPPORTED") throw error;
      const exit = startupTermination(error) ?? Promise.resolve();
      if (required) {
        const timedOut = error instanceof OrcaError && error.details?.["startup"] === "timeout";
        throw withStartupTermination(contextRecoveryFailure(timedOut ? "load-timeout" : "load-failed"), exit);
      }
      // One Claude Code at a time: the fresh one starts once the refused one is gone.
      await exit.catch(() => undefined);
    }
    if (resumed) return opened(resumed, { mode: "loaded", reason: "load-supported" });
  } else if (required) throw contextRecoveryFailure("load-failed");
  return opened(await openClaudeSdkProcess(options, undefined), { mode: "fresh", reason: "load-failed" });
}

/** One Claude Code process and its `query()`: a new session, or `resume`'s transcript continued. */
async function openClaudeSdkProcess(
  options: ClaudeSdkSessionOptions,
  resume: string | undefined,
): Promise<AgentSession> {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const { executable, env } = options.preflight;
  const cwd = options.cwd;
  const cancelGraceMs = options.cancelGraceMs ?? options.agent.cancelGraceMs;
  const exitGraceMs = options.exitGraceMs ?? CLAUDE_SDK_EXIT_GRACE_MS;

  if (process.platform === "win32") throw claudeSdkPlatformUnsupported(options.agent.id);
  checkClaudeSdkMcpServers(options.agent.id, options.mcpServers ?? []);
  if (options.signal?.aborted)
    throw new OrcaError("CANCELLED", `opening agent ${options.agent.id} was cancelled before it started`);

  // ---- the owned process ------------------------------------------------------------------
  let child: ChildProcess | undefined;
  let spawned = false;
  let exitObserved = false;
  let resolveExit: () => void = () => undefined;
  const exited = new Promise<void>((r) => (resolveExit = r));
  const markExited = () => {
    exitObserved = true;
    resolveExit();
  };
  const killGroup = (signal: NodeJS.Signals) => {
    const pid = child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
  };
  const spawnClaude = (o: SpawnOptions): SpawnedProcess => {
    if (spawned)
      throw new OrcaError("AGENT_PROTOCOL", "the Claude Agent SDK asked to start a second claude for one session");
    if (o.command !== executable)
      throw new OrcaError(
        "AGENT_PROTOCOL",
        "the Claude Agent SDK asked to start a program other than the checked claude",
        {
          executable,
        },
      );
    spawned = true;
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined) childEnv[k] = v;
    const proc = spawn(o.command, o.args, {
      cwd: o.cwd ?? cwd,
      env: childEnv,
      // stderr is not read: nothing the CLI prints is kept (see the module comment).
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
      windowsHide: true,
    });
    child = proc;
    proc.once("exit", markExited);
    proc.once("error", () => {
      // A spawn that failed has no process to wait for.
      if (proc.pid === undefined) markExited();
    });
    // The SDK's forwarded signal fires only after its own stdin-EOF grace: stop everything.
    o.signal.addEventListener("abort", () => killGroup("SIGKILL"), { once: true });
    return proc;
  };
  // Once the process is gone, anything it started in its group goes too.
  const terminated: Promise<void> = exited.then(() => killGroup("SIGKILL"));

  // ---- input, permissions, the query --------------------------------------------------------
  const id = newId("sess", clock.now());
  /** Claude Code's own session id: the transcript it keeps, and what a later session resumes. */
  const acpSessionId = resume ?? randomUUID();
  const input = new InputQueue();
  const abort = new AbortController();
  let activeTurn: ActiveTurn | undefined;
  /** Which tool call started the subagent that made a tool call, from the stream (this turn's). */
  const parents = new Map<string, string>();
  // Set once the session is up; an ask before then has no turn and is denied anyway.
  let failAsk: (turnId: string, error: unknown) => void = () => undefined;
  /** Aborted when the session ends: its MCP servers serve nothing after it (#1125). */
  const sessionLive = new AbortController();
  const telemetry = options.toolCallTelemetry === "keep" ? inProcessHookTelemetry() : undefined;
  const { preToolUse, canUseTool, authorizeMcp } = claudeSdkPermissionBridge({
    agent: options.agent,
    sessionId: id,
    cwd,
    protectedPaths: options.protectedPaths,
    permissionFiles: options.permissionFiles,
    askPermission: options.askPermission,
    onPermission: options.onPermission,
    liveTurn: () =>
      activeTurn && !activeTurn.cancelReason && !activeTurn.abort.signal.aborted
        ? { id: activeTurn.id, signal: activeTurn.abort.signal }
        : undefined,
    parentOf: (toolUseId) => parents.get(toolUseId),
    onAskFailed: (turnId, error) => failAsk(turnId, error),
    sessionSignal: sessionLive.signal,
    additionalDirectories: options.additionalDirectories,
    ...(telemetry ? { onToolCallTelemetry: (line: HookTelemetryLine) => telemetry.record(line) } : {}),
    logger,
  });
  // ORCA's MCP relay (#1125): the real servers run on ORCA's side, started only for a request
  // the bridge allows; Claude is told a name and nothing else.
  const mcpServers = options.mcpServers ?? [];
  // Admitted once Claude has answered `initialize` and the session is ready, refused if it never
  // gets there or teardown begins first: no server starts for a session that is not open.
  let admit: (ready: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((r) => (admit = r));
  let relay: McpRelay | undefined;
  /** Every value the session read, the servers' own included: none of them reaches Claude through a server. */
  const mcpSecretValues = [...(options.secretValues ?? [])];
  if (mcpServers.length > 0) {
    if (!options.host)
      throw new OrcaError("INTERNAL", `agent ${options.agent.id}: MCP servers need the session's host to run on`);
    relay = createMcpRelay({
      host: options.host,
      cwd,
      withheldEnv: options.withheldEnv,
      redact: (text) => redactSecretValues(text, mcpSecretValues),
      servers: mcpServers.map((m) => ({ name: m.name, command: m.command, args: [...m.args], env: { ...m.env } })),
      admitted: ready,
      authorize: authorizeMcp,
      logger,
      clientInfo: { ...ORCA_CLIENT_INFO },
      exitGraceMs,
    });
  }
  const q: Query = query({
    prompt: input,
    options: {
      pathToClaudeCodeExecutable: executable,
      env: { ...env },
      cwd,
      ...(options.additionalDirectories?.length ? { additionalDirectories: [...options.additionalDirectories] } : {}),
      abortController: abort,
      permissionMode: "default",
      settingSources: [],
      // Kept, so that a later session can continue it (#1121), as Claude Code does over ACP.
      persistSession: true,
      ...(resume ? { resume } : { sessionId: acpSessionId }),
      // Only ORCA's relayed servers; `strictMcpConfig` keeps every other MCP config out.
      mcpServers: relay
        ? claudeSdkMcpServers(relay, mcpServers, (value) => redactSecretValues(value, mcpSecretValues))
        : {},
      strictMcpConfig: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse], onFailure: "block" }] },
      spawnClaudeCodeProcess: spawnClaude,
    },
  });

  let terminating: Promise<void> | undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  /** End the input, give claude `exitGraceMs` to exit, then kill its group. Settles either way. */
  const terminate = (): Promise<void> =>
    (terminating ??= (async () => {
      // Retired first: nothing new is admitted or started once teardown begins.
      admit(false);
      sessionLive.abort();
      const relayClosed = relay?.close().catch(() => undefined);
      input.end();
      if (spawned && !(await within(exited, exitGraceMs))) {
        logger.warn("claude did not exit after its input ended; killing it", { agentId: options.agent.id });
        killGroup("SIGKILL");
        abort.abort();
        await within(exited, KILL_SETTLE_MS);
      }
      abort.abort();
      try {
        q.close();
      } catch {
        // already closed
      }
      await relayClosed;
      // The last lines the hook recorded are handed over before the session counts as closed.
      await telemetry?.finish();
      resolveClosed();
    })());

  // ---- startup ---------------------------------------------------------------------------
  const startupTimeoutMs = options.startupTimeoutMs ?? CLAUDE_SDK_STARTUP_TIMEOUT_MS;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let onOpenAbort: (() => void) | undefined;
  let initResult: SDKControlInitializeResponse;
  try {
    // Each loser of the race below must not become an unhandled rejection later.
    const initialized = q.initializationResult();
    initialized.catch(() => undefined);
    const exitedFirst = exited.then(() => Promise.reject(startupFailure("exited before it answered")));
    exitedFirst.catch(() => undefined);
    initResult = await Promise.race([
      initialized,
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(startupFailure("did not answer in time", { startup: "timeout" })),
          startupTimeoutMs,
        );
        onOpenAbort = () => reject(new OrcaError("CANCELLED", `opening agent ${options.agent.id} was cancelled`));
        options.signal?.addEventListener("abort", onOpenAbort, { once: true });
      }),
      exitedFirst,
    ]);
  } catch (e) {
    const error = e instanceof OrcaError ? e : startupFailure("refused to start a session", { sdkError: errorName(e) });
    await terminate();
    throw withStartupTermination(error, spawned && !exitObserved ? terminated : Promise.resolve());
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    if (onOpenAbort) options.signal?.removeEventListener("abort", onOpenAbort);
  }

  function startupFailure(what: string, details: Record<string, unknown> = {}): OrcaError {
    return new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${options.agent.id}: Claude Code (${executable}) ${what} when the Claude Agent SDK started it`,
      { agentId: options.agent.id, executable, ...details },
    );
  }

  // ---- which Claude Code runs (#1124) ---------------------------------------------------------
  const attestation = attestClaudeSdkRuntime({
    pid: child?.pid,
    claudeCodeVersion: options.preflight.version,
    pairs: options.runtimeAttestation?.pairs,
  }).then((result) => {
    try {
      options.runtimeAttestation?.onResult?.(result);
    } catch {
      // An observer's failure is not the session's.
    }
    return result;
  });
  if (options.runtimeAttestation?.required) {
    const result = await attestation;
    if (!result.verified) {
      await terminate();
      throw withStartupTermination(
        new OrcaError(
          "NOT_SUPPORTED",
          `agent ${options.agent.id} has nativeToolHook: experimental, but the Claude Code it runs is not one ORCA verified: ${result.reason}. ` +
            `ORCA refuses the session rather than run it unattested; use the pinned Claude Code (docs/agents/claude-agent-sdk.md), or remove nativeToolHook.`,
          { agentId: options.agent.id, executable, reason: result.reason },
        ),
        spawned && !exitObserved ? terminated : Promise.resolve(),
      );
    }
  } else
    void attestation.then((result) => {
      if (!result.verified)
        logger.warn("the Claude Code this session runs is not one ORCA verified", {
          agentId: options.agent.id,
          reason: result.reason,
        });
    });

  // ---- the session -----------------------------------------------------------------------
  admit(true);
  const models = claudeModelChoices(initResult.models);
  let model = initialModel(models);
  let effort = CLAUDE_SDK_DEFAULT_EFFORT;
  let configOptions = claudeSdkConfigOptions(models, model, effort);
  /** One change at a time, so the SDK and the options never disagree about the order. */
  let configChain: Promise<unknown> = Promise.resolve();
  const configRefusal = (configId: string, value: unknown, why: string, details: Record<string, unknown> = {}) =>
    new OrcaError(
      "AGENT_PROTOCOL",
      `agent '${options.agent.id}' rejected session/set_config_option ${configId}=${String(value)}: ${why}`,
      { configId, value, ...details },
    );
  const sendEffort = (next: string) =>
    q.applyFlagSettings({ effortLevel: next === CLAUDE_SDK_DEFAULT_EFFORT ? null : (next as ClaudeEffort) });
  /** Changes asked for and not yet settled: no turn starts then, and no change starts during a turn. */
  let configPending = 0;
  const setOption = async (configId: string, value: string | boolean): Promise<SessionConfigOption[]> => {
    if (ended || terminating)
      throw new OrcaError("AGENT_TRANSPORT", `agent ${options.agent.id}: the session has ended`);
    if (activeTurn)
      throw new OrcaError(
        "RUN_STATE",
        `agent ${options.agent.id}: a turn is running; change ${configId} after it ends`,
      );
    if (typeof value !== "string") throw configRefusal(configId, value, "it takes a value from its list");
    const option = configOptions.find((o) => o.id === configId);
    if (!option) throw configRefusal(configId, value, "the session has no such option");
    const offered = configOptionValues(option).map((o) => o.value);
    if (!offered.includes(value))
      throw configRefusal(configId, value, `offered: ${offered.join(", ")}`, { available: offered });
    const nextModel = configId === CLAUDE_SDK_MODEL_OPTION ? value : model!;
    // An effort the new model does not take goes back to the default, which every model takes,
    // so it is set first, while the old model is still on: then only the model call is left.
    const nextEffort =
      configId === CLAUDE_SDK_MODEL_OPTION
        ? effortFits(models, value, effort)
          ? effort
          : CLAUDE_SDK_DEFAULT_EFFORT
        : value;
    {
      let effortSent = false;
      try {
        if (nextEffort !== effort) {
          await sendEffort(nextEffort);
          effortSent = true;
        }
        if (nextModel !== model) await q.setModel(nextModel);
      } catch (e) {
        // Put back what was already changed. If that fails too, ORCA no longer knows what Claude
        // runs on, so the session is stopped rather than left in a state nobody chose.
        if (effortSent) {
          try {
            await sendEffort(effort);
          } catch {
            logger.warn("claude did not take back an effort change; stopping the session", {
              agentId: options.agent.id,
            });
            void terminate();
            throw new OrcaError(
              "AGENT_TRANSPORT",
              `agent ${options.agent.id}: Claude Code took part of the change ${configId}=${value} and refused to undo it; the session was stopped`,
              { configId, value, sdkError: errorName(e) },
            );
          }
        }
        throw configRefusal(configId, value, "Claude Code refused it", { sdkError: errorName(e) });
      }
      model = nextModel;
      effort = nextEffort;
      configOptions = claudeSdkConfigOptions(models, model, effort);
      return configOptions;
    }
  };
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  const tools = new Map<string, string>();
  let ended: Error | undefined;

  const emit = (raw: acp.SessionUpdate) => {
    const event: SessionUpdateEvent = { sessionId: id, raw, summary: summarizeUpdate(raw), at: clock.now() };
    for (const l of listeners) {
      try {
        l(event);
      } catch (e) {
        logger.warn("session update listener threw", { error: String(e) });
      }
    }
  };

  const settle = (turn: ActiveTurn, outcome: TurnResult | Error) => {
    if (activeTurn !== turn) return;
    activeTurn = undefined;
    turn.abort.abort("turn ended");
    parents.clear();
    if (turn.grace) clearTimeout(turn.grace);
    if (outcome instanceof Error) turn.reject(outcome);
    else turn.resolve(outcome);
  };

  const handle = (m: SDKMessage) => {
    // A subagent's tool calls name the tool call that started it.
    if (m.type === "assistant" && typeof m.parent_tool_use_id === "string")
      for (const block of m.message.content) if (block.type === "tool_use") parents.set(block.id, m.parent_tool_use_id);
    for (const update of sessionUpdates(m, tools)) emit(update);
    if (m.type === "result" && activeTurn) {
      const turn = activeTurn;
      settle(turn, turnOutcome(m, turn, clock.now(), options.agent.id));
    }
  };

  void (async () => {
    let end: OrcaError;
    try {
      for await (const m of q) handle(m);
      end = new OrcaError("AGENT_TRANSPORT", `agent ${options.agent.id}: Claude Code ended the session`);
    } catch (e) {
      end = new OrcaError("AGENT_TRANSPORT", `agent ${options.agent.id}: the Claude Agent SDK session failed`, {
        sdkError: errorName(e),
      });
    }
    ended = end;
    if (activeTurn) settle(activeTurn, end);
    await terminate();
  })();

  const requestCancel = (reason: string) => {
    const turn = activeTurn;
    if (!turn || turn.cancelReason) return;
    turn.cancelReason = reason;
    turn.abort.abort(reason);
    logger.debug("interrupting claude turn", { reason, graceMs: cancelGraceMs });
    void q.interrupt().catch(() => undefined /* the process may already be gone */);
    turn.grace = setTimeout(() => {
      settle(
        turn,
        new OrcaError(
          "AGENT_TRANSPORT",
          `agent ${options.agent.id}: Claude Code did not end its turn within ${cancelGraceMs}ms of an interrupt (${reason}); stopping it`,
          { reason },
        ),
      );
      void terminate();
    }, cancelGraceMs);
  };

  // An answerer that failed fails the live turn it was asked in, as on the ACP route, and the
  // session is retired with it: Claude's turn has not ended, and whatever it sends later must
  // never be taken for the next prompt's (#1306 review).
  failAsk = (turnId, error) => {
    const turn = activeTurn;
    if (!turn || turn.id !== turnId) return;
    ended = new OrcaError(
      "AGENT_TRANSPORT",
      `agent ${options.agent.id}: the session was stopped after its permission answerer failed`,
    );
    settle(
      turn,
      error instanceof Error ? error : new OrcaError("INTERNAL", "permission callback failed", {}, { cause: error }),
    );
    void terminate();
  };

  return {
    id,
    agentId: options.agent.id,
    hostId: options.hostId,
    cwd,
    acpSessionId,
    closed,
    terminated,
    promptCapabilities: { embeddedContext: false },
    ...(telemetry ? { hookTelemetry: telemetry } : {}),
    get configOptions() {
      return configOptions;
    },

    async prompt(promptInput, promptOptions: PromptOptions = {}): Promise<TurnResult> {
      if (ended || terminating)
        throw new OrcaError("AGENT_TRANSPORT", `agent ${options.agent.id}: the session has ended`);
      if (activeTurn) throw new OrcaError("RUN_STATE", "a prompt turn is already active on this session");
      if (configPending > 0)
        throw new OrcaError("RUN_STATE", `agent ${options.agent.id}: a model or effort change is being applied`);
      if (promptOptions.signal?.aborted)
        throw new OrcaError("CANCELLED", String(promptOptions.signal.reason ?? "cancelled"));
      const content = claudeContent(promptInput);
      let turn!: ActiveTurn;
      const done = new Promise<TurnResult>((resolve, reject) => {
        turn = { id: randomUUID(), abort: new AbortController(), started: clock.now(), resolve, reject };
      });
      activeTurn = turn;
      const onAbort = () => requestCancel(`aborted: ${String(promptOptions.signal?.reason ?? "cancelled")}`);
      promptOptions.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = promptOptions.timeoutMs
        ? setTimeout(() => requestCancel(`turn timed out after ${promptOptions.timeoutMs}ms`), promptOptions.timeoutMs)
        : undefined;
      input.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage);
      try {
        return await done;
      } finally {
        if (timer) clearTimeout(timer);
        promptOptions.signal?.removeEventListener("abort", onAbort);
      }
    },

    onUpdate(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    setConfigOption(configId, value) {
      // Counted from the call, so a prompt sent while this change waits its turn is refused too.
      configPending++;
      const next = configChain.then(() => setOption(configId, value)).finally(() => configPending--);
      configChain = next.catch(() => undefined);
      return next;
    },

    async cancel() {
      requestCancel("cancel requested");
    },

    close() {
      return terminate();
    },
  };
}

/** Resolves true when `p` settles within `ms`, false otherwise. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The error's class name only: an SDK message may quote what the CLI printed. */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/** Streaming input for `query()`: one user message per turn, ended when the session closes. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
  private done = false;

  push(m: SDKUserMessage): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: m, done: false });
    } else this.items.push(m);
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiting = r));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

type ClaudeContentBlock =
  { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** An ORCA prompt as Claude message content: text, images, and text resources as text. */
export function claudeContent(input: string | acp.ContentBlock[]): ClaudeContentBlock[] {
  if (typeof input === "string") return [{ type: "text", text: input }];
  return input.map((b): ClaudeContentBlock => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text };
      case "image":
        if (!IMAGE_TYPES.has(b.mimeType))
          throw new OrcaError("NOT_SUPPORTED", `a Claude Agent SDK prompt cannot carry an image of type ${b.mimeType}`);
        return { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } };
      case "resource_link":
        return { type: "text", text: `[${b.name}](${b.uri})` };
      default:
        throw new OrcaError("NOT_SUPPORTED", `a Claude Agent SDK prompt cannot carry a ${b.type} block yet`);
    }
  });
}

const TOOL_KINDS: Record<string, acp.ToolKind> = {
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  Glob: "search",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "think",
};

/** The ACP session updates one SDK message stands for. `tools` remembers tool names by id. */
export function sessionUpdates(m: SDKMessage, tools: Map<string, string>): acp.SessionUpdate[] {
  const updates: acp.SessionUpdate[] = [];
  if (m.type === "assistant") {
    for (const block of m.message.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0)
        updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
      else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0)
        updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
      else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        tools.set(block.id, block.name);
        const rawInput = block.input as Record<string, unknown> | undefined;
        const path = typeof rawInput?.file_path === "string" ? rawInput.file_path : undefined;
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: block.id,
          title: block.name,
          kind: TOOL_KINDS[block.name] ?? "other",
          status: "pending",
          ...(rawInput ? { rawInput } : {}),
          ...(path ? { locations: [{ path }] } : {}),
        });
        const plan = block.name === "TodoWrite" ? planEntries(rawInput) : undefined;
        if (plan) updates.push({ sessionUpdate: "plan", entries: plan });
      }
    }
  } else if (m.type === "user" && Array.isArray(m.message.content)) {
    for (const block of m.message.content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      if (!tools.has(block.tool_use_id)) continue;
      const text = toolResultText(block.content);
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: block.tool_use_id,
        status: block.is_error === true ? "failed" : "completed",
        ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
      });
    }
  }
  return updates;
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text);
  return parts.length ? parts.join("\n") : undefined;
}

const PLAN_STATUS = new Set(["pending", "in_progress", "completed"]);

function planEntries(input: Record<string, unknown> | undefined): acp.PlanEntry[] | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  return (input.todos as Array<Record<string, unknown>>)
    .filter((t) => typeof t?.content === "string")
    .map((t) => ({
      content: t.content as string,
      priority: "medium",
      status: PLAN_STATUS.has(t.status as string) ? (t.status as acp.PlanEntryStatus) : "pending",
    }));
}

/** How a turn ended, from its `result` message: a stop reason, or an error with no CLI text. */
function turnOutcome(
  m: Extract<SDKMessage, { type: "result" }>,
  turn: ActiveTurn,
  now: number,
  agentId: string,
): TurnResult | Error {
  const durationMs = now - turn.started;
  if (turn.cancelReason) return { stopReason: "cancelled", durationMs };
  if (m.subtype === "success" && !m.is_error) {
    const stopReason: acp.StopReason =
      m.stop_reason === "max_tokens" ? "max_tokens" : m.stop_reason === "refusal" ? "refusal" : "end_turn";
    return { stopReason, durationMs };
  }
  if (m.subtype === "error_max_turns") return { stopReason: "max_turn_requests", durationMs };
  return new OrcaError("AGENT_PROTOCOL", `agent ${agentId}: Claude ended the turn with an error (${m.subtype})`, {
    agentId,
    subtype: m.subtype,
  });
}
