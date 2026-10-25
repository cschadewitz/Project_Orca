/**
 * The editor's canvas (#181): the viewer's canvas with hands.
 *
 * - **Drag a node** to move it. The drop is a `place` operation on the draft's layout, never a
 *   change to the workflow file; a node nobody has dragged stays where the automatic layout
 *   puts it, and Tidy hands every node back to it.
 * - **Drag from a node's port** (the dot on its right edge, or its bottom edge when the
 *   layers run top to bottom — the side its edges leave by) onto another node to connect them.
 * - **Drop a palette item** on empty canvas to add a node there, or onto an edge to put the
 *   new node in the middle of it - `from → new → to`.
 * - **Click an edge** to select it; the inspector edits its condition and label.
 *
 * Every gesture has a keyboard path through the same operations (`workflow-edit` scope, and
 * the palette and inspector for the rest), so nothing here is reachable by pointer alone.
 *
 * The drawing is the viewer's - `.orca-node` boxes over one SVG of `.orca-edge` paths - with
 * the design system's draft states on top: added, changed and removed nodes, new edges dashed
 * in accent, and errors on the box that has them. So is the view: zoom and pan are
 * `useCanvasView`'s, the corner holds the same controls and minimap, and the direction is the
 * viewer's own preference (`workflow`), because this is the viewer's canvas with hands. A drop
 * in a turned graph is sent in the horizontal frame the layout record keeps (`draft-model.ts`).
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import { GRAPH_GEOMETRY } from "@orca/design";
import type { DraftGraphPath, DraftIssue, DraftLayout } from "@orca/protocol";
import { useKeyboard } from "../../keyboard-context.js";
import { scopeProps } from "../../keyboard-map.js";
import {
  CanvasControls,
  GraphMinimap,
  WorkflowNode,
  asNodeType,
  textClass,
  useCanvasView,
  useGraphPreferences,
  type MinimapNode,
  type MinimapTone,
  type ViewportMeasurer,
} from "../../ui/index.js";
import { counted } from "../../ui/count.js";
import { fromDirection, labelTransform, type GraphMetrics } from "../layout.js";
import { editorLayout, nestedSteps, type EditorGraph, type PlacedEditorNode } from "./draft-model.js";

const METRICS: GraphMetrics = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};
const PAD = METRICS.rankGap;
const PAN_STEP = METRICS.nodeW + METRICS.layerGap;
/** A press that moves less than this is a click, not a drag: half a rank gap, in screen pixels. */
const DRAG_THRESHOLD = METRICS.rankGap / 4;

/** The palette's drag payload: the node type being dropped. */
export const NODE_TYPE_MIME = "application/x-orca-workflow-node";

export type EditorSelection = { kind: "node"; id: string } | { kind: "edge"; index: number };

export interface CanvasHandle {
  /** Put keyboard focus on the canvas's one tab stop: where Delete, the arrows and ⌘Z are. */
  focus(): void;
}

export interface EditorCanvasProps {
  graph: EditorGraph;
  layout: DraftLayout;
  path: DraftGraphPath;
  issues: { byNode: ReadonlyMap<string, DraftIssue[]>; byEdge: ReadonlyMap<number, DraftIssue[]> };
  selection: EditorSelection | undefined;
  onSelect: (selection: EditorSelection | undefined) => void;
  /** Somebody else's draft, or a daemon that cannot take writes: look, do not touch. */
  readOnly: boolean;
  label: string;
  onPlace: (id: string, x: number, y: number) => void;
  onConnect: (from: string, to: string) => void;
  onAdd: (type: string, at?: { x: number; y: number }) => void;
  onInsert: (type: string, edgeIndex: number) => void;
  onDelete: (detach: boolean) => void;
  onOpenNested: (nodeId: string) => void;
  onRename: () => void;
  onConnectMenu: () => void;
  onAddMenu: () => void;
  onReorder: (delta: -1 | 1) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** How the viewport is measured. The document by default; a test injects a size. */
  measure?: ViewportMeasurer;
  /** The editor's hold on the canvas: where it puts focus after a delete from the inspector. */
  ref?: Ref<CanvasHandle>;
}

interface Drag {
  id: string;
  pointer: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

export function EditorCanvas(props: EditorCanvasProps): JSX.Element {
  const { graph, layout, path, issues, selection, onSelect, readOnly, label } = props;
  const graphView = useGraphPreferences("workflow", "workflow-edit");
  const { direction } = graphView;
  const [override, setOverride] = useState<{ id: string; x: number; y: number } | undefined>(undefined);
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | undefined>(undefined);
  // Gesture ownership is consumed synchronously; React may replay state updaters.
  const activeWire = useRef<{ from: string; pointer: number; path: DraftGraphPath } | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<number | "canvas" | undefined>(undefined);
  const scene = useRef<HTMLDivElement>(null);

  const placed = useMemo(
    () => editorLayout(graph, layout, path, METRICS, override, direction),
    [graph, layout, path, override, direction],
  );
  const content = useMemo(
    () => ({ width: placed.width + PAD * 2, height: placed.height + PAD * 2 }),
    [placed.width, placed.height],
  );
  const canvas = useCanvasView({ scope: "workflow-edit", content, panStep: PAN_STEP, measure: props.measure });
  const scale = canvas.view.scale;
  /* The viewport is the canvas view's (it measures and clips it) and the editor's focus target
     after a delete from the inspector, so one stable ref feeds both. */
  const viewport = useRef<HTMLDivElement | null>(null);
  const { ref: viewRef } = canvas;
  const viewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      viewport.current = element;
      viewRef(element);
    },
    [viewRef],
  );
  useImperativeHandle(props.ref, () => ({ focus: () => viewport.current?.focus() }), []);
  // Turning the graph puts the view back at rest, as on the viewer.
  const { rest, panBy } = canvas;
  const turned = useRef(direction);
  useEffect(() => {
    if (turned.current === direction) return;
    turned.current = direction;
    rest();
  }, [direction, rest]);
  /** A drawn point, in the horizontal frame the layout record keeps its pins in. */
  const kept = useCallback((at: { x: number; y: number }) => fromDirection(at, direction, METRICS), [direction]);

  /** A client point in layout units: through the pan, the zoom and the drawing's margin. */
  const toLayout = useCallback(
    (clientX: number, clientY: number) => {
      const rect = scene.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left) / scale - PAD, y: (clientY - rect.top) / scale - PAD };
    },
    [scale],
  );

  /* ---------- keys ---------- */

  const move = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const nodes = placed.nodes.filter((p) => p.node.state !== "removed");
      const from = selection?.kind === "node" ? nodes.find((p) => p.node.id === selection.id) : undefined;
      if (!from) {
        const first = nodes.find((p) => p.node.id === graph.start) ?? nodes[0];
        if (first) onSelect({ kind: "node", id: first.node.id });
        return;
      }
      const next = nearest(nodes, from, direction);
      if (next) onSelect({ kind: "node", id: next.node.id });
    },
    [placed, selection, graph.start, onSelect],
  );

  const keyboard = useKeyboard();
  const latest = useRef({ props, move, selection, readOnly });
  latest.current = { props, move, selection, readOnly };

  useEffect(() => {
    const writes = (action: () => void) => () => {
      if (!latest.current.readOnly) action();
    };
    const selectedNode = () => {
      const s = latest.current.selection;
      return s?.kind === "node" ? s.id : undefined;
    };
    const registrations = [
      { key: "ArrowDown", label: "Select the node below", action: () => latest.current.move("down") },
      { key: "ArrowUp", label: "Select the node above", action: () => latest.current.move("up") },
      { key: "ArrowRight", label: "Select the node to the right", action: () => latest.current.move("right") },
      { key: "ArrowLeft", label: "Select the node to the left", action: () => latest.current.move("left") },
      {
        key: "Enter",
        label: "Open the selected container's inside",
        action: () => {
          const id = selectedNode();
          if (id !== undefined) latest.current.props.onOpenNested(id);
        },
      },
      {
        key: "Delete",
        label: "Delete the selected node or edge",
        action: writes(() => latest.current.props.onDelete(false)),
      },
      {
        key: "Backspace",
        label: "Delete the selected node or edge",
        action: writes(() => latest.current.props.onDelete(false)),
      },
      {
        key: "Shift+Delete",
        label: "Delete the selected node and its connections",
        action: writes(() => latest.current.props.onDelete(true)),
      },
      { key: "F2", label: "Rename the selected node", action: writes(() => latest.current.props.onRename()) },
      {
        key: "C",
        label: "Connect the selected node to another",
        action: writes(() => latest.current.props.onConnectMenu()),
      },
      {
        key: "Mod+Enter",
        label: "Add a node after the selected one",
        action: writes(() => latest.current.props.onAddMenu()),
      },
      {
        key: "Alt+ArrowUp",
        label: "Move the selected node up the list",
        action: writes(() => latest.current.props.onReorder(-1)),
      },
      {
        key: "Alt+ArrowDown",
        label: "Move the selected node down the list",
        action: writes(() => latest.current.props.onReorder(1)),
      },
      { key: "Mod+Z", label: "Undo", action: writes(() => latest.current.props.onUndo()) },
      { key: "Mod+Shift+Z", label: "Redo", action: writes(() => latest.current.props.onRedo()) },
      // Zoom and pan — `+`, `-`, `0` and the shifted arrows — are `useCanvasView`'s, in this scope.
    ].map((shortcut) => keyboard.register({ scope: "workflow-edit", ...shortcut }));
    return () => registrations.forEach((unregister) => unregister());
  }, [keyboard]);

  /* ---------- panning the empty canvas ---------- */

  const panning = useRef<{ x: number; y: number } | null>(null);
  const onViewportPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget && event.target !== scene.current) return;
      panning.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      onSelect(undefined);
    },
    [onSelect],
  );
  const onViewportPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const from = panning.current;
      if (!from) return;
      panBy(event.clientX - from.x, event.clientY - from.y);
      panning.current = { x: event.clientX, y: event.clientY };
    },
    [panBy],
  );
  const onViewportPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    panning.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  /* ---------- dragging a node ---------- */

  const drag = useRef<Drag | null>(null);
  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: PlacedEditorNode) => {
      if (event.button !== 0 || readOnly || node.node.state === "removed") return;
      drag.current = {
        id: node.node.id,
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.x,
        originY: node.y,
        moved: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [readOnly],
  );
  const onNodePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.pointer !== event.pointerId) return;
      const dx = event.clientX - d.startX;
      const dy = event.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.moved = true;
      setOverride({ id: d.id, x: Math.max(0, d.originX + dx / scale), y: Math.max(0, d.originY + dy / scale) });
    },
    [scale],
  );
  const onNodePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
      if (!d || !d.moved) return;
      const x = Math.max(0, d.originX + (event.clientX - d.startX) / scale);
      const y = Math.max(0, d.originY + (event.clientY - d.startY) / scale);
      // Sent in the frame the layout record keeps; drawn where it landed until the draft that pins it arrives.
      const pin = kept({ x, y });
      latest.current.props.onPlace(d.id, pin.x, pin.y);
      setOverride({ id: d.id, x, y });
    },
    [scale, kept],
  );
  /* The override is dropped once the layout the daemon sent agrees with it - or the drag
     was refused and the layout never will - which is any new layout at all. */
  useEffect(() => setOverride(undefined), [layout]);

  /* ---------- connecting ---------- */

  const onPortPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>, id: string) => {
      if (event.button !== 0 || readOnly) return;
      event.stopPropagation();
      if (activeWire.current) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      activeWire.current = { from: id, pointer: event.pointerId, path };
      setWire({ from: id, ...toLayout(event.clientX, event.clientY) });
    },
    [readOnly, toLayout, path],
  );
  const onPortPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      if (activeWire.current?.pointer !== event.pointerId) return;
      const point = toLayout(event.clientX, event.clientY);
      setWire((current) => (current ? { ...current, ...point } : current));
    },
    [toLayout],
  );
  const finishWire = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const current = activeWire.current;
    if (!current || current.pointer !== event.pointerId) return;
    activeWire.current = undefined;
    setWire(undefined);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const latestProps = latest.current.props;
    if (event.type !== "pointerup" || latestProps.readOnly || current.path !== latestProps.path) return;
    const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]")
      ?.dataset.nodeId;
    if (target !== undefined && target !== current.from) latestProps.onConnect(current.from, target);
  }, []);

  useEffect(() => {
    activeWire.current = undefined;
    setWire(undefined);
  }, [readOnly, path]);

  /* ---------- dropping from the palette ---------- */

  const carries = (event: ReactDragEvent) => Array.from(event.dataTransfer?.types ?? []).includes(NODE_TYPE_MIME);
  const edgeUnder = (target: EventTarget | null): number | undefined => {
    const index = (target as Element | null)?.closest?.("[data-edge-index]")?.getAttribute("data-edge-index");
    return index === null || index === undefined ? undefined : Number(index);
  };
  const onDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (readOnly || !carries(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropTarget(edgeUnder(event.target) ?? "canvas");
    },
    [readOnly],
  );
  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      setDropTarget(undefined);
      if (readOnly || !carries(event)) return;
      event.preventDefault();
      const type = event.dataTransfer.getData(NODE_TYPE_MIME);
      if (!type) return;
      const edge = edgeUnder(event.target);
      if (edge !== undefined) latest.current.props.onInsert(type, edge);
      else {
        const at = toLayout(event.clientX, event.clientY);
        latest.current.props.onAdd(
          type,
          kept({ x: Math.max(0, at.x - METRICS.nodeW / 2), y: Math.max(0, at.y - METRICS.nodeH / 2) }),
        );
      }
    },
    [readOnly, toLayout, kept],
  );

  /* ---------- drawing ---------- */

  const { width, height } = content;
  const selectedNode = selection?.kind === "node" ? selection.id : undefined;
  const wireFrom = wire ? placed.nodes.find((p) => p.node.id === wire.from) : undefined;
  /* The port is on the side a node's edges leave by — right, or bottom when the layers run
     top to bottom — so the wire being drawn starts where the edge it becomes will. */
  const portAt = (node: PlacedEditorNode): { x: number; y: number } =>
    direction === "vertical"
      ? { x: node.x + METRICS.nodeW / 2, y: node.y + METRICS.nodeH }
      : { x: node.x + METRICS.nodeW, y: node.y + METRICS.nodeH / 2 };
  const wireStart = wireFrom ? portAt(wireFrom) : undefined;

  /* The minimap's boxes: the draft's change on each node, as the canvas draws it. */
  const overview: MinimapNode[] = placed.nodes.map((node) => ({
    id: node.node.id,
    x: node.x + PAD,
    y: node.y + PAD,
    width: METRICS.nodeW,
    height: METRICS.nodeH,
    tone: issues.byNode.get(node.node.id)?.some((issue) => issue.severity === "error")
      ? "failed"
      : DRAFT_TONE[node.node.state ?? "unchanged"],
    selected: node.node.id === selectedNode,
  }));

  return (
    <div className="orca-wfcanvas orca-wfedit__canvas" data-direction={direction}>
      <div className="orca-wfcanvas__stage">
        <div
          ref={viewportRef}
          className={`orca-wfcanvas__viewport${dropTarget === "canvas" ? " orca-wfedit__viewport--drop" : ""}`}
          {...scopeProps("workflow-edit")}
          role="listbox"
          aria-label={label}
          aria-describedby={readOnly ? undefined : "orca-wfedit-howto"}
          {...(selectedNode !== undefined && placed.nodes.some((p) => p.node.id === selectedNode)
            ? { "aria-activedescendant": editorNodeDomId(selectedNode) }
            : {})}
          tabIndex={0}
          onPointerDown={onViewportPointerDown}
          onPointerMove={onViewportPointerMove}
          onPointerUp={onViewportPointerUp}
          onPointerCancel={onViewportPointerUp}
          onDragOver={onDragOver}
          onDragLeave={() => setDropTarget(undefined)}
          onDrop={onDrop}
        >
          <div
            ref={scene}
            className={`orca-wfcanvas__scene orca-wfedit__scene${canvas.eased ? " orca-wfcanvas__scene--eased" : ""}`}
            role="presentation"
            style={{ transform: canvas.transform }}
          >
            <div
              className="orca-wfcanvas__plane"
              role="presentation"
              style={{ width: `${width}px`, height: `${height}px` }}
            >
              <svg
                className="orca-wfcanvas__edges"
                viewBox={`${-PAD} ${-PAD} ${width} ${height}`}
                width={width}
                height={height}
                aria-hidden="true"
                focusable="false"
              >
                {placed.edges.map((edge) => {
                  const classes = ["orca-edge"];
                  if (edge.isBack) classes.push("orca-edge--back");
                  if (edge.edge.added) classes.push("orca-edge--draft");
                  if (issues.byEdge.has(edge.edge.index)) classes.push("orca-wfedit__edge--invalid");
                  if (selection?.kind === "edge" && selection.index === edge.edge.index)
                    classes.push("orca-wfedit__edge--selected");
                  if (dropTarget === edge.edge.index) classes.push("orca-wfedit__edge--drop");
                  const text = edge.edge.label ?? edge.edge.when;
                  return (
                    <g key={edge.key}>
                      <path className={classes.join(" ")} d={edge.path} />
                      <path
                        className="orca-wfedit__hit"
                        d={edge.path}
                        data-edge-index={edge.edge.index}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => onSelect({ kind: "edge", index: edge.edge.index })}
                      />
                      {text !== undefined && (
                        <text
                          className={`orca-edge__label ${textClass("mono-id")}`}
                          x={edge.labelX}
                          y={edge.labelY}
                          transform={labelTransform(edge)}
                          textAnchor="middle"
                        >
                          {text}
                        </text>
                      )}
                    </g>
                  );
                })}
                {wire && wireStart && (
                  <path
                    className="orca-edge orca-edge--draft"
                    d={`M ${wireStart.x} ${wireStart.y} L ${wire.x} ${wire.y}`}
                  />
                )}
              </svg>

              {placed.nodes.map((node) => {
                const errors = (issues.byNode.get(node.node.id) ?? []).filter((issue) => issue.severity === "error");
                const flag =
                  errors.length > 0
                    ? counted(errors.length, "error")
                    : node.node.id === graph.start
                      ? "start"
                      : node.pinned
                        ? "pinned"
                        : undefined;
                const inner = nestedSteps(node.node);
                return (
                  <div
                    key={node.node.id}
                    className={`orca-wfcanvas__box orca-wfedit__box${readOnly || node.node.state === "removed" ? "" : " orca-wfedit__box--movable"}`}
                    role="presentation"
                    data-node-id={node.node.id}
                    style={{ left: `${node.x + PAD}px`, top: `${node.y + PAD}px` }}
                    onPointerDown={(event) => onNodePointerDown(event, node)}
                    onPointerMove={onNodePointerMove}
                    onPointerUp={onNodePointerUp}
                    onPointerCancel={onNodePointerUp}
                    onDoubleClick={() => inner.length > 0 && props.onOpenNested(node.node.id)}
                  >
                    <WorkflowNode
                      id={editorNodeDomId(node.node.id)}
                      type={asNodeType(node.node.type)}
                      typeLabel={node.node.type}
                      name={node.node.name ?? node.node.id}
                      selected={node.node.id === selectedNode}
                      {...(node.node.state ? { draft: node.node.state } : {})}
                      {...(errors.length > 0 ? { invalid: true } : {})}
                      {...(flag !== undefined ? { flag } : {})}
                      {...(inner.length > 0 ? { collapsed: `${inner.length} inside — double-click to open` } : {})}
                      onOpen={() => onSelect({ kind: "node", id: node.node.id })}
                    />
                    {!readOnly && node.node.state !== "removed" && node.node.type !== "end" && (
                      <span
                        className={`orca-port orca-wfedit__port${wire?.from === node.node.id ? " orca-port--armed" : ""}`}
                        role="presentation"
                        title="Drag to another node to connect"
                        onPointerDown={(event) => onPortPointerDown(event, node.node.id)}
                        onPointerMove={onPortPointerMove}
                        onPointerUp={finishWire}
                        onPointerCancel={finishWire}
                        onLostPointerCapture={finishWire}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="orca-wfcanvas__corner">
          {graphView.minimap && (
            <GraphMinimap
              content={content}
              nodes={overview}
              view={canvas.view}
              viewport={canvas.viewport}
              onPan={canvas.panTo}
            />
          )}
          <CanvasControls
            label={`${label} view`}
            scale={canvas.view.scale}
            onZoomIn={canvas.zoomIn}
            onZoomOut={canvas.zoomOut}
            onRest={canvas.rest}
            onFit={canvas.fit}
            direction={direction}
            onToggleDirection={graphView.toggleDirection}
            minimap={graphView.minimap}
            onToggleMinimap={graphView.toggleMinimap}
          />
        </div>
      </div>
      {!readOnly && (
        <p id="orca-wfedit-howto" className="orca-visually-hidden">
          {`Drag a node to move it, or drag from its ${direction === "vertical" ? "bottom" : "right-hand"} dot to another node to connect them. Drop an item from the palette onto the canvas to add it, or onto an edge to insert it there. Delete removes the selection, C connects the selected node, F2 renames it.`}
        </p>
      )}
    </div>
  );
}

/**
 * A node's tone in the minimap, from the draft's change at it — the same states the canvas
 * draws: added in the success colour, removed faint, changed emphasised. A node with errors is
 * failed whatever its change, as its box on the canvas is.
 */
const DRAFT_TONE: Record<NonNullable<PlacedEditorNode["node"]["state"]> | "unchanged", MinimapTone> = {
  unchanged: "plain",
  added: "succeeded",
  changed: "strong",
  removed: "faint",
};

/** The DOM id of a node's box in the editor. Its own prefix: the viewer may be mounted beside it. */
export const editorNodeDomId = (nodeId: string): string => `orca-wfedit-node-${nodeId}`;

/** The node nearest `from` in `direction`, by where the boxes are drawn. */
function nearest(
  nodes: readonly PlacedEditorNode[],
  from: PlacedEditorNode,
  direction: "up" | "down" | "left" | "right",
): PlacedEditorNode | undefined {
  const ahead = nodes.filter((p) => {
    if (p === from) return false;
    if (direction === "right") return p.x > from.x;
    if (direction === "left") return p.x < from.x;
    if (direction === "down") return p.y > from.y;
    return p.y < from.y;
  });
  const along = direction === "left" || direction === "right" ? "x" : "y";
  const across = along === "x" ? "y" : "x";
  return ahead.reduce<PlacedEditorNode | undefined>((best, p) => {
    const score = (q: PlacedEditorNode) => Math.abs(q[along] - from[along]) + 2 * Math.abs(q[across] - from[across]);
    return best === undefined || score(p) < score(best) ? p : best;
  }, undefined);
}
