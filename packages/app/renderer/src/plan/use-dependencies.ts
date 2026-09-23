/**
 * The dependency graph's reads (#171): the plan's whole `dependencies.list` and the cycles
 * `schedule.get` reports, made only while the graph is on screen.
 *
 * A write this surface made is folded in from its own answer rather than re-read:
 * `dependencies.waive` answers with the dependency as it now stands, so `patch` replaces that
 * one row and the graph, the inspector and the strip move at once — no second
 * `dependencies.list`. A `plan.changed` frame (`revision`) is still what re-reads, because a
 * push is the daemon saying something changed that this surface did not do.
 */
import { useCallback, useEffect, useState } from "react";
import type { DependencyView, ProtocolError } from "@orca/protocol";
import { patchDependency } from "./graph-model.js";

export type DependenciesState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | { phase: "ready"; dependencies: readonly DependencyView[]; cycles: readonly (readonly string[])[] };

export function usePlanDependencies(
  planId: string | undefined,
  revision: number,
): { state: DependenciesState; reload: () => void; patch: (changed: DependencyView) => void } {
  const [state, setState] = useState<DependenciesState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (planId === undefined) return;
    let live = true;
    void Promise.all([window.orca.plan.dependencies({ planId }), window.orca.plan.schedule({ planId })]).then(
      ([dependencies, schedule]) => {
        if (!live) return;
        if (!dependencies.ok) {
          setState({ phase: "error", error: dependencies.error });
          return;
        }
        setState({
          phase: "ready",
          dependencies: dependencies.result.dependencies,
          // A schedule that could not be read has no cycles to report, which is not a failure
          // of the graph: the edges are still the dependencies.
          cycles: schedule.ok ? schedule.result.schedule.cycles : [],
        });
      },
    );
    return () => {
      live = false;
    };
  }, [planId, revision, attempt]);

  const patch = useCallback((changed: DependencyView) => {
    setState((current) =>
      current.phase === "ready"
        ? { ...current, dependencies: patchDependency(current.dependencies, changed) }
        : current,
    );
  }, []);

  return { state, reload, patch };
}
