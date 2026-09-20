/**
 * A step's log: one read on mount, then the push stream — the data half of the step detail
 * pane and of the output pane inside it.
 *
 * A step's output *is* its `agent.update` events, so there is no second method and no
 * second subscription: `runs.events({ runId, stepRunId })` pages over the run's log with
 * the step filter (#158), and `agent.update` notifications carry the same events forwards
 * as they happen. One read serves three readers — the header's host (from
 * `agent.session.opened`), the tool-call list and the output pane — which is why the events
 * and the line buffer come out of the same hook.
 *
 * **How the first page is chosen.** A person opening a step wants its *end*, not its
 * beginning, and `runs.events` has no "last page" anchor. So the first call is an ordinary
 * forward page, which answers two things at once: the page itself, and `lastSeq`. A short
 * step is entirely in that page (`hasMore` false) and costs one call. A long one costs a
 * second — `before: lastSeq + 1`, which is the tail — and the page it just threw away was
 * the cheapest way to learn the number it needed. From there **Load earlier output** pages
 * backwards with `before`, which is the same cursor the in-memory buffer's own trim
 * produces, so the marker row means one thing however it arrived.
 *
 * **Nothing here polls, and nothing re-reads.** A notification is folded into what is held.
 * The one thing that is re-read is a step the person asked to see earlier output of.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionState } from "@orca/design";
import type { ProtocolError } from "@orca/protocol";
import { useNotifications } from "../notifications-context.js";
import {
  OutputBuffer,
  updatesOf,
  updatesOfNotification,
  type BufferOptions,
  type LogEvent,
  type OutputRow,
} from "./line-buffer.js";

/** One page of the run's log. 500 is the protocol's cap; a step's log is worth one call. */
export const PAGE_SIZE = 500;

export type LogPhase = "loading" | "ready" | "error";

export interface StepLog {
  phase: LogPhase;
  error?: ProtocolError;
  /**
   * The page as it was read, `agent.update` and all — the tool-call fold and the session
   * fold both walk it, and neither wants the lines.
   */
  events: readonly LogEvent[];
  /** The rows the output pane renders: lines, and the seams where the stream stopped. */
  rows: readonly OutputRow[];
  /** Set when there is output in front of what is held; the marker row's cursor. */
  earlierBefore: number | undefined;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  /** Pinned to the end. The surface owns it; the substrate only says when it stopped. */
  following: boolean;
  hold: () => void;
  follow: () => void;
  /** Lines that have arrived since following stopped — the jump button's count. */
  pending: number;
}

export interface StepLogOptions {
  /** The connection, so the stream's seams can be drawn where it stopped and resumed. */
  connection: ConnectionState;
  /** Open held rather than following: a finished step opens at the top (#158). */
  openHeld?: boolean;
  /** Called with how many rows landed in front of the list, for `VirtualList.shiftBy`. */
  onPrepend?: (rows: number) => void;
  /** The buffer's clock and frame scheduler, for a test that drives both. */
  buffer?: BufferOptions;
}

export function useStepLog(runId: string, stepRunId: string, options: StepLogOptions): StepLog {
  const { connection, openHeld = false, onPrepend, buffer: bufferOptions } = options;
  const stream = useNotifications();

  const [phase, setPhase] = useState<LogPhase>("loading");
  const [error, setError] = useState<ProtocolError | undefined>(undefined);
  const [events, setEvents] = useState<readonly LogEvent[]>([]);
  const [rows, setRows] = useState<readonly OutputRow[]>([]);
  const [earlierBefore, setEarlierBefore] = useState<number | undefined>(undefined);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [following, setFollowing] = useState(!openHeld);
  const [heldAt, setHeldAt] = useState<number | undefined>(openHeld ? 0 : undefined);
  const [appended, setAppended] = useState(0);

  /* One buffer per step, and only per step: it is a *sink*, so pushing into it must not
     re-render anything — what re-renders is the array it commits. Its options are read
     once, through a ref, so a caller passing them inline does not get a new buffer (and a
     blank pane) on every render. */
  const settings = useRef(bufferOptions);
  const buffer = useMemo(() => new OutputBuffer(settings.current ?? {}), [runId, stepRunId]);
  const prepend = useRef(onPrepend);
  prepend.current = onPrepend;
  /* Whether to open held is a property of the step at the moment it is opened. Read through
     a ref so that a step *finishing* under the reader does not re-read its log. */
  const held = useRef(openHeld);
  held.current = openHeld;

  useEffect(() => {
    const off = buffer.subscribe((next) => {
      setRows(next);
      setAppended(buffer.linesAppended);
      // A trim of the buffer's own front is the same fact as an unread page on disk, and
      // it names a newer cursor, so it wins.
      setEarlierBefore((current) => buffer.trimmedBefore ?? current);
    });
    return () => {
      off();
      buffer.dispose();
    };
  }, [buffer]);

  /* The first page. `live` guards the two awaits against a step the person has left. */
  useEffect(() => {
    let live = true;
    const openAtTop = held.current;
    setPhase("loading");
    setError(undefined);
    setEvents([]);
    setEarlierBefore(undefined);
    setFollowing(!openAtTop);
    setHeldAt(openAtTop ? 0 : undefined);

    void (async () => {
      const first = await window.orca.runs.events({ runId, stepRunId, limit: PAGE_SIZE });
      if (!live) return;
      if (!first.ok) {
        setError(first.error);
        setPhase("error");
        return;
      }
      let page = first.result;
      if (page.hasMore) {
        // The tail, now that `lastSeq` is known. `before` takes the events *immediately*
        // before the cursor, so `lastSeq + 1` is the last page of the step's own log.
        const tail = await window.orca.runs.events({
          runId,
          stepRunId,
          before: page.lastSeq + 1,
          limit: PAGE_SIZE,
        });
        if (!live) return;
        if (!tail.ok) {
          setError(tail.error);
          setPhase("error");
          return;
        }
        page = tail.result;
      }
      setEvents(page.events);
      buffer.load(updatesOf(page.events));
      setEarlierBefore(page.hasMore ? page.prevCursor : undefined);
      setPhase("ready");
    })();

    return () => {
      live = false;
    };
  }, [runId, stepRunId, buffer]);

  /* Forwards, from the push channel. `agent.update` is coalesced by the daemon — one frame
     per step per 100ms with many updates inside — so this is a batch, not a line. */
  useEffect(() => {
    const offUpdates = stream.on(
      "agent.update",
      (params) => {
        if (params.stepRunId !== stepRunId) return;
        buffer.push(updatesOfNotification(params));
      },
      { runId },
    );
    /* Everything that is not output but is about this step: the session that opened, the
       permission that settled a tool call, the turn that stopped. `event.appended` excludes
       `agent.update` by design, so the two streams do not overlap. */
    const offEvents = stream.on(
      "event.appended",
      (params) => {
        const event = params.event;
        const payload: Record<string, unknown> = event.payload;
        if (payload["stepRunId"] !== stepRunId) return;
        setEvents((current) => [...current, event]);
      },
      { runId },
    );
    return () => {
      offUpdates();
      offEvents();
    };
  }, [stream, runId, stepRunId, buffer]);

  /* The reconnect seam, inline where it happened. Not a banner and not a live region
     (rule 11): where the gap falls in the output is the whole of what it says. */
  const wasLive = useRef(connection === "live");
  useEffect(() => {
    const live = connection === "live";
    if (live === wasLive.current) return;
    wasLive.current = live;
    buffer.mark(live ? "reconnected" : "paused", new Date().toISOString());
  }, [connection, buffer]);

  const hold = useCallback(() => {
    setFollowing(false);
    setHeldAt(buffer.linesAppended);
  }, [buffer]);

  const follow = useCallback(() => {
    setFollowing(true);
    setHeldAt(undefined);
  }, []);

  const loadEarlier = useCallback(() => {
    const before = earlierBefore;
    if (before === undefined || loadingEarlier) return;
    setLoadingEarlier(true);
    void window.orca.runs.events({ runId, stepRunId, before, limit: PAGE_SIZE }).then((answer) => {
      setLoadingEarlier(false);
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      const page = answer.result;
      setEvents((current) => [...page.events, ...current]);
      const added = buffer.prepend(updatesOf(page.events), page.hasMore ? page.prevCursor : undefined);
      setEarlierBefore(page.hasMore ? page.prevCursor : undefined);
      // The rows in front moved every index down by `added`; without this the reader is
      // thrown back by exactly the page they asked to see.
      if (added > 0) prepend.current?.(added);
    });
  }, [runId, stepRunId, earlierBefore, loadingEarlier, buffer]);

  const pending = heldAt === undefined ? 0 : Math.max(0, appended - heldAt);

  return {
    phase,
    ...(error === undefined ? {} : { error }),
    events,
    rows,
    earlierBefore,
    loadingEarlier,
    loadEarlier,
    following,
    hold,
    follow,
    pending,
  };
}
