/**
 * The canvas: the derived layout drawn, panned, zoomed and selected on — and nothing else.
 * "Direct manipulation that is still available: pan and zoom, selecting a node or an edge,
 * and collapsing a `subworkflow` or `parallel` node's children. Nothing that changes the
 * file happens by dragging on the canvas." (docs/design/70-workflow-editing.md.)
 *
 * **Edges are SVG, nodes are HTML.** One `<svg>` behind the boxes carries every `.orca-edge`
 * path; the boxes themselves are `WorkflowNode`s absolutely positioned over it. That split
 * is deliberate: an edge is geometry and an SVG path is the only honest way to draw one,
 * while a node is text in two type styles with a status chip in it — everything `<text>` is
 * bad at and the component layer is already good at.
 *
 * **One tab stop, `aria-activedescendant` for the selection.** The canvas is a `listbox` of
 * nodes, exactly as a run tree is a `tree` of steps: sixteen tab stops would be sixteen
 * presses to cross one graph. Selection and focus are different things and both stay legible
 * (RULES.md rule 10) — the ring is on the viewport, the selected node takes
 * `.orca-node--selected`.
 *
 * **Every `option` is inside a `listbox`, and every wrapper between them says it is scenery.**
 * The boxes are positioned by three nested divs — the scene that is panned and zoomed, the
 * plane the edges are drawn on, and the absolutely-placed box itself — and a div between a
 * `listbox` and its `option`s is a node a screen reader has to walk past for nothing. They
 * are all `role="presentation"`. An *expanded* container's group box sits outside the
 * viewport (see below), so its plane carries a `listbox` role and a label of its own rather
 * than leaving its nodes as options belonging to nothing.
 *
 * **Which listbox carries `aria-activedescendant` follows the selection.** `aria-activedescendant`
 * has to name an element the listbox contains, so when the selected node lives in an expanded
 * group it is that group's listbox that points at it and the viewport that does not — one
 * selection (70-workflow-editing.md), two places it can be. The viewport stays the only tab
 * stop; the group listboxes are reached by the same arrows, through the same scope.
 *
 * **The keys are the map's, and they are registered once.** The arrows move the selection —
 * along a layer and across to the next one, pointing the way the graph is laid out (`↓` is
 * the next node down a column left to right, and the next layer top to bottom; `layout.ts`,
 * `arrowMove`) — `Enter` expands or collapses a container, `+`/`-`/`0` zoom and `⇧` with an
 * arrow pans — all in the `workflow` scope, so the palette lists every one of them. The
 * arrows move the *selection* rather than the viewport, because that is what an arrow does
 * everywhere else in this app; panning is the shifted form, and dragging an empty patch of
 * canvas is the pointer's way to the same thing. An expanded nested graph draws through
 * `Graph` below, which registers nothing: two registrations of `↑` in one scope is an error
 * by design, and a graph inside a graph is one canvas with more drawing in it.
 *
 * **The view is `useCanvasView`'s, and the corner is the pointer's way to it.** Zoom and pan
 * are one state shared with the zoom keys, the controls in the canvas's corner, a ⌘/Ctrl
 * wheel or a pinch, and the minimap above the controls — so a click on `+` and a press of `+`
 * are one zoom. The layout direction and whether the minimap shows are the person's
 * (`useGraphPreferences`), remembered with their other view preferences rather than in the
 * workflow. The corner sits outside the `workflow` scope: inside it, `Enter` on a focused
 * button would be the canvas's `Enter`, and the map would win.
 */
import { useCallback, useEffect, useMemo, useRef, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { GRAPH_GEOMETRY } from "@orca/design";
import type { WorkflowNodeView, WorkflowView } from "@orca/protocol";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import {
  CanvasControls,
  GraphMinimap,
  Text,
  WorkflowNode,
  asNodeType,
  textClass,
  useCanvasView,
  useGraphPreferences,
  type MinimapNode,
  type MinimapTone,
  type ViewportMeasurer,
  type WorkflowNodeRunState,
} from "../ui/index.js";
import { arrowLabel, layoutWorkflow, stepSelection, type Arrow, type GraphMetrics } from "./layout.js";
import type { OverlayIndex } from "./use-workflow.js";

/** The tokens, in the shape `layout.ts` takes them. One statement of the mapping. */
const METRICS: GraphMetrics = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};

/**
 * The margin around the drawing, which is also the room a back edge's gutter runs in: back
 * edges are routed half a rank gap above the top row, so anything less would clip them.
 */
const PAD = METRICS.rankGap;

/** How far one pan press moves the viewport: one layer step, so a press crosses a column. */
const PAN_STEP = METRICS.nodeW + METRICS.layerGap;

export interface WorkflowCanvasProps {
  workflow: WorkflowView;
  /** The run's path over this graph, or undefined for the definition on its own. */
  overlay?: OverlayIndex | undefined;
  /** The selected node's id, held by the surface so the inspector and the canvas agree. */
  selected: string | undefined;
  onSelect: (nodeId: string) => void;
  /** Container nodes whose nested graphs are drawn; everything else is collapsed. */
  expanded: ReadonlySet<string>;
  onToggleExpanded: (nodeId: string) => void;
  /** The accessible name of the canvas — the workflow, said once. */
  label: string;
  /** How the viewport is measured. The document by default; a test injects a size, since happy-dom has no layout. */
  measure?: ViewportMeasurer;
}

export function WorkflowCanvas({
  workflow,
  overlay,
  selected,
  onSelect,
  expanded,
  onToggleExpanded,
  label,
  measure,
}: WorkflowCanvasProps): JSX.Element {
  const graphView = useGraphPreferences("workflow", "workflow");
  const { direction } = graphView;
  const layout = useMemo(() => layoutWorkflow(workflow, METRICS, direction), [workflow, direction]);
  /* The drawing's extent with its margin: the plane the scene holds, which is what fit fits,
     what a wheel scrolls over and what the minimap shows the whole of. */
  const content = useMemo(
    () => ({ width: layout.width + PAD * 2, height: layout.height + PAD * 2 }),
    [layout.width, layout.height],
  );
  const canvas = useCanvasView({ scope: "workflow", content, panStep: PAN_STEP, measure });

  /* Turning the graph puts the view back at rest. The pan was a place in the old drawing,
     and the same numbers over the turned one point at wherever that happens to be now —
     usually nothing. Rest is where both drawings start: `start`, top left. */
  const { rest } = canvas;
  const turned = useRef(direction);
  useEffect(() => {
    if (turned.current === direction) return;
    turned.current = direction;
    rest();
  }, [direction, rest]);

  /* Moving the selection: along the layer, or to the node in the next layer along whose order
     is nearest this one's, so a move across a fan-out lands where the eye already is rather
     than at the start of the layer. Which arrow is which follows the direction. */
  const move = useCallback(
    (arrow: Arrow) => {
      const from = layout.nodes.find((placed) => placed.node.id === selected);
      if (!from) {
        // Nothing selected yet: the first arrow selects the entry node rather than moving.
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
  // Through a ref so a canvas whose handlers are rebuilt on every push — which is every
  // canvas with a live run overlaid — does not unregister and re-register its shortcuts on
  // each frame. The same reason `useListKeys` does it. The zoom and pan keys are
  // `useCanvasView`'s; the arrows are re-registered only when the direction turns, because
  // their labels say which way the layers run.
  const latest = useRef({ move, onToggleExpanded, selected });
  latest.current = { move, onToggleExpanded, selected };

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
        label: "Expand or collapse the selected node",
        action: () => {
          const id = latest.current.selected;
          if (id !== undefined) latest.current.onToggleExpanded(id);
        },
      },
    ].map((shortcut) => keyboard.register({ scope: "workflow", ...shortcut }));
    return () => registrations.forEach((unregister) => unregister());
  }, [keyboard, direction]);

  /* Dragging an empty patch of canvas pans it. A drag that starts on a node is not a pan and
     is not a move either — nothing on this canvas is dragged (70-workflow-editing.md) — so
     the capture is taken only when the press landed on the viewport itself. */
  const { panBy } = canvas;
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

  /* The minimap's boxes: every node of this graph, in the tone the run left it in. */
  const overview = useMemo<MinimapNode[]>(
    () =>
      layout.nodes.map((placed) => ({
        id: placed.node.id,
        x: placed.x + PAD,
        y: placed.y + PAD,
        width: METRICS.nodeW,
        height: METRICS.nodeH,
        tone: minimapToneOf(placed.node, overlay),
        selected: placed.node.id === selected,
      })),
    [layout, overlay, selected],
  );

  const groups = layout.nodes
    .filter((placed) => expanded.has(placed.node.id))
    .flatMap((placed) => (placed.node.nested ?? []).map((nested) => ({ owner: placed.node, nested })));

  return (
    <div className="orca-wfcanvas" data-direction={direction}>
      <div className="orca-wfcanvas__stage">
        <div
          ref={canvas.ref}
          className="orca-wfcanvas__viewport"
          {...scopeProps("workflow")}
          role="listbox"
          aria-label={label}
          {...(selected !== undefined && layout.nodes.some((p) => p.node.id === selected)
            ? { "aria-activedescendant": nodeDomId(selected) }
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
            <Graph layout={layout} overlay={overlay} selected={selected} onSelect={onSelect} expanded={expanded} />
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

      {/* An expanded container's body, laid out by the same function in a group box of its
          own. It is beside the canvas rather than inside it because a nested graph is a
          graph — its own start, its own layers, its own back edges — and inlining one would
          move every node around the container that holds it. It runs the same way as the
          graph that holds it, and it is in the `workflow` scope like the viewport is. */}
      {groups.map(({ owner, nested }) => (
        <section
          key={nested.id}
          className="orca-wfcanvas__group"
          {...scopeProps("workflow")}
          /* Named by the graph, not just by the container: a `parallel` has one group box
             per branch, and two regions called "Inside Fan out the pieces" would be two
             things a screen reader could not tell apart. */
          aria-label={`Inside ${owner.name ?? owner.id}: ${nested.id}`}
        >
          <header className="orca-wfcanvas__group-head">
            <span className={`orca-id ${textClass("mono-id")}`}>{nested.id}</span>
            <Text style="caption">{countLabel(nested)}</Text>
          </header>
          <div className="orca-wfcanvas__scene" role="presentation">
            <Graph
              layout={layoutWorkflow(nested, METRICS, direction)}
              overlay={overlay}
              selected={selected}
              onSelect={onSelect}
              expanded={expanded}
              /* Its own listbox, because these options are outside the viewport's: a node
                 inside a `listbox` is an option of that listbox, and an option with no
                 listbox over it is a role with nothing to belong to. Not named `… graph`,
                 which is the viewport's name and has to stay the one match for it. */
              owns={{ label: `Nodes of ${nested.id}`, holds: nested.nodes }}
            />
          </div>
        </section>
      ))}
    </div>
  );
}

interface GraphProps {
  layout: ReturnType<typeof layoutWorkflow>;
  overlay: OverlayIndex | undefined;
  selected: string | undefined;
  onSelect: (nodeId: string) => void;
  expanded: ReadonlySet<string>;
  /**
   * Set when this drawing is not inside the viewport's `listbox` — an expanded container's
   * group box — so the plane has to be the `listbox` its options belong to. `holds` is the
   * graph's own nodes, which is what decides whether this listbox is the one pointing at the
   * selection.
   */
  owns?: { label: string; holds: readonly WorkflowNodeView[] };
}

/** The drawing itself: the edges under the boxes. Registers nothing and owns no state. */
function Graph({ layout, overlay, selected, onSelect, expanded, owns }: GraphProps): JSX.Element {
  const width = layout.width + PAD * 2;
  const height = layout.height + PAD * 2;
  const mine = owns !== undefined && selected !== undefined && owns.holds.some((node) => node.id === selected);

  return (
    <div
      className="orca-wfcanvas__plane"
      {...(owns ? { role: "listbox", "aria-label": owns.label } : { role: "presentation" })}
      {...(mine && selected !== undefined ? { "aria-activedescendant": nodeDomId(selected) } : {})}
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
          const classes = ["orca-edge"];
          // With a run overlaid an edge is either one the run took or one it did not; with
          // no run there is no such fact, and the edge is drawn plain.
          // By the pair, not by the layout's key: a traversal names the ends it came over and
          // cannot say which of two parallel edges it was.
          if (overlay) classes.push(overlay.edges.has(placed.pair) ? "orca-edge--active" : "orca-edge--untaken");
          if (placed.isBack) classes.push("orca-edge--back");
          const label = placed.edge.label ?? placed.edge.when;
          return (
            <g key={placed.key}>
              <path className={classes.join(" ")} d={placed.path} />
              {/* The author's word for the edge, or the condition verbatim — which is what
                  the protocol says a `when` is, and why it is mono. */}
              {label !== undefined && (
                <text
                  className={`orca-edge__label ${textClass("mono-id")}`}
                  x={placed.labelX}
                  y={placed.labelY}
                  textAnchor="middle"
                >
                  {label}
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
          <WorkflowNode
            id={nodeDomId(placed.node.id)}
            type={asNodeType(placed.node.type)}
            typeLabel={placed.node.type}
            name={placed.node.name ?? placed.node.id}
            selected={placed.node.id === selected}
            {...runStateOf(placed.node, overlay)}
            {...collapsedOf(placed.node, expanded)}
            onOpen={() => onSelect(placed.node.id)}
          />
        </div>
      ))}
    </div>
  );
}

/** The DOM id of a node's box. Prefixed, because a node id is a string an author chose. */
export const nodeDomId = (nodeId: string): string => `orca-wfnode-${nodeId}`;

/** `3 nodes` — what a group box's header says it is holding, counted rather than estimated. */
export const countLabel = (workflow: WorkflowView): string =>
  `${workflow.nodes.length} ${workflow.nodes.length === 1 ? "node" : "nodes"}`;

/**
 * What a collapsed container says it is hiding: the number of nested graphs, which for a
 * `parallel` is its branches and for a `loop` or an inline `subworkflow` is its one body.
 * A container with nothing nested — a `subworkflow` that names a registered workflow by id,
 * a `parallel` that picks one per item with an expression — says nothing at all, because
 * there is nothing hidden to count (rule 12).
 */
export function collapsedOf(node: WorkflowNodeView, expanded: ReadonlySet<string>): { collapsed?: string } {
  const nested = node.nested ?? [];
  if (nested.length === 0 || expanded.has(node.id)) return {};
  return { collapsed: `${nested.length} nested ${nested.length === 1 ? "graph" : "graphs"}` };
}

/** What the run did at this node, or nothing at all when no run is overlaid. */
export function runStateOf(
  node: WorkflowNodeView,
  overlay: OverlayIndex | undefined,
): { runState?: WorkflowNodeRunState; untaken?: boolean } {
  if (!overlay) return {};
  const visit = overlay.nodes.get(node.id);
  // "Untaken" is "a run is overlaid and this node has no visit", which is a different thing
  // from "no run is overlaid" — and the reason the overlay is a parameter rather than a flag.
  if (!visit) return { untaken: true };
  return {
    runState: {
      status: visit.status,
      ...(visit.attempts > 1 ? { attempts: visit.attempts } : {}),
      ...(overlay.current === node.id ? { current: true } : {}),
    },
  };
}

/**
 * A node's tone in the minimap, from the same facts `runStateOf` hands the node: the four
 * overlay states `WorkflowNode` draws, and faint for a node the run never reached. With no
 * run overlaid there is no state to show, and every box is plain.
 */
export function minimapToneOf(node: WorkflowNodeView, overlay: OverlayIndex | undefined): MinimapTone {
  const { runState, untaken } = runStateOf(node, overlay);
  if (untaken) return "faint";
  if (!runState) return "plain";
  if (runState.current) return "running";
  switch (runState.status) {
    case "running":
      return "running";
    case "waiting":
    case "blocked":
    case "held":
      return "waiting";
    case "failed":
    case "cancelled":
      return "failed";
    case "succeeded":
    case "stale":
      return "strong";
  }
}
