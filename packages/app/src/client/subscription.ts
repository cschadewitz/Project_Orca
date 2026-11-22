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
  PROTOCOL_VERSION,
  SUBSCRIBE_METHOD,
  SubscribeResultSchema,
  parseMessage,
  parseNotification,
  type DaemonNotification,
  type SubscribeParams,
} from "@orca/protocol";

import type { DaemonIdentity } from "../daemon-connection.js";
import {
  assertCredentialDestination,
  authenticationCode,
  CredentialTransportUnavailable,
  type DaemonTokenSource,
} from "./auth.js";

/** What the subscription needs of an open connection. */
export interface SocketHandle {
  send: (text: string) => void;
  close: () => void;
}

/** What it wants told about one. `onClose` fires once per connection, however it ended. */
export interface SocketHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: (code?: number) => void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers, protocols?: string[]) => SocketHandle;

/**
 * The default: Node's own `WebSocket`, which is also Electron's. No `ws` on this side -
 * the daemon needs a WebSocket *server* and the platform has none, but a client it has.
 */
export const webSocketFactory: SocketFactory = (url, handlers, protocols) => {
  const ws = new WebSocket(url, protocols);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event: MessageEvent) => handlers.onMessage(String(event.data));
  // A connection that never opened fires `error` and then `close`. `close` is the one that
  // always comes, so reconnection hangs off that alone; this handler exists only so that a
  // failed connect is not an unhandled error event.
  ws.onerror = () => {};
  ws.onclose = (event: CloseEvent) => handlers.onClose(event.code);
  return { send: (text) => ws.send(text), close: () => ws.close() };
};

/**
 * The delay before each reconnection attempt, in order; the last value repeats. Immediate,
 * then widening to five seconds - long enough not to bother a daemon that is down, short
 * enough that a person who restarts one does not notice.
 */
export const RECONNECT_BACKOFF_MS = [0, 250, 1_000, 2_500, 5_000] as const;

/** What the connection indicator shows. `closed` is deliberate: nobody is trying any more. */
export type SubscriptionState = "connecting" | "live" | "reconnecting" | "auth-failed" | "closed";

/**
 * How badly the retry loop is doing, reported beside the state.
 *
 * The word on its own cannot say: a socket that has failed twice and a socket that has
 * failed twenty times are both `reconnecting`, and that difference is exactly what #239
 * asks the status bar to tell apart. It is a fact about *this* loop rather than a
 * stopwatch, so `atCap` survives a change to `RECONNECT_BACKOFF_MS` — it counts the
 * failures that were already waiting the longest this subscription will ever wait.
 */
export interface RetryCount {
  /** Consecutive failed connections; reset to zero by an accepted `subscribe`. */
  consecutive: number;
  /** How many of those waited the backoff's last, repeating delay. */
  atCap: number;
}

export interface DaemonSubscriptionOptions {
  /** The daemon's socket URL - `DaemonClient.socketUrl`. */
  url: string;
  params: SubscribeParams;
  onNotification: (notification: DaemonNotification) => void;
  /**
   * Called on every transition, and on *every* failed connection even where the word does
   * not change, because the retry count is news when `reconnecting` is not.
   */
  onState?: ((state: SubscriptionState, retries: RetryCount) => void) | undefined;
  socket?: SocketFactory | undefined;
  backoffMs?: readonly number[] | undefined;
  /** Check this attempt's lifetime before publishing any verification side effects. */
  verify?: (isCurrent: () => boolean) => Promise<DaemonIdentity | undefined>;
  auth?: { tokens: DaemonTokenSource; verify?: () => Promise<void> };
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
  private authRetried = false;
  private epoch = 0;
  private identity: DaemonIdentity | undefined;
  private verified = false;
  private resetCursor = false;

  constructor(opts: DaemonSubscriptionOptions) {
    this.opts = opts;
    this.socket = opts.socket ?? webSocketFactory;
    this.backoff = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
    this.connect();
  }

  get state(): SubscriptionState {
    return this.current;
  }

  /**
   * How many connections have failed in a row, and how many of those waited the capped
   * delay. `atCap` is derived rather than counted: every attempt after the backoff runs
   * out of entries waits the last one, so the first capped attempt is the `length - 1`th.
   */
  get retries(): RetryCount {
    const beforeTheCap = this.backoff.length - 1;
    return { consecutive: this.attempt, atCap: Math.max(0, this.attempt - beforeTheCap) };
  }

  /** The cursor a reconnect would resume from; `undefined` until the first notification. */
  get lastSeq(): number | undefined {
    return this.cursor;
  }

  /** Stop for good: no further frames, no further reconnection. Safe to call twice. */
  close(): void {
    if (this.done) return;
    this.done = true;
    this.epoch += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.handle?.close();
    this.handle = undefined;
    this.setState("closed");
  }

  private setState(state: SubscriptionState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onState?.(state, this.retries);
  }

  private connect(): void {
    if (this.done) return;
    const epoch = ++this.epoch;
    const verify = this.opts.verify ?? this.opts.auth?.verify;
    if (verify) {
      void verify(() => !this.done && this.epoch === epoch).then(
        (identity) => {
          if (this.done || this.epoch !== epoch) return;
          if (
            this.verified &&
            (!identity ||
              !this.identity ||
              identity.workspaceId !== this.identity.workspaceId ||
              identity.instanceId !== this.identity.instanceId)
          ) {
            this.cursor = undefined;
            this.resetCursor = true;
          }
          this.identity = identity || undefined;
          this.verified = true;
          this.openSocket(epoch);
        },
        (error: unknown) => {
          if (this.done || this.epoch !== epoch) return;
          const code = authenticationCode(error);
          if (code) this.authenticationFailed(code === "AUTH_INVALID");
          else this.onClose();
        },
      );
    } else this.openSocket(epoch);
  }

  private openSocket(epoch: number): void {
    let token: string | undefined;
    try {
      token = this.opts.auth?.tokens.read();
      assertCredentialDestination(this.opts.url, token);
    } catch (error) {
      // A tunnel that is not verified yet: reconnect later, as for a dropped socket.
      if (error instanceof CredentialTransportUnavailable) {
        this.onClose();
        return;
      }
      this.authenticationFailed(false);
      return;
    }
    this.handle = this.socket(
      this.opts.url,
      {
        onOpen: () => {
          if (this.epoch === epoch) this.onOpen();
        },
        onMessage: (text) => {
          if (this.epoch === epoch) this.onMessage(text);
        },
        onClose: (code) => {
          if (this.epoch === epoch) this.onClose(code);
        },
      },
      token ? ["orca.v1", `orca.bearer.${token}`] : undefined,
    );
  }

  /** A revoked credential is not a network blip. One local reload, then stay refused. */
  private authenticationFailed(refresh: boolean): void {
    this.epoch += 1;
    const handle = this.handle;
    this.handle = undefined;
    this.pendingSubscribe = undefined;
    handle?.close();
    this.setState("auth-failed");
    if (!refresh || this.authRetried || !this.opts.auth) return;
    this.authRetried = true;
    try {
      if (this.opts.auth.tokens.refresh()) this.connect();
    } catch {
      // The state already says authentication failed; never log credential-file contents.
    }
  }

  // The socket callbacks are epoch-guarded in openSocket; close invalidates that epoch.
  private onOpen(): void {
    this.pendingSubscribe = ++this.requestId;
    // Resume where the stream got to. A cursor is a sequence number within one run, so it
    // only goes out when the subscription is for one run (the protocol refuses it otherwise).
    // This build's event schema reads every type up to its own protocol (#357).
    const base: SubscribeParams = { protocol: PROTOCOL_VERSION, ...this.opts.params };
    if (this.resetCursor) delete base.since;
    const params: SubscribeParams =
      this.opts.params.runId !== undefined && this.cursor !== undefined ? { ...base, since: this.cursor } : base;
    this.handle?.send(JSON.stringify({ kind: "request", id: this.pendingSubscribe, method: SUBSCRIBE_METHOD, params }));
  }

  private onMessage(text: string): void {
    const message = parseMessage(text);
    if (!message) return;
    if (message.kind === "response") {
      if (message.id !== this.pendingSubscribe) return;
      this.pendingSubscribe = undefined;
      if (!message.ok && authenticationCode(message)) {
        this.authenticationFailed(message.error.code === "AUTH_INVALID");
        return;
      }
      // A refused subscribe is not a transport failure, and retrying it would loop: the
      // daemon means it. The stream stays open for whatever else the connection carries.
      if (!message.ok || !SubscribeResultSchema.safeParse(message.result).success) return;
      this.attempt = 0;
      this.authRetried = false;
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

  private onClose(code?: number): void {
    if (code === 4401) {
      this.authenticationFailed(true);
      return;
    }
    this.epoch += 1;
    this.handle = undefined;
    this.pendingSubscribe = undefined;
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 0;
    this.attempt += 1;
    /* Announced after the count has moved, and announced again on every further failure
       even though the word stays `reconnecting`: the second, third and seventh failures
       are all news to a machine that gives up at the cap (#239), and `setState` would
       swallow every one of them after the first. */
    if (this.current !== "auth-failed") this.current = "reconnecting";
    this.opts.onState?.(this.current, this.retries);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
    // A pending retry must not be what keeps the process alive at quit.
    this.timer.unref?.();
  }
}
