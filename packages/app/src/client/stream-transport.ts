/**
 * Daemon traffic over connections the caller hands out one at a time (#874): HTTP for RPCs
 * and the WebSocket for the push stream, each on a stream from `connect()` instead of a
 * dialled TCP port.
 *
 * For an SSH profile, `connect()` is one authenticated `ssh -W` channel to the daemon, so a
 * request that carries the credential is bound to that exact channel: if ssh is down there
 * is no connection to write to, and nothing goes to whatever might be listening on a local
 * port. A stream that ends ends its connection; the transport never redials under a
 * request. Requests that arrive while `connect()` throws fail before a byte is written.
 */
import { Agent, request, type ClientRequest, type ClientRequestArgs, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket from "ws";
import type { SocketFactory } from "./subscription.js";

export type StreamConnect = () => Duplex;

export interface StreamTransport {
  fetch: typeof fetch;
  socket: SocketFactory;
  /** Ends every pooled connection. Requests after this still go through `connect()`. */
  close(): void;
}

/** A keep-alive agent whose connections come from `connect()`, so RPC bursts share one stream. */
class StreamAgent extends Agent {
  constructor(private readonly open: StreamConnect) {
    super({ keepAlive: true, maxSockets: 8 });
  }
  /** A refusal from `connect()` fails the one request waiting for it, never the process. */
  override createConnection(
    _options: ClientRequestArgs,
    created?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    try {
      return this.open();
    } catch (error) {
      created?.(error instanceof Error ? error : new Error(String(error)), undefined as unknown as Duplex);
      return undefined;
    }
  }
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => (out[key] = value));
  return out;
}

export function streamTransport(connect: StreamConnect): StreamTransport {
  const agent = new StreamAgent(connect);

  const streamFetch = ((input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      if (input instanceof Request) throw new TypeError("streamTransport.fetch takes a URL");
      const body = init.body;
      if (body !== undefined && body !== null && typeof body !== "string")
        throw new TypeError("streamTransport.fetch sends string bodies only");
      const url = new URL(String(input));
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        return;
      }
      let req: ClientRequest;
      try {
        req = request(
          {
            agent,
            host: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: init.method ?? "GET",
            headers: headerRecord(init.headers),
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("error", reject);
            res.on("end", () => {
              const status = res.statusCode ?? 502;
              const body = chunks.length && status !== 204 && status !== 304 ? Buffer.concat(chunks) : null;
              const headers = new Headers();
              for (const [key, value] of Object.entries(res.headers))
                for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value])
                  headers.append(key, one);
              resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers }));
            });
          },
        );
      } catch (error) {
        // `connect()` refused (tunnel closed, failed or released): nothing was written.
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      req.on("error", reject);
      const abort = () =>
        req.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      req.on("close", () => signal?.removeEventListener("abort", abort));
      req.end(body ?? undefined);
    })) as typeof fetch;

  const socket: SocketFactory = (url, handlers, protocols) => {
    let closed = false;
    const finish = (code?: number) => {
      if (closed) return;
      closed = true;
      handlers.onClose(code);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, protocols, { createConnection: () => connect() as Socket, perMessageDeflate: false });
    } catch {
      // No stream to open (tunnel down): the subscription treats it as a closed attempt.
      queueMicrotask(() => finish());
      return { send: () => {}, close: () => {} };
    }
    ws.on("open", () => handlers.onOpen());
    ws.on("message", (data: WebSocket.RawData) =>
      handlers.onMessage(
        Buffer.isBuffer(data)
          ? data.toString()
          : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString(),
      ),
    );
    ws.on("error", () => {});
    ws.on("close", (code: number) => finish(code));
    return {
      send: (text) => ws.send(text),
      close: () => ws.close(),
    };
  };

  return { fetch: streamFetch, socket, close: () => agent.destroy() };
}
