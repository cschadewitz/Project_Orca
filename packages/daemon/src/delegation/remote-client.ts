/**
 * JSON-RPC to another ORCA daemon over connections handed out one at a time (#883): each one
 * is a stream from the profile's `SshTunnel.connect()`, an authenticated `ssh -W` channel to
 * the daemon's loopback port, so a request that carries the credential is bound to that exact
 * channel and is never sent to whatever might listen on a local port. Requests that arrive
 * while the tunnel cannot give a stream fail before a byte is written; the client never
 * redials under a request.
 *
 * HTTP only: the delegating session reads the remote run's log by cursor (`runs.events`), so
 * it has nothing to resume after a dropped connection beyond the cursor it already holds.
 */
import { Agent, request, type ClientRequestArgs } from "node:http";
import type { Duplex } from "node:stream";
import { ResponseMessageSchema, type ProtocolError } from "@orca/protocol";

export type StreamConnect = () => Duplex;

/** The remote daemon answered, and refused. `code` is its wire code (`AUTH_INVALID`, `RUN_STATE`, …). */
export class RemoteFault extends Error {
  override readonly name = "RemoteFault";
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(
    readonly method: string,
    error: ProtocolError,
  ) {
    super(`${method}: ${error.code}: ${error.message}`);
    this.code = error.code;
    this.details = error.details;
  }
}

/**
 * No answer: the stream could not be opened, broke, or the call timed out. Nothing says
 * whether the daemon acted on the request, so only an idempotent call may be repeated.
 */
export class RemoteUnreachable extends Error {
  override readonly name = "RemoteUnreachable";
  constructor(
    readonly method: string,
    override readonly cause: unknown,
  ) {
    super(`${method}: no answer from the remote daemon`);
  }
}

/** A keep-alive agent whose connections come from `connect()`, so a burst of calls shares one stream. */
class StreamAgent extends Agent {
  constructor(private readonly open: StreamConnect) {
    super({ keepAlive: true, maxSockets: 4 });
  }
  override createConnection(
    _options: ClientRequestArgs,
    created?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    try {
      return this.open();
    } catch (error) {
      (created as (error: Error | null, stream: Duplex) => void)(error as Error, undefined as unknown as Duplex);
      return undefined;
    }
  }
}

/**
 * An agent that opens exactly one stream: every call through it shares that connection, and
 * once the stream is gone a further call fails before a byte is written instead of opening
 * another one. What one call verified about the remote then holds for the next.
 */
class OneStreamAgent extends Agent {
  private opened = false;
  constructor(private readonly open: StreamConnect) {
    super({ keepAlive: true, maxSockets: 1 });
  }
  override createConnection(
    _options: ClientRequestArgs,
    created?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const fail = (error: Error) => {
      (created as (error: Error | null, stream: Duplex) => void)(error, undefined as unknown as Duplex);
      return undefined;
    };
    if (this.opened) return fail(new Error("the verified connection to the remote daemon is gone"));
    this.opened = true;
    try {
      return this.open();
    } catch (error) {
      return fail(error as Error);
    }
  }
}

/** The calls made on one connection (see `RemoteDaemonClient.onOneConnection`). */
export type ConnectionCall = (
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal | undefined },
) => Promise<unknown>;

/** The most one answer may be: an artifact's text is capped at 1 MB on the daemon side. */
const ANSWER_LIMIT = 8 * 1024 * 1024;

export interface RemoteClientOptions {
  connect: StreamConnect;
  /** The bearer credential the remote daemon issued for this daemon. */
  token: string;
  /** Per-call limit. Default 30 s. */
  timeoutMs?: number;
}

export class RemoteDaemonClient {
  private readonly agent: StreamAgent;
  private nextId = 1;
  constructor(private readonly options: RemoteClientOptions) {
    this.agent = new StreamAgent(options.connect);
  }

  /** One call. Resolves with the result, or rejects with a `RemoteFault` or `RemoteUnreachable`. */
  call(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<unknown> {
    return this.send(this.agent, method, params, options);
  }

  /**
   * Run `fn` with calls that all travel on one new connection, closed afterwards (#363). A call
   * after that connection broke rejects with `RemoteUnreachable` without sending anything, so a
   * check made by an earlier call is about the daemon a later call reaches.
   */
  async onOneConnection<T>(fn: (call: ConnectionCall) => Promise<T>): Promise<T> {
    const agent = new OneStreamAgent(this.options.connect);
    try {
      return await fn((method, params, options = {}) => this.send(agent, method, params, options));
    } finally {
      agent.destroy();
    }
  }

  private send(
    agent: Agent,
    method: string,
    params: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal | undefined },
  ): Promise<unknown> {
    const body = JSON.stringify({ kind: "request", id: this.nextId++, method, params });
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        fn();
      };
      const req = request(
        {
          agent,
          // Never dialled: the agent's connection is the tunnel's stream. The host names the
          // remote loopback for the daemon's Host check.
          host: "127.0.0.1",
          path: "/rpc",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            authorization: `Bearer ${this.options.token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > ANSWER_LIMIT) {
              req.destroy(new Error("answer too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", (error) => finish(() => reject(new RemoteUnreachable(method, error))));
          res.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch (error) {
              finish(() => reject(new RemoteUnreachable(method, error)));
              return;
            }
            const answer = ResponseMessageSchema.safeParse(parsed);
            if (!answer.success) {
              finish(() =>
                reject(new RemoteUnreachable(method, new Error(`HTTP ${res.statusCode} with no ORCA answer`))),
              );
              return;
            }
            const message = answer.data;
            finish(() => (message.ok ? resolve(message.result) : reject(new RemoteFault(method, message.error))));
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error("timed out")), timeoutMs);
      const abort = () => req.destroy(new Error("aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });
      req.on("error", (error) => finish(() => reject(new RemoteUnreachable(method, error))));
      req.end(body);
    });
  }

  /** Ends every pooled connection; the tunnel's streams close with them. */
  close(): void {
    this.agent.destroy();
  }
}
