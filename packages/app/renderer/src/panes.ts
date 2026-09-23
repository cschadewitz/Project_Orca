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
 *
 * **A size is not always a length.** A boundary says which of the two it is (`PaneSizeKind`,
 * #281): the four column boundaries are remembered in px, and the one stacked boundary is
 * remembered as a fraction of its container, because a ratio is what a person chooses there
 * and a ratio is the only thing that travels between two window heights. Everything in
 * between — the drag, the arrow keys, the clamp, the separator's `aria-valuenow` — is px
 * either way; the conversion happens at the two edges, `panePreferenceOf` and `panePx`.
 */
import { PANE_GEOMETRY, type SizeToken } from "@orca/design";

/** Every boundary the app can resize. The id is what the size is remembered by. */
export const PANE_IDS = ["sidebar", "panel", "runs-detail", "runs-tree", "plan-rail", "plan-risk"] as const;
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

/**
 * Whether the boundary's size is **a length or a ratio** — which is the difference between a
 * pane sized to what it holds and two halves of one column (#281).
 *
 * A `length` is right for a boundary between two *columns*: a side pane holds a line of
 * output or a rule sentence, and 520px means the same thing on a laptop and on a 34" display.
 * It is wrong for a stacked boundary, where neither half is sized to its content and what a
 * person chooses is "more tree than timeline" — remembered as a length, a tree dragged to
 * 600px on a tall monitor arrives as most of the column on a laptop.
 *
 * The distinction is only about what is **remembered and applied**: a `fraction` boundary is
 * still dragged, stepped and clamped in px against its container, because px is what a
 * pointer moves in and what `aria-valuemin`/`max` are stated in. It is converted on the way
 * into the preference and back out of it (`panePreferenceOf`, `panePx`).
 */
export type PaneSizeKind = "length" | "fraction";

export interface PaneBoundary {
  /** The custom property the size is written to, and the one the stylesheet reads. */
  readonly property: string;
  /** What the person resizing it would call the two panes, for a list of what is remembered. */
  readonly label: string;
  /** The size token the stylesheet falls back to; `undefined` where the default is a fraction. */
  readonly token: SizeToken | undefined;
  /** A length in px, or a ratio of the container. See `PaneSizeKind`. */
  readonly size: PaneSizeKind;
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
    label: "Sidebar",
    token: "sidebar-width",
    size: "length",
    orientation: "vertical",
    edge: "leading",
    min: PANE_GEOMETRY["pane-min-sidebar"],
    max: PANE_GEOMETRY["pane-max-sidebar"],
  },
  panel: {
    property: "--pane-panel",
    label: "Docked panel",
    token: "panel-width",
    size: "length",
    orientation: "vertical",
    edge: "trailing",
    min: PANE_GEOMETRY["pane-min-side"],
    max: PANE_GEOMETRY["pane-max-side"],
  },
  "runs-detail": {
    property: "--pane-runs-detail",
    label: "Step detail",
    token: "panel-width",
    size: "length",
    orientation: "vertical",
    edge: "trailing",
    min: PANE_GEOMETRY["pane-min-side"],
    max: PANE_GEOMETRY["pane-max-side"],
  },
  /* The one stacked boundary, and the one with no size token behind it: the run tree's share
     of the left column is a fraction of it (`2fr` against the timeline's `3fr`), which is not
     a length and cannot be one — a default height in pixels would be wrong at every window
     size. So the fallback is in the stylesheet and there is no ceiling here; the container is
     the ceiling. And what is remembered is a fraction for the same reason the default is one:
     the two halves are not sized to what they hold, so what a person chose is a ratio and it
     has to travel between a tall monitor and a laptop (#281). */
  "runs-tree": {
    property: "--pane-runs-tree",
    label: "Run tree",
    token: undefined,
    size: "fraction",
    orientation: "horizontal",
    edge: "leading",
    min: PANE_GEOMETRY["pane-min-stack"],
    max: undefined,
  },
  "plan-rail": {
    property: "--pane-plan-rail",
    label: "Requests rail",
    token: "sidebar-width",
    size: "length",
    orientation: "vertical",
    edge: "leading",
    min: PANE_GEOMETRY["pane-min-sidebar"],
    max: PANE_GEOMETRY["pane-max-sidebar"],
  },
  /* The risk matrix over its register (#172): the second stacked boundary, and a fraction for
     the reason the run tree's is. The matrix is sized by the plan's scale and the register by
     how many risks there are, so neither half has a length that is right on every window. */
  "plan-risk": {
    property: "--pane-plan-risk",
    label: "Risk matrix",
    token: undefined,
    size: "fraction",
    orientation: "horizontal",
    edge: "leading",
    min: PANE_GEOMETRY["pane-min-stack"],
    max: undefined,
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
 * A fraction is kept strictly inside `(0, 1)`, and to four places.
 *
 * Strictly, because a boundary at `0` or `1` is a pane that is not there and the preferences
 * schema rejects both — and because `clampPaneSize` can return a floor larger than the
 * container when the window is too small for two panes, which would otherwise be remembered
 * as "more than all of it". Four places is a tenth of a pixel on a 1000px column, which is
 * finer than anything a person can drag to and short enough to read in a JSON file.
 */
const FRACTION_EPSILON = 0.0001;

function asFraction(ratio: number): number {
  const rounded = Math.round(ratio * 10_000) / 10_000;
  return Math.min(1 - FRACTION_EPSILON, Math.max(FRACTION_EPSILON, rounded));
}

/**
 * The px a remembered preference means, in a container of `extent` along the axis.
 *
 * `undefined` for a fractional boundary whose container has not been laid out: a ratio of a
 * container of nothing is not a length, and the honest answer there is "not yet" rather than
 * zero. A length boundary needs no container and so never answers that.
 */
export function panePx(boundary: PaneBoundary, preference: number | undefined, extent: number): number | undefined {
  if (preference === undefined) return undefined;
  if (boundary.size === "length") return preference;
  return extent > 0 ? preference * extent : undefined;
}

/** The preference a px size is remembered as: a whole number of px, or a fraction of the container. */
export function panePreferenceOf(boundary: PaneBoundary, size: number, extent: number): number | undefined {
  if (boundary.size === "length") return Math.round(size);
  return extent > 0 ? asFraction(size / extent) : undefined;
}

/**
 * The CSS a px size is written as for this boundary: a length, or a **percentage** of the
 * container. The percentage is the point of a fractional boundary — a track of `42%` keeps
 * the ratio through every window height, where a track of `336px` is a different split at
 * each one (#281).
 */
export function paneSizeValue(boundary: PaneBoundary, size: number, extent: number): string | undefined {
  if (boundary.size === "length") return `${Math.round(size)}px`;
  const fraction = panePreferenceOf(boundary, size, extent);
  return fraction === undefined ? undefined : `${(fraction * 100).toFixed(2)}%`;
}

/**
 * Write a size onto the container, or hand the boundary back to its default by removing the
 * property. The only code that touches a `--pane-*` property, as `density.ts` is the only code
 * that touches `data-density`.
 *
 * `size` is px, always, whatever the boundary remembers — the drag and the arrow keys work in
 * one unit. A fractional boundary with no container to be a fraction of writes nothing, which
 * leaves the stylesheet's own `2fr` in place: the default is the right answer until there is
 * something to measure against.
 */
export function applyPaneSize(
  container: HTMLElement,
  boundary: PaneBoundary,
  size: number | undefined,
  extent = 0,
): void {
  const value = size === undefined ? undefined : paneSizeValue(boundary, size, extent);
  if (value === undefined) container.style.removeProperty(boundary.property);
  else container.style.setProperty(boundary.property, value);
}

/**
 * What is applied to the container right now in px, or `undefined` while it is at its default.
 * A percentage needs the same `extent` it was written against to be read back as a length.
 */
export function readPaneSize(container: HTMLElement, boundary: PaneBoundary, extent = 0): number | undefined {
  const value = container.style.getPropertyValue(boundary.property).trim();
  if (value === "") return undefined;
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return undefined;
  if (!value.endsWith("%")) return number;
  return extent > 0 ? (number / 100) * extent : undefined;
}
