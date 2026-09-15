/**
 * ACP client implementation of AgentSession.
 *
 * Lifecycle: spawn process on host -> initialize -> session/new -> N prompt
 * turns -> close. ORCA serves the agent's `fs/*` requests from the host file
 * system (scoped to the session cwd) and answers `session/request_permission`
 * through the agent's PermissionPolicy.
 */
import { isAbsolute, relative } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { newId, OrcaError, silentLogger, type AgentSpec, type Clock, type Logger, systemClock } from "@orca/core";
import type { AgentHost, AgentProcessHandle } from "./host.js";
import { resolvePermission } from "./permissions.js";
import { summarizeUpdate, type AgentSession, type PromptOptions, type SessionUpdateEvent, type TurnResult } from "./session.js";

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
  onPermission?: (info: { toolCallId?: string; title: string; decision: string }) => void;
  handshakeTimeoutMs?: number;
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
  let updateCount = 0;

  const proc: AgentProcessHandle = await opts.host.spawnAgent(opts.agent, { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });

  const app = acp
    .client({ name: ORCA_CLIENT_INFO.name })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const p = ctx.params;
      if (p.sessionId !== acpSessionId && acpSessionId !== "") return;
      updateCount++;
      const e: SessionUpdateEvent = { sessionId: p.sessionId, raw: p.update, summary: summarizeUpdate(p.update), at: clock.now() };
      for (const l of listeners) l(e);
    })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      const { response, decision } = await resolvePermission(opts.agent.permissions, {
        request: ctx.params,
        ...(opts.askPermission ? { ask: opts.askPermission } : {}),
      });
      opts.onPermission?.({ ...(ctx.params.toolCall.toolCallId ? { toolCallId: ctx.params.toolCall.toolCallId } : {}), title: ctx.params.toolCall.title ?? "", decision });
      logger.debug("permission", { title: ctx.params.toolCall.title, decision });
      return response;
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      const { path, line, limit } = ctx.params;
      if (!withinRoots(path, roots)) throw acp.RequestError.invalidParams({ path, reason: "outside session roots" });
      let content = await opts.host.fs.readFile(path);
      if (line !== undefined && line !== null) {
        const lines = content.split("\n").slice(Math.max(0, line - 1), limit !== undefined && limit !== null ? Math.max(0, line - 1) + limit : undefined);
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
      const t = setTimeout(() => reject(new OrcaError("AGENT_TRANSPORT", `${what} timed out after ${ms}ms`, { stderr: proc.stderrTail() })), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });

  try {
    const init = await withTimeout(
      conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { ...ORCA_CLIENT_INFO },
      }),
      handshakeTimeout,
      "initialize",
    );
    logger.debug("initialized", { protocolVersion: init.protocolVersion, agentInfo: init.agentInfo });
    const newSession: acp.NewSessionRequest = {
      cwd: opts.cwd,
      mcpServers: opts.agent.mcpServers.map((m) => ({ name: m.name, command: m.command, args: m.args, env: Object.entries(m.env).map(([name, value]) => ({ name, value })) })),
    };
    if (opts.additionalDirectories) newSession.additionalDirectories = opts.additionalDirectories;
    const created = await withTimeout(conn.agent.request(acp.methods.agent.session.new, newSession), handshakeTimeout, "session/new");
    acpSessionId = created.sessionId;
  } catch (e) {
    proc.kill();
    conn.close(e);
    if (e instanceof OrcaError) throw e;
    throw new OrcaError("AGENT_PROTOCOL", `ACP handshake with '${opts.agent.id}' failed: ${(e as Error).message}`, { stderr: proc.stderrTail() }, { cause: e });
  }

  const id = newId("sess", clock.now());
  let activeTurn: AbortController | undefined;

  const session: AgentSession = {
    id,
    agentId: opts.agent.id,
    hostId: opts.host.id,
    cwd: opts.cwd,
    acpSessionId,
    closed,

    async prompt(input, options: PromptOptions = {}): Promise<TurnResult> {
      if (activeTurn) throw new OrcaError("RUN_STATE", "a prompt turn is already active on this session");
      const blocks: acp.ContentBlock[] = typeof input === "string" ? [{ type: "text", text: input }] : input;
      const started = clock.now();
      const before = updateCount;
      activeTurn = new AbortController();
      const onAbort = () => void session.cancel();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = options.timeoutMs ? setTimeout(() => void session.cancel(), options.timeoutMs) : undefined;
      try {
        const res = await conn.agent.request(acp.methods.agent.session.prompt, { sessionId: acpSessionId, prompt: blocks });
        return { stopReason: res.stopReason, durationMs: clock.now() - started, updateCount: updateCount - before };
      } catch (e) {
        throw new OrcaError("AGENT_PROTOCOL", `prompt failed: ${(e as Error).message}`, { stderr: proc.stderrTail() }, { cause: e });
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        activeTurn = undefined;
      }
    },

    onUpdate(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async cancel() {
      if (!activeTurn) return;
      try {
        await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: acpSessionId });
      } catch {
        /* connection may already be gone */
      }
    },

    async close() {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      proc.kill();
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 2000))]);
      if (proc.pid) proc.kill("SIGKILL");
    },
  };
  return session;
}
