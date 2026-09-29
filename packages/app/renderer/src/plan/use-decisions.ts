/**
 * The decision mode's read (#173): `decisions.list` for the plan, made only while the mode is
 * on screen and re-made when a `decisions` frame bumps `revision`. Nothing polls, and a
 * decide or a reopen does not re-read here: the daemon journals the write and pushes
 * `plan.changed`, which is what moves `revision`.
 */
import { useCallback, useEffect, useState } from "react";
import type { DecisionView, ProtocolError } from "@orca/protocol";

export type DecisionsState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | { phase: "ready"; decisions: readonly DecisionView[] };

export function usePlanDecisions(
  planId: string | undefined,
  revision: number,
): { state: DecisionsState; reload: () => void } {
  const [state, setState] = useState<DecisionsState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (planId === undefined) return;
    let live = true;
    void window.orca.plan.decisions({ planId }).then((result) => {
      if (!live) return;
      setState(
        result.ok ? { phase: "ready", decisions: result.result.decisions } : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [planId, revision, attempt]);

  return { state, reload };
}
