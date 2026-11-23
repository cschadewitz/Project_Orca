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
 * even while it is still starting, or while a write to it is stuck. A request that had to wait
 * for its server to start is decided again once it has started, before it is written.
 *
 * Messages reach a server one at a time, and a request's authority (its turn, its deadline,
 * the session's check) is decided again at the moment the transport takes it: one that ran
 * out while it waited in line is dropped unsent. Every request settles exactly once, by its
 * answer, its deadline, its turn ending or the server ending. An answer JSON-RPC does not
 * allow settles its request as a failure; an answer that matches no request ORCA has pending
 * cannot be attributed, so everything pending fails, the server is stopped, and the next
 * request starts it again.
 *
 * A server runs under the same credential boundary as the agent: the variables the session
 * withholds from the agent (`withheldEnv`) are withheld from it too, and it gets only its own
 * configured environment on top. What a server or ORCA's side says about a failure reaches the
 * agent as a fixed reason, or for an error the server answered, its code and a bounded message
 * with the session's secret values redacted; nothing else the server attached is passed on.
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
  /** Variables of ORCA's own environment the session withholds from the agent, and so from its servers. */
  withheldEnv?: readonly string[] | undefined;
  /** Replaces the session's secret values in text that leaves ORCA. */
  redact: (text: string) => string;
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
  /**
   * Decides again, on the policy as it is now, whether the request may go out: rejects if it
   * may not. The relay calls it when the request reaches the head of the line to the server
   * (and for `server/discover`, once the server has started), then `dispatch`.
   */
  recheck(): Promise<void>;
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
/** The longest message from a server's error that reaches the agent. */
export const MCP_RELAY_ERROR_MESSAGE_LIMIT = 500;

/** Why a relayed request failed on ORCA's side: a fixed set, so no free text reaches the agent. */
export type McpRelayFailureReason =
  | "session-closed"
  | "start-timeout"
  | "start-failed"
  | "server-exited"
  | "write-failed"
  | "deadline"
  | "cancelled"
  | "invalid-response"
  | "failed";

const FAILURE_TEXT: Record<McpRelayFailureReason, string> = {
  "session-closed": "the session closed",
  "start-timeout": "the server did not finish starting in time",
  "start-failed": "the server could not be started",
  "server-exited": "the server exited",
  "write-failed": "the request could not be written to the server",
  deadline: "the request's deadline passed",
  cancelled: "the request was cancelled",
  "invalid-response": "the server's answer was not valid",
  failed: "the request failed",
};

class RelayFailure extends Error {
  constructor(readonly reason: McpRelayFailureReason) {
    super(FAILURE_TEXT[reason]);
  }
}

/** The request's authority no longer held when it reached the transport. */
class DispatchRefused extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Per-request metadata MCP 2026-07-28 adds; a stdio server of an older version has no use for it. */
const REQUEST_META_KEYS = [
  "io.modelcontextprotocol/protocolVersion",
  "io.modelcontextprotocol/clientInfo",
  "io.modelcontextprotocol/clientCapabilities",
];

interface Upstream {
  initialized: { capabilities: unknown; serverInfo: unknown; instructions?: unknown };
  /**
   * At the handoff to the transport, `authority.recheck` decides the request on the policy as
   * it is then, and `authority.dispatch` runs in the same step that writes it; if either
   * refuses, nothing is sent.
   */
  request(
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    authority?: Pick<McpRelayDispatch, "recheck" | "dispatch">,
  ): Promise<unknown>;
  close(): Promise<void>;
  /** False once the server exited, broke the protocol or was stopped. */
  alive(): boolean;
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
      const starting: Promise<Upstream> = startUpstream(server, opts, stopping.signal, running, () => {
        // A server that ended is started again on the next request, unless it was replaced already.
        if (started.get(server.name) === starting) started.delete(server.name);
      });
      up = starting;
      started.set(server.name, up);
      // A server that failed to start is started again on the next request.
      void up.catch(() => {
        if (started.get(server.name) === starting) started.delete(server.name);
      });
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
      if (closing) throw failure(new RelayFailure("session-closed"));
      const call = relayCall(server.name, op.method, op.params);
      if (!call) {
        opts.logger.warn("MCP request refused: ORCA does not relay this method", {
          server: server.name,
          method: op.method,
        });
        throw new acpUnstable.McpProtocolError(METHOD_NOT_FOUND, `${op.method} is not relayed by ORCA`);
      }
      // The request's deadline runs from its arrival: deciding it, starting its server and
      // the server's answer all count against it.
      const deadline = AbortSignal.timeout(opts.requestTimeoutMs ?? MCP_RELAY_REQUEST_TIMEOUT_MS);
      let gate: McpRelayDispatch;
      try {
        gate = await opts.authorize(call);
      } catch (error) {
        opts.logger.warn("MCP request refused", {
          server: server.name,
          method: op.method,
          reason: describeError(error).message,
        });
        throw new acpUnstable.McpProtocolError(
          REFUSED,
          `not allowed: ${bounded(opts.redact(describeError(error).message))}`,
        );
      }
      const signal = AbortSignal.any([op.signal, gate.signal, stopping.signal, deadline]);
      // Nothing is started for a request that has already ended.
      if (closing) throw failure(new RelayFailure("session-closed"));
      if (signal.aborted) throw failure(new RelayFailure(abortFailure(signal)));
      let up: Upstream;
      try {
        // A request that ends while its server starts settles then, not when the start does.
        up = await untilAborted(upstreamFor(server), signal);
      } catch (error) {
        if (error instanceof RelayFailure && signal.aborted) throw failure(error);
        const reason = error instanceof RelayFailure ? error.reason : "start-failed";
        opts.logger.warn("relayed MCP server did not start", { server: server.name, reason });
        throw new acpUnstable.McpProtocolError(UPSTREAM_FAILED, `the MCP server "${server.name}" did not start`, {
          reason,
        });
      }
      if (op.method === "server/discover") {
        // Answered here, from the start: decided now, as a request handed to the server would be.
        try {
          await gate.recheck();
          if (signal.aborted) throw new RelayFailure(abortFailure(signal));
          gate.dispatch();
        } catch (error) {
          if (error instanceof RelayFailure) throw failure(error);
          throw new acpUnstable.McpProtocolError(
            REFUSED,
            `not allowed: ${bounded(opts.redact(describeError(error).message))}`,
          );
        }
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
          result: (await up.request(op.method, withoutRequestMeta(op.params), signal, gate)) as Record<string, unknown>,
        };
      } catch (error) {
        // An error the server answered was made bounded and redacted when it was read.
        if (error instanceof acpUnstable.McpProtocolError) throw error;
        if (error instanceof DispatchRefused)
          throw new acpUnstable.McpProtocolError(REFUSED, `not allowed: ${bounded(opts.redact(error.message))}`);
        // Anything else is reported by a fixed reason; what it said goes to ORCA's log only.
        if (!(error instanceof RelayFailure))
          opts.logger.warn("relayed MCP request failed", { server: server.name, error: describeError(error) });
        throw failure(error instanceof RelayFailure ? error : new RelayFailure("failed"));
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
      stopping.abort(new RelayFailure("session-closed"));
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

function abortFailure(signal: AbortSignal): McpRelayFailureReason {
  const r: unknown = signal.reason;
  if (r instanceof RelayFailure) return r.reason;
  if (r instanceof Error && r.name === "TimeoutError") return "deadline";
  return "cancelled";
}

function failure(f: RelayFailure): acpUnstable.McpProtocolError {
  return new acpUnstable.McpProtocolError(UPSTREAM_FAILED, f.message, { reason: f.reason });
}

/** White space folded, other control characters shown as `?`, at most `max` characters. */
function bounded(text: string, max = MCP_RELAY_ERROR_MESSAGE_LIMIT): string {
  const clean = text
    .replace(/\s+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** `p`, unless `signal` aborts first; then a failure for why it did. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RelayFailure(abortFailure(signal)));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RelayFailure(abortFailure(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new RelayFailure("failed"));
      },
    );
  });
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
  /** Called once when the server can no longer be used, so the next request starts it again. */
  onEnd: () => void = () => undefined,
): Promise<Upstream> {
  if (stopping.aborted) throw new RelayFailure("session-closed");
  const proc: AgentProcessHandle = await opts.host
    .spawnAgent(
      AgentSpecSchema.parse({ id: `mcp-${server.name}`, command: server.command, args: server.args, env: server.env }),
      {
        cwd: opts.cwd,
        ...(opts.env ? { env: opts.env } : {}),
        // The session's credential boundary holds for its servers as it does for its agent.
        ...(opts.withheldEnv?.length ? { withheldEnv: [...opts.withheldEnv] } : {}),
      },
    )
    .catch((error: unknown) => {
      opts.logger.warn("relayed MCP server could not be spawned", { server: server.name, error: describeError(error) });
      throw new RelayFailure("start-failed");
    });
  const cleanup = processCleanup(proc, opts.exitGraceMs);
  // Registered before anything can wait on the server, so `close` stops it even mid-start.
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      running.delete(stop);
      end(new RelayFailure("session-closed"));
      // Never waits on the writer: a write the server is not reading would hold it forever.
      void writer.abort(new RelayFailure("session-closed")).catch(() => undefined);
      await cleanup();
    })();
    return stopped;
  };
  running.add(stop);
  const writer = proc.stream.writable.getWriter();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Requests that were written and then cancelled: a late answer to one is expected, and dropped. */
  const cancelled = new Set<number>();
  let nextId = 0;
  let ended: Error | undefined;
  const end = (error: Error) => {
    if (ended) return;
    ended = error;
    for (const p of [...pending.values()]) p.reject(error);
    pending.clear();
    onEnd();
  };
  /** The server broke the protocol: nothing it has pending can be trusted, so all of it fails and it stops. */
  const violation = (what: string) => {
    opts.logger.warn("relayed MCP server broke the protocol; stopping it", { server: server.name, what });
    end(new RelayFailure("invalid-response"));
    void stop();
  };

  /**
   * One message at a time is handed to the transport, each only once the one before it was
   * taken. `admit` runs at that handoff, not when the message was queued: a request whose
   * turn ended, whose deadline passed or whose authority no longer holds while it waited is
   * dropped there and never reaches the server.
   */
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = (
    message: Message,
    admit: { prepare?: () => Promise<boolean>; check?: () => boolean } = {},
  ): Promise<boolean> => {
    const handoff = tail.then(async () => {
      // Its turn in line: anything asynchronous is decided first, while no other message can
      // go ahead of it, and then the last check and the write happen in one synchronous step.
      if (ended || (admit.prepare && !(await admit.prepare()))) return false;
      if (ended || (admit.check && !admit.check())) return false;
      await writer.write({ jsonrpc: "2.0", ...message } as acp.AnyMessage);
      return true;
    });
    tail = handoff.catch(() => undefined);
    return handoff;
  };

  void (async () => {
    const reader = proc.stream.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (ended) continue;
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          violation("a message that is not a JSON-RPC object");
          continue;
        }
        const m = value as Message;
        if (m.method !== undefined) {
          if (typeof m.method !== "string") violation("a method that is not a string");
          else if (m.id === undefined)
            continue; // Notifications belong to no request ORCA relays.
          else if (typeof m.id !== "number" && typeof m.id !== "string") violation("a request id of the wrong type");
          // A request the server makes of its client: ORCA has nobody to put it to.
          else
            void enqueue({ id: m.id, error: { code: METHOD_NOT_FOUND, message: "not offered" } }).catch(
              () => undefined,
            );
          continue;
        }
        if (typeof m.id === "number" && cancelled.delete(m.id)) continue;
        const p = typeof m.id === "number" ? pending.get(m.id) : undefined;
        // An answer to nothing ORCA asked, or that cannot be matched: which request it settles is
        // ambiguous, so none is trusted.
        if (!p) {
          violation("a response that matches no pending request");
          continue;
        }
        const hasResult = "result" in m;
        const hasError = "error" in m;
        if (hasError && !hasResult) {
          const e = m.error as { code?: unknown; message?: unknown } | null;
          if (
            e === null ||
            typeof e !== "object" ||
            typeof e.code !== "number" ||
            !Number.isInteger(e.code) ||
            typeof e.message !== "string"
          ) {
            p.reject(new RelayFailure("invalid-response"));
            continue;
          }
          // Its code and a bounded, redacted message; whatever `data` it attached stays here.
          p.reject(new acpUnstable.McpProtocolError(e.code, bounded(opts.redact(e.message))));
        } else if (hasResult && !hasError && isPlainObject(m.result)) p.resolve(m.result);
        // Both, neither, or a result that is not an object: settled as a failure, never left open.
        else p.reject(new RelayFailure("invalid-response"));
      }
      end(new RelayFailure("server-exited"));
    } catch (error) {
      opts.logger.debug("relayed MCP server stream failed", { server: server.name, error: describeError(error) });
      end(new RelayFailure("server-exited"));
    }
  })();
  void proc.exited.then(
    () => end(new RelayFailure("server-exited")),
    () => undefined,
  );

  const request = (
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    authority?: Pick<McpRelayDispatch, "recheck" | "dispatch">,
  ): Promise<unknown> => {
    if (ended) return Promise.reject(ended);
    if (signal.aborted) return Promise.reject(new RelayFailure(abortFailure(signal)));
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let written = false;
      /** Every path ends here, and only the first one counts. */
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        signal.removeEventListener("abort", onAbort);
        outcome();
      };
      const onAbort = () => {
        if (settled) return;
        // Already with the server: tell it. Still queued: the handoff drops it.
        if (written) {
          cancelled.add(id);
          void enqueue({ method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }).catch(
            () => undefined,
          );
        }
        settle(() => reject(new RelayFailure(abortFailure(signal))));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      enqueue(
        { id, method, ...(params ? { params } : {}) },
        {
          // The request's authority on the policy as it is at the handoff, not as it was decided.
          prepare: async () => {
            if (settled || signal.aborted) return false;
            if (authority)
              try {
                await authority.recheck();
              } catch (error) {
                settle(() => reject(new DispatchRefused(describeError(error).message)));
                return false;
              }
            return !settled && !signal.aborted;
          },
          check: () => {
            if (settled || signal.aborted) return false;
            try {
              authority?.dispatch();
            } catch (error) {
              settle(() => reject(new DispatchRefused(describeError(error).message)));
              return false;
            }
            // Only now can an answer to it be taken: a reply to anything not yet sent is a reply
            // to nothing.
            written = true;
            pending.set(id, {
              resolve: (v) => settle(() => resolve(v)),
              reject: (e) => settle(() => reject(e)),
            });
            return true;
          },
        },
      ).then(
        (sent) => {
          if (!sent) settle(() => reject(ended ?? new RelayFailure("cancelled")));
        },
        (error: unknown) => {
          opts.logger.debug("relayed MCP write failed", { server: server.name, error: describeError(error) });
          settle(() => reject(new RelayFailure("write-failed")));
        },
      );
    });
  };

  try {
    const startTimeoutMs = opts.startTimeoutMs ?? MCP_RELAY_START_TIMEOUT_MS;
    const init = (await request(
      "initialize",
      { protocolVersion: RELAY_UPSTREAM_PROTOCOL_VERSION, capabilities: {}, clientInfo: opts.clientInfo },
      AbortSignal.any([stopping, AbortSignal.timeout(startTimeoutMs)]),
    ).catch((error: unknown) => {
      if (stopping.aborted) throw new RelayFailure("session-closed");
      if (error instanceof RelayFailure && error.reason === "deadline") throw new RelayFailure("start-timeout");
      if (error instanceof RelayFailure) throw error;
      throw new RelayFailure("start-failed");
    })) as Upstream["initialized"];
    // Not awaited: a server that stops reading must not hold the start.
    void enqueue({ method: "notifications/initialized" }).catch(() => undefined);
    opts.logger.debug("relayed MCP server started", { server: server.name });
    return { initialized: init, request, close: stop, alive: () => ended === undefined };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
