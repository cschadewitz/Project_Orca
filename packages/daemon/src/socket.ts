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
 *
 * **Authority belongs to the credential, not to the connection (#328).** An upgrade is
 * authenticated on its headers before it is accepted (`TransportGate`), and refused with the
 * same status and envelope `/rpc` would give. After that the connection's credential is
 * re-checked before every request it sends, before every notification it is sent and on a
 * timer while it is idle: a revoked or expired credential closes the socket with `4401`, and a
 * reconnect has to authenticate again from scratch. Subscriptions live in the connection's own
 * map, so a subscription id is meaningless on any other connection, and every notification is
 * checked against the principal's current grants before it is written (`Authorizer`).
 */
import { STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { describeError } from "@orca/core";
import {
  SOCKET_PATH,
  SUBSCRIBE_METHOD,
  UNSUBSCRIBE_METHOD,
  SubscribeParamsSchema,
  UnsubscribeParamsSchema,
  isProtocolFault,
  parseMessage,
  protocolError,
  type NotificationMessage,
  type RequestId,
  type ResponseMessage,
} from "@orca/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { MethodContext, MethodTable } from "./methods.js";
import { dispatch, refusalOf } from "./server.js";
import { Subscription, type SubscriptionSource } from "./subscriptions.js";
import { bindPrincipal, type Authorizer } from "./auth/guard.js";
import type { Principal } from "./auth/principal.js";
import { SOCKET_PROTOCOL, type Admission, type TransportGate } from "./auth/transport.js";

/** Close code for a connection whose credential stopped being valid. Application range, after HTTP 401. */
export const CLOSE_AUTH_INVALID = 4401;

export interface SocketOptions {
  methods: MethodTable;
  ctx: MethodContext;
  /** The engine feed subscriptions read from. Without it there is no socket. */
  source: SubscriptionSource;
  /** Authenticates each upgrade and re-checks the credential behind each connection. */
  gate: TransportGate;
  /** Authorizes each request and each notification. */
  authorizer: Authorizer;
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
  const wss = new WebSocketServer({
    noServer: true,
    // Select `orca.v1` when it is offered, and never anything else: in particular never the
    // `orca.bearer.*` protocol, which would echo the token back in a response header.
    handleProtocols: (protocols) => (protocols.has(SOCKET_PROTOCOL) ? SOCKET_PROTOCOL : false),
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // One path only: an upgrade anywhere else is a client's mistake, and answering it would
    // mean guessing what it wanted. Destroying the socket is what `ws` documents for this.
    if ((req.url ?? "").split("?")[0] !== SOCKET_PATH) return void socket.destroy();
    const admission = opts.gate.admit(req, "socket");
    if (!admission.ok) {
      // Refused before the handshake: no connection exists, so nothing can be pushed on one.
      // The status and envelope are the ones `/rpc` gives for the same refusal.
      const refusal = refusalOf(admission);
      const body = JSON.stringify(refusal.body);
      const head = [
        `HTTP/1.1 ${refusal.status} ${STATUS_CODES[refusal.status]}`,
        "content-type: application/json",
        `content-length: ${Buffer.byteLength(body)}`,
        "connection: close",
        ...Object.entries(refusal.headers).map(([k, v]) => `${k}: ${v}`),
      ];
      return void socket.end(`${head.join("\r\n")}\r\n\r\n${body}`);
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, admission));
  };
  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, admission: Extract<Admission, { ok: true }>) => {
    const meta = admission.meta;
    let principal: Principal | undefined = admission.principal;
    const subscriptions = new Map<string, Subscription>();
    const send = (message: ResponseMessage | NotificationMessage): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const fail = (id: RequestId, code: "PROTOCOL_MESSAGE" | "PROTOCOL_METHOD", message: string): void =>
      send({ kind: "response", id, ok: false, error: protocolError(code, message) });
    const stopAll = (): void => {
      for (const subscription of subscriptions.values()) subscription.stop();
      subscriptions.clear();
    };

    /**
     * The principal as of now - with any change to its grants - or `undefined` once its
     * credential has been revoked or has expired, in which case the connection is closed and
     * every subscription on it stopped before anything else is sent.
     */
    const current = (): Principal | undefined => {
      if (!principal) return undefined;
      const check = opts.gate.current(admission.credentialId);
      if (check.ok) return (principal = check.principal);
      opts.authorizer.connectionClosed(principal, meta, check.reason);
      principal = undefined;
      stopAll();
      clearInterval(timer);
      ws.close(CLOSE_AUTH_INVALID, "AUTH_INVALID");
      return undefined;
    };
    const timer = setInterval(() => void current(), opts.gate.revalidateMs);
    timer.unref?.();

    ws.on("message", (data: unknown) => {
      void (async () => {
        const who = current();
        if (!who) return;
        const text = String(data);
        const msg = parseMessage(text);
        // Not a request: the daemon has nothing to answer, and answering id 0 is what the
        // HTTP path does for the same case.
        if (!msg) return fail(0, "PROTOCOL_MESSAGE", "not a protocol message");
        if (msg.kind !== "request") return fail(0, "PROTOCOL_MESSAGE", `expected a request, got a ${msg.kind}`);

        // The operation grant, before params are parsed - including for the two socket methods.
        const answered =
          msg.method === SUBSCRIBE_METHOD ||
          msg.method === UNSUBSCRIBE_METHOD ||
          Object.hasOwn(opts.methods, msg.method);
        try {
          opts.authorizer.checkOperation(who, msg.method, answered, meta);
        } catch (e) {
          return send({
            kind: "response",
            id: msg.id,
            ok: false,
            error: isProtocolFault(e) ? e.toJSON() : describeError(e),
          });
        }

        if (msg.method === SUBSCRIBE_METHOD) {
          const params = SubscribeParamsSchema.safeParse(msg.params ?? {});
          if (!params.success) return fail(msg.id, "PROTOCOL_MESSAGE", `invalid params for '${SUBSCRIBE_METHOD}'`);
          let scope: "replay" | "silent";
          try {
            scope = await opts.authorizer.subscribeScope(who, params.data.runId, meta);
          } catch (e) {
            return send({
              kind: "response",
              id: msg.id,
              ok: false,
              error: isProtocolFault(e) ? e.toJSON() : describeError(e),
            });
          }
          // A run this caller cannot see gets what a run that does not exist gets: a
          // subscription that replays nothing and delivers nothing.
          const { since: _since, ...unreplayed } = params.data;
          const silent = scope === "silent";
          // Every frame passes the gate in order: the check is asynchronous (a run's root may
          // have to be read), so frames queue behind one another rather than racing.
          let delivered: Promise<void> = Promise.resolve();
          const gated = (message: NotificationMessage): void => {
            delivered = delivered
              .then(async () => {
                if (silent) return;
                const now = current();
                if (!now) return;
                const projected = await opts.authorizer.projectNotification(now, message);
                if (projected) send(projected);
              })
              .catch(() => undefined);
          };
          const id = `sub-${++nextSubscriptionId}`;
          const subscription = new Subscription({
            id,
            params: silent ? unreplayed : params.data,
            source: opts.source,
            send: gated,
            // Agent health lives on the context rather than on the source: it is not an
            // event feed and a daemon can have one without the other.
            ...(opts.ctx.agents ? { agents: opts.ctx.agents } : {}),
            // The configuration lives on the context for the same reason: it is not an
            // event feed, and a daemon can serve a workspace without one or the other.
            ...(opts.ctx.config ? { config: opts.ctx.config } : {}),
            // Plan changes live on the context for the same reason: the plan journal is not
            // an event feed, and a daemon can serve one without the other.
            ...(opts.ctx.planSource ? { plans: opts.ctx.planSource } : {}),
            ...(opts.ctx.liveInputs ? { liveInputs: opts.ctx.liveInputs } : {}),
            ...(opts.batchMs === undefined ? {} : { batchMs: opts.batchMs }),
          });
          subscriptions.set(id, subscription);
          try {
            const replayed = await subscription.start();
            // The replay's frames go out before the answer that counts them, as they always did.
            await delivered;
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

        send(await dispatch(text, opts.methods, bindPrincipal(opts.ctx, who, meta)));
      })();
    });

    ws.on("close", () => {
      clearInterval(timer);
      stopAll();
    });
  });

  return () =>
    new Promise<void>((resolve) => {
      server.off("upgrade", onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    });
}
