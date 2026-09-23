/**
 * ACP client implementation of AgentSession.
 *
 * Lifecycle: spawn process on host -> initialize -> session/new -> N prompt
 * turns -> close. ORCA serves the agent's `fs/*` requests from the host file
 * system (scoped to the session cwd) and answers `session/request_permission`
 * through the agent's PermissionPolicy — configured rules, then whatever the
 * permission sidecars say at that moment, then the defaults (ADR 0009, #271).
 */
import { isAbsolute, relative } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  newId,
  OrcaError,
  silentLogger,
  systemClock,
  type AgentSpec,
  type Clock,
  type Logger,
  type SessionConfigOption,
} from "@orca/core";
import { normalizeConfigOption, normalizeSessionConfig } from "./config-options.js";
import type { AgentHost, AgentProcessHandle } from "./host.js";
import { loadEffectivePermissionPolicy, resolvePermission } from "./permissions.js";
import {
  summarizeUpdate,
  type AgentSession,
  type PromptOptions,
  type SessionUpdateEvent,
  type TurnResult,
} from "./session.js";

export interface OpenSessionOptions {
  host: AgentHost;
  agent: AgentSpec;
  cwd: string;
  additionalDirectories?: string[];
  env?: Record<string, string>;
  logger?: Logger;
  clock?: Clock;
  /** Human/upstream escalation for `ask` permissions. */
  askPermission?: (req: acp.RequestPermissionRequest) => Promise<string | undefined>;
  /**
   * Permission sidecars to layer under the agent's configured rules (ADR 0009), in
   * precedence order: the workspace `orca.permissions.json` first, a user-scoped one after
   * it. Omitted — an in-memory or test wiring with no config directory — evaluates the
   * configured rules and the defaults alone, which is what this did before #271.
   */
  permissionFiles?: readonly string[];
  onPermission?: (info: { toolCallId?: string; title: string; decision: string }) => void;
  handshakeTimeoutMs?: number;
  /**
   * How long a turn may keep running after `session/cancel` before the agent is
   * treated as wedged and its process killed. Overrides `agent.cancelGraceMs`.
   */
  cancelGraceMs?: number;
}

export const ORCA_CLIENT_INFO = { name: "orca", version: "0.1.0" } as const;

function withinRoots(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false;
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export async function openAcpSession(opts: OpenSessionOptions): Promise<AgentSession> {
  const logger = (opts.logger ?? silentLogger).child({ agent: opts.agent.id, host: opts.host.id });
  const clock = opts.clock ?? systemClock;
  const roots = [opts.cwd, ...(opts.additionalDirectories ?? [])];
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  let acpSessionId = "";
  let configOptions: SessionConfigOption[] = [];
  /** Sidecars already reported as unreadable; one warn per file per session, not per ask. */
  const warnedSidecars = new Set<string>();

  /**
   * The *evaluated* policy, not `opts.agent.permissions`, which is only what the config says:
   * configured rules, then each sidecar, then `DEFAULT_PERMISSION_POLICY`'s rules when they
   * apply (#140). Read fresh on every ask rather than once per session (#271), because
   * "allow always" is answered *while a session is open*: the daemon appends the rule to the
   * sidecar and the next tool call is the one that has to stop asking. A policy captured at
   * `session/new` would go on asking until the run ended, which is the bug #271 names.
   *
   * A sidecar that is missing contributes nothing. A sidecar that is there and corrupt is
   * logged once and skipped, not thrown: failing the ask would fail the tool call and take
   * the turn with it, and an agent blocked by a file it cannot see or fix is a worse answer
   * than an agent that falls back to its configured rules. The fallback is the conservative
   * direction anyway — an overlay only ever *adds* rules after the configured ones — so what
   * is lost is a grant, never a restriction.
   */
  const policyForAsk = () =>
    loadEffectivePermissionPolicy(opts.agent, opts.permissionFiles ?? [], (file, e) => {
      if (warnedSidecars.has(file)) return;
      warnedSidecars.add(file);
      logger.warn("permission sidecar unreadable; evaluating configured rules alone", {
        file,
        error: e instanceof Error ? e.message : String(e),
      });
    });

  const proc: AgentProcessHandle = await opts.host.spawnAgent(opts.agent, {
    cwd: opts.cwd,
    ...(opts.env ? { env: opts.env } : {}),
  });

  const app = acp
    .client({ name: ORCA_CLIENT_INFO.name })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const p = ctx.params;
      if (p.sessionId !== acpSessionId && acpSessionId !== "") return;
      if (p.update.sessionUpdate === "config_option_update") {
        configOptions = p.update.configOptions.map(normalizeConfigOption);
      }
      const e: SessionUpdateEvent = {
        sessionId: p.sessionId,
        raw: p.update,
        summary: summarizeUpdate(p.update),
        at: clock.now(),
      };
      for (const l of listeners) l(e);
    })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const { response, decision } = await resolvePermission(await policyForAsk(), {
        request: ctx.params,
        ...(opts.askPermission ? { ask: opts.askPermission } : {}),
        // Rules ORCA writes are workspace-relative, so that a grant made in one git worktree
        // still fires in the next one; without the workspace to resolve them against, none
        // of them could ever match the absolute paths an agent reports (ADR 0009).
        scope: { workspaceCwd: opts.cwd },
      });
      opts.onPermission?.({
        ...(ctx.params.toolCall.toolCallId ? { toolCallId: ctx.params.toolCall.toolCallId } : {}),
        title: ctx.params.toolCall.title ?? "",
        decision,
      });
      logger.debug("permission", { title: ctx.params.toolCall.title, decision });
      return response;
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      const { path, line, limit } = ctx.params;
      if (!withinRoots(path, roots)) throw acp.RequestError.invalidParams({ path, reason: "outside session roots" });
      let content = await opts.host.fs.readFile(path);
      if (line !== undefined && line !== null) {
        const lines = content
          .split("\n")
          .slice(
            Math.max(0, line - 1),
            limit !== undefined && limit !== null ? Math.max(0, line - 1) + limit : undefined,
          );
        content = lines.join("\n");
      }
      return { content };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      const { path, content } = ctx.params;
      if (!withinRoots(path, roots)) throw acp.RequestError.invalidParams({ path, reason: "outside session roots" });
      await opts.host.fs.writeFile(path, content);
      return {};
    });

  const conn = app.connect(proc.stream);
  const closed = conn.closed.then(() => undefined);
  const handshakeTimeout = opts.handshakeTimeoutMs ?? 30_000;

  const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(new OrcaError("AGENT_TRANSPORT", `${what} timed out after ${ms}ms`, { stderr: proc.stderrTail() })),
        ms,
      );
      // Forward settlement without adopting the still-pending request: adoption would
      // make the timeout's reject a no-op.
      void p.then(
        (value) => {
          clearTimeout(t);
          resolve(value);
        },
        (error: Error) => {
          clearTimeout(t);
          reject(error);
        },
      );
    });

  try {
    const init = await withTimeout(
      conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
          // ORCA can set boolean config options as well as selects.
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: { ...ORCA_CLIENT_INFO },
      }),
      handshakeTimeout,
      "initialize",
    );
    logger.debug("initialized", { protocolVersion: init.protocolVersion, agentInfo: init.agentInfo });
    const newSession: acp.NewSessionRequest = {
      cwd: opts.cwd,
      mcpServers: opts.agent.mcpServers.map((m) => ({
        name: m.name,
        command: m.command,
        args: m.args,
        env: Object.entries(m.env).map(([name, value]) => ({ name, value })),
      })),
    };
    if (opts.additionalDirectories) newSession.additionalDirectories = opts.additionalDirectories;
    const created = await withTimeout(
      conn.agent.request(acp.methods.agent.session.new, newSession),
      handshakeTimeout,
      "session/new",
    );
    acpSessionId = created.sessionId;
    configOptions = normalizeSessionConfig(created);
  } catch (e) {
    proc.kill();
    conn.close(e);
    if (e instanceof OrcaError) throw e;
    throw new OrcaError(
      "AGENT_PROTOCOL",
      `ACP handshake with '${opts.agent.id}' failed: ${(e as Error).message}`,
      { stderr: proc.stderrTail() },
      { cause: e },
    );
  }

  const id = newId("sess", clock.now());
  const cancelGraceMs = opts.cancelGraceMs ?? opts.agent.cancelGraceMs;

  /** The in-flight prompt turn, if any. */
  interface ActiveTurn {
    /** Why cancellation was requested; set once, by the first requester. */
    cancelReason?: string;
    /** Armed when `session/cancel` is sent; fires if the agent never ends the turn. */
    grace?: ReturnType<typeof setTimeout>;
    /** Rejects the turn from outside the ACP request (the agent is wedged). */
    fail: (e: OrcaError) => void;
  }
  let activeTurn: ActiveTurn | undefined;

  /**
   * Tear the session down: close the connection (which rejects the in-flight
   * `session/prompt` request) and stop the process, escalating to SIGKILL when
   * it ignores SIGTERM. Idempotent; concurrent callers share one shutdown.
   */
  let terminating: Promise<void> | undefined;
  const terminate = (reason?: unknown): Promise<void> => {
    if (terminating) return terminating;
    terminating = (async () => {
      try {
        conn.close(reason);
      } catch {
        /* ignore */
      }
      proc.kill();
      const exitedInTime = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
      ]);
      if (!exitedInTime) {
        // Escalate: the agent ignored SIGTERM (or is wedged). The handle's kill()
        // is a no-op once the process has exited, so this is safe to call blindly.
        proc.kill("SIGKILL");
        await proc.exited;
      }
    })();
    return terminating;
  };

  /**
   * Ask the agent to end the current turn, and stop waiting for it if it does not.
   * `session/cancel` is only a notification: a deadlocked agent (or a stalled
   * transport) never answers it, and the prompt request would otherwise hang
   * forever, taking the step, the run and `orchestrator.cancel()` with it.
   */
  const requestCancel = (reason: string): void => {
    const turn = activeTurn;
    if (!turn || turn.cancelReason) return;
    turn.cancelReason = reason;
    logger.debug("cancelling turn", { reason, graceMs: cancelGraceMs });
    void conn.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: acpSessionId })
      .catch(() => undefined /* connection may already be gone */);
    turn.grace = setTimeout(() => {
      const err = new OrcaError(
        "AGENT_TRANSPORT",
        `agent '${opts.agent.id}' did not end its turn within ${cancelGraceMs}ms of session/cancel (${reason}); killing it`,
        { reason, stderr: proc.stderrTail() },
      );
      logger.warn("agent wedged after cancel; terminating", { reason });
      turn.fail(err);
      void terminate(err);
    }, cancelGraceMs);
  };

  const session: AgentSession = {
    id,
    agentId: opts.agent.id,
    hostId: opts.host.id,
    cwd: opts.cwd,
    acpSessionId,
    closed,

    async prompt(input, options: PromptOptions = {}): Promise<TurnResult> {
      if (activeTurn) throw new OrcaError("RUN_STATE", "a prompt turn is already active on this session");
      if (options.signal?.aborted) throw new OrcaError("CANCELLED", String(options.signal.reason ?? "cancelled"));
      const blocks: acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
      const started = clock.now();
      // Settles the turn when the agent is wedged and the ACP request itself will never answer.
      let wedged: OrcaError | undefined;
      const turn: ActiveTurn = { fail: () => undefined };
      const failed = new Promise<never>((_, reject) => {
        turn.fail = (e) => {
          wedged = e;
          reject(e);
        };
      });
      failed.catch(() => undefined); // observed through the race below
      activeTurn = turn;
      const onAbort = () => requestCancel(`aborted: ${String(options.signal?.reason ?? "cancelled")}`);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = options.timeoutMs
        ? setTimeout(() => requestCancel(`turn timed out after ${options.timeoutMs}ms`), options.timeoutMs)
        : undefined;
      try {
        const res = await Promise.race([
          conn.agent.request(acp.methods.agent.session.prompt, { sessionId: acpSessionId, prompt: blocks }),
          failed,
        ]);
        return { stopReason: res.stopReason, durationMs: clock.now() - started };
      } catch (e) {
        if (wedged) throw wedged;
        throw new OrcaError(
          "AGENT_PROTOCOL",
          `prompt failed: ${(e as Error).message}`,
          { stderr: proc.stderrTail() },
          { cause: e },
        );
      } finally {
        if (timer) clearTimeout(timer);
        if (turn.grace) clearTimeout(turn.grace);
        options.signal?.removeEventListener("abort", onAbort);
        activeTurn = undefined;
      }
    },

    onUpdate(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    get configOptions() {
      return configOptions;
    },

    async setConfigOption(configId, value) {
      const params: acp.SetSessionConfigOptionRequest =
        typeof value === "boolean"
          ? { sessionId: acpSessionId, configId, type: "boolean", value }
          : { sessionId: acpSessionId, configId, value };
      let res: acp.SetSessionConfigOptionResponse;
      try {
        res = await conn.agent.request(acp.methods.agent.session.setConfigOption, params);
      } catch (e) {
        throw new OrcaError(
          "AGENT_PROTOCOL",
          `agent '${opts.agent.id}' rejected session/set_config_option ${configId}=${String(value)}: ${(e as Error).message}`,
          { configId, value },
          { cause: e },
        );
      }
      configOptions = res.configOptions.map(normalizeConfigOption);
      return configOptions;
    },

    async cancel() {
      requestCancel("cancel requested");
    },

    close() {
      return terminate();
    },
  };
  return session;
}
