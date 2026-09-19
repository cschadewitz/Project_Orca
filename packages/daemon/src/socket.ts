/**
 * The WebSocket endpoint, beside the HTTP one rather than instead of it. `POST /rpc` is
 * untouched: a client that only reads still speaks one request per response and needs no
 * socket at all, and `hello` works either way. What a socket adds is the direction HTTP does
 * not have - the daemon pushing `notification` envelopes as runs move.
 *
 * It upgrades on one path (`/socket`) through `noServer`, so `GET /health` and every other
 * request still reach the HTTP handler. A connection carries the same request/response
 * dispatch as `/rpc` - the method table is the method table - plus the two methods that
 * only make sense with somewhere to push to.
 *
 * `subscribe` and `unsubscribe` are handled here rather than in the method table because
 * they are the only methods whose state is the *connection*: a subscription's lifetime is
 * its socket's, and closing the socket ends it. They appear in the table anyway, refusing
 * with `NOT_SUPPORTED`, so that `hello.methods` can advertise them honestly and a client
 * that calls them over `/rpc` is told why rather than getting "unknown method".
 *
 * `ws` is the dependency. Node 22 has a WebSocket *client* (`globalThis.WebSocket`, which is
 * what `@orca/app` uses) but no server, and `ws` is the one everything else in the ecosystem
 * has settled on. It is a leaf with no dependencies of its own, and only the daemon has it -
 * the app side stays on the platform.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { describeError } from "@orca/core";
import {
  SOCKET_PATH,
  SUBSCRIBE_METHOD,
  UNSUBSCRIBE_METHOD,
  SubscribeParamsSchema,
  UnsubscribeParamsSchema,
  parseMessage,
  protocolError,
  type NotificationMessage,
  type RequestId,
  type ResponseMessage,
} from "@orca/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { MethodContext, MethodTable } from "./methods.js";
import { dispatch } from "./server.js";
import { Subscription, type SubscriptionSource } from "./subscriptions.js";

export interface SocketOptions {
  methods: MethodTable;
  ctx: MethodContext;
  /** The engine feed subscriptions read from. Without it there is no socket. */
  source: SubscriptionSource;
  /** Overridable so a test can close the agent-output batch window by hand. */
  batchMs?: number | undefined;
}

/** Subscription ids are opaque to a client; a counter is enough and reads well in a log. */
let nextSubscriptionId = 0;

/**
 * Attach a WebSocket endpoint to an already-created HTTP server. Returns the detach, which
 * closes every open connection - `DaemonHandle.close` calls it before closing the server,
 * because an open socket would otherwise hold `server.close()` open forever.
 */
export function attachSocket(server: Server, opts: SocketOptions): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // One path only: an upgrade anywhere else is a client's mistake, and answering it would
    // mean guessing what it wanted. Destroying the socket is what `ws` documents for this.
    if ((req.url ?? "").split("?")[0] !== SOCKET_PATH) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    const subscriptions = new Map<string, Subscription>();
    const send = (message: ResponseMessage | NotificationMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const fail = (id: RequestId, code: "PROTOCOL_MESSAGE" | "PROTOCOL_METHOD", message: string): void =>
      send({ kind: "response", id, ok: false, error: protocolError(code, message) });

    ws.on("message", (data: unknown) => {
      void (async () => {
        const text = String(data);
        const msg = parseMessage(text);
        // Not a request: the daemon has nothing to answer, and answering id 0 is what the
        // HTTP path does for the same case.
        if (!msg) return fail(0, "PROTOCOL_MESSAGE", "not a protocol message");
        if (msg.kind !== "request") return fail(0, "PROTOCOL_MESSAGE", `expected a request, got a ${msg.kind}`);

        if (msg.method === SUBSCRIBE_METHOD) {
          const params = SubscribeParamsSchema.safeParse(msg.params ?? {});
          if (!params.success) return fail(msg.id, "PROTOCOL_MESSAGE", `invalid params for '${SUBSCRIBE_METHOD}'`);
          const id = `sub-${++nextSubscriptionId}`;
          const subscription = new Subscription({
            id,
            params: params.data,
            source: opts.source,
            send,
            ...(opts.batchMs === undefined ? {} : { batchMs: opts.batchMs }),
          });
          subscriptions.set(id, subscription);
          try {
            const replayed = await subscription.start();
            return send({ kind: "response", id: msg.id, ok: true, result: { subscriptionId: id, replayed } });
          } catch (e) {
            subscriptions.delete(id);
            subscription.stop();
            return send({ kind: "response", id: msg.id, ok: false, error: describeError(e) });
          }
        }

        if (msg.method === UNSUBSCRIBE_METHOD) {
          const params = UnsubscribeParamsSchema.safeParse(msg.params ?? {});
          if (!params.success) return fail(msg.id, "PROTOCOL_MESSAGE", `invalid params for '${UNSUBSCRIBE_METHOD}'`);
          const subscription = subscriptions.get(params.data.subscriptionId);
          subscription?.stop();
          return send({
            kind: "response",
            id: msg.id,
            ok: true,
            result: { stopped: subscriptions.delete(params.data.subscriptionId) },
          });
        }

        send(await dispatch(text, opts.methods, opts.ctx));
      })();
    });

    ws.on("close", () => {
      for (const subscription of subscriptions.values()) subscription.stop();
      subscriptions.clear();
    });
  });

  return () =>
    new Promise<void>((resolve) => {
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    });
}
