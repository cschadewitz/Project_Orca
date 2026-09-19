/**
 * The Runs surface's data: one `runs.list` for the page, then `run.changed` for everything
 * after it.
 *
 * The rule this hook exists to keep is "updates without refetching". A list that re-read
 * `runs.list` on every notification would ask the daemon for the whole store several times a
 * second on a busy run and would still show a row flickering between two answers. So the
 * page is read once per filter and every later transition is folded into the row it is about
 * (`run-rows.ts`).
 *
 * The one call a notification *does* make is for a run the list has never seen. `run.changed`
 * carries a status and a cursor, not a name, a workflow or a creation time — there is no row
 * to draw from it — so an unknown run id is resolved with a single `runs.get` and inserted in
 * creation order. That is what makes a run started from the CLI appear here without a reload,
 * and it is one round trip for one run rather than a re-read of the list.
 *
 * The status filter is a `runs.list` parameter and so re-reads; the text filter is applied to
 * what is already held (see `run-rows.ts` for why the two are split).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayStatus, ProtocolError, RunSummaryView } from "@orca/protocol";
import { useNotifications } from "../notifications-context.js";
import { applyRunChanged, mergeRun, orderRuns } from "./run-rows.js";

/** The status half of the filter. `all` is the absence of a filter, not a ninth status. */
export type StatusFilter = DisplayStatus | "all";

export type RunsState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | {
      phase: "ready";
      runs: readonly RunSummaryView[];
      /** How many runs match the filter in the store — more than `runs.length` when paged. */
      total: number;
    };

export interface RunsFeed {
  state: RunsState;
  /** Re-read the page: the error state's retry, and what a person reaches for after a blip. */
  reload: () => void;
}

export function useRuns(status: StatusFilter): RunsFeed {
  const stream = useNotifications();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RunsState>({ phase: "loading" });
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* The ids the list already holds, for the one decision the state updater cannot make: to
     issue a `runs.get` or not. It trails the state by a commit, which costs at worst one
     redundant call for a run that just arrived — `mergeRun` replaces rather than duplicates,
     so a duplicate answer is harmless, where reading state inside the updater would not be. */
  const known = useRef<ReadonlySet<string>>(new Set());
  /* Ids with a `runs.get` in flight, so a run that emits four events before the first answer
     comes back is fetched once. */
  const fetching = useRef<Set<string>>(new Set());

  useEffect(() => {
    known.current = new Set(state.phase === "ready" ? state.runs.map((r) => r.id) : []);
  }, [state]);

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    void window.orca.runs.list(status === "all" ? {} : { status: [status] }).then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { phase: "ready", runs: orderRuns(result.result.runs), total: result.result.total }
          : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [status, attempt]);

  useEffect(() => {
    let live = true;

    /** A run the list has never seen: resolve it to a row, once, and insert it. */
    const insert = (runId: string): void => {
      if (fetching.current.has(runId)) return;
      fetching.current.add(runId);
      void window.orca.runs.get({ runId }).then((result) => {
        fetching.current.delete(runId);
        if (!live || !result.ok) return;
        const run = result.result.run;
        // The summary is re-checked against the filter rather than trusted from the
        // notification: between the two the run may have moved on again.
        if (status !== "all" && run.status !== status) return;
        setState((prev) =>
          prev.phase === "ready" ? { phase: "ready", runs: mergeRun(prev.runs, run), total: prev.total + 1 } : prev,
        );
      });
    };

    const off = stream.on("run.changed", (params) => {
      if (!known.current.has(params.runId)) {
        // Nothing to repaint, and nothing worth fetching when the filter excludes it.
        if (status === "all" || params.status === status) insert(params.runId);
        return;
      }
      setState((prev) => {
        if (prev.phase !== "ready") return prev;
        const row = prev.runs.find((r) => r.id === params.runId);
        if (!row) return prev;
        const next = applyRunChanged(row, params);
        // A filtered list drops a row that has left the filter, rather than keeping a
        // "succeeded" row on a screen that says it is showing failures.
        if (status !== "all" && next.status !== status) {
          return { phase: "ready", runs: prev.runs.filter((r) => r.id !== next.id), total: prev.total - 1 };
        }
        return { phase: "ready", runs: mergeRun(prev.runs, next), total: prev.total };
      });
    });

    return () => {
      live = false;
      off();
    };
  }, [stream, status]);

  return { state, reload };
}
