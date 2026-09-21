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
 * **The keys are the map's, and they are registered once.** `↑`/`↓` move within a layer,
 * `←`/`→` between layers, `Enter` expands or collapses a container, `+`/`-`/`0` zoom and `⇧`
 * with an arrow pans — all in the `workflow` scope, so the palette lists every one of them.
 * The arrows move the *selection* rather than the viewport, because that is what an arrow
 * does everywhere else in this app; panning is the shifted form, and dragging an empty patch
 * of canvas is the pointer's way to the same thing. An expanded nested graph draws through
 * `Graph` below, which registers nothing: two registrations of `↑` in one scope is an error
 * by design, and a graph inside a graph is one canvas with more drawing in it.
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
import type { WorkflowNodeView, WorkflowView } from "@orca/protocol";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import { Text, WorkflowNode, asNodeType, textClass, type WorkflowNodeRunState } from "../ui/index.js";
import { layoutWorkflow, type GraphMetrics, type PlacedNode } from "./layout.js";
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

/** The zoom stops. A list rather than a multiplier, so `+` and `-` are exactly reversible. */
const ZOOMS = [0.5, 0.75, 1, 1.5, 2];
const DEFAULT_ZOOM = ZOOMS.indexOf(1);
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
}

export function WorkflowCanvas({
  workflow,
  overlay,
  selected,
  onSelect,
  expanded,
  onToggleExpanded,
  label,
}: WorkflowCanvasProps): JSX.Element {
  const layout = useMemo(() => layoutWorkflow(workflow, METRICS), [workflow]);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  /* Moving the selection. `↑`/`↓` step within the layer, `←`/`→` to the node in the next
     layer along whose order is nearest this one's, so a move across a fan-out lands where
     the eye already is rather than at the top of the column. */
  const move = useCallback(
    (direction: Direction) => {
      const from = layout.nodes.find((placed) => placed.node.id === selected);
      if (!from) {
        // Nothing selected yet: the first arrow selects the entry node rather than moving.
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
  // Through a ref so a canvas whose handlers are rebuilt on every push — which is every
  // canvas with a live run overlaid — does not unregister and re-register twelve shortcuts
  // on each frame. The same reason `useListKeys` does it.
  const latest = useRef({ move, onToggleExpanded, selected });
  latest.current = { move, onToggleExpanded, selected };

  useEffect(() => {
    const registrations = [
      { key: "ArrowDown", label: "Next node in this layer", action: () => latest.current.move("down") },
      { key: "ArrowUp", label: "Previous node in this layer", action: () => latest.current.move("up") },
      { key: "ArrowRight", label: "Next layer", action: () => latest.current.move("right") },
      { key: "ArrowLeft", label: "Previous layer", action: () => latest.current.move("left") },
      {
        key: "Enter",
        label: "Expand or collapse the selected node",
        action: () => {
          const id = latest.current.selected;
          if (id !== undefined) latest.current.onToggleExpanded(id);
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
    ].map((shortcut) => keyboard.register({ scope: "workflow", ...shortcut }));
    return () => registrations.forEach((unregister) => unregister());
  }, [keyboard]);

  /* Dragging an empty patch of canvas pans it. A drag that starts on a node is not a pan and
     is not a move either — nothing on this canvas is dragged (70-workflow-editing.md) — so
     the capture is taken only when the press landed on the viewport itself. */
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

  const scale = ZOOMS[zoom]!;
  const groups = layout.nodes
    .filter((placed) => expanded.has(placed.node.id))
    .flatMap((placed) => (placed.node.nested ?? []).map((nested) => ({ owner: placed.node, nested })));

  return (
    <div className="orca-wfcanvas" {...scopeProps("workflow")}>
      <div
        className="orca-wfcanvas__viewport"
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
          className="orca-wfcanvas__scene"
          role="presentation"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        >
          <Graph layout={layout} overlay={overlay} selected={selected} onSelect={onSelect} expanded={expanded} />
        </div>
      </div>

      {/* An expanded container's body, laid out by the same function in a group box of its
          own. It is beside the canvas rather than inside it because a nested graph is a
          graph — its own start, its own layers, its own back edges — and inlining one would
          move every node around the container that holds it. */}
      {groups.map(({ owner, nested }) => (
        <section
          key={nested.id}
          className="orca-wfcanvas__group"
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
              layout={layoutWorkflow(nested, METRICS)}
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

type Direction = "up" | "down" | "left" | "right";

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
 * The node an arrow key moves to.
 *
 * Within a layer it is the neighbour by order. Across layers it is the node in the next
 * layer along whose order is closest to this one's, which keeps a move across a fan-out near
 * where the eye already is instead of snapping to the top of the column.
 */
function step(nodes: readonly PlacedNode[], from: PlacedNode, direction: Direction): PlacedNode | undefined {
  if (direction === "up" || direction === "down") {
    const wanted = from.order + (direction === "down" ? 1 : -1);
    return nodes.find((placed) => placed.layer === from.layer && placed.order === wanted);
  }
  const wanted = from.layer + (direction === "right" ? 1 : -1);
  return nodes
    .filter((placed) => placed.layer === wanted)
    .reduce<PlacedNode | undefined>(
      (best, placed) =>
        best === undefined || Math.abs(placed.order - from.order) < Math.abs(best.order - from.order) ? placed : best,
      undefined,
    );
}
