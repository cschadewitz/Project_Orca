/// <reference lib="dom" />
/**
 * Pane sizes: the registry of the app's draggable boundaries, the arithmetic of a drag, and
 * the one place a size is written onto the document (#276).
 *
 * The shape is `density.ts`'s, for the same reasons. A size is a **CSS custom property on the
 * container whose track reads it** — `--pane-sidebar` on `.orca-body`, `--pane-runs-tree` on
 * `.orca-runs__left` — and the stylesheet spells the track `var(--pane-<id>, var(--<token>))`.
 * So the token stays the single statement of the default, an unset property *is* the default
 * rather than a copy of it, and nothing in the renderer has a second opinion about how wide a
 * side pane is. Framework-free so the arithmetic is a plain module with a plain test; the
 * React side is `chrome/pane-splitter.tsx`.
 *
 * Every boundary is remembered by its id in the app's preferences, beside density
 * (`appearance.ts`), because "a resize that resets on relaunch is worse than no resize".
 * Two boundaries share an id on purpose: the docked panel and the workflow node inspector are
 * the same kind of column, and one remembered width for both is the same decision the
 * `panel-width` token already made.
 */
import { PANE_GEOMETRY, type SizeToken } from "@orca/design";

/** Every boundary the app can resize. The id is what the size is remembered by. */
export const PANE_IDS = ["sidebar", "panel", "runs-detail", "runs-tree", "plan-rail"] as const;
export type PaneId = (typeof PANE_IDS)[number];

/**
 * Which way the separator itself lies, as ARIA means it: a `vertical` separator sits between
 * two columns and moves left and right; a `horizontal` one sits between two stacked panes and
 * moves up and down. It is the value of `aria-orientation` and the axis of the drag at once.
 */
export type PaneOrientation = "vertical" | "horizontal";

/**
 * Which side of the boundary the sized pane is on. `leading` grows as the pointer moves right
 * or down (the sidebar, the run tree); `trailing` shrinks (the docked panel, the step detail).
 */
export type PaneEdge = "leading" | "trailing";

export interface PaneBoundary {
  /** The custom property the size is written to, and the one the stylesheet reads. */
  readonly property: string;
  /** The size token the stylesheet falls back to; `undefined` where the default is a fraction. */
  readonly token: SizeToken | undefined;
  readonly orientation: PaneOrientation;
  readonly edge: PaneEdge;
  /** The floor for the sized pane, and the floor the pane opposite keeps for itself. */
  readonly min: number;
  /** The ceiling, where the design states one. Absent means "whatever the container allows". */
  readonly max: number | undefined;
}

export const PANE_BOUNDARIES: Readonly<Record<PaneId, PaneBoundary>> = {
  sidebar: {
    property: "--pane-sidebar",
    token: "sidebar-width",
    orientation: "vertical",
    edge: "leading",
    min: PANE_GEOMETRY["pane-min-sidebar"],
    max: PANE_GEOMETRY["pane-max-sidebar"],
  },
  panel: {
    property: "--pane-panel",
    token: "panel-width",
    orientation: "vertical",
    edge: "trailing",
    min: PANE_GEOMETRY["pane-min-side"],
    max: PANE_GEOMETRY["pane-max-side"],
  },
  "runs-detail": {
    property: "--pane-runs-detail",
    token: "panel-width",
    orientation: "vertical",
    edge: "trailing",
    min: PANE_GEOMETRY["pane-min-side"],
    max: PANE_GEOMETRY["pane-max-side"],
  },
  /* The one stacked boundary, and the one with no size token behind it: the run tree's share
     of the left column is a fraction of it (`2fr` against the timeline's `3fr`), which is not
     a length and cannot be one — a default height in pixels would be wrong at every window
     size. So the fallback is in the stylesheet and there is no ceiling here; the container is
     the ceiling. */
  "runs-tree": {
    property: "--pane-runs-tree",
    token: undefined,
    orientation: "horizontal",
    edge: "leading",
    min: PANE_GEOMETRY["pane-min-stack"],
    max: undefined,
  },
  "plan-rail": {
    property: "--pane-plan-rail",
    token: "sidebar-width",
    orientation: "vertical",
    edge: "leading",
    min: PANE_GEOMETRY["pane-min-sidebar"],
    max: PANE_GEOMETRY["pane-max-sidebar"],
  },
};

/** How far one arrow press moves a boundary. */
export const PANE_STEP = PANE_GEOMETRY["pane-step"];

/**
 * The size a boundary may actually be given, for a container of `extent` px along the axis.
 *
 * Two ceilings and the lower one wins: the design's, and the one the window imposes — a pane
 * may never take so much that the pane opposite drops below the same floor. That second one is
 * why a remembered size is clamped on every window resize rather than once when it is dragged:
 * the number a person chose is kept, and what is applied is that number as far as the window
 * allows, so widening the window brings their choice back rather than the default.
 *
 * `extent` of 0 — a container that has not been laid out, which is every container under
 * happy-dom — means only the design's limits apply.
 */
export function clampPaneSize(boundary: PaneBoundary, size: number, extent: number): number {
  const ceilings = [boundary.max, extent > 0 ? extent - boundary.min : undefined].filter(
    (c): c is number => c !== undefined,
  );
  const ceiling = Math.min(...ceilings, Number.POSITIVE_INFINITY);
  // The floor wins over the ceiling: a container too small for both is one where the pane
  // keeps its minimum and the overflow is the window's problem, not a pane of zero width.
  return Math.max(boundary.min, Math.min(size, ceiling));
}

/** Where a pointer that has moved `delta` px along the axis puts the boundary. */
export function dragPaneSize(boundary: PaneBoundary, startSize: number, delta: number, extent: number): number {
  return clampPaneSize(boundary, startSize + (boundary.edge === "leading" ? delta : -delta), extent);
}

/**
 * The size a keypress moves a boundary to, or `undefined` for a key that is not one of the
 * four. Only the two keys along the separator's own axis do anything: `←`/`→` on a column
 * boundary, `↑`/`↓` on a stacked one. A press towards the sized pane's own edge shrinks it,
 * which is the direction the pointer would have gone.
 */
export function keyPaneSize(
  boundary: PaneBoundary,
  key: string,
  from: number,
  extent: number,
  step = PANE_STEP,
): number | undefined {
  const axis: readonly [string, string] =
    boundary.orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const direction = key === axis[0] ? -1 : key === axis[1] ? 1 : 0;
  if (direction === 0) return undefined;
  return dragPaneSize(boundary, from, direction * step, extent);
}

/** The container's extent along the boundary's axis, in px. */
export function paneExtent(container: Element, boundary: PaneBoundary): number {
  const box = container.getBoundingClientRect();
  return boundary.orientation === "vertical" ? box.width : box.height;
}

/**
 * Write a size onto the container, or hand the boundary back to its default by removing the
 * property. The only code that touches a `--pane-*` property, as `density.ts` is the only code
 * that touches `data-density`.
 */
export function applyPaneSize(container: HTMLElement, boundary: PaneBoundary, size: number | undefined): void {
  if (size === undefined) container.style.removeProperty(boundary.property);
  else container.style.setProperty(boundary.property, `${Math.round(size)}px`);
}

/** What is applied to the container right now, or `undefined` while it is at its default. */
export function readPaneSize(container: HTMLElement, boundary: PaneBoundary): number | undefined {
  const value = container.style.getPropertyValue(boundary.property);
  if (value === "") return undefined;
  const px = Number.parseFloat(value);
  return Number.isFinite(px) ? px : undefined;
}
