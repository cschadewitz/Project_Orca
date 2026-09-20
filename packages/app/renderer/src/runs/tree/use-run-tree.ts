/**
 * The run tree's data: which rows are open, the `runs.get` projection behind each open
 * run, and the two notifications that keep them honest.
 *
 * The rule this hook exists to keep is the one docs/design/60-implementation.md states
 * twice: **the tree subscribes to `run.changed` and `step.changed` and to nothing else.**
 * An agent producing forty lines a second produces forty `agent.update` batches a second,
 * and a tree that woke for each of them would re-render a thousand rows for output it does
 * not draw. Step status is a different, much rarer stream, and it is the only one here.
 *
 * The other rule is the surface's: a screen never re-reads a list because a notification
 * arrived. One `runs.get` per run, when a person opens it, and every later transition is
 * folded into the projection already held (`tree-rows.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunSummaryView, RunsGetResult } from "@orca/protocol";
import { useNotifications } from "../../notifications-context.js";
import {
  applyRunChangedToDetail,
  applyStepChanged,
  buildTree,
  descendants,
  filterAttention,
  type TreeRow,
} from "./tree-rows.js";

export interface RunTree {
  /** The flattened tree, in document order, after the attention filter if it is on. */
  rows: readonly TreeRow[];
  /** Open or close one row. */
  toggle: (key: string) => void;
  /** Open one row and everything already known under it — `⇧→`. */
  expandDeep: (key: string) => void;
  /** Open a row that is closed; does nothing to one that is open (`→`). */
  expand: (key: string) => void;
  /** Close a row that is open; does nothing to one that is closed (`←`). */
  collapse: (key: string) => void;
  /** `F`: show only the failed and the waiting, and what leads to them. */
  attentionOnly: boolean;
  toggleAttention: () => void;
  /** The `runs.get` projection for a run, once it has been read. */
  detailOf: (runId: string) => RunsGetResult | undefined;
  /**
   * Read a run whose row nobody opened. The timeline needs the same projection the tree
   * caches — the node names behind its step run ids, and the step a row is about — and two
   * components reading one run twice would be two answers to keep in step.
   */
  ensure: (runId: string) => void;
}

export function useRunTree(roots: readonly RunSummaryView[]): RunTree {
  const stream = useNotifications();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState<ReadonlyMap<string, RunsGetResult>>(() => new Map());
  const [attentionOnly, setAttentionOnly] = useState(false);
  /** Runs somebody asked for without opening a row — the timeline's selected run. */
  const [wanted, setWanted] = useState<ReadonlySet<string>>(() => new Set());

  /* Ids with a `runs.get` in flight, so a row opened, closed and opened again while the
     first answer is still out is read once. */
  const fetching = useRef<Set<string>>(new Set());

  const all = useMemo(() => buildTree({ roots, details, expanded }), [roots, details, expanded]);
  const rows = useMemo(() => (attentionOnly ? filterAttention(all) : all), [all, attentionOnly]);

  /* One read per open run, and only for the runs a row actually asks for: a step row needs
     nothing, and a closed child run is a row, not a request. */
  useEffect(() => {
    let live = true;
    const open = all.filter((row) => row.expanded && (row.kind === "run" || row.kind === "child-run"));
    for (const runId of [...new Set([...open.map((row) => row.runId), ...wanted])]) {
      if (details.has(runId) || fetching.current.has(runId)) continue;
      fetching.current.add(runId);
      void window.orca.runs.get({ runId }).then((result) => {
        fetching.current.delete(runId);
        if (!live || !result.ok) return;
        setDetails((prev) => new Map(prev).set(runId, result.result));
      });
    }
    return () => {
      live = false;
    };
  }, [all, details, wanted]);

  useEffect(() => {
    /** Fold one notification into whichever projections hold the object it is about. */
    const patch = (apply: (detail: RunsGetResult) => RunsGetResult): void => {
      setDetails((prev) => {
        let touched = false;
        const next = new Map(prev);
        for (const [runId, detail] of prev) {
          const applied = apply(detail);
          if (applied === detail) continue;
          touched = true;
          next.set(runId, applied);
        }
        return touched ? next : prev;
      });
    };

    const offStep = stream.on("step.changed", (params) => {
      patch((detail) => (detail.run.id === params.runId ? applyStepChanged(detail, params) : detail));
    });
    /* A run's own row *and* its row as somebody's child: the same run can be a root here
       and a `child-run` under a `parallel` step, and both have to repaint. */
    const offRun = stream.on("run.changed", (params) => patch((detail) => applyRunChangedToDetail(detail, params)));

    return () => {
      offStep();
      offRun();
    };
  }, [stream]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const expand = useCallback((key: string) => {
    setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const collapse = useCallback((key: string) => {
    setExpanded((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  /*
   * `⇧→` opens the row and every row already under it — which is what the tree *has*, not
   * what the store has. A subtree three child runs deep is three reads that have not been
   * made yet; opening what is known makes those reads, the rows arrive, and a second `⇧→`
   * reaches the level they brought. Pretending to expand rows nobody has read would be a
   * spinner over a promise the surface cannot keep.
   */
  const expandDeep = useCallback(
    (key: string) => {
      const at = all.findIndex((row) => row.key === key);
      if (at === -1) return;
      const keys = [
        key,
        ...descendants(all, at)
          .filter((row) => row.hasChildren)
          .map((row) => row.key),
      ];
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const k of keys) next.add(k);
        return next;
      });
    },
    [all],
  );

  const detailOf = useCallback((runId: string) => details.get(runId), [details]);
  const toggleAttention = useCallback(() => setAttentionOnly((on) => !on), []);
  const ensure = useCallback((runId: string) => {
    setWanted((prev) => (prev.has(runId) ? prev : new Set(prev).add(runId)));
  }, []);

  return useMemo(
    () => ({ rows, toggle, expand, collapse, expandDeep, attentionOnly, toggleAttention, detailOf, ensure }),
    [rows, toggle, expand, collapse, expandDeep, attentionOnly, toggleAttention, detailOf, ensure],
  );
}
