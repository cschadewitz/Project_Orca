/**
 * A draggable boundary between two panes (#276).
 *
 * One component for every boundary in the app, in the shell rather than in each surface, so a
 * surface that lands later inherits a resizable edge instead of inventing one. What it needs
 * from the markup around it is only that it is **a child of the container whose track sizes
 * the pane**, with the pane it sizes as its immediate sibling: the size is written as a custom
 * property on that container (`panes.ts`), and the sibling is what a drag measures from, so a
 * splitter never has to be told a width or handed a ref.
 *
 * Four decisions worth knowing:
 *
 * - **It is a control, so it has a tab stop and keys.** `role="separator"` with
 *   `aria-valuenow`/`aria-valuemin`/`aria-valuemax`, `←`/`→` on a column boundary and `↑`/`↓`
 *   on a stacked one, `Enter` or a double-click to put the boundary back where the design had
 *   it (docs/design/50-accessibility-and-keyboard.md).
 * - **Those arrow keys are not in the `KeyboardMap`**, and that is the same call the `Menu`'s
 *   roving focus made: they belong to the element that has focus, not to the app. There are
 *   two splitters on screen at once in the chrome alone, so one registration per key could
 *   not say which boundary it meant, and the map throws on a second registration in a scope
 *   rather than guess.
 * - **A drag is the pointer's and never React's.** Pointer capture, one `applyPaneSize` per
 *   move, and the size goes into state (and into the preferences file) once, on release. A
 *   `setState` per pointer move would put a render between a finger and a line. `pointerdown`
 *   stops propagating for a second reason: the workflow canvas pans on a drag of its own
 *   (`.orca-wfcanvas__viewport`) and its inspector's splitter is next door to it.
 * - **What is remembered is what a person asked for, not what fitted.** A window too narrow
 *   for the remembered size shows the size the window allows, and widening it again brings
 *   their choice back — so the clamp is re-applied on every container resize and the
 *   preference is left alone (`clampPaneSize`).
 */
import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from "react";
import { useAppearance } from "../appearance-context.js";
import {
  PANE_BOUNDARIES,
  applyPaneSize,
  clampPaneSize,
  dragPaneSize,
  keyPaneSize,
  paneExtent,
  readPaneSize,
  type PaneBoundary,
  type PaneId,
} from "../panes.js";

export interface PaneSplitterProps {
  /** Which boundary this is. Two splitters may share one id: they are then one remembered size. */
  boundary: PaneId;
  /**
   * The separator's accessible name. Written at the call site rather than derived from the id,
   * because it names the two panes a person is trading space between — "Resize the sidebar" —
   * and the workflow inspector and the docked panel share an id but not a sentence.
   */
  label: string;
}

export function PaneSplitter({ boundary, label }: PaneSplitterProps): JSX.Element {
  const appearance = useAppearance();
  const spec = PANE_BOUNDARIES[boundary];
  const handle = useRef<HTMLDivElement>(null);
  /** What a person asked for, `undefined` while the boundary is at the design's default. */
  const [desired, setDesired] = useState<number | undefined>(() => appearance.preferences().panes[boundary]);
  /** The container's extent along the axis: the second ceiling, and it changes with the window. */
  const [extent, setExtent] = useState(0);
  /** What the pane actually measures, which is what `aria-valuenow` has to say. */
  const [now, setNow] = useState(0);

  const container = useCallback((): HTMLElement | null => handle.current?.parentElement ?? null, []);
  /** The pane this boundary sizes: the sibling on the side the registry names. */
  const sized = useCallback((): Element | null => {
    const self = handle.current;
    if (!self) return null;
    return spec.edge === "leading" ? self.previousElementSibling : self.nextElementSibling;
  }, [spec.edge]);

  /**
   * Where the boundary is, in px: the size this splitter has applied, or — while it has applied
   * none, which is a boundary still at the design's default — the pane as it measures on screen.
   * Everything that moves the boundary starts from here, so a drag and an arrow press both
   * continue from where a person can see it rather than from a number in the preferences that
   * the window may not have had room for.
   */
  const current = useCallback((): number => {
    if (desired !== undefined) return clampPaneSize(spec, desired, extent);
    const pane = sized();
    const box = pane?.getBoundingClientRect();
    const px = box === undefined ? 0 : spec.orientation === "vertical" ? box.width : box.height;
    /* A container that has not been laid out measures zero, and so does every container under
       happy-dom; the floor is then the only honest answer there is. */
    return px > 0 ? px : spec.min;
  }, [desired, extent, sized, spec]);

  /* Apply, on mount and whenever the remembered size or the window changes. This is what makes
     a relaunch open at the size a person chose: the property is written the moment the splitter
     is in the document, before anything has been dragged. */
  useEffect(() => {
    const host = container();
    if (!host) return;
    applyPaneSize(host, spec, desired === undefined ? undefined : clampPaneSize(spec, desired, extent));
    setNow(Math.round(current()));
  }, [container, current, desired, extent, spec]);

  /* The container's extent, watched rather than read once: a boundary dragged wide on a maximised
     window must not leave the pane opposite with nothing when the window is made small again. */
  useEffect(() => {
    const host = container();
    if (!host) return;
    const read = () => setExtent(paneExtent(host, spec));
    read();
    const view = host.ownerDocument.defaultView;
    if (!view || typeof view.ResizeObserver !== "function") return;
    const observer = new view.ResizeObserver(read);
    observer.observe(host);
    return () => observer.disconnect();
  }, [container, spec]);

  /** Remember a size, or `null` to forget one and hand the boundary back to its default. */
  const remember = useCallback(
    (size: number | null) => {
      setDesired(size ?? undefined);
      appearance.set({ panes: { [boundary]: size === null ? null : Math.round(size) } });
    },
    [appearance, boundary],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const host = container();
      const self = handle.current;
      if (!host || !self || event.button !== 0) return;
      /* Not a canvas pan, not a text selection, and not a scroll: the gesture is this
         boundary's from the moment it starts. */
      event.preventDefault();
      event.stopPropagation();
      /* `preventDefault` on a pointerdown is what stops the canvas and the text selection, and
         it also stops the focus the click would have given: taken back by hand, so that a
         person who dragged a boundary can go on nudging it with the arrows. */
      self.focus({ preventScroll: true });
      self.setPointerCapture(event.pointerId);
      self.setAttribute("data-dragging", "");

      const start = spec.orientation === "vertical" ? event.clientX : event.clientY;
      const startSize = current();
      const span = paneExtent(host, spec);
      let frame = 0;
      let latest = startSize;
      let moved = false;

      const move = (e: globalThis.PointerEvent) => {
        const at = spec.orientation === "vertical" ? e.clientX : e.clientY;
        latest = dragPaneSize(spec, startSize, at - start, span);
        if (latest !== startSize) moved = true;
        /* One write per frame, and no React in the loop: a pointer can fire faster than the
           compositor and the only thing that has to keep up is the custom property. */
        if (frame !== 0) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          applyPaneSize(host, spec, latest);
        });
      };

      const end = () => {
        self.removeEventListener("pointermove", move);
        self.removeEventListener("pointerup", end);
        self.removeEventListener("pointercancel", end);
        if (frame !== 0) cancelAnimationFrame(frame);
        self.removeAttribute("data-dragging");
        /* A click that went nowhere is not a resize, and must not become one: remembering the
           size a boundary already had would turn a default into a choice, and freeze the pane
           against the next change to the token behind it. */
        if (!moved) {
          applyPaneSize(host, spec, desired === undefined ? undefined : clampPaneSize(spec, desired, span));
          return;
        }
        applyPaneSize(host, spec, latest);
        // Now, and only now, does the size become state and reach the preferences file.
        remember(readPaneSize(host, spec) ?? latest);
      };

      self.addEventListener("pointermove", move);
      self.addEventListener("pointerup", end);
      self.addEventListener("pointercancel", end);
    },
    [container, current, desired, remember, spec],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      /* Enter is the keyboard's double-click: back to the default, which is the one thing a
         person cannot reach by dragging because the default is not a number they can land on. */
      if (event.key === "Enter") {
        event.preventDefault();
        remember(null);
        return;
      }
      const next = keyPaneSize(spec, event.key, current(), extent);
      if (next === undefined) return;
      event.preventDefault();
      remember(next);
    },
    [current, extent, remember, spec],
  );

  return (
    <div
      ref={handle}
      className="orca-splitter"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={spec.orientation}
      aria-valuenow={now}
      aria-valuemin={spec.min}
      aria-valuemax={ceiling(spec, extent)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => remember(null)}
    />
  );
}

/** The widest this boundary may go right now: the design's ceiling, or the window's. */
function ceiling(spec: PaneBoundary, extent: number): number {
  const room = extent > 0 ? extent - spec.min : undefined;
  if (spec.max === undefined) return room ?? spec.min;
  return room === undefined ? spec.max : Math.max(spec.min, Math.min(spec.max, room));
}
