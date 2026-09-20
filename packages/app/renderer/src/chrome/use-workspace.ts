/**
 * Which store is on screen, as the chrome reads it.
 *
 * The same shape as `useConnection` and for the same reason: the main process owns the
 * answer (`src/main/workspace.ts`), the first value comes from a synchronous `read()` so
 * the file-mode banner names the store on the first paint, and the effect re-reads after
 * subscribing so a switch that landed between the render and the subscription is not the
 * one change nobody hears about.
 *
 * It is a separate channel from the connection on purpose: the connection says whether a
 * daemon is answering, this says *which store* answered, and a person can be disconnected
 * from a store they chose — the banner still has to name it.
 */
import { useEffect, useState } from "react";
import type { WorkspaceSnapshot } from "../../../src/bridge.js";

export function useWorkspace(): WorkspaceSnapshot {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(() => window.orca.workspace.read());

  useEffect(() => {
    const unsubscribe = window.orca.workspace.subscribe(setSnapshot);
    setSnapshot(window.orca.workspace.read());
    return unsubscribe;
  }, []);

  return snapshot;
}
