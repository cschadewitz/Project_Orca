/**
 * The Plan surface's arithmetic, tested without a DOM: which half of a filter the daemon
 * applies, how the seven classifications are drawn by a system that has five marks for
 * them, what the count says, how a journal page folds, and that the explanation is passed
 * through untouched.
 */
import { describe, expect, it } from "vitest";
import {
  classificationMark,
  countLabel,
  earliestSeq,
  explanationItems,
  foldJournal,
  isFiltered,
  isNewFrame,
  itemsParams,
  matchesText,
  newestFirst,
  staleFor,
  NO_FILTERS,
} from "../src/plan/plan-model.js";
import { EXPLANATIONS, JOURNAL, PLAN_ID, PLAN_ITEMS } from "./fixtures-plan.js";

const item = (slug: string) => PLAN_ITEMS.find((candidate) => candidate.slug === slug)!;

describe("the filter, split between the daemon and what is held", () => {
  it("sends classification, status and request, and never the text", () => {
    const params = itemsParams(PLAN_ID, {
      classification: ["ready", "held"],
      status: ["pending"],
      requestId: "req-1",
      text: "auth",
    });

    expect(params).toEqual({
      planId: PLAN_ID,
      classification: ["ready", "held"],
      status: ["pending"],
      requestId: "req-1",
    });
    // The text half is applied locally, like the run list's, so a keystroke is not a read.
    expect("text" in params).toBe(false);
  });

  it("leaves an empty filter out rather than spelling out all seven", () => {
    expect(itemsParams(PLAN_ID, NO_FILTERS)).toEqual({ planId: PLAN_ID });
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, text: "  " })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, classification: ["ready"] })).toBe(true);
  });

  it("matches the two fields the daemon matches: slug and title", () => {
    expect(matchesText(item("auth-api"), "callback")).toBe(true);
    expect(matchesText(item("auth-api"), "AUTH-API")).toBe(true);
    expect(matchesText(item("auth-api"), "redis")).toBe(false);
    // No filter matches everything, including a field that is only whitespace.
    expect(matchesText(item("auth-api"), "  ")).toBe(true);
  });

  it("says which half narrowed the list", () => {
    expect(countLabel(9, 9)).toBe("9 items");
    expect(countLabel(3, 9)).toBe("3 of 9 items");
    expect(countLabel(1, 1)).toBe("1 item");
  });
});

describe("seven classifications, five badges", () => {
  it("draws the five the design system has a badge for", () => {
    for (const classification of ["ready", "running", "waiting", "held", "unschedulable"] as const) {
      expect(classificationMark(classification)).toEqual({ kind: "badge", classification });
    }
  });

  it("draws the two settled ones as the run statuses that mean the same", () => {
    // A settled item is not in the ordering at all: what it has is an outcome, and
    // inventing a sixth badge for it is what rule 3 forbids.
    expect(classificationMark("done")).toEqual({ kind: "outcome", status: "succeeded" });
    expect(classificationMark("failed")).toEqual({ kind: "outcome", status: "failed" });
  });
});

describe("the journal's cursors", () => {
  const first = JOURNAL.slice(6); // seq 6..10
  const earlier = JOURNAL.slice(0, 8); // seq 0..7 — overlapping on purpose

  it("folds an overlapping backward page by seq, oldest first", () => {
    const folded = foldJournal(first, earlier);
    expect(folded.map((entry) => entry.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Overlap replaces rather than duplicates: eleven entries, not thirteen.
    expect(folded).toHaveLength(JOURNAL.length);
  });

  it("leaves what is held alone when the page is empty", () => {
    expect(foldJournal(first, [])).toBe(first);
  });

  it("reads newest first and pages back from the oldest held", () => {
    expect(newestFirst(JOURNAL).map((entry) => entry.seq)[0]).toBe(10);
    expect(earliestSeq(first)).toBe(6);
    expect(earliestSeq([])).toBeUndefined();
  });
});

describe("plan.changed", () => {
  it("re-reads the table for every area that moves the schedule, and only the journal for a journal entry", () => {
    expect(staleFor(["schedule"])).toEqual({ plan: true, items: true, journal: false });
    expect(staleFor(["items"])).toEqual({ plan: true, items: true, journal: false });
    // A decision or a waived dependency changes the classification of the items it gates.
    expect(staleFor(["decisions"])).toEqual({ plan: true, items: true, journal: false });
    expect(staleFor(["journal"])).toEqual({ plan: false, items: false, journal: true });
    // One act may be several areas, and is one repaint.
    expect(staleFor(["decisions", "schedule", "journal"])).toEqual({ plan: true, items: true, journal: true });
  });

  it("ignores a sequence number it has already folded", () => {
    expect(isNewFrame(undefined, 0)).toBe(true);
    expect(isNewFrame(7, 8)).toBe(true);
    expect(isNewFrame(7, 7)).toBe(false);
    expect(isNewFrame(7, 6)).toBe(false);
  });
});

describe("the explanation", () => {
  it("passes the scheduler's lines through untouched, in order", () => {
    const lines = EXPLANATIONS["auth-crypto"]!;
    const rows = explanationItems(lines);

    expect(rows.map((row) => row.label)).toEqual([...lines]);
    // Including the last two, which are `orca plan explain`'s own additions: the wave and
    // the risk that names the item. Nothing is dropped, re-cased or re-sentenced.
    expect(rows[rows.length - 1]!.label).toBe("risk key-leak: open (L4 x I5)");
    // Two identical lines would be two rows, so the id is the position and not the text.
    expect(explanationItems(["same", "same"]).map((row) => row.id)).toEqual(["0", "1"]);
  });
});
