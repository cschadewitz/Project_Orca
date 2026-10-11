/**
 * The editor's canvas (#181): the viewer's canvas with hands.
 *
 * - **Drag a node** to move it. The drop is a `place` operation on the draft's layout, never a
 *   change to the workflow file; a node nobody has dragged stays where the automatic layout
 *   puts it, and Tidy hands every node back to it.
 * - **Drag from a node's port** (the dot on its right edge) onto another node to connect them.
 * - **Drop a palette item** on empty canvas to add a node there, or onto an edge to put the
 *   new node in the middle of it - `from → new → to`.
 * - **Click an edge** to select it; the inspector edits its condition and label.
 *
 * Every gesture has a keyboard path through the same operations (`workflow-edit` scope, and
 * the palette and inspector for the rest), so nothing here is reachable by pointer alone.
 *
 * The drawing is the viewer's - `.orca-node` boxes over one SVG of `.orca-edge` paths - with
 * the design system's draft states on top: added, changed and removed nodes, new edges dashed
 * in accent, and errors on the box that has them.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GRAPH_GEOMETRY } from "@orca/design";
import type { DraftGraphPath, DraftIssue, DraftLayout } from "@orca/protocol";
import { useKeyboard } from "../../keyboard-context.js";
import { scopeProps } from "../../keyboard-map.js";
import { WorkflowNode, asNodeType, textClass } from "../../ui/index.js";
import type { GraphMetrics } from "../layout.js";
import { editorLayout, nestedSteps, type EditorGraph, type PlacedEditorNode } from "./draft-model.js";

const METRICS: GraphMetrics = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};
const PAD = METRICS.rankGap;
const ZOOMS = [0.5, 0.75, 1, 1.5, 2];
const DEFAULT_ZOOM = ZOOMS.indexOf(1);
const PAN_STEP = METRICS.nodeW + METRICS.layerGap;
/** A press that moves less than this is a click, not a drag: half a rank gap, in screen pixels. */
const DRAG_THRESHOLD = METRICS.rankGap / 4;

/** The palette's drag payload: the node type being dropped. */
export const NODE_TYPE_MIME = "application/x-orca-workflow-node";

export type EditorSelection = { kind: "node"; id: string } | { kind: "edge"; index: number };

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
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [override, setOverride] = useState<{ id: string; x: number; y: number } | undefined>(undefined);
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<number | "canvas" | undefined>(undefined);
  const scene = useRef<HTMLDivElement>(null);
  const scale = ZOOMS[zoom]!;

  const placed = useMemo(() => editorLayout(graph, layout, path, METRICS, override), [graph, layout, path, override]);

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
      { key: "+", label: "Zoom in", action: () => setZoom((z) => Math.min(z + 1, ZOOMS.length - 1)) },
      { key: "-", label: "Zoom out", action: () => setZoom((z) => Math.max(z - 1, 0)) },
      {
        key: "0",
        label: "Reset the zoom and the pan",
        action: () => {
          setZoom(DEFAULT_ZOOM);
          setPan({ x: 0, y: 0 });
        },
      },
      { key: "Shift+ArrowRight", label: "Pan right", action: () => setPan((p) => ({ ...p, x: p.x - PAN_STEP })) },
      { key: "Shift+ArrowLeft", label: "Pan left", action: () => setPan((p) => ({ ...p, x: p.x + PAN_STEP })) },
      { key: "Shift+ArrowDown", label: "Pan down", action: () => setPan((p) => ({ ...p, y: p.y - PAN_STEP })) },
      { key: "Shift+ArrowUp", label: "Pan up", action: () => setPan((p) => ({ ...p, y: p.y + PAN_STEP })) },
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
  const onViewportPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const from = panning.current;
    if (!from) return;
    setPan((p) => ({ x: p.x + (event.clientX - from.x), y: p.y + (event.clientY - from.y) }));
    panning.current = { x: event.clientX, y: event.clientY };
  }, []);
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
      latest.current.props.onPlace(d.id, x, y);
      // The drop is drawn where it landed until the draft that pins it arrives.
      setOverride({ id: d.id, x, y });
    },
    [scale],
  );
  /* The override is dropped once the layout the daemon sent agrees with it - or the drag
     was refused and the layout never will - which is any new layout at all. */
  useEffect(() => setOverride(undefined), [layout]);

  /* ---------- connecting ---------- */

  const onPortPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>, id: string) => {
      if (event.button !== 0 || readOnly) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setWire({ from: id, ...toLayout(event.clientX, event.clientY) });
    },
    [readOnly, toLayout],
  );
  const onPortPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      setWire((current) => (current ? { ...current, ...toLayout(event.clientX, event.clientY) } : current));
    },
    [toLayout],
  );
  const onPortPointerUp = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setWire((current) => {
      if (current) {
        const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]")
          ?.dataset.nodeId;
        if (target !== undefined && target !== current.from) latest.current.props.onConnect(current.from, target);
      }
      return undefined;
    });
  }, []);

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
        latest.current.props.onAdd(type, {
          x: Math.max(0, at.x - METRICS.nodeW / 2),
          y: Math.max(0, at.y - METRICS.nodeH / 2),
        });
      }
    },
    [readOnly, toLayout],
  );

  /* ---------- drawing ---------- */

  const width = placed.width + PAD * 2;
  const height = placed.height + PAD * 2;
  const selectedNode = selection?.kind === "node" ? selection.id : undefined;
  const wireFrom = wire ? placed.nodes.find((p) => p.node.id === wire.from) : undefined;

  return (
    <div className="orca-wfcanvas orca-wfedit__canvas" {...scopeProps("workflow-edit")}>
      <div
        className={`orca-wfcanvas__viewport${dropTarget === "canvas" ? " orca-wfedit__viewport--drop" : ""}`}
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
          className="orca-wfcanvas__scene orca-wfedit__scene"
          role="presentation"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
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
                        textAnchor="middle"
                      >
                        {text}
                      </text>
                    )}
                  </g>
                );
              })}
              {wire && wireFrom && (
                <path
                  className="orca-edge orca-edge--draft"
                  d={`M ${wireFrom.x + METRICS.nodeW} ${wireFrom.y + METRICS.nodeH / 2} L ${wire.x} ${wire.y}`}
                />
              )}
            </svg>

            {placed.nodes.map((node) => {
              const errors = (issues.byNode.get(node.node.id) ?? []).filter((issue) => issue.severity === "error");
              const flag =
                errors.length > 0
                  ? `${errors.length} ${errors.length === 1 ? "error" : "errors"}`
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
                      onPointerUp={onPortPointerUp}
                      onPointerCancel={onPortPointerUp}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {!readOnly && (
        <p id="orca-wfedit-howto" className="orca-visually-hidden">
          Drag a node to move it, or drag from its right-hand dot to another node to connect them. Drop an item from the
          palette onto the canvas to add it, or onto an edge to insert it there. Delete removes the selection, C
          connects the selected node, F2 renames it.
        </p>
      )}
    </div>
  );
}

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
