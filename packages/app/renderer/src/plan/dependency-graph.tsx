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
 *   the arrows along a layer and across layers (pointing the way the graph is laid out),
 *   `+`/`-`/`0` zoom, `⇧` with an arrow pans, `Enter` opens the relationships in the dock.
 *   Registered once, here and in `useCanvasView`.
 * - **The workflow canvas's view controls**, shared rather than copied: `useCanvasView` for
 *   zoom and pan, `CanvasControls` and `GraphMinimap` in the corner, and a direction and a
 *   minimap the person chooses for this canvas (`plan-graph`) apart from the workflow's.
 */
import { useCallback, useEffect, useMemo, useRef, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { GRAPH_GEOMETRY } from "@orca/design";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import {
  CanvasControls,
  DependencyNode,
  GraphMinimap,
  textClass,
  useCanvasView,
  useGraphPreferences,
  type MinimapNode,
  type MinimapTone,
  type ViewportMeasurer,
} from "../ui/index.js";
import {
  arrowLabel,
  labelTransform,
  layoutGraph,
  stepSelection,
  type Arrow,
  type GraphMetrics,
} from "../workflow/layout.js";
import { edgeState, type DepEdge, type DepNode } from "./graph-model.js";

const METRICS: GraphMetrics = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};
const PAD = METRICS.rankGap;
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
  /** How the viewport is measured. The document by default; a test injects a size. */
  measure?: ViewportMeasurer;
}

export function DependencyGraph({
  nodes,
  edges,
  cycle,
  selected,
  onSelect,
  onOpen,
  measure,
}: DependencyGraphProps): JSX.Element {
  const graphView = useGraphPreferences("plan-graph", "plan-graph");
  const { direction } = graphView;
  const layout = useMemo(() => layoutGraph({ nodes, edges }, METRICS, direction), [nodes, edges, direction]);
  const content = useMemo(
    () => ({ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }),
    [layout.width, layout.height],
  );
  const canvas = useCanvasView({ scope: "plan-graph", content, panStep: PAN_STEP, measure });
  // Turning the graph puts the view back at rest, as on the workflow canvas.
  const { rest, panBy } = canvas;
  const turned = useRef(direction);
  useEffect(() => {
    if (turned.current === direction) return;
    turned.current = direction;
    rest();
  }, [direction, rest]);
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
    (arrow: Arrow) => {
      const from = layout.nodes.find((placed) => placed.node.id === selected);
      if (!from) {
        const first = layout.nodes[0];
        if (first) onSelect(first.node.id);
        return;
      }
      const next = stepSelection(layout.nodes, from, arrow, direction);
      if (next) onSelect(next.node.id);
    },
    [layout, selected, onSelect, direction],
  );

  const keyboard = useKeyboard();
  const latest = useRef({ move, onOpen, selected });
  latest.current = { move, onOpen, selected };
  useEffect(() => {
    const arrows: [string, Arrow][] = [
      ["ArrowDown", "down"],
      ["ArrowUp", "up"],
      ["ArrowRight", "right"],
      ["ArrowLeft", "left"],
    ];
    const registrations = [
      ...arrows.map(([key, arrow]) => ({
        key,
        label: arrowLabel(arrow, direction),
        action: () => latest.current.move(arrow),
      })),
      {
        key: "Enter",
        label: "Show the selected node's relationships",
        action: () => {
          const id = latest.current.selected;
          if (id !== undefined) latest.current.onOpen(id);
        },
      },
    ].map((shortcut) => keyboard.register({ scope: "plan-graph", ...shortcut }));
    return () => registrations.forEach((unregister) => unregister());
  }, [keyboard, direction]);

  /* An empty patch of canvas pans; a press on a node selects it and never moves it. */
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const from = drag.current;
      if (!from) return;
      panBy(event.clientX - from.x, event.clientY - from.y);
      drag.current = { x: event.clientX, y: event.clientY };
    },
    [panBy],
  );
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const overview = useMemo<MinimapNode[]>(
    () =>
      layout.nodes.map((placed) => ({
        id: placed.node.id,
        x: placed.x + PAD,
        y: placed.y + PAD,
        width: METRICS.nodeW,
        height: METRICS.nodeH,
        tone: onCycle.has(placed.node.id) ? "failed" : DEPENDENCY_TONE[placed.node.state],
        selected: placed.node.id === selected,
      })),
    [layout, onCycle, selected],
  );

  const width = content.width;
  const height = content.height;

  return (
    <div className="orca-wfcanvas orca-plan__canvas" data-direction={direction}>
      <div className="orca-wfcanvas__stage">
        <div
          ref={canvas.ref}
          className="orca-wfcanvas__viewport"
          {...scopeProps("plan-graph")}
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
            className={`orca-wfcanvas__scene${canvas.eased ? " orca-wfcanvas__scene--eased" : ""}`}
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
                          transform={labelTransform(placed)}
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
            label="Dependency graph view"
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
    </div>
  );
}

/**
 * A dependency node's tone in the minimap: its state's colour, as `.orca-dep--<state>` draws
 * its border. A node on a `blocks` cycle is failed whatever its state, as on the canvas.
 */
const DEPENDENCY_TONE: Record<DepNode["state"], MinimapTone> = {
  open: "plain",
  satisfied: "succeeded",
  failed: "failed",
  waived: "faint",
};
