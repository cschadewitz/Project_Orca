/**
 * The daemon's HTTP surface: `POST /rpc` takes one request envelope and answers with one
 * response envelope; `GET /health` is for process supervisors.
 *
 * Notifications need a connection the daemon can push on, which HTTP has not got, so a
 * `MethodContext.source` also brings up a WebSocket endpoint on `/socket` (socket.ts). That
 * is strictly additive: without a `source` this is exactly the server it always was, and
 * even with one, `hello` and every read method still work over `/rpc` with no socket in
 * sight. A client subscribes by opening a socket, not by changing how it reads.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describeError } from "@orca/core";
import {
  isProtocolFault,
  parseMessage,
  protocolError,
  socketUrlFor,
  type ProtocolError,
  type ResponseMessage,
} from "@orca/protocol";
import { methodsFor, type MethodContext, type MethodTable } from "./methods.js";
import { Maintenance } from "./maintenance.js";
import { attachSocket } from "./socket.js";

export interface DaemonOptions extends MethodContext {
  maintenanceToken?: string | undefined;
  admissionFile?: string | undefined;
  host?: string | undefined;
  /** `0` (the default) picks a free port; read the real one from `DaemonHandle.port`. */
  port?: number | undefined;
  methods?: MethodTable | undefined;
  /** Overridable so a test can close the agent-output batch window by hand. */
  batchMs?: number | undefined;
}

export interface DaemonHandle {
  host: string;
  port: number;
  url: string;
  /** The WebSocket URL, when this daemon was given an engine feed to subscribe to. */
  socketUrl?: string | undefined;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Run one request envelope through the method table; every failure becomes a response envelope. */
export async function dispatch(text: string, methods: MethodTable, ctx: MethodContext): Promise<ResponseMessage> {
  const fail = (id: string | number, error: ProtocolError): ResponseMessage => ({
    kind: "response",
    id,
    ok: false,
    error,
  });
  const msg = parseMessage(text);
  if (!msg) return fail(0, protocolError("PROTOCOL_MESSAGE", "not a protocol message"));
  if (msg.kind !== "request")
    return fail(0, protocolError("PROTOCOL_MESSAGE", `expected a request, got a ${msg.kind}`));
  const method = methods[msg.method];
  if (!method) return fail(msg.id, protocolError("PROTOCOL_METHOD", `unknown method '${msg.method}'`));
  const params = method.params.safeParse(msg.params ?? {});
  if (!params.success) {
    return fail(
      msg.id,
      protocolError("PROTOCOL_MESSAGE", `invalid params for '${msg.method}'`, { issues: params.error.issues }),
    );
  }
  try {
    return { kind: "response", id: msg.id, ok: true, result: await method.handle(params.data, ctx) };
  } catch (e) {
    // A `ProtocolFault` already *is* the error half of a response - it carries one of the
    // protocol-only codes, which `describeError` (whose vocabulary is `OrcaErrorCode`) would
    // flatten to `INTERNAL`. Everything else goes the way it always did.
    return fail(msg.id, isProtocolFault(e) ? e.toJSON() : describeError(e));
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const host = opts.host ?? "127.0.0.1";
  const ctx: MethodContext = {
    processId: process.pid,
    maintenance: new Maintenance(opts.maintenanceToken, opts.admissionFile),
    orcaVersion: opts.orcaVersion,
    storeDir: opts.storeDir,
    capabilities: opts.capabilities,
    reads: opts.reads,
    source: opts.source,
    planSource: opts.planSource,
    control: opts.control,
    planControl: opts.planControl,
    agents: opts.agents,
    config: opts.config,
  };
  // A daemon without a store serves `hello` alone, and says so in `hello.methods`: a read
  // method it cannot answer is an unknown method, not a method that fails.
  const methods = opts.methods ? ctx.maintenance!.wrap(opts.methods) : methodsFor(ctx);
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true });
      if (req.method === "POST" && req.url === "/rpc") {
        let body: string;
        try {
          body = await readBody(req);
        } catch (e) {
          return sendJson(res, 413, { kind: "response", id: 0, ok: false, error: describeError(e) });
        }
        return sendJson(res, 200, await dispatch(body, methods, ctx));
      }
      sendJson(res, 404, { kind: "response", id: 0, ok: false, error: protocolError("PROTOCOL_METHOD", "not found") });
    })();
  });
  const detachSocket = ctx.source
    ? attachSocket(server, {
        methods,
        ctx,
        source: ctx.source,
        ...(opts.batchMs === undefined ? {} : { batchMs: opts.batchMs }),
      })
    : undefined;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host}:${port}`;
  return {
    host,
    port,
    url,
    ...(detachSocket ? { socketUrl: socketUrlFor(url) } : {}),
    close: async () => {
      // Sockets first: an open upgraded connection is not an HTTP connection, so
      // `closeAllConnections` does not reach it and `server.close` would wait on it forever.
      await detachSocket?.();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
