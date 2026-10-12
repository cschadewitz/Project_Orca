/**
 * The graph canvases' view arithmetic (`ui/canvas-view.ts`): the zoom stops and their clamp,
 * zooming about a point, fit, the wheel, and the minimap's geometry. Pure functions, round
 * numbers; the hook and the controls that use them are `canvas-controls.test.tsx`'s.
 */
import { describe, expect, it } from "vitest";
import {
  REST,
  ZOOM_MAX,
  ZOOM_MIN,
  canZoom,
  centreOn,
  fitView,
  fromMinimap,
  inside,
  minimapGeometry,
  nextStop,
  panForMinimap,
  toMinimap,
  visibleRect,
  wheelPan,
  wheelPixels,
  wheelZoomFactor,
  zoomAt,
  zoomPercent,
  type CanvasView,
  type Point,
} from "../src/ui/canvas-view.js";

/** Where a world point lands on screen: the one equation everything here solves. */
const screenOf = (view: CanvasView, world: Point): Point => ({
  x: view.pan.x + view.scale * world.x,
  y: view.pan.y + view.scale * world.y,
});

describe("the zoom stops", () => {
  it("step to the next stop either way, from a stop or from between two, and stop at the ends", () => {
    expect(nextStop(1, 1)).toBe(1.5);
    expect(nextStop(1, -1)).toBe(0.75);
    // A wheel or a fit can leave the scale between stops; the next press goes to the nearest one past it.
    expect(nextStop(0.6, 1)).toBe(0.75);
    expect(nextStop(0.6, -1)).toBe(0.5);
    // A scale a rounding error off a stop is that stop.
    expect(nextStop(0.7500000001, 1)).toBe(1);
    expect(nextStop(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(nextStop(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
    expect([ZOOM_MIN, ZOOM_MAX]).toEqual([0.25, 2]);
  });

  it("say whether there is anywhere further to go, which is what disables a button", () => {
    expect(canZoom(1, 1)).toBe(true);
    expect(canZoom(ZOOM_MAX, 1)).toBe(false);
    expect(canZoom(ZOOM_MIN, -1)).toBe(false);
    expect(canZoom(ZOOM_MIN, 1)).toBe(true);
  });

  it("read as a percentage the way a person says it", () => {
    expect(zoomPercent(1)).toBe("100%");
    expect(zoomPercent(0.6123)).toBe("61%");
    expect(zoomPercent(REST.scale)).toBe("100%");
  });
});

describe("zooming about a point", () => {
  it("keeps the world point under the pointer exactly where it was", () => {
    const view: CanvasView = { scale: 1, pan: { x: -40, y: 10 } };
    const pointer = { x: 300, y: 200 };
    // The world point under the pointer before the zoom …
    const world = { x: (pointer.x - view.pan.x) / view.scale, y: (pointer.y - view.pan.y) / view.scale };
    const zoomed = zoomAt(view, 1.5, pointer);
    expect(zoomed.scale).toBe(1.5);
    // … is under it after.
    expect(screenOf(zoomed, world)).toEqual(pointer);
  });

  it("clamps to the floor and the ceiling, still about the point", () => {
    const pointer = { x: 100, y: 100 };
    const out = zoomAt(REST, 0.01, pointer);
    expect(out.scale).toBe(ZOOM_MIN);
    expect(screenOf(out, pointer)).toEqual(pointer);
    expect(zoomAt(REST, 40, pointer).scale).toBe(ZOOM_MAX);
  });

  it("is about the top-left corner when the viewport has not been measured, as the canvas always was", () => {
    // The middle of a 0x0 viewport is its corner: a zoom from rest leaves the pan at nothing.
    expect(zoomAt(REST, 1.5, { x: 0, y: 0 })).toEqual({ scale: 1.5, pan: { x: 0, y: 0 } });
  });
});

describe("zoom to fit", () => {
  it("shows the whole drawing, centred, at the larger scale that fits both ways", () => {
    const fit = fitView({ width: 2000, height: 500 }, { width: 800, height: 600 });
    // The width is what binds: 800 / 2000.
    expect(fit.scale).toBe(0.4);
    // Centred: the drawing's middle is the viewport's middle.
    expect(screenOf(fit, { x: 1000, y: 250 })).toEqual({ x: 400, y: 300 });
    // Every corner of the drawing is on screen.
    expect(screenOf(fit, { x: 0, y: 0 }).x).toBeGreaterThanOrEqual(0);
    expect(screenOf(fit, { x: 2000, y: 500 }).x).toBeLessThanOrEqual(800);
  });

  it("never magnifies past 100%: a small graph is centred at rest scale", () => {
    const fit = fitView({ width: 200, height: 100 }, { width: 800, height: 600 });
    expect(fit.scale).toBe(1);
    expect(screenOf(fit, { x: 100, y: 50 })).toEqual({ x: 400, y: 300 });
  });

  it("stops at the floor for a drawing too big even at a quarter, still centred", () => {
    const fit = fitView({ width: 10_000, height: 400 }, { width: 800, height: 600 });
    expect(fit.scale).toBe(ZOOM_MIN);
    expect(screenOf(fit, { x: 5000, y: 200 })).toEqual({ x: 400, y: 300 });
  });

  it("is rest when there is nothing to fit or nothing measured", () => {
    expect(fitView({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual(REST);
    expect(fitView({ width: 2000, height: 500 }, { width: 0, height: 0 })).toEqual(REST);
  });
});

describe("the wheel", () => {
  it("zooms by the same factor in as out, so a notch and its reverse cancel", () => {
    expect(wheelZoomFactor(100) * wheelZoomFactor(-100)).toBeCloseTo(1, 12);
    // Down (a positive delta) is out; up is in.
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
  });

  it("reads a delta in lines or pages as px", () => {
    expect(wheelPixels(3, 0, 600, 16)).toBe(3);
    expect(wheelPixels(3, 1, 600, 16)).toBe(48);
    expect(wheelPixels(1, 2, 600, 16)).toBe(600);
  });

  it("pans a drawing larger than the viewport, up to its edge and no further", () => {
    const content = { width: 2000, height: 1000 };
    const viewport = { width: 800, height: 600 };
    const down = wheelPan(REST, { x: 0, y: 100 }, content, viewport)!;
    expect(down.pan).toEqual({ x: 0, y: -100 });
    // The bottom edge of the drawing is 400px below the viewport's: a big wheel stops there.
    const far = wheelPan(REST, { x: 0, y: 10_000 }, content, viewport)!;
    expect(far.pan.y).toBe(viewport.height - content.height);
    // And from there, further down is nothing — so the canvas around it can scroll instead.
    expect(wheelPan(far, { x: 0, y: 100 }, content, viewport)).toBeUndefined();
    // Up from the top is nothing too.
    expect(wheelPan(REST, { x: 0, y: -100 }, content, viewport)).toBeUndefined();
  });

  it("does not pan a drawing that already fits, so the wheel scrolls on to the group boxes", () => {
    expect(wheelPan(REST, { x: 0, y: 100 }, { width: 300, height: 200 }, { width: 800, height: 600 })).toBeUndefined();
  });

  it("does not yank back a drawing a person dragged off to one side", () => {
    // Dragged 300px right of where it starts: a wheel to the right moves it back towards
    // the edge, a wheel further left has nowhere to go and is let through.
    const dragged: CanvasView = { scale: 1, pan: { x: 300, y: 0 } };
    const content = { width: 2000, height: 600 };
    const viewport = { width: 800, height: 600 };
    expect(wheelPan(dragged, { x: 100, y: 0 }, content, viewport)!.pan.x).toBe(200);
    expect(wheelPan(dragged, { x: -100, y: 0 }, content, viewport)).toBeUndefined();
  });

  it("scales the bounds with the zoom: at a half, a 1000px drawing is 500px of screen", () => {
    const half: CanvasView = { scale: 0.5, pan: { x: 0, y: 0 } };
    expect(wheelPan(half, { x: 0, y: 1000 }, { width: 400, height: 1000 }, { width: 800, height: 300 })!.pan.y).toBe(
      -200,
    );
  });
});

describe("the minimap", () => {
  const box = { width: 160, height: 112 };

  it("scales the whole drawing into the box with its aspect, and centres it", () => {
    // Wide, as a left-to-right graph is: the width binds and the drawing is centred top to bottom.
    const wide = minimapGeometry({ width: 1600, height: 400 }, box);
    expect(wide.scale).toBe(0.1);
    expect(wide.offset).toEqual({ x: 0, y: 36 });
    // Tall, as a top-to-bottom one is: the height binds and it is centred across.
    const tall = minimapGeometry({ width: 400, height: 1120 }, box);
    expect(tall.scale).toBe(0.1);
    expect(tall.offset).toEqual({ x: 60, y: 0 });
    // A node's box, scaled and offset.
    expect(toMinimap(wide, { x: 100, y: 200, width: 200, height: 100 })).toEqual({
      x: 10,
      y: 56,
      width: 20,
      height: 10,
    });
  });

  it("draws what the viewport shows as a rectangle, which moves with the pan and grows with a zoom out", () => {
    const geometry = minimapGeometry({ width: 1600, height: 400 }, box);
    const viewport = { width: 800, height: 600 };
    // At rest the viewport shows the drawing's top-left 800x600.
    expect(visibleRect(REST, viewport)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(toMinimap(geometry, visibleRect(REST, viewport))).toEqual({ x: 0, y: 36, width: 80, height: 60 });
    // Panned 400px left, it shows 400px further right.
    const panned: CanvasView = { scale: 1, pan: { x: -400, y: 0 } };
    expect(toMinimap(geometry, visibleRect(panned, viewport)).x).toBe(40);
    // Zoomed out to a half, it shows twice as much.
    const half: CanvasView = { scale: 0.5, pan: { x: 0, y: 0 } };
    expect(toMinimap(geometry, visibleRect(half, viewport)).width).toBe(160);
  });

  it("turns a click into a pan that centres the view on that point", () => {
    const geometry = minimapGeometry({ width: 1600, height: 400 }, box);
    const viewport = { width: 800, height: 600 };
    const click = { x: 120, y: 56 };
    const world = fromMinimap(geometry, click);
    expect(world).toEqual({ x: 1200, y: 200 });
    // Taking hold of the rectangle's middle and putting it at the click is centring on it.
    const frame = toMinimap(geometry, visibleRect(REST, viewport));
    const pan = panForMinimap(geometry, { x: click.x - frame.width / 2, y: click.y - frame.height / 2 }, 1);
    expect(screenOf({ scale: 1, pan }, world)).toEqual({ x: 400, y: 300 });
    // Which is the same view `centreOn` gives.
    expect(pan).toEqual(centreOn(world, 1, viewport).pan);
  });

  it("turns a drag of the rectangle into a pan of the drag's distance, in the drawing's px", () => {
    const geometry = minimapGeometry({ width: 1600, height: 400 }, box);
    // The rectangle's corner moved 10px right on the minimap: 100px of drawing, at a scale of 1.5
    // that is 150px of screen to the left.
    const before = panForMinimap(geometry, { x: 0, y: 36 }, 1.5);
    const after = panForMinimap(geometry, { x: 10, y: 36 }, 1.5);
    expect(after.x - before.x).toBeCloseTo(-150, 9);
    expect(after.y - before.y).toBe(0);
  });

  it("knows a press inside the rectangle from one outside it", () => {
    const frame = { x: 10, y: 10, width: 40, height: 30 };
    expect(inside({ x: 30, y: 20 }, frame)).toBe(true);
    expect(inside({ x: 60, y: 20 }, frame)).toBe(false);
  });

  it("is centred on nothing for a drawing with no extent, rather than dividing by zero", () => {
    const empty = minimapGeometry({ width: 0, height: 0 }, box);
    expect(empty.scale).toBe(0);
    expect(fromMinimap(empty, { x: 10, y: 10 })).toEqual({ x: 0, y: 0 });
  });
});
