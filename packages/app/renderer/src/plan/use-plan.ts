/**
 * The Plan surface's data: one hook per data source, as `runs/` does it.
 *
 * `usePlan` holds the plan, the schedule table and the journal; `useItemDetail` holds the
 * selected item's dependencies and risks for the inspector. Four decisions worth knowing:
 *
 * - **The daemon has no default plan.** Every method names a `planId`, so `plans.list` is
 *   how a surface finds one (`packages/protocol/src/plan.ts`). The first plan is taken
 *   unless a key or an id was asked for, and a store with no plan at all is a state rather
 *   than an error: nothing is broken, there is simply nothing planned.
 * - **Nothing polls.** `plan.changed` says which *areas* moved and carries the plan
 *   journal's `seq`; a frame for an area this surface holds bumps that read and nothing
 *   else, a frame for another plan is ignored, and a `seq` already folded is dropped —
 *   the daemon may repeat one, and repainting twice for one act is the thing `kinds`
 *   exists to prevent.
 * - **The filter's daemon half is in the dependency list.** Classification, status and
 *   request are `items.list` parameters, so changing one re-reads; the text half never
 *   reaches here at all (`plan-model.ts`).
 * - **The journal is read newest-first, which takes two calls at most.** `journal.list`
 *   with no anchor answers the *oldest* page — the wire pages oldest-first whichever
 *   anchor it was given — and every answer carries `lastSeq`, so the newest page is one
 *   further call with `before: lastSeq + 1`, made only when the journal is longer than a
 *   page. "Load earlier" then walks back with `before`, and a push walks forward with
 *   `after`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DependencyView,
  PlanItemView,
  PlanJournalEntryView,
  PlanView,
  ProtocolError,
  RiskView,
} from "@orca/protocol";
import { useNotifications } from "../notifications-context.js";
import {
  earliestSeq,
  foldItems,
  foldJournal,
  isNewFrame,
  itemsParams,
  staleFor,
  type ItemsParams,
  type PlanFilters,
} from "./plan-model.js";

/** One page of journal entries. Short: a journal row is read, not scrolled past. */
export const JOURNAL_PAGE = 50;

/**
 * One page of work items, sent explicitly rather than left to the wire's default.
 *
 * `items.list` caps a page at the schema's `limit`, and a surface that said nothing about
 * paging was silently truncated at that cap while its count claimed the whole plan. The
 * page size is stated here, `loadMore` walks it with `offset`, and the count says how many
 * of the total are held — so "200 of 260 items" is a fact about this screen with a control
 * beside it, rather than a number that lies.
 */
export const ITEMS_PAGE = 200;

export type PlanState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  /** The daemon answered, and there is no plan in this store. Not a failure. */
  | { phase: "none" }
  | { phase: "ready"; plan: PlanView; asOf: string };

export type ItemsState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | {
      phase: "ready";
      items: readonly PlanItemView[];
      /** How many items match the daemon's half of the filter, held or not. */
      total: number;
      asOf: string;
      /** Whether the plan continues past what is held — what "Load more" is for. */
      hasMore: boolean;
      loadingMore: boolean;
    };

export interface JournalState {
  entries: readonly PlanJournalEntryView[];
  /** Whether the journal continues before the oldest entry held. */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** The highest sequence number the plan's journal has, filter or no filter. */
  lastSeq: number;
  error?: ProtocolError;
}

export interface PlanFeed {
  state: PlanState;
  items: ItemsState;
  journal: JournalState;
  /** Page backwards, the way the timeline's "Load earlier" does. */
  loadEarlier: () => void;
  /** The next page of work items, appended to what is held. */
  loadMore: () => void;
  /**
   * How many `plan.changed` frames have moved the items, the schedule, the dependencies,
   * the risks or the decisions. The inspector's two reads depend on it: a dependency's
   * `evaluation.detail` is recomputed by the daemon and nothing about the *selection*
   * changes when it moves, so without this the stored `status` and the live detail drift
   * apart on screen.
   */
  itemsRevision: number;
  /** Re-read everything. The error state's retry, and what a person reaches for after a blip. */
  reload: () => void;
}

const NO_JOURNAL: JournalState = { entries: [], hasEarlier: false, loadingEarlier: false, lastSeq: 0 };

export function usePlan(filters: PlanFilters, wanted?: string): PlanFeed {
  const stream = useNotifications();
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const [state, setState] = useState<PlanState>({ phase: "loading" });
  const [items, setItems] = useState<ItemsState>({ phase: "loading" });
  const [journal, setJournal] = useState<JournalState>(NO_JOURNAL);

  /* The pushes, counted per area. The reads below depend on these, so a frame is "read
     that one again" rather than a second subscription, a timer or a payload to merge. */
  const [planRevision, setPlanRevision] = useState(0);
  const [itemsRevision, setItemsRevision] = useState(0);
  const [journalRevision, setJournalRevision] = useState(0);

  /* Which plan is on screen. Held apart from `state` because every other read depends on
     the id and not on the view, and a `plan.changed` repaint must not re-pick a plan. */
  const [planId, setPlanId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    void window.orca.plan.list().then((result) => {
      if (!live) return;
      if (!result.ok) {
        setPlanId(undefined);
        setState({ phase: "error", error: result.error });
        return;
      }
      const plans = result.result.plans;
      const picked = wanted === undefined ? plans[0] : plans.find((p) => p.id === wanted || p.key === wanted);
      if (!picked) {
        setPlanId(undefined);
        setState({ phase: "none" });
        return;
      }
      setPlanId(picked.id);
    });
    return () => {
      live = false;
    };
  }, [wanted, attempt]);

  /* The header and its counts. Re-read on every area that moves, because `counts` is the
     schedule folded to seven numbers and a decision can change it without touching a row. */
  useEffect(() => {
    if (planId === undefined) return;
    let live = true;
    void window.orca.plan.get({ planId }).then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { phase: "ready", plan: result.result.plan, asOf: result.result.asOf }
          : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [planId, planRevision, attempt]);

  /* The table. The daemon's half of the filter is in the parameters and therefore in this
     effect's dependencies; the text half is applied by the surface to what lands here. */
  const params = useMemo(
    () => (planId === undefined ? undefined : itemsParams(planId, filters)),
    // The arrays are rebuilt by the filter rail on every press, so the *contents* are what
    // this depends on: a new array with the same classifications is not a new read.
    [planId, filters.classification.join(","), filters.status.join(","), filters.requestId],
  );

  /* How many rows are held, for the two reads below that have to ask for the same span
     again. A ref rather than a dependency: a re-read must not re-run because its own
     answer changed the count. */
  const itemsRef = useRef<ItemsState>(items);
  itemsRef.current = items;
  const heldItems = items.phase === "ready" ? items.items.length : 0;
  const heldItemsRef = useRef(heldItems);
  heldItemsRef.current = heldItems;

  /* What the last read was *for*. A `plan.changed` frame is "read that again", not "a new
     question": it re-reads the same span in place and the rows, the selection and the
     inspector opened over them stay exactly where they are. Only a new question — a
     changed filter, a different plan, or the retry a person pressed — blanks the table,
     because only then is what is on screen an answer to something nobody asked. */
  const askedFor = useRef<{ params: ItemsParams; attempt: number } | undefined>(undefined);

  useEffect(() => {
    if (params === undefined) return;
    let live = true;
    const asked = askedFor.current;
    const isNewQuestion = asked === undefined || asked.params !== params || asked.attempt !== attempt;
    askedFor.current = { params, attempt };
    /* A revision bump re-reads every page already held, not just the first: a person who
       pressed "Load more" twice keeps all three pages through a repaint. */
    const limit = isNewQuestion ? ITEMS_PAGE : Math.max(ITEMS_PAGE, heldItemsRef.current);
    if (isNewQuestion) setItems({ phase: "loading" });
    void window.orca.plan.items({ ...params, limit, offset: 0 }).then((result) => {
      if (!live) return;
      setItems(
        result.ok
          ? {
              phase: "ready",
              items: result.result.items,
              total: result.result.total,
              asOf: result.result.asOf,
              hasMore: result.result.items.length < result.result.total,
              loadingMore: false,
            }
          : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [params, itemsRevision, attempt]);

  /* The next page, appended in place. `offset` is what is held rather than a page number,
     because the page size is this surface's and the daemon's answer is a window over one
     ordering — and an append never disturbs the selection above it. */
  const loadMore = useCallback(() => {
    const current = itemsRef.current;
    if (params === undefined || current.phase !== "ready" || current.loadingMore || !current.hasMore) return;
    const offset = current.items.length;
    setItems({ ...current, loadingMore: true });
    void window.orca.plan.items({ ...params, limit: ITEMS_PAGE, offset }).then((result) => {
      setItems((latest) => {
        if (latest.phase !== "ready") return latest;
        if (!result.ok) return { ...latest, loadingMore: false };
        /* Appended to whatever is held *now*: a `plan.changed` frame may have landed while
           this was in flight, and the answer to "the rows after 200" is still the rows
           after 200. Folded by id so an overlap replaces rather than duplicates. */
        const items = foldItems(latest.items, result.result.items);
        return {
          phase: "ready",
          items,
          total: result.result.total,
          asOf: result.result.asOf,
          hasMore: items.length < result.result.total,
          loadingMore: false,
        };
      });
    });
  }, [params]);

  /* The journal's first page, newest last. A plan whose journal fits in one page is one
     call; a longer one is two, and the second is the only place `lastSeq` could have come
     from — asking for "the newest page" is not something the wire has a cursor for. */
  useEffect(() => {
    if (planId === undefined) return;
    let live = true;
    setJournal(NO_JOURNAL);
    void window.orca.plan.journal({ planId, limit: JOURNAL_PAGE }).then(async (first) => {
      if (!live) return;
      if (!first.ok) {
        setJournal({ ...NO_JOURNAL, error: first.error });
        return;
      }
      const page = first.result;
      const newest =
        page.hasMore && page.lastSeq > 0
          ? await window.orca.plan.journal({ planId, before: page.lastSeq + 1, limit: JOURNAL_PAGE })
          : first;
      if (!live) return;
      if (!newest.ok) {
        setJournal({ ...NO_JOURNAL, error: newest.error });
        return;
      }
      setJournal({
        entries: newest.result.entries,
        /* `hasMore` is "the journal continues past this page, in the direction it was
           taken". The newest page was taken backwards, so its `hasMore` is exactly
           "there are earlier entries"; the one-call case read from the start of the
           journal, where by definition there are none. */
        hasEarlier: newest === first ? false : newest.result.hasMore,
        loadingEarlier: false,
        lastSeq: newest.result.lastSeq,
      });
    });
    return () => {
      live = false;
    };
  }, [planId, attempt]);

  /* The journal's forward page, which is what a `journal` frame means: entries after the
     highest one held. Never a re-read of the whole journal. */
  const heldRef = useRef(journal.entries);
  heldRef.current = journal.entries;
  useEffect(() => {
    if (planId === undefined || journalRevision === 0) return;
    let live = true;
    const held = heldRef.current;
    const after = held.length === 0 ? undefined : held[held.length - 1]!.seq;
    void window.orca.plan
      .journal({ planId, limit: JOURNAL_PAGE, ...(after !== undefined ? { after } : {}) })
      .then((result) => {
        if (!live || !result.ok) return;
        setJournal((current) => ({
          ...current,
          entries: foldJournal(current.entries, result.result.entries),
          lastSeq: result.result.lastSeq,
        }));
      });
    return () => {
      live = false;
    };
  }, [planId, journalRevision]);

  const loadEarlier = useCallback(() => {
    if (planId === undefined) return;
    const before = earliestSeq(heldRef.current);
    if (before === undefined || before === 0) return;
    setJournal((current) => ({ ...current, loadingEarlier: true }));
    void window.orca.plan.journal({ planId, before, limit: JOURNAL_PAGE }).then((result) => {
      setJournal((current) => {
        if (!result.ok) return { ...current, loadingEarlier: false, error: result.error };
        return {
          entries: foldJournal(current.entries, result.result.entries),
          hasEarlier: result.result.hasMore,
          loadingEarlier: false,
          lastSeq: result.result.lastSeq,
        };
      });
    });
  }, [planId]);

  /* The one subscription. `plan.changed` carries no `runId` — a plan outlives every run in
     it — so there is no filter to give the stream and the plan check is here. */
  const folded = useRef<number | undefined>(undefined);
  useEffect(() => {
    folded.current = undefined;
  }, [planId]);

  useEffect(() => {
    if (planId === undefined) return;
    return stream.on("plan.changed", (params) => {
      if (params.planId !== planId) return;
      if (!isNewFrame(folded.current, params.seq)) return;
      folded.current = params.seq;
      const stale = staleFor(params.kinds);
      if (stale.plan) setPlanRevision((n) => n + 1);
      if (stale.items) setItemsRevision((n) => n + 1);
      if (stale.journal) setJournalRevision((n) => n + 1);
    });
  }, [stream, planId]);

  return { state, items, journal, loadEarlier, loadMore, itemsRevision, reload };
}

/** The selected item's dependencies and risks — the inspector's two reads and nothing else. */
export interface ItemDetail {
  dependencies: readonly DependencyView[];
  risks: readonly RiskView[];
}

const NO_DETAIL: ItemDetail = { dependencies: [], risks: [] };

/**
 * `dependencies.list` filtered to the item's own `from` side, and `risks.list` filtered to
 * the risks that name it. Both take an id or a slug, so the selection is handed over as it
 * is rather than resolved here.
 *
 * `revision` is `PlanFeed.itemsRevision`, and it is a dependency because neither read is
 * about the selection alone: a `dependencies`, `risks` or `decisions` frame recomputes an
 * `evaluation.detail` without the selected item changing at all, and an inspector that did
 * not hear it would show a stored `status` beside a live detail that no longer agreed with
 * it. Defaulted, so a caller that has no feed to hand still gets the selection behaviour.
 */
export function useItemDetail(
  planId: string | undefined,
  workItemId: string | undefined,
  revision = 0,
): ItemDetail {
  const [detail, setDetail] = useState<ItemDetail>(NO_DETAIL);

  useEffect(() => {
    if (planId === undefined || workItemId === undefined) {
      setDetail(NO_DETAIL);
      return;
    }
    let live = true;
    void Promise.all([
      window.orca.plan.dependencies({ planId, workItemId }),
      window.orca.plan.risks({ planId, workItemId }),
    ]).then(([dependencies, risks]) => {
      if (!live) return;
      setDetail({
        dependencies: dependencies.ok ? dependencies.result.dependencies : [],
        risks: risks.ok ? risks.result.risks : [],
      });
    });
    return () => {
      live = false;
    };
  }, [planId, workItemId, revision]);

  return detail;
}
