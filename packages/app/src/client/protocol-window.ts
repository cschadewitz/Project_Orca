/**
 * The app's side of the protocol compatibility window (#880), in one module so every place
 * that judges a `hello` judges it the same way: the connection machine, the connection
 * target, first-run setup, the workspace and the subscription's verify step.
 *
 * A daemon on this app's protocol is `current`. While `PREVIOUS_PROTOCOL` is set, a daemon
 * one major behind is `previous`: the app connects, reads and writes, and everything the
 * newer major added stays off because that daemon does not advertise it, and the connection
 * banner says why. Anything else is a mismatch.
 *
 * Tests replace this module to stand the app one major ahead of a real daemon.
 */
import {
  PROTOCOL_WINDOW,
  daemonRelation,
  formatProtocolVersion,
  helloOffer,
  type ProtocolRelation,
  type ProtocolVersion,
  type ProtocolWindow,
} from "@orca/protocol";

export const APP_PROTOCOL_WINDOW: ProtocolWindow = PROTOCOL_WINDOW;

/** What the app sends in `hello`: its protocol, and its fallback while a window is open. */
export function appHelloOffer(): { protocol: ProtocolVersion; fallback?: ProtocolVersion } {
  return helloOffer(APP_PROTOCOL_WINDOW);
}

/** How this app relates to a daemon that answered `hello` with `daemon`, if it can talk to it at all. */
export function appDaemonRelation(daemon: ProtocolVersion): ProtocolRelation | undefined {
  return daemonRelation(daemon, APP_PROTOCOL_WINDOW);
}

/** Whether this app can talk to that daemon, on either protocol of its window. */
export function appSpeaks(daemon: ProtocolVersion): boolean {
  return appDaemonRelation(daemon) !== undefined;
}

/** This app's own protocol, for the "daemon 2.4 · app 3.0" rendering. */
export function appProtocolLabel(): string {
  return formatProtocolVersion(APP_PROTOCOL_WINDOW.current);
}
