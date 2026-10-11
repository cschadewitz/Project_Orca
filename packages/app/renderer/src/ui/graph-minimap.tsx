/**
 * `GraphMinimap` — the whole of a graph canvas's drawing, small, in the canvas's corner, with
 * a rectangle for the part the canvas is showing. Click in it to centre the view there; drag
 * the rectangle to pan. Not the list's status minimap (`.orca-minimap`), which is a gutter of
 * ticks beside a scroller.
 *
 * **Boxes, not nodes.** Each node is a rectangle in its tone — the run's status where a run is
 * overlaid, the draft's change in the editor, the dependency's state on the plan — and nothing
 * else: no name, no glyph, no edge. A minimap that re-rendered sixteen `WorkflowNode`s at a
 * tenth of their size would be sixteen unreadable nodes; this is a picture of where things are,
 * which is all a person glances at it for. The canvas decides the tones, from the same facts it
 * draws the nodes with, so the minimap never infers a state of its own.
 *
 * **Hidden from assistive technology, on purpose.** The minimap is a pointer convenience: it
 * is a faster way to do what `⇧`-arrows (pan), `+` / `-` / `0` and **Zoom to fit** already do
 * from the keyboard, and what it shows is the canvas's own listbox, which a screen reader
 * already reads node by node, status first. Exposed, it would be a second, unlabelled copy of
 * the graph with no keyboard path of its own — so it is `aria-hidden`, holds no tab stop, and
 * the button that shows and hides it is an ordinary, named control beside it.
 *
 * **It never asks for more than its corner.** Its box is the `minimap-w` × `minimap-h` tokens,
 * on `surface-raised` with a hairline and no shadow ("structure, not shadow"; a menu opened
 * over the canvas must be the one shadow on screen), and the drawing keeps its aspect inside
 * it. Anything it covers is still reachable — the canvas pans under it.
 */
import { useRef, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { GRAPH_GEOMETRY } from "@orca/design";
import {
  inside,
  minimapGeometry,
  panForMinimap,
  toMinimap,
  visibleRect,
  type CanvasView,
  type Point,
  type Rect,
  type Size,
} from "./canvas-view.js";

/**
 * The few tones a box can take: a status where one is known, the editor's change, and two
 * neutrals. Not the eight statuses — a box this size carries a colour and nothing else, and
 * the canvas beside it carries the glyph and the word (rule 4).
 */
export type MinimapTone = "plain" | "strong" | "running" | "waiting" | "failed" | "succeeded" | "faint";

export interface MinimapNode extends Rect {
  id: string;
  tone?: MinimapTone;
  /** The selection: drawn in accent, which is what selection is (rule 5). */
  selected?: boolean;
}

/** The box, in px: the `minimap-w` and `minimap-h` tokens. */
export const MINIMAP_BOX: Size = { width: GRAPH_GEOMETRY["minimap-w"], height: GRAPH_GEOMETRY["minimap-h"] };

export interface GraphMinimapProps {
  /** The drawing's extent in its own px, margin included — the same `content` the canvas fits. */
  content: Size;
  nodes: readonly MinimapNode[];
  view: CanvasView;
  viewport: Size;
  /** Show the drawing at this pan, at the current scale. Called on the press and on every move of a drag. */
  onPan: (pan: Point) => void;
  /** The box. The tokens' size unless a test or the preview says otherwise. */
  box?: Size;
}

export function GraphMinimap({
  content,
  nodes,
  view,
  viewport,
  onPan,
  box = MINIMAP_BOX,
}: GraphMinimapProps): JSX.Element {
  const geometry = minimapGeometry(content, box);
  const frame = toMinimap(geometry, visibleRect(view, viewport));

  /* Where the pointer took hold of the rectangle, from its top-left corner. A drag keeps that
     point under the pointer; a click outside the rectangle takes hold of its middle, which is
     what makes a click "centre the view here". */
  const drag = useRef<{ pointer: number; grab: Point } | null>(null);

  /** A pointer event's position in the box's own px — the viewBox's, whatever it is drawn at. */
  const local = (event: ReactPointerEvent<SVGSVGElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const sx = bounds.width > 0 ? box.width / bounds.width : 1;
    const sy = bounds.height > 0 ? box.height / bounds.height : 1;
    return { x: (event.clientX - bounds.left) * sx, y: (event.clientY - bounds.top) * sy };
  };

  const moveTo = (at: Point, grab: Point) =>
    onPan(panForMinimap(geometry, { x: at.x - grab.x, y: at.y - grab.y }, view.scale));

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const at = local(event);
    const held = inside(at, frame);
    const grab = held ? { x: at.x - frame.x, y: at.y - frame.y } : { x: frame.width / 2, y: frame.height / 2 };
    drag.current = { pointer: event.pointerId, grab };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (!held) moveTo(at, grab);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const held = drag.current;
    if (!held || held.pointer !== event.pointerId) return;
    moveTo(local(event), held.grab);
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="orca-graphmap" aria-hidden="true">
      <svg
        className="orca-graphmap__svg"
        viewBox={`0 0 ${box.width} ${box.height}`}
        focusable="false"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {nodes.map((node) => {
          const at = toMinimap(geometry, node);
          const classes = ["orca-graphmap__node", `orca-graphmap__node--${node.tone ?? "plain"}`];
          if (node.selected) classes.push("orca-graphmap__node--selected");
          return (
            <rect
              key={node.id}
              className={classes.join(" ")}
              data-node={node.id}
              x={at.x}
              y={at.y}
              width={at.width}
              height={at.height}
            />
          );
        })}
        <rect
          className="orca-graphmap__view"
          x={frame.x}
          y={frame.y}
          width={Math.max(0, frame.width)}
          height={Math.max(0, frame.height)}
        />
      </svg>
    </div>
  );
}
