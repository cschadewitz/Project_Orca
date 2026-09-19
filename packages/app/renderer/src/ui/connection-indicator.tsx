/**
 * `ConnectionIndicator` — the status bar's rendering of the five connection states.
 *
 * Rendering only: what state the app is in, and how it gets there, is the reconnect state
 * machine's job (#163). This component is handed a state and draws the row from
 * docs/design/40-connection-states.md — glyph, word, and the one detail that state needs:
 * how long reconnecting has been going, when the last event arrived, the two versions.
 *
 * It is a polite live region because the spec says the connection state announces on
 * change. The `since` detail is inside it and ticks once a second, which would make every
 * tick an announcement, so the detail is `aria-hidden` and only the word is announced.
 */
import type { JSX } from "react";
import { CONNECTION_PRESENTATION, type ConnectionState } from "@orca/design";
import { Duration, Time } from "./time.js";
import { Text } from "./text.js";

export interface ConnectionIndicatorProps {
  state: ConnectionState;
  /** For 'reconnecting': when the attempt started. For 'disconnected': the last event. */
  since: Date;
  /** The event the UI is projected up to. Shown live, because it is how you tell it is moving. */
  eventCursor?: number;
  versions?: { app: string; daemon: string };
  className?: string;
}

export function ConnectionIndicator({
  state,
  since,
  eventCursor,
  versions,
  className,
}: ConnectionIndicatorProps): JSX.Element {
  const { word, glyph } = CONNECTION_PRESENTATION[state];

  return (
    <span
      className={["orca-conn", `orca-conn--${state}`, className].filter(Boolean).join(" ")}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">{glyph}</span>
      <span>{word}</span>
      <span aria-hidden="true">{detail(state, since, eventCursor, versions)}</span>
    </span>
  );
}

/** One detail per state, exactly as the status-bar column in 40-connection-states.md reads. */
function detail(
  state: ConnectionState,
  since: Date,
  eventCursor: number | undefined,
  versions: { app: string; daemon: string } | undefined,
): JSX.Element | null {
  switch (state) {
    case "live":
      return eventCursor === undefined ? null : <Text style="mono-id">{`· event ${eventCursor}`}</Text>;
    case "reconnecting":
      /* Elapsed, not the time it started: "reconnecting… 3s" is the wording in the spec. */
      return (
        <>
          {"… "}
          <Duration since={since} />
        </>
      );
    case "disconnected":
      /* Relative here: this is the one clock the app still trusts, its own. */
      return (
        <>
          {"· "}
          <Time at={since} show="relative" />
        </>
      );
    case "file":
      return <Text style="caption">· read-only</Text>;
    case "mismatch":
      return versions === undefined ? null : (
        <Text style="mono-id">{`· daemon ${versions.daemon} · app ${versions.app}`}</Text>
      );
  }
}
