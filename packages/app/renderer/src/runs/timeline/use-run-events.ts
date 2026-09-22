/**
 * The event timeline's data: one page of `runs.events` for the selected run, earlier pages
 * on demand, and everything after it from the push channel.
 *
 * Paging goes **backwards from the newest end**, which is where a person opens a run: the
 * last thing that happened is the thing they came for, and "load earlier" walks back from
 * there. That is not quite what `runs.events` makes easy — see `NEWEST` below — and it is
 * the one place this surface has to work around the read method (#208).
 *
 * Forward, there are two channels and they are deliberately different:
 *
 * - `event.appended` is the raw log entry, one notification per event, every type **except**
 *   `agent.update`;
 * - `agent.update` is the coalesced batch, at most one per step per 100 ms, many updates
 *   inside. It is one row, not one row per update — an agent producing forty lines a second
 *   would otherwise put forty rows a second into a list a person is trying to read, and the
 *   daemon coalesced it for exactly that reason.
 *
 * Both are folded with `mergeEntries`, which merges on `seq`. Sequence numbers are per run
 * and gap-free, so a page that overlaps what is already held costs nothing and a page that
 * does not leaves no hole.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProtocolError, RunsGetResult } from "@orca/protocol";
import { useSubscriptionGeneration } from "../../chrome/use-connection.js";
import { useNotifications } from "../../notifications-context.js";
import {
  agentUpdateEntry,
  earliestSeq,
  mergeEntries,
  nodeNames,
  toEntries,
  toEntry,
  type TimelineEntry,
} from "./timeline-entries.js";

/** How many events a page asks for. The protocol's ceiling is 500. */
export const PAGE = 200;

/**
 * The anchor for "the newest page".
 *
 * `runs.events` pages from `after` (forwards) or `before` (backwards) and has no parameter
 * for "the end of the log", so the newest page is asked for as everything *before* a
 * sequence number no run can have reached. The alternative is two round trips — one to
 * learn `lastSeq`, one to page back from it — for every run a person clicks on. Worth
 * naming on #208.
 */
export const NEWEST = Number.MAX_SAFE_INTEGER;

export type EventsState =
  /** No run selected: there is no log to show and nothing was asked for. */
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | {
      phase: "ready";
      entries: readonly TimelineEntry[];
      /** The highest sequence number in the run, filter or no filter — the run's cursor. */
      lastSeq: number;
      /** Whether the log continues before the first row held. */
      hasEarlier: boolean;
      loadingEarlier: boolean;
    };

export interface EventsFeed {
  state: EventsState;
  /** Page one more `PAGE` of events off the front. */
  loadEarlier: () => void;
  /** Re-read the newest page: the error state's retry. */
  reload: () => void;
}

/**
 * `detail` is the run's `runs.get` projection when the tree has read it. It is used for one
 * thing: naming the step a row is about. Most `step.*` and `agent.*` events carry a
 * `stepRunId` and no node id, and the `step.scheduled` that would name it may be pages
 * back — so the projection, which holds every step run, is where the name comes from.
 *
 * `onPrepend` is called with how many rows landed in front of the list, which is what the
 * substrate's `shiftBy` needs so a backward page does not throw the reader back by exactly
 * the page they asked for.
 */
export function useRunEvents(
  runId: string | undefined,
  detail: RunsGetResult | undefined,
  onPrepend?: (rows: number) => void,
): EventsFeed {
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const pending = useRef<TimelineEntry[]>([]);
  const requestEpoch = useRef(0);
  const reading = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<EventsState>({ phase: "idle" });
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* Step run id to node id, from the run's own projection. A step the projection has not
     heard of still names itself by id, which is at least addressable. */
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const step of detail?.steps ?? []) map.set(step.id, step.nodeId);
    return map;
  }, [detail]);
  const namesRef = useRef(names);
  namesRef.current = names;

  const prepend = useRef(onPrepend);
  prepend.current = onPrepend;

  useEffect(() => {
    if (runId === undefined) {
      setState({ phase: "idle" });
      return;
    }
    let live = true;
    requestEpoch.current += 1;
    pending.current = [];
    reading.current = true;
    setState({ phase: "loading" });
    void window.orca.runs.events({ runId, before: NEWEST, limit: PAGE }).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setState({ phase: "error", error: result.error });
        return;
      }
      reading.current = false;
      const { events, hasMore, lastSeq } = result.result;
      // The page's own `step.scheduled` events name steps the projection may not hold yet.
      const known = new Map([...nodeNames(events), ...namesRef.current]);
      setState({
        phase: "ready",
        entries: mergeEntries(toEntries(events, known), pending.current).entries,
        lastSeq: Math.max(lastSeq, ...pending.current.map((entry) => entry.seq)),
        hasEarlier: hasMore,
        loadingEarlier: false,
      });
    });
    return () => {
      live = false;
      requestEpoch.current += 1;
    };
  }, [runId, attempt, generation]);

  /* The push half. Both listeners are filtered to this run, so a store with fifty runs in
     it wakes this timeline only for the one on screen. */
  useEffect(() => {
    if (runId === undefined) return;

    const append = (entry: TimelineEntry): void => {
      if (reading.current) pending.current.push(entry);
      setState((prev) => {
        if (prev.phase !== "ready") return prev;
        const { entries } = mergeEntries(prev.entries, [entry]);
        return { ...prev, entries, lastSeq: Math.max(prev.lastSeq, entry.seq) };
      });
    };

    const offAppended = stream.on("event.appended", (params) => append(toEntry(params.event, namesRef.current)), {
      runId,
    });
    const offAgent = stream.on("agent.update", (params) => append(agentUpdateEntry(params, namesRef.current)), {
      runId,
    });

    return () => {
      offAppended();
      offAgent();
    };
  }, [stream, runId]);

  /* The state as of the last render, for `loadEarlier`: a state updater must stay pure —
     it can run twice — and paging is a call to the daemon and a scroll offset to move,
     which are both things that must happen once. */
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadEarlier = useCallback(() => {
    const current = stateRef.current;
    if (runId === undefined || current.phase !== "ready" || current.loadingEarlier || !current.hasEarlier) return;

    const before = earliestSeq(current.entries);
    // Sequence numbers start at zero and are gap-free, so seq 0 *is* the start of the log.
    if (before === undefined || before === 0) {
      setState((prev) => (prev.phase === "ready" ? { ...prev, hasEarlier: false } : prev));
      return;
    }

    setState((prev) => (prev.phase === "ready" ? { ...prev, loadingEarlier: true } : prev));
    const epoch = requestEpoch.current;
    void window.orca.runs.events({ runId, before, limit: PAGE }).then((result) => {
      if (epoch !== requestEpoch.current) return;
      const held = stateRef.current;
      if (held.phase !== "ready") return;
      if (!result.ok) {
        setState({ ...held, loadingEarlier: false });
        return;
      }
      const known = new Map([...nodeNames(result.result.events), ...namesRef.current]);
      const { entries, prepended } = mergeEntries(held.entries, toEntries(result.result.events, known));
      setState({ ...held, entries, hasEarlier: result.result.hasMore, loadingEarlier: false });
      // After the rows are in `entries`, so the metrics `shiftBy` reads are the ones the
      // prepend produced (see `list/use-list-viewport.ts`).
      if (prepended > 0) prepend.current?.(prepended);
    });
  }, [runId]);

  return { state, loadEarlier, reload };
}
