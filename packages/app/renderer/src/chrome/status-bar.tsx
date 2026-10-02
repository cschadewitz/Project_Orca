/**
 * Bottom bar: the connection, the event cursor, the daemon's version, and — when it is not
 * the connection that is stopping them — why writes are unavailable.
 *
 * The connection indicator lives here rather than in the title bar (#163). The status bar
 * is where docs/design/40-connection-states.md puts it, and it is the only place with room
 * for the detail each state carries: the ticking event cursor while live, the elapsed
 * attempt while reconnecting, the two protocol versions on a mismatch. It is a polite live
 * region, so the word announces when it changes and the ticking detail does not.
 *
 * The "read-only" note is the calm half of "can write, or why not". It appears only while
 * the connection is `live`, because every other state has already said so two cells to the
 * left and a second sentence saying the same thing is noise. Today it is the normal case
 * rather than the exception: no daemon advertises `runs.control` yet, so a connected app is
 * a readable one, and saying so plainly beats a screen of controls that do nothing.
 *
 * The active run count the mock shows is still missing — no protocol method serves it — so
 * it is absent rather than an invented zero (docs/design/60-implementation.md).
 */
import type { JSX } from "react";
import { Button, ConnectionIndicator, Text, textClass } from "../ui/index.js";
import { writability, type Connection } from "../connection.js";

export interface StatusBarProps {
  connection: Connection;
}

export function StatusBar({ connection }: StatusBarProps): JSX.Element {
  const writes = writability(connection);

  return (
    <div className={`orca-statusbar ${textClass("mono-id")}`}>
      <ConnectionIndicator
        state={connection.state}
        since={connection.since}
        {...(connection.eventCursor !== undefined ? { eventCursor: connection.eventCursor } : {})}
        {...(connection.versions ? { versions: connection.versions } : {})}
      />
      {window.orca.daemonConnection && (
        <Button size="sm" onClick={() => window.orca.daemonConnection?.show()}>
          Connect to a daemon…
        </Button>
      )}
      <span className="orca-spacer" />
      {connection.state === "live" && !writes.can ? (
        <Text style="caption" className="orca-faint">
          read-only — {writes.reason}
        </Text>
      ) : null}
      {connection.orcaVersion ? (
        <span>orca-daemon {connection.orcaVersion}</span>
      ) : (
        <span className="orca-faint">no daemon</span>
      )}
    </div>
  );
}
