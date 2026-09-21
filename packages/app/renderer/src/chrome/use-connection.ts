/**
 * The connection state, as the chrome reads it: a subscription to what the main process
 * pushes, not a probe.
 *
 * It used to be a one-shot `hello` at startup, which could only ever be right once — a
 * daemon that went away afterwards left the status bar claiming a connection that had
 * stopped existing. The state machine that decides the five states now lives in the main
 * process (`src/main/connection-state.ts`), because the socket, the bundled daemon's exit
 * and the handshake are all on that side of the bridge; this hook only holds the latest
 * snapshot and turns it into the shape the chrome renders.
 *
 * The first value comes from a synchronous `read()` so the status bar is right on the first
 * paint, and the effect re-reads after subscribing: a change that landed between the render
 * and the subscription would otherwise be the one change nobody hears about.
 */
import { useEffect, useMemo, useState } from "react";
import type { ConnectionSnapshot } from "../../../src/bridge.js";
import { toConnection, writability, writesPresent, type Connection, type Writability } from "../connection.js";

export type { Connection } from "../connection.js";

export function useConnection(): Connection {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>(() => window.orca.connection.read());

  useEffect(() => {
    const unsubscribe = window.orca.connection.subscribe(setSnapshot);
    setSnapshot(window.orca.connection.read());
    return unsubscribe;
  }, []);

  return useMemo(() => toConnection(snapshot), [snapshot]);
}

/**
 * "Can write, or why not", for any control that sends something. The reason is a sentence
 * fit for `Button`'s `disabledReason`, so a control never has to compose its own — and so
 * that every control in the app gives the same answer to the same question.
 */
export function useWritability(): Writability {
  const connection = useConnection();
  return useMemo(() => writability(connection), [connection]);
}

/**
 * Whether a write control belongs on the screen at all — see `writesPresent`. A control
 * asks this *and* `useWritability()`: the first decides whether it is drawn, the second
 * why it is disabled when it is.
 */
export function useWritesPresent(): boolean {
  const connection = useConnection();
  return writesPresent(connection);
}
