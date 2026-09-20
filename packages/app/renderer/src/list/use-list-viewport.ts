/// <reference lib="dom" />
/**
 * The measured half of the list substrate: the scroller element, the three numbers
 * `list-window.ts` divides, and the one call — `reveal` — that puts a row on screen.
 *
 * Three things are measured rather than assumed, and each is re-measured from the event
 * that can change it:
 *
 * - **the row height**, from `--row-h` on the scroller (`row-height.ts`), re-read when a
 *   `data-density` attribute above the list changes, which is the only thing that rebinds
 *   it. A `MutationObserver` rather than a prop, because density is set on the surface root
 *   by `⌘⇧D` and by the remembered preference, neither of which passes through this list;
 * - **the viewport height**, from the scroller's `clientHeight`, re-read on resize;
 * - **the scroll offset**, from the scroll event, because nothing else knows where a
 *   person put the list.
 *
 * `reveal` is the replacement for `scrollIntoView`. It exists as arithmetic rather than a
 * DOM call for one reason: `scrollIntoView` can only reach a row that is *in the document*,
 * and the row a key just selected may be four thousand rows below the last one rendered.
 * So the offset is computed, assigned, and fed straight back into the state that decides
 * the window — the row is mounted because the window moved, not the other way round. That
 * also means it works where there is no layout to scroll: unmeasured, `reveal` moves the
 * anchor index instead and the same row appears.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DENSITY_ATTRIBUTE, SURFACE_ATTRIBUTE } from "../density.js";
import {
  hasContentBeneath,
  isAtBottom,
  isMeasured,
  listWindow,
  revealAnchor,
  revealScrollTop,
  shiftAnchor,
  shiftScrollTop,
  type ListMetrics,
  type ListWindow,
} from "./list-window.js";
import { measureRowHeight } from "./row-height.js";

export interface ListViewport {
  /** Goes on the element that scrolls. */
  scrollerRef: (element: HTMLDivElement | null) => void;
  /** Its `onScroll`. */
  onScroll: () => void;
  metrics: ListMetrics;
  /** The current metrics, for a callback that must stay stable across renders. */
  metricsRef: { readonly current: ListMetrics };
  window: ListWindow;
  /** Whether anything has scrolled under the sticky header yet. */
  scrolled: boolean;
  /** Whether the list is at its end — the pixel half of "is this stream following?". */
  atBottom: boolean;
  /** Put row `index` on screen, moving nothing when it already is. */
  reveal: (index: number) => void;
  /**
   * Keep what is on screen on screen after `rows` items were prepended. Called *after* the
   * new items are in `items`, so the metrics it reads are the ones the prepend produced.
   */
  shiftBy: (rows: number) => void;
}

/** The pixels, gathered in one state so a resize and a density change repaint together. */
interface Geometry {
  rowHeight: number;
  viewportHeight: number;
}

const UNMEASURED: Geometry = { rowHeight: 0, viewportHeight: 0 };

/**
 * `count` is the whole list's length and `rowSpan` how many `--row-h` one row occupies —
 * two for the declared two-line variant, which is a taller row, never a row that grew.
 *
 * `onLeaveBottom` is how a following stream finds out it has been taken off the end. It
 * belongs here, and fires from the scroll event rather than from a render, for one reason:
 * a stream that is following moves its own offset every time the list grows, and between
 * that offset being computed and it being committed there is a render in which the list is
 * *not* at the bottom and is about to be. A check over render state fires there, on the
 * frame a person did nothing — so the check is over the scroll that actually happened.
 */
export function useListViewport(count: number, rowSpan = 1, onLeaveBottom?: () => void): ListViewport {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<Geometry>(UNMEASURED);
  const [scrollTop, setScrollTop] = useState(0);
  const [anchor, setAnchor] = useState(0);

  const measure = useCallback(() => {
    if (!scroller) return;
    const next: Geometry = {
      rowHeight: measureRowHeight(scroller) * rowSpan,
      viewportHeight: scroller.clientHeight,
    };
    // Same numbers, same object: a `ResizeObserver` that fires on every frame of a window
    // drag should not re-render a list of fifty thousand rows on the frames that changed
    // nothing.
    setGeometry((prev) =>
      prev.rowHeight === next.rowHeight && prev.viewportHeight === next.viewportHeight ? prev : next,
    );
  }, [scroller, rowSpan]);

  useEffect(() => {
    if (!scroller) return;
    measure();

    const view = scroller.ownerDocument.defaultView;
    /* Both observers are optional: the substrate has to mount where neither exists (a DOM
       with no layout engine), and there it simply stays unmeasured rather than throwing. */
    const resize =
      view && typeof view.ResizeObserver === "function" ? new view.ResizeObserver(() => measure()) : undefined;
    resize?.observe(scroller);

    /* Density is an attribute on the surface root, and it is *removed* rather than set to
       "comfortable" — so the element to watch is the surface, not an element carrying the
       attribute today. With no surface above the list, the document element is the widest
       honest guess and costs one observer. */
    const densityRoot = scroller.closest(`[${SURFACE_ATTRIBUTE}]`) ?? scroller.ownerDocument.documentElement;
    const mutation =
      view && typeof view.MutationObserver === "function" ? new view.MutationObserver(() => measure()) : undefined;
    mutation?.observe(densityRoot, { attributes: true, attributeFilter: [DENSITY_ATTRIBUTE] });

    return () => {
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [scroller, measure]);

  const metrics = useMemo<ListMetrics>(
    () => ({ count, rowHeight: geometry.rowHeight, viewportHeight: geometry.viewportHeight, scrollTop, anchor }),
    [count, geometry.rowHeight, geometry.viewportHeight, scrollTop, anchor],
  );

  /* Read through a ref by `reveal` and by the keyboard moves, which have to keep one
     identity for the life of the list: re-registering four shortcuts on every notification
     would drop the keypress that landed between the unregister and the register. This is
     the same trick `runs/use-run-selection.ts` uses on its rows. */
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  scrollerRef.current = scroller;

  /* Whether the list was at its end as of the last offset anything assigned or observed.
     A ref rather than state because it is the *previous* value that says whether a scroll
     was the moment a person took a stream off its end, and a render cannot see that. */
  const leave = useRef(onLeaveBottom);
  leave.current = onLeaveBottom;
  const bottomRef = useRef(true);

  /* Assign and record: the assignment moves the real scrollbar, the state moves the window.
     A browser answers with a scroll event too, which lands on the same number. */
  const offsetTo = useCallback((next: number, current: ListMetrics) => {
    if (next === current.scrollTop) return;
    bottomRef.current = isAtBottom({ ...current, scrollTop: next });
    if (scrollerRef.current) scrollerRef.current.scrollTop = next;
    setScrollTop(next);
  }, []);

  const reveal = useCallback(
    (index: number) => {
      const current = metricsRef.current;
      if (!isMeasured(current)) {
        setAnchor(revealAnchor(index, current));
        return;
      }
      offsetTo(revealScrollTop(index, current), current);
    },
    [offsetTo],
  );

  /* The same two halves as `reveal`, because a prepend has the same two cases: pixels to
     add to when the list has been laid out, and an anchor row to move when it has not. */
  const shiftBy = useCallback(
    (rows: number) => {
      if (rows === 0) return;
      const current = metricsRef.current;
      if (!isMeasured(current)) {
        setAnchor(shiftAnchor(rows, current));
        return;
      }
      offsetTo(shiftScrollTop(rows, current), current);
    },
    [offsetTo],
  );

  const onScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const top = element.scrollTop;
    setScrollTop(top);

    const bottom = isAtBottom({ ...metricsRef.current, scrollTop: top });
    const was = bottomRef.current;
    bottomRef.current = bottom;
    /* The transition off the end, and only the transition: a drag is one scroll event per
       frame, and a surface told forty times that following stopped would say so once and
       re-render thirty-nine times for nothing. */
    if (was && !bottom) leave.current?.();
  }, []);

  return {
    scrollerRef: setScroller,
    onScroll,
    metrics,
    metricsRef,
    window: useMemo(() => listWindow(metrics), [metrics]),
    scrolled: hasContentBeneath(scrollTop),
    atBottom: isAtBottom(metrics),
    reveal,
    shiftBy,
  };
}
