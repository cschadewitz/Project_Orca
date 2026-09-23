/**
 * The dependency graph's canvas (#171): the derived layout drawn, panned, zoomed and selected
 * on, and never dragged — the workflow canvas's contract (`workflow/workflow-canvas.tsx`) over
 * the plan's dependencies.
 *
 * - **Layout is `layoutGraph`**, the workflow layout generalised to a plain graph with many
 *   roots. No dagre, no ELK: the app's dependencies stay what they were (ADR 0008).
 * - **Edges are SVG, nodes are HTML**, as on the workflow canvas. An edge's kind is its stroke
 *   and its state its colour (`.orca-dep-edge--*`); an edge on a `blocks` cycle is heavier
 *   and coloured as a failure, since nothing on it can ever start.
 * - **One tab stop, `aria-activedescendant`**, and the keys in their own `plan-graph` scope:
 *   `↑`/`↓` within a layer, `←`/`→` across, `+`/`-`/`0` zoom, `⇧` with an arrow pans,
 *   `Enter` opens the relationships in the dock. Registered once, here.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GRAPH_GEOMETRY } from "@orca/design";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import { DependencyNode, textClass } from "../ui/index.js";
import { layoutGraph, type GraphMetrics, type PlacedNode } from "../workflow/layout.js";
import { edgeState, type DepEdge, type DepNode } from "./graph-model.js";

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

export const depNodeDomId = (id: string): string => `orca-depnode-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export interface DependencyGraphProps {
  nodes: readonly DepNode[];
  edges: readonly DepEdge[];
  /** Dependency ids on a `blocks` cycle (`cycleDependencies`). */
  cycle: ReadonlySet<string>;
  selected: string | undefined;
  onSelect: (nodeId: string) => void;
  /** `Enter` on the selection: show its relationships. */
  onOpen: (nodeId: string) => void;
}

type Direction = "up" | "down" | "left" | "right";

export function DependencyGraph({
  nodes,
  edges,
  cycle,
  selected,
  onSelect,
  onOpen,
}: DependencyGraphProps): JSX.Element {
  const layout = useMemo(() => layoutGraph({ nodes, edges }, METRICS), [nodes, edges]);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const onCycle = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of edges) {
      if (!cycle.has(edge.dependency.id)) continue;
      ids.add(edge.from);
      ids.add(edge.to);
    }
    return ids;
  }, [edges, cycle]);

  const move = useCallback(
    (direction: Direction) => {
      const from = layout.nodes.find((placed) => placed.node.id === selected);
      if (!from) {
        const first = layout.nodes[0];
        if (first) onSelect(first.node.id);
        return;
      }
      const next = step(layout.nodes, from, direction);
      if (next) onSelect(next.node.id);
    },
    [layout, selected, onSelect],
  );

  const keyboard = useKeyboard();
  const latest = useRef({ move, onOpen, selected });
  latest.current = { move, onOpen, selected };
  useEffect(() => {
    const registrations = [
      { key: "ArrowDown", label: "Next node in this layer", action: () => latest.current.move("down") },
      { key: "ArrowUp", label: "Previous node in this layer", action: () => latest.current.move("up") },
      { key: "ArrowRight", label: "Next layer", action: () => latest.current.move("right") },
      { key: "ArrowLeft", label: "Previous layer", action: () => latest.current.move("left") },
      {
        key: "Enter",
        label: "Show the selected node's relationships",
        action: () => {
          const id = latest.current.selected;
          if (id !== undefined) latest.current.onOpen(id);
        },
      },
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
    ].map((shortcut) => keyboard.register({ scope: "plan-graph", ...shortcut }));
    return () => registrations.forEach((unregister) => unregister());
  }, [keyboard]);

  /* An empty patch of canvas pans; a press on a node selects it and never moves it. */
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    setPan((p) => ({ x: p.x + (event.clientX - from.x), y: p.y + (event.clientY - from.y) }));
    drag.current = { x: event.clientX, y: event.clientY };
  }, []);
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const width = layout.width + PAD * 2;
  const height = layout.height + PAD * 2;

  return (
    <div className="orca-wfcanvas orca-plan__canvas" {...scopeProps("plan-graph")}>
      <div
        className="orca-wfcanvas__viewport"
        role="listbox"
        aria-label="Dependency graph"
        {...(selected !== undefined && layout.nodes.some((p) => p.node.id === selected)
          ? { "aria-activedescendant": depNodeDomId(selected) }
          : {})}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="orca-wfcanvas__scene"
          role="presentation"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${ZOOMS[zoom]!})` }}
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
              {layout.edges.map((placed) => {
                const d = placed.edge.dependency;
                const classes = ["orca-edge", `orca-dep-edge--${d.type}`, `orca-dep-edge--${edgeState(d)}`];
                if (cycle.has(d.id)) classes.push("orca-dep-edge--cycle");
                if (placed.isBack) classes.push("orca-edge--back");
                return (
                  <g key={placed.key} data-dependency={d.id}>
                    <path className={classes.join(" ")} d={placed.path} />
                    {d.target.kind === "work-item" && d.target.stage !== undefined && (
                      <text
                        className={`orca-edge__label ${textClass("mono-id")}`}
                        x={placed.labelX}
                        y={placed.labelY}
                        textAnchor="middle"
                      >
                        {d.target.stage}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {layout.nodes.map((placed) => (
              <div
                key={placed.node.id}
                className="orca-wfcanvas__box"
                role="presentation"
                style={{ left: `${placed.x + PAD}px`, top: `${placed.y + PAD}px` }}
              >
                <DependencyNode
                  id={depNodeDomId(placed.node.id)}
                  name={placed.node.name}
                  title={placed.node.title}
                  target={placed.node.target}
                  state={placed.node.state}
                  inCycle={onCycle.has(placed.node.id)}
                  selected={placed.node.id === selected}
                  onOpen={() => onSelect(placed.node.id)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The node an arrow moves to — the workflow canvas's rule, over any placed node. */
function step<N extends { id: string }>(
  nodes: readonly PlacedNode<N>[],
  from: PlacedNode<N>,
  direction: Direction,
): PlacedNode<N> | undefined {
  if (direction === "up" || direction === "down") {
    const wanted = from.order + (direction === "down" ? 1 : -1);
    return nodes.find((placed) => placed.layer === from.layer && placed.order === wanted);
  }
  const wanted = from.layer + (direction === "right" ? 1 : -1);
  return nodes
    .filter((placed) => placed.layer === wanted)
    .reduce<PlacedNode<N> | undefined>(
      (best, placed) =>
        best === undefined || Math.abs(placed.order - from.order) < Math.abs(best.order - from.order) ? placed : best,
      undefined,
    );
}
