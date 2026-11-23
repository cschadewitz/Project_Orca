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
 *
 * Admission is only the first gate. Every request is checked again when it is dispatched
 * (`authorize`, which the session supplies): the session must still be live, and a request
 * that acts (`tools/call`) must belong to the session's live turn and be allowed by ORCA's
 * policy for that tool, read at that moment. A request ORCA does not relay is refused. Each
 * request has a deadline and ends with the turn or the session; a server that does not
 * finish starting within its own deadline is stopped, and closing the relay stops a server
 * even while it is still starting.
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
  /**
   * Decides one request at dispatch time, after admission. It throws to refuse, and returns
   * the check to run in the same step the request is written to the server, plus the signal
   * that ends the request with the turn or session it belongs to.
   */
  authorize: (call: McpRelayCall) => Promise<McpRelayDispatch>;
  /** How long a server has to answer `initialize` before it is stopped. */
  startTimeoutMs?: number | undefined;
  /** How long one relayed request may take. */
  requestTimeoutMs?: number | undefined;
  exitGraceMs?: number | undefined;
}

/** One request the agent sent a relayed server, as `authorize` sees it. */
export type McpRelayCall =
  | { server: string; method: (typeof MCP_RELAY_LISTING_METHODS)[number] }
  | { server: string; method: "tools/call"; tool: string; arguments: unknown };

export interface McpRelayDispatch {
  /** Throws if the request may no longer go out; run in the same step that sends it. */
  dispatch(): void;
  /** Aborts when the turn or session the request belongs to ends. */
  signal: AbortSignal;
}

/** Requests that only describe the server and act on nothing: allowed in a live session. */
export const MCP_RELAY_LISTING_METHODS = ["server/discover", "tools/list", "ping"] as const;
/** The default for `startTimeoutMs`. */
export const MCP_RELAY_START_TIMEOUT_MS = 30_000;
/** The default for `requestTimeoutMs`. */
export const MCP_RELAY_REQUEST_TIMEOUT_MS = 10 * 60_000;

/** The MCP protocol version ORCA opens a real server with. Servers answer with theirs. */
export const RELAY_UPSTREAM_PROTOCOL_VERSION = "2025-06-18";
/** What ORCA tells the agent it speaks, over ACP. */
export const RELAY_PROTOCOL_VERSION = "2026-07-28";
const NOT_ADMITTED = -32002;
const REFUSED = -32001;
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
  /** `dispatch` runs in the same step that writes the request; if it throws, nothing is sent. */
  request(
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    dispatch: () => void,
  ): Promise<unknown>;
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
  /** Aborted by `close`: stops servers that are running and servers still starting. */
  const stopping = new AbortController();
  const running = new Set<() => Promise<void>>();

  const upstreamFor = (server: RelayedMcpServer): Promise<Upstream> => {
    let up = started.get(server.name);
    if (!up) {
      up = startUpstream(server, opts, stopping.signal, running);
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
      const call = relayCall(server.name, op.method, op.params);
      if (!call) {
        opts.logger.warn("MCP request refused: ORCA does not relay this method", {
          server: server.name,
          method: op.method,
        });
        throw new acpUnstable.McpProtocolError(METHOD_NOT_FOUND, `${op.method} is not relayed by ORCA`);
      }
      let gate: McpRelayDispatch;
      try {
        gate = await opts.authorize(call);
      } catch (error) {
        opts.logger.warn("MCP request refused", {
          server: server.name,
          method: op.method,
          reason: describeError(error).message,
        });
        throw new acpUnstable.McpProtocolError(REFUSED, `not allowed: ${describeError(error).message}`);
      }
      if (closing) throw new acpUnstable.McpProtocolError(UPSTREAM_FAILED, "the session is closing");
      const signal = AbortSignal.any([
        op.signal,
        gate.signal,
        stopping.signal,
        AbortSignal.timeout(opts.requestTimeoutMs ?? MCP_RELAY_REQUEST_TIMEOUT_MS),
      ]);
      let up: Upstream;
      try {
        up = await upstreamFor(server);
      } catch (error) {
        throw new acpUnstable.McpProtocolError(UPSTREAM_FAILED, `the MCP server "${server.name}" did not start`, {
          reason: describeError(error).message,
        });
      }
      if (signal.aborted) throw new acpUnstable.McpProtocolError(REFUSED, `the request ended: ${abortReason(signal)}`);
      if (op.method === "server/discover") {
        gate.dispatch();
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
      try {
        return {
          result: (await up.request(op.method, withoutRequestMeta(op.params), signal, () => gate.dispatch())) as Record<
            string,
            unknown
          >,
        };
      } catch (error) {
        if (error instanceof acpUnstable.McpProtocolError) throw error;
        throw new acpUnstable.McpProtocolError(UPSTREAM_FAILED, describeError(error).message);
      }
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
      stopping.abort(new Error("the session closed"));
      await Promise.allSettled(registrations.map((r) => r.dispose()));
      // Every server that was spawned, whether or not it finished starting.
      await Promise.allSettled([...running].map((stop) => stop()));
    },
  };
}

function relayCall(
  server: string,
  method: string,
  params: Record<string, unknown> | undefined,
): McpRelayCall | undefined {
  if ((MCP_RELAY_LISTING_METHODS as readonly string[]).includes(method))
    return { server, method: method as McpRelayCall["method"] } as McpRelayCall;
  if (method === "tools/call") {
    const tool = params?.["name"];
    if (typeof tool !== "string" || tool === "") return undefined;
    return { server, method, tool, arguments: params?.["arguments"] };
  }
  return undefined;
}

function abortReason(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  if (r instanceof Error && r.name === "TimeoutError") return "the request's deadline passed";
  return r instanceof Error ? r.message : typeof r === "string" ? r : "cancelled";
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

async function startUpstream(
  server: RelayedMcpServer,
  opts: McpRelayOptions,
  stopping: AbortSignal,
  running: Set<() => Promise<void>>,
): Promise<Upstream> {
  if (stopping.aborted) throw new Error("the session closed");
  const proc: AgentProcessHandle = await opts.host.spawnAgent(
    AgentSpecSchema.parse({ id: `mcp-${server.name}`, command: server.command, args: server.args, env: server.env }),
    { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) },
  );
  const cleanup = processCleanup(proc, opts.exitGraceMs);
  // Registered before anything can wait on the server, so `close` stops it even mid-start.
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      running.delete(stop);
      end(new Error(`the MCP server "${server.name}" was stopped`));
      await writer.close().catch(() => undefined);
      await cleanup();
    })();
    return stopped;
  };
  running.add(stop);
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
    signal: AbortSignal,
    dispatch: () => void = () => undefined,
  ): Promise<unknown> => {
    if (ended) return Promise.reject(ended);
    if (signal.aborted) return Promise.reject(new Error(abortReason(signal)));
    // The last check, in the same step as the write: a turn that ended since is refused here.
    dispatch();
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        if (!pending.delete(id)) return;
        void send({ method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }).catch(
          () => undefined,
        );
        reject(new Error(abortReason(signal)));
      };
      pending.set(id, {
        resolve: (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      send({ id, method, ...(params ? { params } : {}) }).catch((error: unknown) => {
        pending.delete(id);
        reject(new Error(`could not write to the MCP server "${server.name}": ${describeError(error).message}`));
      });
    });
  };

  try {
    const startTimeoutMs = opts.startTimeoutMs ?? MCP_RELAY_START_TIMEOUT_MS;
    const init = (await request(
      "initialize",
      { protocolVersion: RELAY_UPSTREAM_PROTOCOL_VERSION, capabilities: {}, clientInfo: opts.clientInfo },
      AbortSignal.any([stopping, AbortSignal.timeout(startTimeoutMs)]),
    ).catch((error: unknown) => {
      if (stopping.aborted) throw new Error("the session closed");
      if (error instanceof Error && error.message === "the request's deadline passed")
        throw new Error(`it did not answer initialize within ${startTimeoutMs} ms`);
      throw error;
    })) as Upstream["initialized"];
    await send({ method: "notifications/initialized" });
    opts.logger.debug("relayed MCP server started", { server: server.name });
    return { initialized: init, request, close: stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
