/**
 * What a screen is allowed to conclude from the connection state, in one place and with no
 * DOM (`packages/app/test/connection.test.ts`).
 *
 * The state itself is not decided here any more. It is decided once, in the main process
 * (`src/main/connection-state.ts`), from the socket, the bundled daemon's exit and the
 * handshake, and arrives over the `connection` bridge namespace as a snapshot. What is left
 * for the renderer is the three questions every surface asks of that word, kept together so
 * that they are answered the same way on every screen:
 *
 * - **is what is on screen last-known rather than live** — the values drop to
 *   `opacity-stale`, the labels do not;
 * - **do the clocks run** — a duration accruing against a daemon that is not talking is an
 *   invented number, and a relative time computed against a stale clock is a lie
 *   (docs/design/40-connection-states.md, docs/design/60-implementation.md);
 * - **can this app write, and if not, why not** — which is a question about the connection
 *   *and* about what the daemon said it could do.
 */
import type { ConnectionState } from "@orca/design";
import type { DaemonCapability } from "@orca/protocol";
import type { ConnectionSnapshot } from "../../src/bridge.js";

/** The snapshot as the chrome holds it: `since` parsed once, `capabilities` never undefined. */
export interface Connection {
  state: ConnectionState;
  /** For `reconnecting`, when the attempt started. For `disconnected`, when it was last live. */
  since: Date;
  eventCursor?: number;
  versions?: { app: string; daemon: string };
  orcaVersion?: string;
  /** What the daemon said it can do; empty until it has said, which is not an error. */
  capabilities: readonly DaemonCapability[];
}

export function toConnection(snapshot: ConnectionSnapshot): Connection {
  return {
    state: snapshot.state,
    since: new Date(snapshot.since),
    capabilities: snapshot.capabilities ?? [],
    ...(snapshot.eventCursor !== undefined ? { eventCursor: snapshot.eventCursor } : {}),
    ...(snapshot.versions !== undefined ? { versions: snapshot.versions } : {}),
    ...(snapshot.orcaVersion !== undefined ? { orcaVersion: snapshot.orcaVersion } : {}),
  };
}

/** Whether the values on screen are the last the daemon sent rather than what is true now. */
export function isStale(state: ConnectionState): boolean {
  return state !== "live";
}

/**
 * Whether accruing durations and running pulses keep moving. Only `live` does: "the pulse
 * stops and the glyph becomes ◷" (docs/design/40-connection-states.md).
 */
export function clocksRun(state: ConnectionState): boolean {
  return state === "live";
}

/** What `Time` should show. Absolute off `live`, because "6m ago" against a stale clock lies. */
export function timeDisplay(state: ConnectionState): "both" | "absolute" {
  return state === "live" ? "both" : "absolute";
}

/**
 * "Can write, or why not." Never `{ can: false }` without a sentence: a control that is
 * disabled and silent reads as broken, and docs/design/40-connection-states.md requires the
 * reason to be *on* the control (which is what `Button`'s `disabledReason` is for).
 */
export type Writability = { can: true } | { can: false; reason: string };

/** The one capability that means this daemon will take a command about a run. */
export const CONTROL_CAPABILITY: DaemonCapability = "runs.control";

/**
 * Two questions, in that order. The connection comes first because it is the one a person
 * can act on — reconnect and ask again. Only a live daemon gets asked the second question,
 * and the answer today is almost always no: **no daemon advertises `runs.control` yet**
 * (it arrives with the control methods), and an absent capability is a calm, explained
 * unavailability rather than an error. A daemon that has not answered `hello` at all is in
 * exactly the same position, and says the same thing, because "it has not said" and "it
 * said no" mean the same to a person holding a button that will not do anything.
 */
export function writability(connection: Pick<Connection, "state" | "capabilities" | "versions">): Writability {
  switch (connection.state) {
    case "reconnecting":
      /* The spec queues a write here and labels the button "will send on reconnect". There
         is no queue yet — the control methods and their outbox are #163's successors — and
         promising one the app does not have would be worse than saying to wait. */
      return { can: false, reason: "the daemon is not answering; wait for the connection to come back" };
    case "disconnected":
      return { can: false, reason: "no daemon is answering" };
    case "file":
      return { can: false, reason: "file mode is a replay of an event log; there is nothing to send to" };
    case "mismatch":
      return {
        can: false,
        reason: connection.versions
          ? `the daemon speaks protocol ${connection.versions.daemon}, this app ${connection.versions.app}`
          : "the daemon speaks a protocol this app cannot type-check",
      };
    case "live":
      return connection.capabilities.includes(CONTROL_CAPABILITY)
        ? { can: true }
        : { can: false, reason: "this daemon offers no run control" };
  }
}
