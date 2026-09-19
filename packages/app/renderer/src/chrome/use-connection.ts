/**
 * A one-shot connection probe at startup, mapped onto the five connection states by
 * `connection.ts`: reconnecting until `hello` answers, then live, mismatch or
 * disconnected. The reconnect state machine that keeps it moving after that is #163;
 * this issue only needs enough to render the title bar and the status bar.
 */
import { useEffect, useState } from "react";
import type { ConnectionState } from "@orca/design";
import { connectionState, type Handshake } from "../connection.js";

export interface Connection {
  state: ConnectionState;
  /** When the current attempt started — the indicator's elapsed/last-seen reading. */
  since: Date;
  orcaVersion?: string;
}

export function useConnection(): Connection {
  const [handshake, setHandshake] = useState<Handshake>({ phase: "connecting" });
  const [since] = useState(() => new Date());

  useEffect(() => {
    let live = true;
    void window.orca.hello().then((result) => {
      if (live) setHandshake({ phase: "done", result });
    });
    return () => {
      live = false;
    };
  }, []);

  const version = handshake.phase === "done" && handshake.result.ok ? handshake.result.result.orcaVersion : undefined;
  return { state: connectionState(handshake), since, ...(version !== undefined ? { orcaVersion: version } : {}) };
}
