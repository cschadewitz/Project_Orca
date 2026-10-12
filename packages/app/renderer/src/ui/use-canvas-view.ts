/// <reference lib="dom" />
/**
 * One graph canvas's zoom and pan, and every way of changing them: the keys, the controls'
 * buttons, a ⌘/Ctrl wheel or a pinch, a plain wheel, a drag and the minimap.
 *
 * **One state, many hands.** The keys used to be the only way to zoom, and each of the three
 * canvases held its own `useState` for it. Buttons that held a second one would
 * be two zooms that disagree the moment one of them is used, so the state lives here, the
 * keys are registered here, and the buttons, the wheel and the minimap call the same four
 * actions the keys do. A canvas hands the controls `zoomIn` — it never re-implements it.
 *
 * **The keys are the map's**, registered in the canvas's own scope (`workflow`,
 * `workflow-edit`, `plan-graph`) through a ref, so a canvas that re-renders on every push does
 * not unregister and re-register them on each frame — the reason `useListKeys` does the same.
 * `+`, `-` and `0` keep the meaning the keyboard table gives them, `0` included: it is *rest*,
 * 100% and no pan. **Zoom to fit** is the other meaning a reset could have had, and it is a
 * button and a keyless palette command (#205) rather than a key: the table is deliberately
 * short, and fit is one press of a visible control away.
 *
 * **The wheel listener is the DOM's, not React's.** React attaches `wheel` as a passive
 * listener, so a handler there cannot `preventDefault` — and a ⌘/Ctrl wheel that is not
 * prevented zooms the whole Electron window instead of the canvas.
 *
 * **Measured, but injectable.** The viewport's size decides where "the middle" is and what
 * fit means. It is read off the element and re-read when it resizes; a test injects it,
 * because happy-dom has no layout and measures everything as zero — `Menu`'s measurer is the
 * precedent. Unmeasured, the middle is the top-left corner and fit is rest, which is exactly
 * what the canvas did before it could be measured at all.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PANE_GEOMETRY } from "@orca/design";
import { useKeyboard } from "../keyboard-context.js";
import type { ShortcutScope } from "../keyboard-map.js";
import {
  REST,
  canZoom,
  centreOf,
  fitView,
  nextStop,
  wheelPan,
  wheelPixels,
  wheelZoomFactor,
  zoomAt,
  type CanvasView,
  type Point,
  type Size,
} from "./canvas-view.js";

/** How a canvas learns its viewport's size. The default reads the element; a test passes numbers. */
export type ViewportMeasurer = (viewport: HTMLElement) => Size;

const measureElement: ViewportMeasurer = (viewport) => ({ width: viewport.clientWidth, height: viewport.clientHeight });

const UNMEASURED: Size = { width: 0, height: 0 };

/** A wheel "line" in px: one grid step, which is what a pane boundary moves by too. */
const LINE = PANE_GEOMETRY["pane-step"];

export interface CanvasViewOptions {
  /** The keyboard scope the canvas owns, where `+`, `-`, `0` and the pans are registered. */
  scope: ShortcutScope;
  /** The drawing's extent in its own px, margin included: what fit fits and a wheel scrolls over. */
  content: Size;
  /** How far one ⇧-arrow press pans, in screen px. */
  panStep: number;
  measure?: ViewportMeasurer | undefined;
}

export interface CanvasViewHandle {
  /** Put on the viewport: the element that clips the scene and takes the wheel. */
  ref: (element: HTMLDivElement | null) => void;
  view: CanvasView;
  viewport: Size;
  /** The scene's `transform`, in the one spelling every canvas and test reads. */
  transform: string;
  /**
   * Whether the last change was a step — a key, a button, a click in the minimap — that the
   * scene eases into, rather than a gesture tracking a pointer, which must never lag it.
   */
  eased: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Rest: 100% and no pan, which is `0`. */
  rest: () => void;
  /** The whole drawing, centred, at up to 100%. */
  fit: () => void;
  /** Move the scene by a screen delta, following a pointer. */
  panBy: (dx: number, dy: number) => void;
  /** Show this pan outright at the current scale, following a pointer — the minimap's drag. */
  panTo: (pan: Point) => void;
}

export function useCanvasView({
  scope,
  content,
  panStep,
  measure = measureElement,
}: CanvasViewOptions): CanvasViewHandle {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ view: CanvasView; eased: boolean }>({ view: REST, eased: false });
  const [viewport, setViewport] = useState<Size>(UNMEASURED);

  /* What the handlers read. Kept current on every render *and* on every commit, because two
     wheel events can arrive before React has rendered the first one's result, and the second
     must zoom from where the first left the view rather than from where the last render did. */
  const latest = useRef({ view: state.view, viewport, content, panStep });
  latest.current = { ...latest.current, viewport, content, panStep };

  const commit = useCallback((view: CanvasView, eased: boolean) => {
    latest.current.view = view;
    setState({ view, eased });
  }, []);

  /* ---------- measuring ---------- */

  const measured = useRef(measure);
  measured.current = measure;
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => {
      const next = measured.current(element);
      setViewport((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    read();
    const view = element.ownerDocument.defaultView;
    // Optional, as the list substrate's is: a DOM with no layout engine has none.
    const resize = view && typeof view.ResizeObserver === "function" ? new view.ResizeObserver(read) : undefined;
    resize?.observe(element);
    return () => resize?.disconnect();
  }, [element]);

  /* ---------- the actions ---------- */

  const zoomBy = useCallback(
    (way: 1 | -1) => {
      const { view, viewport: size } = latest.current;
      commit(zoomAt(view, nextStop(view.scale, way), centreOf(size)), true);
    },
    [commit],
  );
  const zoomIn = useCallback(() => zoomBy(1), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(-1), [zoomBy]);
  const rest = useCallback(() => commit(REST, true), [commit]);
  const fit = useCallback(() => commit(fitView(latest.current.content, latest.current.viewport), true), [commit]);
  const panBy = useCallback(
    (dx: number, dy: number) => {
      const { view } = latest.current;
      commit({ scale: view.scale, pan: { x: view.pan.x + dx, y: view.pan.y + dy } }, false);
    },
    [commit],
  );
  const panTo = useCallback((pan: Point) => commit({ scale: latest.current.view.scale, pan }, false), [commit]);
  /** A ⇧-arrow: a step, so it eases like the other keys do. */
  const step = useCallback(
    (dx: number, dy: number) => {
      const { view } = latest.current;
      commit({ scale: view.scale, pan: { x: view.pan.x + dx, y: view.pan.y + dy } }, true);
    },
    [commit],
  );

  /* ---------- the keys ---------- */

  const keyboard = useKeyboard();
  const actions = useRef({ zoomIn, zoomOut, rest, fit, step });
  actions.current = { zoomIn, zoomOut, rest, fit, step };
  useEffect(() => {
    const pan = () => latest.current.panStep;
    const registrations = [
      { key: "+", label: "Zoom in", action: () => actions.current.zoomIn() },
      { key: "-", label: "Zoom out", action: () => actions.current.zoomOut() },
      { key: "0", label: "Reset the zoom and the pan", action: () => actions.current.rest() },
      { key: "Shift+ArrowRight", label: "Pan right", action: () => actions.current.step(-pan(), 0) },
      { key: "Shift+ArrowLeft", label: "Pan left", action: () => actions.current.step(pan(), 0) },
      { key: "Shift+ArrowDown", label: "Pan down", action: () => actions.current.step(0, -pan()) },
      { key: "Shift+ArrowUp", label: "Pan up", action: () => actions.current.step(0, pan()) },
      {
        label: "Zoom to fit the whole graph",
        detail: "Show every node at once, at up to 100%. 0 goes back to 100% where the graph starts.",
        action: () => actions.current.fit(),
      },
    ].map((shortcut) => keyboard.register({ scope, ...shortcut }));
    return () => registrations.forEach((unregister) => unregister());
  }, [keyboard, scope]);

  /* ---------- the wheel ---------- */

  useEffect(() => {
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const { view, viewport: size, content: extent } = latest.current;
      /* ⌘ on macOS, Ctrl elsewhere — the map's `Mod` — and Ctrl on macOS too, because that is
         how Chromium reports a trackpad pinch. Always prevented: an unprevented one zooms the
         window. */
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const box = element.getBoundingClientRect();
        const at = { x: event.clientX - box.left, y: event.clientY - box.top };
        const delta = wheelPixels(event.deltaY, event.deltaMode, size.height, LINE);
        commit(zoomAt(view, view.scale * wheelZoomFactor(delta), at), false);
        return;
      }
      let dx = wheelPixels(event.deltaX, event.deltaMode, size.width, LINE);
      let dy = wheelPixels(event.deltaY, event.deltaMode, size.height, LINE);
      // ⇧ and a mouse wheel is a sideways scroll on Windows and Linux, where nothing turns it into deltaX.
      if (event.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      const next = wheelPan(view, { x: dx, y: dy }, extent, size);
      // Nowhere further to go: let the canvas around the drawing scroll on, to the group boxes.
      if (!next) return;
      event.preventDefault();
      commit(next, false);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [element, commit]);

  const { view } = state;
  return {
    ref: setElement,
    view,
    viewport,
    transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.scale})`,
    eased: state.eased,
    canZoomIn: canZoom(view.scale, 1),
    canZoomOut: canZoom(view.scale, -1),
    zoomIn,
    zoomOut,
    rest,
    fit,
    panBy,
    panTo,
  };
}
