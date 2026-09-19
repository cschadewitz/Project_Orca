/**
 * The daemon's HTTP surface: `POST /rpc` takes one request envelope and answers with one
 * response envelope; `GET /health` is for process supervisors. Notifications (the live
 * event stream) need a WebSocket, which comes with the first subscribe method - the
 * envelope already has the message kind for it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describeError } from "@orca/core";
import { parseMessage, protocolError, type ProtocolError, type ResponseMessage } from "@orca/protocol";
import { methodsFor, type MethodContext, type MethodTable } from "./methods.js";

export interface DaemonOptions extends MethodContext {
  host?: string | undefined;
  /** `0` (the default) picks a free port; read the real one from `DaemonHandle.port`. */
  port?: number | undefined;
  methods?: MethodTable | undefined;
}

export interface DaemonHandle {
  host: string;
  port: number;
  url: string;
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
    return fail(msg.id, describeError(e));
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const host = opts.host ?? "127.0.0.1";
  const ctx: MethodContext = {
    orcaVersion: opts.orcaVersion,
    storeDir: opts.storeDir,
    capabilities: opts.capabilities,
    reads: opts.reads,
  };
  // A daemon without a store serves `hello` alone, and says so in `hello.methods`: a read
  // method it cannot answer is an unknown method, not a method that fails.
  const methods = opts.methods ?? methodsFor(ctx);
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
