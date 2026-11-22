/**
 * The Runs surface's data: one `runs.list` for the page, then `run.changed` for everything
 * after it.
 *
 * The rule this hook exists to keep is "updates without refetching". A list that re-read
 * `runs.list` on every notification would ask the daemon for the whole store several times a
 * second on a busy run and would still show a row flickering between two answers. So the
 * page is read once per filter or transport attachment and every later transition is folded into the row it is about
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
import { useCallback, useEffect, useState } from "react";
import type { DisplayStatus, ProtocolError, RunSummaryView, RunChangedParams } from "@orca/protocol";
import { useSubscriptionGeneration } from "../chrome/use-connection.js";
import { useNotifications } from "../notifications-context.js";
import { applyRunChanged, mergeRun, orderRuns } from "./run-rows.js";

/** The status half of the filter. `all` is the absence of a filter, not a ninth status. */
export type StatusFilter = DisplayStatus | "all";

/**
 * The rest of the daemon-side filter (protocol 2.3, #340): one workflow, and runs created at
 * or after an instant. Both are `runs.list` parameters, and both are applied again to what
 * comes back - a 2.2 daemon ignores parameters it does not know and answers unfiltered, and
 * a run resolved from a notification never went through the daemon's filter at all.
 */
export interface RunsQuery {
  workflowId?: string | undefined;
  createdFrom?: string | undefined;
}

function inQuery(run: RunSummaryView, query: RunsQuery): boolean {
  if (query.workflowId !== undefined && run.workflowId !== query.workflowId) return false;
  if (query.createdFrom !== undefined && Date.parse(run.createdAt) < Date.parse(query.createdFrom)) return false;
  return true;
}

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

export function useRuns(status: StatusFilter, query: RunsQuery = {}): RunsFeed {
  const { workflowId, createdFrom } = query;
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RunsState>({ phase: "loading" });
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    let snapshot: Extract<RunsState, { phase: "ready" }> | undefined;
    const changes = new Map<string, RunChangedParams>();
    const resolved = new Map<string, RunSummaryView>();
    const cursors = new Map<string, number>();
    const fetching = new Set<string>();
    setState({ phase: "loading" });

    // Overlay pushes on every read, including resolving reads that started before a newer
    // transition. Keep the overlay until this read generation ends; a list has no cursor.
    const publish = () => {
      if (!live || !snapshot) return;
      let runs = snapshot.runs;
      let total = snapshot.total;
      for (const run of resolved.values()) {
        if (!runs.some((r) => r.id === run.id)) total += 1;
        runs = mergeRun(runs, run);
      }
      for (const params of changes.values()) {
        const row = runs.find((r) => r.id === params.runId);
        if (row && params.seq > (cursors.get(row.id) ?? -1)) runs = mergeRun(runs, applyRunChanged(row, params));
      }
      if (status !== "all" || workflowId !== undefined || createdFrom !== undefined) {
        const included = runs.filter(
          (r) => (status === "all" || r.status === status) && inQuery(r, { workflowId, createdFrom }),
        );
        total -= runs.length - included.length;
        runs = included;
      }
      setState({ phase: "ready", runs: orderRuns(runs), total: Math.max(0, total) });
    };
    const resolve = (runId: string) => {
      if (fetching.has(runId) || resolved.has(runId)) return;
      fetching.add(runId);
      void window.orca.runs.get({ runId }).then((result) => {
        fetching.delete(runId);
        if (!live || !result.ok) return;
        resolved.set(runId, result.result.run);
        cursors.set(runId, result.result.lastSeq);
        publish();
      });
    };
    // Subscribe before issuing the read so there is no mount-time delivery gap.
    const off = stream.on("run.changed", (params) => {
      const previous = changes.get(params.runId);
      if (previous && previous.seq >= params.seq) return;
      changes.set(params.runId, params);
      if (!snapshot?.runs.some((r) => r.id === params.runId) && (status === "all" || params.status === status)) {
        resolve(params.runId);
      }
      publish();
    });
    const params = {
      ...(status === "all" ? {} : { status: [status] }),
      ...(workflowId === undefined ? {} : { workflowId }),
      ...(createdFrom === undefined ? {} : { createdFrom }),
    };
    void window.orca.runs.list(params).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setState({ phase: "error", error: result.error });
        return;
      }
      snapshot = { phase: "ready", runs: result.result.runs, total: result.result.total };
      publish();
    });
    return () => {
      live = false;
      off();
    };
  }, [stream, status, workflowId, createdFrom, attempt, generation]);
  return { state, reload };
}
