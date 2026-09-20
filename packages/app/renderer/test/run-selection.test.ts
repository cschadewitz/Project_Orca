/**
 * One selection over two lists, without a DOM.
 *
 * The thing worth testing here is that the two directions are one function: a step picked
 * in the tree moves the timeline to that step's first event, an event picked in the
 * timeline picks the step it is about, and neither is a component watching the other
 * through an effect.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_INDEX, buildSelectionIndex, reduceSelection, type RunSelection } from "../src/runs/use-run-selection.js";

/* A log where `s-build-1` runs from seq 3, `s-build-2` from seq 7, and seqs 0-2 are the
   run's own — which is the shape every ORCA log has. */
const index = buildSelectionIndex([
  { seq: 0 },
  { seq: 1 },
  { seq: 2 },
  { seq: 3, stepRunId: "s-build-1" },
  { seq: 4, stepRunId: "s-build-1" },
  { seq: 7, stepRunId: "s-build-2" },
  { seq: 8, stepRunId: "s-build-2" },
]);

const from = (state: RunSelection, action: Parameters<typeof reduceSelection>[1]): RunSelection =>
  reduceSelection(state, action, index);

describe("one selection for the tree and the timeline", () => {
  it("indexes a step by its first event, not its last", () => {
    expect(index.firstSeqByStep.get("s-build-1")).toBe(3);
    expect(index.firstSeqByStep.get("s-build-2")).toBe(7);
    expect(index.stepBySeq.get(0)).toBeUndefined();
    expect(index.stepBySeq.get(8)).toBe("s-build-2");
  });

  it("scrolls the timeline to a step's first event when the step is picked", () => {
    expect(from({}, { type: "select-step", runId: "run-parent", stepRunId: "s-build-2" })).toEqual({
      selectedRunId: "run-parent",
      selectedStepRunId: "s-build-2",
      selectedSeq: 7,
    });
  });

  it("picks the step an event is about when the event is picked", () => {
    expect(from({}, { type: "select-event", runId: "run-parent", seq: 4 })).toEqual({
      selectedRunId: "run-parent",
      selectedStepRunId: "s-build-1",
      selectedSeq: 4,
    });
  });

  it("leaves no step selected for a run-level event", () => {
    const state = from(
      { selectedRunId: "run-parent", selectedStepRunId: "s-build-1", selectedSeq: 3 },
      { type: "select-event", runId: "run-parent", seq: 1 },
    );
    expect(state).toEqual({ selectedRunId: "run-parent", selectedStepRunId: undefined, selectedSeq: 1 });
  });

  it("keeps the reader's place when the picked step has no held event", () => {
    // Its first event has been paged out, so there is no row to scroll to — and jumping to
    // the top of the log would lose the place a person was reading.
    const state = from(
      { selectedRunId: "run-parent", selectedSeq: 8 },
      { type: "select-step", runId: "run-parent", stepRunId: "s-gone" },
    );
    expect(state).toEqual({ selectedRunId: "run-parent", selectedStepRunId: "s-gone", selectedSeq: 8 });
  });

  it("drops the cursor when the run changes, because a sequence number is per run", () => {
    const state = from(
      { selectedRunId: "run-parent", selectedStepRunId: "s-build-1", selectedSeq: 3 },
      { type: "select-step", runId: "run-other", stepRunId: "s-gone" },
    );
    expect(state).toEqual({ selectedRunId: "run-other", selectedStepRunId: "s-gone", selectedSeq: undefined });
  });

  it("selects a run alone, with no step and no event", () => {
    expect(
      from(
        { selectedRunId: "run-parent", selectedStepRunId: "s-build-1", selectedSeq: 3 },
        {
          type: "select-run",
          runId: "run-parent",
        },
      ),
    ).toEqual({ selectedRunId: "run-parent" });
  });

  it("is the same object when nothing moved, so neither list repaints", () => {
    const state: RunSelection = { selectedRunId: "run-parent", selectedStepRunId: "s-build-2", selectedSeq: 7 };
    expect(from(state, { type: "select-step", runId: "run-parent", stepRunId: "s-build-2" })).toBe(state);
    expect(reduceSelection({}, { type: "clear" }, EMPTY_INDEX)).toEqual({});
  });

  it("clears everything when the run leaves the list", () => {
    const state: RunSelection = { selectedRunId: "run-parent", selectedStepRunId: "s-build-2", selectedSeq: 7 };
    expect(reduceSelection(state, { type: "clear" }, EMPTY_INDEX)).toEqual({});
  });

  it("resolves nothing against an empty index, and still selects the step", () => {
    expect(reduceSelection({}, { type: "select-step", runId: "r", stepRunId: "s" }, EMPTY_INDEX)).toEqual({
      selectedRunId: "r",
      selectedStepRunId: "s",
      selectedSeq: undefined,
    });
  });
});
