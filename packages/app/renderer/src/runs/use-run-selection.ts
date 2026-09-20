/**
 * One selection for the whole Runs surface: the run, the step run inside it, and the event
 * the timeline is parked on.
 *
 * The surface holds two lists over the same objects — the run tree above, the event
 * timeline below — and they are not two selections. Picking a timeline entry picks the step
 * it is about in the tree; picking a step in the tree scrolls the timeline to that step's
 * first event. Both directions are one reducer so that neither can drift from the other,
 * and so the arithmetic is a plain test rather than two components watching each other
 * through effects.
 *
 * The keys that *move* a selection are not here. `J`/`K`, the arrows, `Home`/`End` and the
 * page keys belong to the list substrate (`list/use-list-keys.ts`) and register once per
 * scope — `run-tree` for the tree, `list` for the timeline. Moving a selection and moving
 * the window it is rendered in are the same act now that both lists are virtualised.
 */
import { useCallback, useEffect, useMemo, useReducer } from "react";

export interface RunSelection {
  /** The run both lists are about. */
  selectedRunId?: string | undefined;
  /** The step run inside it, when a step rather than the run itself is selected. */
  selectedStepRunId?: string | undefined;
  /** The event the timeline is parked on — a sequence number within `selectedRunId`. */
  selectedSeq?: number | undefined;
}

/**
 * What the reducer has to look up to keep the two lists agreeing, passed in rather than
 * read from a closure so the whole thing stays a pure function of its arguments.
 *
 * Both maps are over the events the timeline currently holds. A step whose first event has
 * been paged out has no entry, and selecting it then leaves the timeline where it is —
 * which is the honest answer, because the row it would scroll to is not in the list.
 */
export interface SelectionIndex {
  /** Step run id to the sequence number of its first held event. */
  firstSeqByStep: ReadonlyMap<string, number>;
  /** Sequence number to the step run it is about; run-level events are about none. */
  stepBySeq: ReadonlyMap<number, string | undefined>;
}

export const EMPTY_INDEX: SelectionIndex = { firstSeqByStep: new Map(), stepBySeq: new Map() };

/** What a row is about, keyed both ways. Built from the events the timeline holds. */
export function buildSelectionIndex(
  entries: readonly { seq: number; stepRunId?: string | undefined }[],
): SelectionIndex {
  const firstSeqByStep = new Map<string, number>();
  const stepBySeq = new Map<number, string | undefined>();
  for (const entry of entries) {
    stepBySeq.set(entry.seq, entry.stepRunId);
    // First wins: "the step's first event" is where selecting a step scrolls to.
    if (entry.stepRunId !== undefined && !firstSeqByStep.has(entry.stepRunId)) {
      firstSeqByStep.set(entry.stepRunId, entry.seq);
    }
  }
  return { firstSeqByStep, stepBySeq };
}

export type SelectionAction =
  /** A run row in the tree: the run, and no step inside it. */
  | { type: "select-run"; runId: string }
  /** A step, an attempt or a note row in the tree. */
  | { type: "select-step"; runId: string; stepRunId: string }
  /** A row in the timeline. */
  | { type: "select-event"; runId: string; seq: number }
  /** The selected run left the list under us. */
  | { type: "clear" };

/**
 * The whole of the two lists' agreement, in one function.
 *
 * Selecting a step keeps the timeline where it is when that step has no held event:
 * jumping to the top of the log because a step's first event is four pages back would lose
 * the place a person was reading, and there is nothing better to jump to. Selecting a
 * *different run* does drop the cursor, because a sequence number is per run and the old
 * one names nothing in the new log.
 */
export function reduceSelection(state: RunSelection, action: SelectionAction, index: SelectionIndex): RunSelection {
  switch (action.type) {
    case "clear":
      return isEmpty(state) ? state : {};

    case "select-run":
      return settle(state, { selectedRunId: action.runId });

    case "select-step": {
      const kept = action.runId === state.selectedRunId ? state.selectedSeq : undefined;
      return settle(state, {
        selectedRunId: action.runId,
        selectedStepRunId: action.stepRunId,
        selectedSeq: index.firstSeqByStep.get(action.stepRunId) ?? kept,
      });
    }

    case "select-event":
      return settle(state, {
        selectedRunId: action.runId,
        selectedStepRunId: index.stepBySeq.get(action.seq),
        selectedSeq: action.seq,
      });
  }
}

/** Same values, same object — so a repeated click does not re-render two lists. */
const settle = (state: RunSelection, next: RunSelection): RunSelection => (same(state, next) ? state : next);

const same = (a: RunSelection, b: RunSelection): boolean =>
  a.selectedRunId === b.selectedRunId && a.selectedStepRunId === b.selectedStepRunId && a.selectedSeq === b.selectedSeq;

const isEmpty = (state: RunSelection): boolean => same(state, {});

export interface RunSelectionApi extends RunSelection {
  selectRun: (runId: string) => void;
  selectStep: (runId: string, stepRunId: string) => void;
  selectEvent: (runId: string, seq: number) => void;
  clear: () => void;
}

/**
 * The reducer as a hook. `runIds` is the tree's roots — a run that leaves the list takes
 * the selection with it, because an id naming no row would make the next `J` jump
 * somewhere unrelated.
 *
 * `index` is a **ref**, not a value, and that is not an optimisation. The index is built
 * from the events the timeline holds, and the timeline is only asked for a log once a run
 * is selected — so the selection cannot take the index as a prop without the two hooks
 * depending on each other. Reading it at dispatch time also means the five key handlers
 * keep one identity for the life of the surface, which is what stops eight shortcuts being
 * unregistered and re-registered on every notification.
 */
export function useRunSelection(
  index: { readonly current: SelectionIndex },
  runIds: readonly string[],
): RunSelectionApi {
  const [state, dispatch] = useReducer(
    (current: RunSelection, action: SelectionAction & { index: SelectionIndex }) =>
      reduceSelection(current, action, action.index),
    {},
  );

  const selectRun = useCallback(
    (runId: string) => dispatch({ type: "select-run", runId, index: index.current }),
    [index],
  );
  const selectStep = useCallback(
    (runId: string, stepRunId: string) => dispatch({ type: "select-step", runId, stepRunId, index: index.current }),
    [index],
  );
  const selectEvent = useCallback(
    (runId: string, seq: number) => dispatch({ type: "select-event", runId, seq, index: index.current }),
    [index],
  );
  const clear = useCallback(() => dispatch({ type: "clear", index: EMPTY_INDEX }), []);

  const { selectedRunId } = state;
  useEffect(() => {
    if (selectedRunId !== undefined && !runIds.includes(selectedRunId)) clear();
  }, [runIds, selectedRunId, clear]);

  return useMemo(
    () => ({ ...state, selectRun, selectStep, selectEvent, clear }),
    [state, selectRun, selectStep, selectEvent, clear],
  );
}
