/**
 * How a `hello` round trip maps onto the design system's five connection states, kept
 * apart from the component so it can be tested without a DOM (`test/connection.test.ts`).
 * The screens that replace the placeholder will need the same mapping for the status bar.
 */
import type { ConnectionState } from "@orca/design";
import { PROTOCOL_VERSION, formatProtocolVersion, isCompatible, type HelloResult } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";

export type Handshake = { phase: "connecting" } | { phase: "done"; result: BridgeResult<HelloResult> };

/**
 * A daemon that answers but speaks another major protocol is `mismatch`, not `live`: it is
 * reachable and still unusable, and the two read very differently to a user. `reconnecting`
 * is the closest state the system names for "no answer yet"; there is no separate
 * first-connect state, and inventing one is a design change, not an implementation detail.
 */
export function connectionState(handshake: Handshake): ConnectionState {
  if (handshake.phase === "connecting") return "reconnecting";
  if (!handshake.result.ok) return "disconnected";
  return isCompatible(PROTOCOL_VERSION, handshake.result.result.protocol) ? "live" : "mismatch";
}

/** The body of the placeholder's log well: the handshake result, or why there isn't one. */
export function handshakeDetail(handshake: Handshake): string {
  if (handshake.phase === "connecting") return `asking for protocol ${formatProtocolVersion(PROTOCOL_VERSION)}…`;
  if (!handshake.result.ok) return `${handshake.result.error.code}: ${handshake.result.error.message}`;
  return JSON.stringify(handshake.result.result, null, 2);
}
