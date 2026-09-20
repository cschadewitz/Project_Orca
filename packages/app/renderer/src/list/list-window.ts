/**
 * The list substrate's arithmetic, with no React and no DOM in it: which slice of a list
 * is worth rendering, where the scroller has to be for a row to be on screen, where a
 * status tick sits in the gutter, and which row a key moves to.
 *
 * It is a separate module for the same reason `runs/run-rows.ts` is: these are the parts
 * most likely to be wrong and the parts a DOM test reads worst. A list of fifty thousand
 * runs is one `runs.list` answer and fifty thousand rows nobody can afford to put in the
 * document, so what the substrate renders is a window — and every off-by-one in that
 * window is a row that flickers, a scrollbar that lies about its length, or a selection
 * that vanishes under a page key. All of that is checked here, in plain numbers.
 *
 * The one thing worth knowing before reading on: **a viewport nobody has measured yet is
 * an ordinary case, not an error.** A row's height is `--row-h`, read off the DOM, and the
 * scroller's height is its `clientHeight` — and both are zero before the first layout, in
 * a test environment with no layout at all, and for the frame between mounting and the
 * `ResizeObserver` firing. Dividing by zero there would render the whole list, which on
 * fifty thousand rows is exactly the freeze this module exists to prevent. So when there
 * are no pixels to divide, the window is a fixed *count* of rows taken from an anchor
 * index, the spacers are zero, and scrolling to a row moves the anchor rather than the
 * scroll offset. Everything still works; it just cannot be pixel-accurate until something
 * can be measured, which is the honest answer rather than a guessed row height.
 */

/**
 * Rows kept rendered either side of the visible band, so a scroll of a few pixels does not
 * mount a row at the edge the eye is already on.
 */
export const OVERSCAN = 4;

/**
 * The window's size, in rows, while nothing can be measured. Generous enough that every
 * list a test or a first frame actually shows is complete, and small enough that fifty
 * thousand rows stay a few dozen elements.
 */
export const UNMEASURED_ROWS = 48;

/** Everything the window depends on, gathered so it can be passed around as one value. */
export interface ListMetrics {
  /** Rows in the whole list, not in the window. */
  count: number;
  /** One row's height in pixels, from `--row-h`; zero when nothing has been measured. */
  rowHeight: number;
  /** The scroller's inner height in pixels; zero before layout. */
  viewportHeight: number;
  /** The scroller's offset in pixels. */
  scrollTop: number;
  /** The first row of the window while there are no pixels to divide. */
  anchor?: number;
  /** Rows either side of the visible band. Defaults to `OVERSCAN`. */
  overscan?: number;
}

/** The slice to render, and the two spacers that stand in for everything else. */
export interface ListWindow {
  /** Index of the first rendered row. */
  first: number;
  /** One past the last rendered row, so `items.slice(first, end)` is the window. */
  end: number;
  /** Pixels of nothing above the window — the rows before it, as height. */
  padTop: number;
  /** Pixels of nothing below it, so the scrollbar is the length of the whole list. */
  padBottom: number;
  /** Whether the numbers above came from measured pixels or from the row count. */
  measured: boolean;
}

/** Every move a key can make, named by what a person would call it. */
export type ListMove = "next" | "previous" | "first" | "last" | "page-down" | "page-up";

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** An index that names a row of `count`, or 0 for an empty list. */
export const clampIndex = (index: number, count: number): number =>
  count <= 0 ? 0 : clamp(Math.trunc(index), 0, count - 1);

/** Whether there are pixels to divide: a row height and a viewport, both real. */
export const isMeasured = (metrics: ListMetrics): boolean => metrics.rowHeight > 0 && metrics.viewportHeight > 0;

/** How many rows the viewport shows — the unmeasured window's size when it cannot be divided. */
export function rowsInView(metrics: ListMetrics): number {
  if (!isMeasured(metrics)) return UNMEASURED_ROWS;
  return Math.max(1, Math.ceil(metrics.viewportHeight / metrics.rowHeight));
}

/**
 * How far a page key moves: a viewport less one row, so the row that was at the bottom is
 * at the top afterwards and a person keeps their place rather than skipping a row's worth
 * of list on every press.
 */
export const pageRows = (metrics: ListMetrics): number => Math.max(1, rowsInView(metrics) - 1);

/**
 * The slice to render for these metrics.
 *
 * Measured, it is the band the scroll offset covers plus the overscan, with the rows above
 * and below turned into two spacer heights — which is what keeps the scrollbar the length
 * of the whole list rather than the length of what happens to be rendered. Unmeasured, it
 * is `UNMEASURED_ROWS` rows from the anchor, pulled back off the end so the window stays
 * full when the anchor is the last row.
 */
export function listWindow(metrics: ListMetrics): ListWindow {
  const count = Math.max(0, metrics.count);
  const measured = isMeasured(metrics);
  if (count === 0) return { first: 0, end: 0, padTop: 0, padBottom: 0, measured };

  if (!measured) {
    const first = Math.min(clampIndex(metrics.anchor ?? 0, count), Math.max(0, count - UNMEASURED_ROWS));
    return { first, end: Math.min(count, first + UNMEASURED_ROWS), padTop: 0, padBottom: 0, measured: false };
  }

  const { rowHeight, viewportHeight } = metrics;
  const overscan = metrics.overscan ?? OVERSCAN;
  const top = Math.max(0, metrics.scrollTop);
  const first = clamp(Math.floor(top / rowHeight) - overscan, 0, count - 1);
  const end = clamp(Math.ceil((top + viewportHeight) / rowHeight) + overscan, first + 1, count);
  return { first, end, padTop: first * rowHeight, padBottom: (count - end) * rowHeight, measured: true };
}

/**
 * The scroll offset that puts row `index` on screen, the way `scrollIntoView({ block:
 * "nearest" })` would: a row already whole-visible does not move the list under the
 * person's eyes, a row above the band comes to the top, a row below it comes to the
 * bottom. Unmeasured, there is no offset to compute and the current one is returned — see
 * `revealAnchor` for that half.
 */
export function revealScrollTop(index: number, metrics: ListMetrics): number {
  if (!isMeasured(metrics)) return metrics.scrollTop;
  const top = clampIndex(index, metrics.count) * metrics.rowHeight;
  const bottom = top + metrics.rowHeight;
  if (top < metrics.scrollTop) return top;
  if (bottom > metrics.scrollTop + metrics.viewportHeight) return bottom - metrics.viewportHeight;
  return metrics.scrollTop;
}

/**
 * `revealScrollTop`'s unmeasured twin, in rows rather than pixels: the anchor that puts
 * row `index` in the window, leaving it alone when the row is already there.
 */
export function revealAnchor(index: number, metrics: ListMetrics): number {
  const count = Math.max(0, metrics.count);
  if (count === 0) return 0;
  const target = clampIndex(index, count);
  const { first, end } = listWindow(metrics);
  if (target < first) return target;
  if (target >= end) return Math.max(0, target - UNMEASURED_ROWS + 1);
  return first;
}

/**
 * Where the selection lands. `next` and `previous` take the end they point at when nothing
 * is selected — so the first `J` is the top of the list and the first `K` the bottom,
 * rather than both being row one — and every move stops at the ends rather than wrapping:
 * a list that wraps loses a person who was holding a key down.
 */
export function moveIndex(move: ListMove, selected: number | undefined, count: number, page: number): number {
  if (count <= 0) return 0;
  const last = count - 1;
  if (move === "first") return 0;
  if (move === "last") return last;
  if (selected === undefined) return move === "next" || move === "page-down" ? 0 : last;

  const at = clampIndex(selected, count);
  const step = { next: 1, previous: -1, "page-down": page, "page-up": -page }[move];
  return clamp(at + step, 0, last);
}

/**
 * Where a row's tick sits in the minimap gutter, as a percentage of the gutter's height.
 *
 * The gutter is the whole list, not the rendered window — that is the point of it: a
 * failure four thousand rows below the fold is a mark on the right-hand edge, and the
 * only way to know it is there without scrolling past it.
 */
export const tickOffset = (index: number, count: number): number =>
  count <= 0 ? 0 : (clampIndex(index, count) / count) * 100;

/** Which row a fraction of the gutter's height names — clicking a tick's twin. */
export const indexAtOffset = (fraction: number, count: number): number =>
  clampIndex(Math.floor(clamp(fraction, 0, 1) * count), count);

/**
 * Whether the sticky header has content passing under it. It carries `shadow-sticky` only
 * then: a shadow over an unscrolled list is a lift with nothing beneath it, which says
 * "there is more above" when there is not.
 */
export const hasContentBeneath = (scrollTop: number): boolean => scrollTop > 0;
