/**
 * ORCA serves a session's MCP servers to the agent itself, over the ACP connection (#704).
 *
 * The agent is told only a name and an opaque id for each server (`{ type: "acp" }` in
 * `session/new`), never its command, arguments or environment. ORCA starts the real server,
 * with its secrets filled in on ORCA's side, the first time the agent asks it anything, and
 * only once the session has been admitted: until then a request waits, and if admission is
 * refused it is answered with an error and nothing is started.
 *
 * The agent speaks MCP 2026-07-28 over `mcp/message` (`server/discover`, then requests that
 * each carry their own protocol metadata). The real server is a stdio server of any recent
 * version: ORCA opens it with `initialize` and answers `server/discover` from what it said.
 * Requests the server makes of its client (sampling, roots, elicitation) are refused; ORCA
 * has no model or person to put them to on the agent's behalf.
 */
import * as acpUnstable from "@agentclientprotocol/sdk/unstable";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, describeError, type Logger } from "@orca/core";
import type { AgentHost, AgentProcessHandle } from "./host.js";
import { processCleanup } from "./process-cleanup.js";

/** One server ORCA runs for the session; `env` holds literal values only. */
export interface RelayedMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpRelayOptions {
  host: AgentHost;
  cwd: string;
  /** The process environment the session's agent was given, for the servers too. */
  env?: Record<string, string> | undefined;
  servers: readonly RelayedMcpServer[];
  /** Fulfils true once the session may be served; false refuses every request. */
  admitted: Promise<boolean>;
  logger: Logger;
  clientInfo: { name: string; version: string };
  exitGraceMs?: number | undefined;
}

/** The MCP protocol version ORCA opens a real server with. Servers answer with theirs. */
export const RELAY_UPSTREAM_PROTOCOL_VERSION = "2025-06-18";
/** What ORCA tells the agent it speaks, over ACP. */
export const RELAY_PROTOCOL_VERSION = "2026-07-28";
const NOT_ADMITTED = -32002;
const UPSTREAM_FAILED = -32603;
const METHOD_NOT_FOUND = -32601;
/** Per-request metadata MCP 2026-07-28 adds; a stdio server of an older version has no use for it. */
const REQUEST_META_KEYS = [
  "io.modelcontextprotocol/protocolVersion",
  "io.modelcontextprotocol/clientInfo",
  "io.modelcontextprotocol/clientCapabilities",
];

interface Upstream {
  initialized: { capabilities: unknown; serverInfo: unknown; instructions?: unknown };
  request(method: string, params: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpRelay {
  /** Register with `onRequest(methods.client.mcp.message, relay.handleRequest)`. */
  readonly handleRequest: acpUnstable.McpOverAcpProvider["handleRequest"];
  /** Registers every server on the connection; pass the declarations in `session/new`. */
  declare(connection: acpUnstable.HasConnectionContext): acp.McpServer[];
  /** Stops every server ORCA started. */
  close(): Promise<void>;
}

export function createMcpRelay(opts: McpRelayOptions): McpRelay {
  const provider = new acpUnstable.McpOverAcpProvider();
  const started = new Map<string, Promise<Upstream>>();
  const registrations: acpUnstable.McpServerRegistration[] = [];
  let closing = false;

  const upstreamFor = (server: RelayedMcpServer): Promise<Upstream> => {
    let up = started.get(server.name);
    if (!up) {
      up = startUpstream(server, opts);
      started.set(server.name, up);
      // A server that failed to start is started again on the next request.
      void up.catch(() => started.delete(server.name));
    }
    return up;
  };

  const handlerFor =
    (server: RelayedMcpServer): acpUnstable.McpRequestHandler =>
    async (op) => {
      if (!(await opts.admitted)) {
        opts.logger.warn("MCP request refused: the session was not admitted", {
          server: server.name,
          method: op.method,
        });
        throw new acpUnstable.McpProtocolError(NOT_ADMITTED, "the session was not admitted");
      }
      if (closing) throw new acpUnstable.McpProtocolError(UPSTREAM_FAILED, "the session is closing");
      if (op.method === "initialize")
        throw new acpUnstable.McpProtocolError(METHOD_NOT_FOUND, "initialize is ORCA's to send");
      let up: Upstream;
      try {
        up = await upstreamFor(server);
      } catch (error) {
        throw new acpUnstable.McpProtocolError(UPSTREAM_FAILED, `the MCP server "${server.name}" did not start`, {
          reason: describeError(error),
        });
      }
      if (op.method === "server/discover") {
        const { capabilities, serverInfo, instructions } = up.initialized;
        return {
          result: {
            supportedVersions: [RELAY_PROTOCOL_VERSION],
            capabilities: capabilities ?? {},
            serverInfo: serverInfo ?? { name: server.name, version: "0" },
            ...(typeof instructions === "string" ? { instructions } : {}),
          },
        };
      }
      return {
        result: (await up.request(op.method, withoutRequestMeta(op.params), op.signal)) as Record<string, unknown>,
      };
    };

  return {
    handleRequest: provider.handleRequest,
    declare(connection) {
      return opts.servers.map((server) => {
        const reg = provider.registerServer(connection, { name: server.name, handler: handlerFor(server) });
        registrations.push(reg);
        return reg.declaration as unknown as acp.McpServer;
      });
    },
    async close() {
      closing = true;
      await Promise.allSettled(registrations.map((r) => r.dispose()));
      await Promise.allSettled([...started.values()].map((up) => up.then((u) => u.close())));
    },
  };
}

function withoutRequestMeta(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const meta = params["_meta"];
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return params;
  const rest = { ...(meta as Record<string, unknown>) };
  for (const key of REQUEST_META_KEYS) delete rest[key];
  const out = { ...params };
  if (Object.keys(rest).length) out["_meta"] = rest;
  else delete out["_meta"];
  return out;
}

type Message = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown };

async function startUpstream(server: RelayedMcpServer, opts: McpRelayOptions): Promise<Upstream> {
  const proc: AgentProcessHandle = await opts.host.spawnAgent(
    AgentSpecSchema.parse({ id: `mcp-${server.name}`, command: server.command, args: server.args, env: server.env }),
    { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) },
  );
  const cleanup = processCleanup(proc, opts.exitGraceMs);
  const writer = proc.stream.writable.getWriter();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  let ended: Error | undefined;
  const end = (error: Error) => {
    if (ended) return;
    ended = error;
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const send = (message: Message) => writer.write({ jsonrpc: "2.0", ...message } as acp.AnyMessage);

  void (async () => {
    const reader = proc.stream.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const m = value as Message;
        if (m.method !== undefined && m.id !== undefined) {
          // A request the server makes of its client: ORCA has nobody to put it to.
          await send({ id: m.id, error: { code: METHOD_NOT_FOUND, message: `${m.method} is not offered` } }).catch(
            () => undefined,
          );
        } else if (m.method === undefined && typeof m.id === "number") {
          const p = pending.get(m.id);
          if (!p) continue;
          pending.delete(m.id);
          if (m.error !== undefined) {
            const e = m.error as { code?: unknown; message?: unknown; data?: unknown };
            p.reject(
              new acpUnstable.McpProtocolError(
                typeof e.code === "number" ? e.code : UPSTREAM_FAILED,
                typeof e.message === "string" ? e.message : "the MCP server returned an error",
                e.data,
              ),
            );
          } else p.resolve(m.result ?? {});
        }
        // Notifications belong to no request ORCA relays; they are dropped.
      }
      end(new Error(`the MCP server "${server.name}" closed its output`));
    } catch (error) {
      end(new Error(`the MCP server "${server.name}" stream failed: ${describeError(error).message}`));
    }
  })();
  void proc.exited.then(
    () => end(new Error(`the MCP server "${server.name}" exited`)),
    () => undefined,
  );

  const request = (
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (ended) return Promise.reject(ended);
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        if (!pending.delete(id)) return;
        void send({ method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }).catch(
          () => undefined,
        );
        reject(new Error("cancelled"));
      };
      pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      send({ id, method, ...(params ? { params } : {}) }).catch((error: unknown) => {
        pending.delete(id);
        reject(new Error(`could not write to the MCP server "${server.name}": ${describeError(error).message}`));
      });
    });
  };

  try {
    const init = (await request("initialize", {
      protocolVersion: RELAY_UPSTREAM_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: opts.clientInfo,
    })) as Upstream["initialized"];
    await send({ method: "notifications/initialized" });
    opts.logger.debug("relayed MCP server started", { server: server.name });
    return {
      initialized: init,
      request: (method, params, signal) => request(method, params, signal),
      close: async () => {
        end(new Error("closed"));
        await writer.close().catch(() => undefined);
        await cleanup();
      },
    };
  } catch (error) {
    end(error instanceof Error ? error : new Error(String(error)));
    await cleanup().catch(() => undefined);
    throw error;
  }
}
