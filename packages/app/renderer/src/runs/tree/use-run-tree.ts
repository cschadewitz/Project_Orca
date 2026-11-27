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
 * arrived. One `runs.get` per run when opened or reattached, and every later transition is
 * folded into the projection already held (`tree-rows.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunSummaryView, RunsGetResult } from "@orca/protocol";
import { useSubscriptionGeneration } from "../../chrome/use-connection.js";
import { useNotifications } from "../../notifications-context.js";
import {
  applyRunChangedToDetail,
  applyStepChanged,
  buildTree,
  descendants,
  TERMINAL_STEP_EVENTS,
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

interface PendingChange {
  runId: string;
  seq: number;
  apply: (detail: RunsGetResult) => RunsGetResult;
}

/**
 * Fold the notifications that arrived while a `runs.get` was out over its answer. The read may
 * already include a transition of its own run; child-run cursors are independent of the
 * parent's, so only a notification about the read's own run is compared against its cursor.
 */
function replay(pending: readonly PendingChange[], runId: string, read: RunsGetResult): RunsGetResult {
  return pending.reduce((held, change) => {
    if (change.runId === runId && change.seq <= read.lastSeq) return held;
    return change.apply(held);
  }, read);
}

export function useRunTree(roots: readonly RunSummaryView[]): RunTree {
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState<ReadonlyMap<string, RunsGetResult>>(() => new Map());
  const [attentionOnly, setAttentionOnly] = useState(false);
  /** Runs somebody asked for without opening a row — the timeline's selected run. */
  const [wanted, setWanted] = useState<ReadonlySet<string>>(() => new Set());

  /* Ids with a `runs.get` in flight, so a row opened, closed and opened again while the
     first answer is still out is read once. */
  const fetching = useRef(new Map<string, PendingChange[]>());
  const epoch = useRef(0);
  /* Runs with a re-read in flight, each with whether it moved again while that read was out.
     The entry is the request's own object, so a settling read only ever clears itself. */
  const rereading = useRef(new Map<string, { again: boolean; pending: PendingChange[] }>());
  /* Runs that settled while their first read was still out: that read may predate the step's
     variables, and the status patch queued behind it carries none, so it is read once more. */
  const rereadAfterFetch = useRef(new Set<string>());
  /* The newest notification cursor seen per run. A re-read older than that would undo a
     status already folded in, so it is dropped. */
  const notified = useRef(new Map<string, number>());
  useEffect(() => {
    epoch.current += 1;
    fetching.current.clear();
    rereading.current.clear();
    rereadAfterFetch.current.clear();
    notified.current.clear();
    setDetails(new Map());
    return () => {
      epoch.current += 1;
      fetching.current.clear();
      rereading.current.clear();
      rereadAfterFetch.current.clear();
    };
  }, [generation]);

  /* The projections as last rendered, for the re-read below, which runs outside a render. */
  const held = useRef(details);
  held.current = details;

  /*
   * A fresh `runs.get` for a run already held. The notifications carry status, not data: a
   * step that finishes and sets a variable says "completed", and the projection's `vars` (the
   * step detail's Variables) kept what the first read saw until the run was selected again
   * (#1109). So when a step of a held run settles, or the run itself changes, the projection is
   * read again and replaces the held one if it is not older. One read per run at a time; a
   * change while one is out asks for one more. A run whose first read is still out is read
   * again once that read lands.
   */
  const read = useCallback((runId: string): void => {
    const inFlight = rereading.current.get(runId);
    if (inFlight) {
      inFlight.again = true;
      return;
    }
    const entry = { again: false, pending: [] as PendingChange[] };
    rereading.current.set(runId, entry);
    const requestEpoch = epoch.current;
    const settle = (result: Awaited<ReturnType<typeof window.orca.runs.get>> | undefined): void => {
      // A reconnect cleared the map; a newer request may own the slot now, so only remove ours.
      if (rereading.current.get(runId) === entry) rereading.current.delete(runId);
      if (requestEpoch !== epoch.current) return;
      if (result?.ok && result.result.lastSeq >= (notified.current.get(runId) ?? 0)) {
        // As for the first read: what arrived while this one was out is replayed over it, since
        // a child run's cursor says nothing about whether the parent's answer includes it.
        const detail = replay(entry.pending, runId, result.result);
        setDetails((prev) => {
          const current = prev.get(runId);
          if (!current || current.lastSeq > detail.lastSeq) return prev;
          return new Map(prev).set(runId, detail);
        });
      }
      if (entry.again) read(runId);
    };
    void window.orca.runs.get({ runId }).then(settle, () => settle(undefined));
  }, []);

  const reread = useCallback(
    (runId: string): void => {
      if (fetching.current.has(runId)) {
        rereadAfterFetch.current.add(runId);
        return;
      }
      if (!held.current.has(runId)) return;
      read(runId);
    },
    [read],
  );

  const all = useMemo(() => buildTree({ roots, details, expanded }), [roots, details, expanded]);
  const rows = useMemo(() => (attentionOnly ? filterAttention(all) : all), [all, attentionOnly]);

  /* One read per open run, and only for the runs a row actually asks for: a step row needs
     nothing, and a closed child run is a row, not a request. */
  useEffect(() => {
    const requestEpoch = epoch.current;
    const open = all.filter((row) => row.expanded && (row.kind === "run" || row.kind === "child-run"));
    for (const runId of [...new Set([...open.map((row) => row.runId), ...wanted])]) {
      if (details.has(runId) || fetching.current.has(runId)) continue;
      const pending: PendingChange[] = [];
      fetching.current.set(runId, pending);
      const settle = (result: Awaited<ReturnType<typeof window.orca.runs.get>> | undefined): void => {
        if (requestEpoch !== epoch.current) return;
        if (fetching.current.get(runId) === pending) fetching.current.delete(runId);
        const settled = rereadAfterFetch.current.delete(runId);
        if (!result?.ok) return;
        // Only when the read predates something that settled while it was out.
        const again = settled && pending.some((change) => change.runId === runId && change.seq > result.result.lastSeq);
        const detail = replay(pending, runId, result.result);
        setDetails((prev) => new Map(prev).set(runId, detail));
        if (again) read(runId);
      };
      void window.orca.runs.get({ runId }).then(settle, () => settle(undefined));
    }
  }, [all, details, wanted, generation, read]);

  useEffect(() => {
    /** Fold one notification into whichever projections hold the object it is about. */
    const patch = (apply: (detail: RunsGetResult) => RunsGetResult, runId: string, seq: number): void => {
      notified.current.set(runId, Math.max(seq, notified.current.get(runId) ?? 0));
      for (const pending of fetching.current.values()) pending.push({ apply, runId, seq });
      for (const { pending } of rereading.current.values()) pending.push({ apply, runId, seq });
      setDetails((prev) => {
        let touched = false;
        const next = new Map(prev);
        for (const [id, detail] of prev) {
          if (detail.run.id === runId && seq <= detail.lastSeq) continue;
          const applied = apply(detail);
          if (applied === detail) continue;
          touched = true;
          next.set(id, applied);
        }
        return touched ? next : prev;
      });
    };

    const offStep = stream.on("step.changed", (params) => {
      patch(
        (detail) => (detail.run.id === params.runId ? applyStepChanged(detail, params) : detail),
        params.runId,
        params.seq,
      );
      if (TERMINAL_STEP_EVENTS.includes(params.event)) reread(params.runId);
    });
    /* A run's own row *and* its row as somebody's child: the same run can be a root here
       and a `child-run` under a `parallel` step, and both have to repaint. */
    const offRun = stream.on("run.changed", (params) => {
      patch((detail) => applyRunChangedToDetail(detail, params), params.runId, params.seq);
      reread(params.runId);
    });

    return () => {
      offStep();
      offRun();
    };
  }, [stream, reread]);

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
