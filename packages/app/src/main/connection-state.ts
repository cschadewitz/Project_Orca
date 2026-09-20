/**
 * The connection state machine: three inputs, one of the design system's five states, and
 * five seconds of silence in front of it.
 *
 * It lives in the main process because that is the only place all three inputs exist at
 * once — the renderer sees none of them:
 *
 * - **the socket**, as `DaemonSubscription.onState` (`connecting | live | reconnecting |
 *   closed`), which is the transport's own opinion and the fastest signal there is;
 * - **the bundled daemon's `onExit`**, which is the one thing that distinguishes "the
 *   daemon is restarting" from "the daemon this app started is gone";
 * - **the `hello` result**, which is the only thing that can say the daemon on the other
 *   end speaks a protocol this app cannot type-check.
 *
 * Two properties are the whole point of writing it as a machine rather than as conditionals
 * spread over the screens that care:
 *
 * - **The five states are decided once.** `connectionStateFor` below is the single mapping
 *   from those three inputs onto `ConnectionState`. A component never asks "is the socket
 *   reconnecting *and* was the handshake compatible"; it is handed a word.
 * - **A blip is not news.** Leaving `live` is held back for five seconds before anything is
 *   pushed, "because a WebSocket blip that resolves in 400ms should not flash a banner at
 *   someone reading a log" (docs/design/40-connection-states.md). The window is measured
 *   from the moment the connection went, so when the bar does appear it is already reading
 *   the true elapsed time rather than starting from zero.
 *
 * `file` is never produced here. It is a genuinely different product mode — a replay of an
 * event log with no daemon behind it — and the app cannot enter it until it can be pointed
 * at one (#164). This module is Electron-free so it can be driven by a plain test against
 * the real `DaemonSubscription`.
 */
import type { ConnectionState } from "@orca/design";
import {
  PROTOCOL_VERSION,
  formatProtocolVersion,
  isCompatible,
  type DaemonCapability,
  type HelloResult,
} from "@orca/protocol";
import type { ConnectionSnapshot } from "../bridge.js";
import type { SubscriptionState } from "../client/subscription.js";

/** How long a departure from `live` stays off the screen. */
export const QUIET_MS = 5_000;

/** Everything the five states are decided from. */
export interface ConnectionInputs {
  /** What the socket is doing — `DaemonSubscription.onState`. */
  link: SubscriptionState;
  /** Whether the last answered `hello` was a protocol this app can talk. */
  compatible: boolean;
  /** Whether a daemon this process started has exited on its own. */
  daemonGone: boolean;
}

/**
 * The one mapping from transport and handshake onto the design's five states.
 *
 * `mismatch` wins outright: a daemon that answers but speaks another major is reachable and
 * still unusable, and the two read very differently to a person. Otherwise a transport that
 * has stopped trying — or a daemon this app started and then watched exit — is
 * `disconnected`, and anything short of a subscribed socket is `reconnecting`. There is no
 * separate first-connect state; the system names five and inventing a sixth is a design
 * change, not an implementation detail.
 */
export function connectionStateFor({ link, compatible, daemonGone }: ConnectionInputs): ConnectionState {
  if (!compatible) return "mismatch";
  if (daemonGone || link === "closed") return "disconnected";
  return link === "live" ? "live" : "reconnecting";
}

export interface ConnectionMachineOptions {
  /**
   * Ask the daemon who it is. Called on every transition into `live`, because the daemon on
   * the far end of a reconnected socket is not necessarily the one that was there before —
   * a restart onto an older build is exactly the case the mismatch dialog exists for.
   */
  hello: () => Promise<HelloResult>;
  /** Called with every snapshot the renderer has not already been told about. */
  onChange: (snapshot: ConnectionSnapshot) => void;
  quietMs?: number | undefined;
  now?: (() => number) | undefined;
}

export class ConnectionMachine {
  private readonly opts: ConnectionMachineOptions;
  private readonly quietMs: number;
  private readonly now: () => number;

  /* -- the inputs -- */
  private link: SubscriptionState = "connecting";
  private compatible = true;
  private daemonGone = false;

  /* -- what the handshake said -- */
  private orcaVersion: string | undefined;
  private daemonProtocol: string | undefined;
  private capabilities: readonly DaemonCapability[] | undefined;
  private cursor: number | undefined;
  /** Guards a slow `hello` answering after a newer one was asked for. */
  private handshake = 0;

  /* -- the true state, and the one the screen has -- */
  private state: ConnectionState = "reconnecting";
  private since: number;
  private shown: ConnectionSnapshot;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;

  constructor(opts: ConnectionMachineOptions) {
    this.opts = opts;
    this.quietMs = opts.quietMs ?? QUIET_MS;
    this.now = opts.now ?? Date.now;
    this.since = this.now();
    this.shown = this.snapshot();
  }

  /** What a window that has just opened should be handed. Never undefined, never stale. */
  get current(): ConnectionSnapshot {
    return this.shown;
  }

  /** `DaemonSubscription.onState`. */
  linkChanged(link: SubscriptionState): void {
    if (this.done || this.link === link) return;
    this.link = link;
    // A socket that has just become a stream is a daemon that has just answered a
    // `subscribe`, and not necessarily the daemon that answered the last one.
    if (link === "live") void this.shakeHands();
    this.settle();
  }

  /** `startBundledDaemon`'s `onExit`: the daemon this process owns went away by itself. */
  daemonExited(): void {
    if (this.done) return;
    this.daemonGone = true;
    this.settle();
  }

  /**
   * The cursor a reconnect would resume from — `DaemonSubscription.lastSeq`. A sequence
   * number is per-run, so a store-wide subscription has none and passes `undefined`; the
   * status bar then shows no event number rather than a made-up one (rule 12).
   */
  sawCursor(cursor: number | undefined): void {
    if (this.done || cursor === undefined || cursor === this.cursor) return;
    this.cursor = cursor;
    this.settle();
  }

  /** Stop for good: no further pushes, no pending quiet window. Safe to call twice. */
  close(): void {
    this.done = true;
    this.disarm();
  }

  private async shakeHands(): Promise<void> {
    const token = ++this.handshake;
    let result: HelloResult;
    try {
      result = await this.opts.hello();
    } catch {
      /* The socket is a stream and the read endpoint did not answer. That is not a verdict
         on the daemon's protocol, so the last verdict stands rather than being invented. */
      return;
    }
    if (this.done || token !== this.handshake) return;
    this.orcaVersion = result.orcaVersion;
    this.daemonProtocol = formatProtocolVersion(result.protocol);
    this.capabilities = result.capabilities;
    this.compatible = isCompatible(PROTOCOL_VERSION, result.protocol);
    this.settle();
  }

  /** Recompute the state, then decide whether the screen gets to hear about it yet. */
  private settle(): void {
    if (this.done) return;
    const next = connectionStateFor({ link: this.link, compatible: this.compatible, daemonGone: this.daemonGone });
    if (next !== this.state) {
      this.state = next;
      this.since = this.now();
    }

    if (this.state === this.shown.state) {
      // Back where the screen already is: whatever was being waited out never happened, and
      // the blip cost a reader nothing. A cursor or a version may still have moved.
      this.disarm();
      this.publish();
      return;
    }

    // Leaving `live` is the one transition a person is spared for a moment. Everything
    // else — a mismatch, a first connection, a reconnection — is news as soon as it is known.
    if (this.shown.state === "live" && (this.state === "reconnecting" || this.state === "disconnected")) {
      this.arm();
      return;
    }
    this.disarm();
    this.publish();
  }

  /**
   * Hold the screen where it is until the quiet window runs out, measured from when the
   * connection went. An already-armed timer is left alone: a reconnecting stream that gives
   * up and becomes disconnected inside the window does not get a second five seconds.
   */
  private arm(): void {
    if (this.timer !== undefined) return;
    const wait = Math.max(0, this.since + this.quietMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.publish();
    }, wait);
    // A pending window must not be what keeps the process alive at quit.
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(): void {
    const next = this.snapshot();
    // Compared by value: a cursor that has not moved and a state that has not changed are
    // not worth an IPC frame to every window, and the renderer re-renders on identity.
    if (JSON.stringify(next) === JSON.stringify(this.shown)) return;
    this.shown = next;
    this.opts.onChange(next);
  }

  private snapshot(): ConnectionSnapshot {
    return {
      state: this.state,
      since: new Date(this.since).toISOString(),
      ...(this.cursor !== undefined ? { eventCursor: this.cursor } : {}),
      ...(this.daemonProtocol !== undefined
        ? { versions: { app: formatProtocolVersion(PROTOCOL_VERSION), daemon: this.daemonProtocol } }
        : {}),
      ...(this.orcaVersion !== undefined ? { orcaVersion: this.orcaVersion } : {}),
      ...(this.capabilities !== undefined ? { capabilities: this.capabilities } : {}),
    };
  }
}
