/**
 * The list substrate's arithmetic, without a DOM: the window, the scroll offset that
 * reveals a row, the moves a key makes, and where a tick sits in the gutter.
 *
 * `virtual-list.test.tsx` proves the component wires these up; this proves the edges a DOM
 * test would have to contrive a layout to reach — a viewport nothing has measured, an
 * anchor on the last row, a page key on an empty list, a `--row-h` that resolved to
 * nothing at all. The numbers below are the design system's real ones (32px comfortable,
 * 24px compact) so a reader can picture the list they describe.
 */
import { describe, expect, it } from "vitest";
import {
  UNMEASURED_ROWS,
  clampIndex,
  hasContentBeneath,
  indexAtOffset,
  isMeasured,
  listWindow,
  moveIndex,
  pageRows,
  revealAnchor,
  revealScrollTop,
  rowsInView,
  tickOffset,
  type ListMetrics,
} from "../src/list/list-window.js";
import { parseRowHeight } from "../src/list/row-height.js";

/** A measured list: 50,000 rows, a comfortable row height, ten rows of viewport. */
const metrics = (over: Partial<ListMetrics> = {}): ListMetrics => ({
  count: 50_000,
  rowHeight: 32,
  viewportHeight: 320,
  scrollTop: 0,
  ...over,
});

/** The same list before anything could be measured: no row height, no viewport. */
const unmeasured = (over: Partial<ListMetrics> = {}): ListMetrics =>
  metrics({ rowHeight: 0, viewportHeight: 0, ...over });

describe("the window over a measured list", () => {
  it("renders the band on screen plus the overscan, and nothing else", () => {
    const window = listWindow(metrics());
    expect(window.measured).toBe(true);
    expect(window.first).toBe(0);
    // Ten rows of viewport, four of overscan below, none above the top of the list.
    expect(window.end).toBe(14);
    expect(window.end - window.first).toBeLessThan(100);
  });

  it("stands the rest of the list in as two spacers, so the scrollbar is the whole list", () => {
    const window = listWindow(metrics({ scrollTop: 32_000 }));
    expect(window.first).toBe(996);
    expect(window.end).toBe(1014);
    expect(window.padTop).toBe(996 * 32);
    expect(window.padBottom).toBe((50_000 - 1014) * 32);
    // The two spacers plus the window are the list, to the pixel: anything else is a
    // scrollbar that lies about how much there is.
    expect(window.padTop + (window.end - window.first) * 32 + window.padBottom).toBe(50_000 * 32);
  });

  it("stops at the ends rather than running past them", () => {
    const window = listWindow(metrics({ scrollTop: 50_000 * 32 }));
    expect(window.end).toBe(50_000);
    expect(window.first).toBeLessThan(window.end);
    expect(window.padBottom).toBe(0);
  });

  it("is the whole of a list shorter than the viewport", () => {
    expect(listWindow(metrics({ count: 5 }))).toMatchObject({ first: 0, end: 5, padTop: 0, padBottom: 0 });
  });

  it("is empty for an empty list, without dividing anything", () => {
    expect(listWindow(metrics({ count: 0 }))).toMatchObject({ first: 0, end: 0, padTop: 0, padBottom: 0 });
  });
});

describe("the window over a list nothing has measured", () => {
  /* The case that matters most: a first frame, a hidden pane, an environment with no
     layout. Dividing by a zero row height would render all fifty thousand rows, which is
     the freeze the substrate exists to prevent. */
  it("is a fixed count of rows rather than a division by zero", () => {
    const window = listWindow(unmeasured());
    expect(window.measured).toBe(false);
    expect(window.first).toBe(0);
    expect(window.end).toBe(UNMEASURED_ROWS);
    expect(window.padTop).toBe(0);
    expect(window.padBottom).toBe(0);
  });

  it("is a window on the anchor, pulled back off the end so it stays full", () => {
    expect(listWindow(unmeasured({ anchor: 30_000 })).first).toBe(30_000);
    expect(listWindow(unmeasured({ anchor: 49_999 })).first).toBe(50_000 - UNMEASURED_ROWS);
  });

  it("is the whole of a short list, which is why a five-row list still renders five rows", () => {
    expect(listWindow(unmeasured({ count: 5, anchor: 4 }))).toMatchObject({ first: 0, end: 5 });
  });

  it("says so, because a half-measured list is not measured", () => {
    expect(isMeasured(metrics())).toBe(true);
    expect(isMeasured(metrics({ rowHeight: 0 }))).toBe(false);
    expect(isMeasured(metrics({ viewportHeight: 0 }))).toBe(false);
  });
});

describe("revealing a row", () => {
  it("leaves a row that is already whole-visible exactly where it is", () => {
    expect(revealScrollTop(5, metrics({ scrollTop: 96 }))).toBe(96);
  });

  it("brings a row above the band to the top and one below it to the bottom", () => {
    expect(revealScrollTop(0, metrics({ scrollTop: 320 }))).toBe(0);
    // Row 20 ends at 672px; a 320px viewport has to start at 352 to end there.
    expect(revealScrollTop(20, metrics({ scrollTop: 0 }))).toBe(352);
  });

  it("clamps to a row the list has", () => {
    expect(revealScrollTop(99_999, metrics())).toBe(50_000 * 32 - 320);
    expect(revealScrollTop(-4, metrics({ scrollTop: 320 }))).toBe(0);
  });

  it("moves the anchor instead when there are no pixels to move", () => {
    // Already in the window: nothing moves, so the rows do not jump under a person.
    expect(revealAnchor(10, unmeasured())).toBe(0);
    // Below it: the row becomes the last of the window. Above it: the first.
    expect(revealAnchor(200, unmeasured())).toBe(200 - UNMEASURED_ROWS + 1);
    expect(revealAnchor(3, unmeasured({ anchor: 100 }))).toBe(3);
    expect(revealAnchor(0, unmeasured({ count: 0 }))).toBe(0);
  });
});

describe("the moves a key makes", () => {
  it("takes the end it points at when nothing is selected yet", () => {
    expect(moveIndex("next", undefined, 5, 4)).toBe(0);
    expect(moveIndex("previous", undefined, 5, 4)).toBe(4);
    expect(moveIndex("page-down", undefined, 5, 4)).toBe(0);
    expect(moveIndex("page-up", undefined, 5, 4)).toBe(4);
  });

  it("steps one row, a page, or straight to an end", () => {
    expect(moveIndex("next", 2, 50, 9)).toBe(3);
    expect(moveIndex("previous", 2, 50, 9)).toBe(1);
    expect(moveIndex("page-down", 2, 50, 9)).toBe(11);
    expect(moveIndex("page-up", 20, 50, 9)).toBe(11);
    expect(moveIndex("first", 20, 50, 9)).toBe(0);
    expect(moveIndex("last", 20, 50, 9)).toBe(49);
  });

  it("stops at the ends rather than wrapping, which would lose anyone holding a key", () => {
    expect(moveIndex("previous", 0, 50, 9)).toBe(0);
    expect(moveIndex("next", 49, 50, 9)).toBe(49);
    expect(moveIndex("page-down", 48, 50, 9)).toBe(49);
    expect(moveIndex("page-up", 1, 50, 9)).toBe(0);
  });

  it("does nothing to an empty list", () => {
    expect(moveIndex("next", undefined, 0, 9)).toBe(0);
    expect(clampIndex(7, 0)).toBe(0);
  });

  it("is a viewport less one row, so the bottom row becomes the top one", () => {
    expect(rowsInView(metrics())).toBe(10);
    expect(pageRows(metrics())).toBe(9);
    // Compact rows: the same viewport holds more of them, so a page is longer.
    expect(pageRows(metrics({ rowHeight: 24 }))).toBe(13);
    // Unmeasured, a page is the unmeasured window — the only honest answer available.
    expect(pageRows(unmeasured())).toBe(UNMEASURED_ROWS - 1);
    // A viewport shorter than a row still moves a row, rather than standing still.
    expect(pageRows(metrics({ viewportHeight: 8 }))).toBe(1);
  });
});

describe("the gutter", () => {
  it("places a tick by its place in the whole list, not in the window", () => {
    expect(tickOffset(0, 50_000)).toBe(0);
    expect(tickOffset(25_000, 50_000)).toBe(50);
    expect(tickOffset(49_999, 50_000)).toBeCloseTo(99.998);
    expect(tickOffset(3, 0)).toBe(0);
  });

  it("reads back the row a fraction of its height names", () => {
    expect(indexAtOffset(0, 50_000)).toBe(0);
    expect(indexAtOffset(0.5, 50_000)).toBe(25_000);
    expect(indexAtOffset(1, 50_000)).toBe(49_999);
    expect(indexAtOffset(-1, 50_000)).toBe(0);
  });
});

describe("the sticky header", () => {
  it("lifts only once something is under it", () => {
    expect(hasContentBeneath(0)).toBe(false);
    expect(hasContentBeneath(1)).toBe(true);
  });
});

describe("reading the row height back out of the cascade", () => {
  it("takes a computed pixel length and nothing else", () => {
    expect(parseRowHeight("32px")).toBe(32);
    expect(parseRowHeight("  24px  ")).toBe(24);
    expect(parseRowHeight("28.5px")).toBe(28.5);
  });

  it("is zero — not a guess — for anything that did not go through the cascade", () => {
    // A `--row-h` that is still a reference, a relative unit, or nothing at all: each one
    // means "not measured", and the window falls back to counting rows.
    expect(parseRowHeight("")).toBe(0);
    expect(parseRowHeight("var(--row-comfortable)")).toBe(0);
    expect(parseRowHeight("2rem")).toBe(0);
    expect(parseRowHeight("0px")).toBe(0);
    expect(parseRowHeight("-32px")).toBe(0);
  });
});
