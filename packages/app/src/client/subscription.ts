/**
 * The app's end of the daemon's push channel: one WebSocket, one `subscribe`, and a
 * notification stream that survives the daemon going away. Lives in the main process beside
 * `DaemonClient` (the renderer never sees a socket, only the preload bridge) and imports
 * nothing but `@orca/protocol`, which lint enforces for the whole app package.
 *
 * What this adds over "open a socket and listen" is the two things a desktop app cannot do
 * without:
 *
 * - **Reconnect with backoff.** A daemon restarts, a laptop sleeps, a VPN drops. The socket
 *   closes, and this reopens it on a widening delay rather than hammering a machine that is
 *   busy starting up. The first retry is immediate, because much the commonest cause is a
 *   daemon that just finished restarting.
 * - **Resume from the cursor.** Every notification carries `seq`, the sequence number of the
 *   event behind it, so the highest one seen is exactly where the stream got to. Resubscribe
 *   sends it as `since` and the daemon replays `since + 1` onwards, so a blip costs latency
 *   and not data. A cursor is per-run, so this only applies to a subscription with a
 *   `runId`; a store-wide one reconnects fresh and the screens behind it re-read.
 *
 * The socket is opened through a `SocketFactory` rather than `new WebSocket` directly, so a
 * test drives the whole lifecycle - open, frame, close, reconnect - without a server and
 * without waiting on a real timer.
 */
import {
  SUBSCRIBE_METHOD,
  SubscribeResultSchema,
  parseMessage,
  parseNotification,
  type DaemonNotification,
  type SubscribeParams,
} from "@orca/protocol";

/** What the subscription needs of an open connection. */
export interface SocketHandle {
  send: (text: string) => void;
  close: () => void;
}

/** What it wants told about one. `onClose` fires once per connection, however it ended. */
export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: () => void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

/**
 * The default: Node 22's own `WebSocket`, which is also Electron's. No `ws` on this side -
 * the daemon needs a WebSocket *server* and the platform has none, but a client it has.
 */
export const webSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event: MessageEvent) => handlers.onMessage(String(event.data));
  // A connection that never opened fires `error` and then `close`. `close` is the one that
  // always comes, so reconnection hangs off that alone; this handler exists only so that a
  // failed connect is not an unhandled error event.
  ws.onerror = () => {};
  ws.onclose = () => handlers.onClose();
  return { send: (text) => ws.send(text), close: () => ws.close() };
};

/**
 * The delay before each reconnection attempt, in order; the last value repeats. Immediate,
 * then widening to five seconds - long enough not to bother a daemon that is down, short
 * enough that a person who restarts one does not notice.
 */
export const RECONNECT_BACKOFF_MS = [0, 250, 1_000, 2_500, 5_000] as const;

/** What the connection indicator shows. `closed` is deliberate: nobody is trying any more. */
export type SubscriptionState = "connecting" | "live" | "reconnecting" | "closed";

export interface DaemonSubscriptionOptions {
  /** The daemon's socket URL - `DaemonClient.socketUrl`. */
  url: string;
  params: SubscribeParams;
  onNotification: (notification: DaemonNotification) => void;
  /** Called on every transition, for the connection indicator. */
  onState?: ((state: SubscriptionState) => void) | undefined;
  socket?: SocketFactory | undefined;
  backoffMs?: readonly number[] | undefined;
}

export class DaemonSubscription {
  private readonly opts: DaemonSubscriptionOptions;
  private readonly socket: SocketFactory;
  private readonly backoff: readonly number[];
  private handle: SocketHandle | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** How many times in a row the connection has failed; reset by a successful `subscribe`. */
  private attempt = 0;
  private requestId = 0;
  private pendingSubscribe: number | undefined;
  /** The highest `seq` seen, and so where a resubscribe resumes from. */
  private cursor: number | undefined;
  private current: SubscriptionState = "connecting";
  private done = false;

  constructor(opts: DaemonSubscriptionOptions) {
    this.opts = opts;
    this.socket = opts.socket ?? webSocketFactory;
    this.backoff = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
    this.connect();
  }

  get state(): SubscriptionState {
    return this.current;
  }

  /** The cursor a reconnect would resume from; `undefined` until the first notification. */
  get lastSeq(): number | undefined {
    return this.cursor;
  }

  /** Stop for good: no further frames, no further reconnection. Safe to call twice. */
  close(): void {
    if (this.done) return;
    this.done = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.handle?.close();
    this.handle = undefined;
    this.setState("closed");
  }

  private setState(state: SubscriptionState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onState?.(state);
  }

  // Only ever called from the constructor or from a timer `close()` would have cleared, so
  // it needs no `done` guard of its own; `onOpen` does, because a socket can still open
  // after the close that stopped caring about it.
  private connect(): void {
    this.handle = this.socket(this.opts.url, {
      onOpen: () => this.onOpen(),
      onMessage: (text) => this.onMessage(text),
      onClose: () => this.onClose(),
    });
  }

  private onOpen(): void {
    if (this.done) return;
    this.pendingSubscribe = ++this.requestId;
    // Resume where the stream got to. A cursor is a sequence number within one run, so it
    // only goes out when the subscription is for one run (the protocol refuses it otherwise).
    const params: SubscribeParams =
      this.opts.params.runId !== undefined && this.cursor !== undefined
        ? { ...this.opts.params, since: this.cursor }
        : this.opts.params;
    this.handle?.send(JSON.stringify({ kind: "request", id: this.pendingSubscribe, method: SUBSCRIBE_METHOD, params }));
  }

  private onMessage(text: string): void {
    if (this.done) return;
    const message = parseMessage(text);
    if (!message) return;
    if (message.kind === "response") {
      if (message.id !== this.pendingSubscribe) return;
      this.pendingSubscribe = undefined;
      // A refused subscribe is not a transport failure, and retrying it would loop: the
      // daemon means it. The stream stays open for whatever else the connection carries.
      if (!message.ok || !SubscribeResultSchema.safeParse(message.result).success) return;
      this.attempt = 0;
      this.setState("live");
      return;
    }
    if (message.kind !== "notification") return;
    const notification = parseNotification(message);
    if (!notification) return;
    /* Only for the run this subscription is about, and only from a frame that has a cursor:
       sequence numbers are per-run, so a store-wide stream interleaves numbers from
       unrelated logs and has no single cursor, and `agent.changed` has no `seq` at all
       (#241). The `runId` test alone is not enough — on a store-wide subscription it
       compares `undefined` with `undefined` and passes, which would fold `undefined` into
       the cursor the moment a cursor-less notification arrived. */
    const { runId, seq } = notification.params as { runId?: string; seq?: number };
    if (runId === this.opts.params.runId && typeof seq === "number") {
      this.cursor = this.cursor === undefined ? seq : Math.max(this.cursor, seq);
    }
    this.opts.onNotification(notification);
  }

  private onClose(): void {
    if (this.done) return;
    this.handle = undefined;
    this.pendingSubscribe = undefined;
    this.setState("reconnecting");
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 0;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
    // A pending retry must not be what keeps the process alive at quit.
    this.timer.unref?.();
  }
}
