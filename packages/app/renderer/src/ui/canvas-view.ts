/**
 * The graph canvases' view: how far in a person is zoomed, where they have panned to, and the
 * minimap that shows both against the whole drawing. Arithmetic only — the hook that holds the
 * state is `use-canvas-view.ts`, and the two controls that drive it are `canvas-controls.tsx`
 * and `graph-minimap.tsx` — so it is a plain module with a plain test, the way
 * `menu-placement.ts` is beside `Menu`.
 *
 * **One coordinate system.** A canvas draws a *scene* — the plane of boxes and edges, `PAD`
 * of margin included — translated by `pan` and scaled by `scale` about its top-left corner,
 * inside a *viewport* that clips it: `screen = pan + scale × world`, with both measured from
 * the viewport's top-left. Everything here is that one equation, solved for whichever side a
 * gesture knows. "World" is the scene's own px, the ones `layout.ts` places nodes in.
 *
 * **Zoom is a scale, and the stops are where the keys land.** `+` and `-` step through
 * `ZOOM_STOPS`, so a press and its reverse are exactly reversible, as they always were; a
 * wheel, a pinch and **Zoom to fit** may stop between two, and the next press goes to the
 * nearest stop past the current scale rather than by a fixed factor from wherever the wheel
 * left it. The first and last stops are the limits for everything.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** What a canvas is showing: `screen = pan + scale × world`. */
export interface CanvasView {
  scale: number;
  pan: Point;
}

/**
 * The zoom stops. A list rather than a multiplier, so `+` and `-` are exactly reversible, and
 * the ends are the limits. A quarter is the floor because **Zoom to fit** has to be able to
 * show a whole workflow — `ai-sdlc` is ten layers, which is wider than a laptop's canvas at a
 * half — and twice is the ceiling because past it a node is larger than the text in it needs.
 *
 * These are behaviour, not appearance: no stylesheet reads them and no theme changes them, so
 * they are stated once here rather than as tokens (the three canvases used to state the list
 * three times).
 */
export const ZOOM_STOPS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.5, 2];
export const ZOOM_MIN = ZOOM_STOPS[0]!;
export const ZOOM_MAX = ZOOM_STOPS[ZOOM_STOPS.length - 1]!;

/** Rest: 100% and no pan, which is what `0` puts back (docs/design/50-accessibility-and-keyboard.md). */
export const REST: CanvasView = { scale: 1, pan: { x: 0, y: 0 } };

/** Two scales this close are one stop: a fit that landed on 0.7500000001 is at 75%. */
const SAME = 1e-6;

export const clampScale = (scale: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));

/** Whether there is a stop above (`1`) or below (`-1`) this scale to go to. */
export const canZoom = (scale: number, way: 1 | -1): boolean =>
  way === 1 ? scale < ZOOM_MAX - SAME : scale > ZOOM_MIN + SAME;

/** The next stop past `scale` in that direction, or the limit when there is none. */
export function nextStop(scale: number, way: 1 | -1): number {
  if (way === 1) return ZOOM_STOPS.find((stop) => stop > scale + SAME) ?? ZOOM_MAX;
  return [...ZOOM_STOPS].reverse().find((stop) => stop < scale - SAME) ?? ZOOM_MIN;
}

/** `75%` — the readout on the controls, rounded the way a person says it. */
export const zoomPercent = (scale: number): string => `${Math.round(scale * 100)}%`;

/**
 * The view at `scale`, keeping the world point under `at` (a viewport point) where it is.
 * This is what makes a wheel zoom *about the pointer*, and a key or a button zoom about the
 * middle of the canvas, rather than about the scene's top-left corner — which is what the
 * canvas did when the transform's origin was the only point that held still.
 */
export function zoomAt(view: CanvasView, scale: number, at: Point): CanvasView {
  const next = clampScale(scale);
  /* Through the world point rather than a ratio of scales: every stop is a sum of halves and
     quarters, so dividing by one and multiplying by another is exact, and `+` then `-` comes
     back to the very pan it left rather than to within a rounding error of it. */
  const world = { x: (at.x - view.pan.x) / view.scale, y: (at.y - view.pan.y) / view.scale };
  return { scale: next, pan: { x: at.x - world.x * next, y: at.y - world.y * next } };
}

/** The middle of a viewport, which is what a key or a button zooms about. */
export const centreOf = (viewport: Size): Point => ({ x: viewport.width / 2, y: viewport.height / 2 });

/**
 * The view that shows the whole drawing, centred.
 *
 * **Never past rest.** Fit is "show me all of it", and a three-node graph blown up to 200% is
 * not more of it, only larger — so the scale is the smaller of the two ratios, clamped to the
 * zoom floor and to 100%. A drawing too large even at the floor is centred on its middle, and
 * the minimap is the way round the rest of it. With nothing measured yet — a canvas that has
 * not been laid out, or happy-dom, which never lays anything out — it is rest.
 */
export function fitView(content: Size, viewport: Size): CanvasView {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return REST;
  const scale = Math.max(ZOOM_MIN, Math.min(1, viewport.width / content.width, viewport.height / content.height));
  return centreOn({ x: content.width / 2, y: content.height / 2 }, scale, viewport);
}

/** The view at `scale` with the world point `world` in the middle of the viewport. */
export function centreOn(world: Point, scale: number, viewport: Size): CanvasView {
  return { scale, pan: { x: viewport.width / 2 - world.x * scale, y: viewport.height / 2 - world.y * scale } };
}

/** What part of the drawing the viewport shows, in world px. */
export function visibleRect(view: CanvasView, viewport: Size): Rect {
  // `0 -` rather than a unary minus, so no pan is 0 and not -0.
  return {
    x: (0 - view.pan.x) / view.scale,
    y: (0 - view.pan.y) / view.scale,
    width: viewport.width / view.scale,
    height: viewport.height / view.scale,
  };
}

/* ---------- the wheel ---------- */

/** `WheelEvent.deltaMode`: px, lines or pages. */
const LINE = 1;
const PAGE = 2;

/**
 * A wheel delta in px, whatever unit the device sent it in. A line is taken as one grid step
 * and a page as the viewport — Firefox on Linux sends lines, everything else this app runs on
 * sends px, and a trackpad sends small px deltas many times a second.
 */
export function wheelPixels(delta: number, mode: number, page: number, line: number): number {
  if (mode === LINE) return delta * line;
  if (mode === PAGE) return delta * page;
  return delta;
}

/**
 * How much a ⌘/Ctrl wheel or a pinch multiplies the scale by, for a delta in px.
 *
 * Exponential, so a notch in and a notch out cancel exactly and a slow pinch and a fast one
 * cover the same ground. One mouse notch (a delta of about a hundred) is about one stop; a
 * trackpad pinch arrives as dozens of single-digit deltas and adds up to the same thing
 * smoothly. Chromium reports a pinch as a wheel with `ctrlKey` set, which is why the canvas
 * gets a pinch for nothing.
 */
export const wheelZoomFactor = (deltaPx: number): number => Math.pow(2, -deltaPx / 200);

/**
 * A plain wheel or a two-finger scroll, as a pan — or `undefined` when the drawing has
 * nowhere further to go that way, so the canvas can let the event through.
 *
 * **It behaves like the scroll region it replaced.** The canvas used to scroll natively when
 * the drawing outgrew it, and below the drawing are the group boxes an expanded container
 * opens. So a wheel moves the drawing until its edge meets the viewport's — no further — and
 * then stops consuming the wheel, which lets the canvas around it scroll on down to the group
 * boxes exactly as before. A drawing a person has dragged off to one side is not yanked back:
 * the bound is wherever the drawing already is, if that is further out.
 */
export function wheelPan(view: CanvasView, delta: Point, content: Size, viewport: Size): CanvasView | undefined {
  const axis = (pan: number, d: number, extent: number, room: number): number => {
    const lo = Math.min(pan, room - extent * view.scale);
    const hi = Math.max(pan, 0);
    return Math.min(hi, Math.max(lo, pan - d));
  };
  const x = axis(view.pan.x, delta.x, content.width, viewport.width);
  const y = axis(view.pan.y, delta.y, content.height, viewport.height);
  if (Math.abs(x - view.pan.x) < SAME && Math.abs(y - view.pan.y) < SAME) return undefined;
  return { scale: view.scale, pan: { x, y } };
}

/* ---------- the minimap ---------- */

/**
 * How the whole drawing fits the minimap's box: one scale, and the offset that centres the
 * scaled drawing in the box. The drawing keeps its aspect, so a left-to-right graph fills the
 * box's width and a top-to-bottom one its height — which is what "follows the layout
 * direction" comes to, without the minimap knowing there is one.
 */
export interface MinimapGeometry {
  scale: number;
  offset: Point;
  box: Size;
}

export function minimapGeometry(content: Size, box: Size): MinimapGeometry {
  if (content.width <= 0 || content.height <= 0)
    return { scale: 0, offset: { x: box.width / 2, y: box.height / 2 }, box };
  const scale = Math.min(box.width / content.width, box.height / content.height);
  return {
    scale,
    offset: { x: (box.width - content.width * scale) / 2, y: (box.height - content.height * scale) / 2 },
    box,
  };
}

/** A world rectangle — a node, or the visible part of the drawing — in minimap px. */
export function toMinimap(geometry: MinimapGeometry, rect: Rect): Rect {
  return {
    x: geometry.offset.x + rect.x * geometry.scale,
    y: geometry.offset.y + rect.y * geometry.scale,
    width: rect.width * geometry.scale,
    height: rect.height * geometry.scale,
  };
}

/** A minimap point, in world px. */
export function fromMinimap(geometry: MinimapGeometry, at: Point): Point {
  if (geometry.scale === 0) return { x: 0, y: 0 };
  return { x: (at.x - geometry.offset.x) / geometry.scale, y: (at.y - geometry.offset.y) / geometry.scale };
}

/**
 * The pan that puts the viewport's rectangle on the minimap with its top-left corner at
 * `corner` (a minimap point). A drag of the rectangle keeps the pointer where it took hold of
 * it, so it is the corner that moves with the pointer; a click elsewhere takes hold of the
 * rectangle's middle, which is what "centre the view there" is.
 */
export function panForMinimap(geometry: MinimapGeometry, corner: Point, scale: number): Point {
  const world = fromMinimap(geometry, corner);
  return { x: -world.x * scale, y: -world.y * scale };
}

/** Whether a minimap point is inside a rectangle on it — the viewport's, for a drag. */
export const inside = (at: Point, rect: Rect): boolean =>
  at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height;
