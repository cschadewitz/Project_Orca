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
 *
 * **History is paged, never read whole (#340).** The first read is one page of `PAGE` runs;
 * `loadOlder` asks for the next, by `cursor` on a 2.8 daemon (a place in the order, so runs
 * started meanwhile do not shift it) and by `offset` on an older one. One page is in flight at
 * a time, and a page that answers after the filter changed, the transport reattached or the
 * surface went is dropped: those reads belong to a list nobody is looking at any more.
 *
 * **A link can name a run no page holds yet.** `include` resolves it with one `runs.get` and
 * pins it in the list whatever the filter says, so `orca://run/<id>` opens last month's run
 * as surely as this morning's.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { compareRunsListOrder } from "@orca/protocol";
import type { DisplayStatus, ProtocolError, RunSummaryView, RunChangedParams, RunsListParams } from "@orca/protocol";
import { useSubscriptionGeneration } from "../chrome/use-connection.js";
import { useNotifications } from "../notifications-context.js";
import { applyRunChanged, mergeRun, orderRuns } from "./run-rows.js";

/** The status half of the filter. `all` is the absence of a filter, not a ninth status. */
export type StatusFilter = DisplayStatus | "all";

/**
 * The rest of the daemon-side filter (protocol 2.3, #340): one workflow, and runs created at
 * or after an instant. Both are `runs.list` parameters the daemon applies across the whole
 * store; they are applied here only to runs resolved from a notification, which never went
 * through the daemon's filter. A daemon older than 2.3 would ignore them and answer one
 * unfiltered page, so the surface does not offer them there (`runFiltersSupported`).
 */
export interface RunsQuery {
  workflowId?: string | undefined;
  createdFrom?: string | undefined;
}

/**
 * Whether the daemon applies `workflowId` and `createdFrom` itself: protocol 2.3 on. Unknown
 * (no handshake yet) is taken as yes, because the app and its daemon normally ship together.
 */
export function runFiltersSupported(daemon: string | undefined): boolean {
  if (daemon === undefined) return true;
  const [major, minor] = daemon.split(".").map(Number);
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) return false;
  return major > 2 || (major === 2 && minor >= 3);
}

/**
 * Whether `runs.list` takes a `cursor`: protocol 2.8 on. A 2.7 daemon would strip it and answer
 * the first page again, so an older one is paged by `offset` instead.
 */
export function runCursorSupported(daemon: string | undefined): boolean {
  if (daemon === undefined) return true;
  const [major, minor] = daemon.split(".").map(Number);
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) return false;
  return major > 2 || (major === 2 && minor >= 8);
}

/** Runs per `runs.list` read: the daemon's own default, so every read is a bounded page. */
export const RUNS_PAGE = 100;

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
      /** Older runs match the filter than the pages read so far hold. */
      more: boolean;
      /** A `loadOlder` page is in flight. */
      loadingOlder: boolean;
      /** The last `loadOlder` failed; the rows held are unchanged and it may be asked again. */
      olderError?: ProtocolError | undefined;
    };

export interface RunsFeed {
  state: RunsState;
  /** Re-read the page: the error state's retry, and what a person reaches for after a blip. */
  reload: () => void;
  /** Read the next page back through history. Does nothing while one is in flight or none is left. */
  loadOlder: () => void;
  /** Hold this run in the list whatever the filter or the pages say: a link named it. */
  include: (runId: string) => void;
  /**
   * The run ids `include` could not resolve because the daemon said so: `RUN_NOT_FOUND`, which
   * is also how it answers a run this caller may not see. A failed read (a dropped connection,
   * a daemon error) is not an answer: the link stays pending and is read again on the next
   * reconnect or retry. Emptied at every new read generation; an id leaves it once read.
   */
  unresolved: ReadonlySet<string>;
}

export interface RunsPaging {
  /** Page by `cursor` (protocol 2.8) rather than `offset`. */
  cursor?: boolean | undefined;
  /** Runs per read; `RUNS_PAGE` unless a test needs a small one. */
  pageSize?: number | undefined;
}

const NOTHING: ReadonlySet<string> = new Set();

export function useRuns(status: StatusFilter, query: RunsQuery = {}, paging: RunsPaging = {}): RunsFeed {
  const { workflowId, createdFrom } = query;
  const byCursor = paging.cursor ?? true;
  const pageSize = paging.pageSize ?? RUNS_PAGE;
  const stream = useNotifications();
  const generation = useSubscriptionGeneration();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RunsState>({ phase: "loading" });
  const [pins, setPins] = useState<readonly string[]>([]);
  const [unresolved, setUnresolved] = useState<ReadonlySet<string>>(NOTHING);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  /* The effect owns the pages; these are its handles, replaced on every read generation so a
     call into an old one is a no-op rather than a write into a list nobody shows. */
  const older = useRef<() => void>(() => {});
  const pin = useRef<(runId: string) => void>(() => {});
  const loadOlder = useCallback(() => older.current(), []);
  const include = useCallback((runId: string) => {
    setPins((held) => (held.includes(runId) ? held : [...held, runId]));
    pin.current(runId);
  }, []);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  useEffect(() => {
    let live = true;
    let snapshot: { runs: readonly RunSummaryView[]; total: number } | undefined;
    /* Pages after the first, in the order they were read. Kept apart from the first page so a
       reload is one assignment, and merged by id so a run on two pages is one row. */
    let pages: RunSummaryView[] = [];
    /* How far the reads have gone: the next cursor, or how many list rows were read for the
       offset fallback. `undefined` cursor after a read means the store has nothing older. */
    let nextCursor: string | undefined;
    let readRows = 0;
    let loadingOlder = false;
    let olderError: ProtocolError | undefined;
    const pinned = new Set(pinsRef.current);
    const changes = new Map<string, RunChangedParams>();
    const resolved = new Map<string, RunSummaryView>();
    const cursors = new Map<string, number>();
    const fetching = new Set<string>();
    setState({ phase: "loading" });
    // A new read generation (retry, reconnect, filter) asks again about every pinned run.
    setUnresolved(NOTHING);

    const filter = {
      ...(status === "all" ? {} : { status: [status] }),
      ...(workflowId === undefined ? {} : { workflowId }),
      ...(createdFrom === undefined ? {} : { createdFrom }),
    };
    const more = (): boolean =>
      snapshot !== undefined && (byCursor ? nextCursor !== undefined : readRows < snapshot.total);

    // Overlay pushes on every read, including resolving reads that started before a newer
    // transition. Keep the overlay until this read generation ends; a list has no cursor.
    const publish = () => {
      if (!live || !snapshot) return;
      let runs = snapshot.runs;
      let total = snapshot.total;
      for (const run of pages) runs = mergeRun(runs, run);
      const head = snapshot.runs[0];
      for (const run of resolved.values()) {
        // A run newer than the first page is one `total` never counted; an older one a link
        // or a notification brought in from history already is.
        if (!runs.some((r) => r.id === run.id) && (!head || compareRunsListOrder(run, head) < 0)) total += 1;
        runs = mergeRun(runs, run);
      }
      for (const params of changes.values()) {
        const row = runs.find((r) => r.id === params.runId);
        if (row && params.seq > (cursors.get(row.id) ?? -1)) runs = mergeRun(runs, applyRunChanged(row, params));
      }
      if (status !== "all" || workflowId !== undefined || createdFrom !== undefined) {
        // A pinned run stays: a link asked for it, and the filter is not the link's business.
        const included = runs.filter(
          (r) =>
            pinned.has(r.id) || ((status === "all" || r.status === status) && inQuery(r, { workflowId, createdFrom })),
        );
        total -= runs.length - included.length;
        runs = included;
      }
      setState({
        phase: "ready",
        runs: orderRuns(runs),
        total: Math.max(0, total, runs.length),
        more: more(),
        loadingOlder,
        ...(olderError ? { olderError } : {}),
      });
    };
    const resolve = (runId: string) => {
      if (fetching.has(runId) || resolved.has(runId)) return;
      fetching.add(runId);
      void window.orca.runs.get({ runId }).then((result) => {
        fetching.delete(runId);
        if (!live) return;
        if (!result.ok) {
          // Only a link's run is reported, and only on the daemon's definitive answer: a
          // transient failure leaves the link pending for the next generation to read again.
          if (pinned.has(runId) && result.error.code === "RUN_NOT_FOUND")
            setUnresolved((gone) => new Set(gone).add(runId));
          return;
        }
        setUnresolved((gone) => {
          if (!gone.has(runId)) return gone;
          const next = new Set(gone);
          next.delete(runId);
          return next;
        });
        resolved.set(runId, result.result.run);
        cursors.set(runId, result.result.lastSeq);
        publish();
      });
    };
    pin.current = (runId: string) => {
      pinned.add(runId);
      const held =
        snapshot?.runs.some((r) => r.id === runId) || pages.some((r) => r.id === runId) || resolved.has(runId);
      if (held) publish();
      else if (snapshot) resolve(runId);
    };
    older.current = () => {
      if (!live || !snapshot || loadingOlder || !more()) return;
      loadingOlder = true;
      olderError = undefined;
      publish();
      const page: Partial<RunsListParams> = {
        ...filter,
        limit: pageSize,
        ...(byCursor ? { cursor: nextCursor } : { offset: readRows }),
      };
      void window.orca.runs.list(page).then((result) => {
        // Superseded: the filter, the transport or the surface changed while it was out.
        if (!live) return;
        loadingOlder = false;
        if (!result.ok) {
          olderError = result.error;
          publish();
          return;
        }
        pages = [...pages, ...result.result.runs];
        readRows += result.result.runs.length;
        nextCursor = result.result.nextCursor;
        // An offset page that came back empty has nothing behind it, whatever `total` said.
        if (!byCursor && result.result.runs.length === 0) readRows = snapshot!.total;
        snapshot = { ...snapshot!, total: result.result.total };
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
    // The daemon's default page is `RUNS_PAGE`, so the first read only says a size it chose.
    void window.orca.runs.list(pageSize === RUNS_PAGE ? filter : { ...filter, limit: pageSize }).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setState({ phase: "error", error: result.error });
        return;
      }
      snapshot = { runs: result.result.runs, total: result.result.total };
      readRows = result.result.runs.length;
      nextCursor = result.result.nextCursor;
      for (const runId of pinned) if (!snapshot.runs.some((r) => r.id === runId)) resolve(runId);
      publish();
    });
    return () => {
      live = false;
      older.current = () => {};
      pin.current = () => {};
      off();
    };
  }, [stream, status, workflowId, createdFrom, attempt, generation, byCursor, pageSize]);
  return { state, reload, loadOlder, include, unresolved };
}
