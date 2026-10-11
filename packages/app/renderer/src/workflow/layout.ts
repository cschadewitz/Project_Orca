/**
 * The workflow canvas's layout: nodes and edges in, boxes and paths out.
 *
 * **Why this is thirty lines of arithmetic and not a dependency.** The viewer's one hard
 * constraint is that layout is *derived* — "you edit a list and a form, the graph follows"
 * (docs/design/70-workflow-editing.md) — because a dragged graph has to persist coordinates
 * somewhere and a workflow is one file the daemon parses. Derived layout for these graphs is
 * a longest-path layering and a barycentre sweep, which is what dagre and ELK spend their
 * first two passes doing before the parts that matter for graphs of hundreds of nodes. ORCA's
 * are sixteen. So this is a plain module with a plain test, the way `artifacts/diff.ts` is,
 * and the app keeps its four dependencies (ADR 0008 lets it import `@orca/protocol` and
 * `@orca/design` and nothing else from the workspace).
 *
 * ## The contract
 *
 * 1. **Layer = longest-path depth from `start` over the forward edges.** Longest rather than
 *    shortest, because a node must be drawn after everything that can reach it: `bump-build`
 *    is fed by `await-deps`, by the test decision and by the review decision, and a shortest
 *    path would draw it left of two of its own predecessors.
 * 2. **A back edge is an edge whose target's depth is not greater than its source's.** Cycles
 *    are the normal case here — `ai-sdlc`'s review verdict returns to `bump-build`, a `loop`
 *    body returns to its head — so a cycle is not an error and is not broken. It is left out
 *    of the layering (which is what makes the layering terminate) and drawn as a back edge:
 *    routed out of the source's top, along the gutter above the layers and down into the
 *    target. `isBack` on the laid-out edge is what the canvas draws that from.
 * 3. **Order within a layer is the barycentre of the node's predecessors**, over forward
 *    edges only, with a stable tie-break on node id. A node with no predecessor in the layer
 *    above keeps the order it was declared in, which is file order — the one ordering the
 *    author actually chose.
 * 4. **Positions are a whole number of grid steps.** `node-w`, `node-h`, `layer-gap` and
 *    `rank-gap` are all multiples of 16px in `tokens.json`, so every box lands on the grid
 *    without this module rounding anything.
 * 5. **Unreachable nodes are laid out, never dropped.** A node no edge reaches from `start`
 *    has no path and so no depth; it goes in a layer of its own after the last one rather
 *    than at zero, where it would read as a second entry point. The validation panel's job
 *    is to call it unreachable (70-workflow-editing.md); this module's job is to draw it.
 *
 * Layers run left to right and order runs top to bottom, which is the reading direction the
 * design's canvas sketch uses.
 */
import type { WorkflowEdgeView, WorkflowNodeView, WorkflowView } from "@orca/protocol";

/**
 * ## Any graph, not only a workflow (#171)
 *
 * `layoutGraph` is the whole of the above over a plain `{ nodes, edges }`: anything with an
 * `id`, anything with a `from` and a `to`. The plan's dependency graph is the second caller,
 * and it differs from a workflow in one way that matters — it has **many roots** and no
 * `start`. So `roots` is optional: given, they are layer 0 and the search starts from them
 * (a workflow passes `[start]`, which is exactly what `layoutWorkflow` always did); absent,
 * every node nothing points at is a root, and only a node reachable from none of them — one
 * sitting on a cycle — goes in the trailing layer. `layoutWorkflow` is a thin adapter.
 */
export interface GraphNode {
  id: string;
}
export interface GraphEdge {
  from: string;
  to: string;
}
export interface PlainGraph<N extends GraphNode, E extends GraphEdge> {
  nodes: readonly N[];
  edges: readonly E[];
  /** Layer 0. Absent means every node with no incoming forward edge. */
  roots?: readonly string[];
}

/**
 * The box and the gaps, in px. `GRAPH_GEOMETRY` from `@orca/design` is the value to pass;
 * it is a parameter rather than an import so the test can lay a graph out on a unit grid and
 * assert on the shape instead of on four-digit numbers.
 */
export interface GraphMetrics {
  /** `node-w` — the width every node is laid out at. */
  nodeW: number;
  /** `node-h` — the height every node is laid out at. */
  nodeH: number;
  /** `layer-gap` — the horizontal space between two layers, where the edges are drawn. */
  layerGap: number;
  /** `rank-gap` — the vertical space between two nodes in one layer. */
  rankGap: number;
}

/** One node, placed. `x`/`y` is its top-left corner; the box is `metrics.nodeW` × `nodeH`. */
export interface PlacedNode<N extends GraphNode = WorkflowNodeView> {
  node: N;
  /** Dependency depth: 0 is `start`. */
  layer: number;
  /** Position within the layer, top to bottom. */
  order: number;
  x: number;
  y: number;
}

/** One edge, routed. `path` is an SVG `d` in the same coordinate space as the nodes. */
export interface PlacedEdge<E extends GraphEdge = WorkflowEdgeView> {
  edge: E;
  /**
   * This edge's identity within the layout: its index and its ends. It carries the index
   * because a `decision` with two branches to one target is two edges, and keying them both
   * `a→b` gave React two children with one key and made "is this a back edge?" a question
   * about the *pair* rather than about the edge — so marking one back dashed the other too.
   */
  key: string;
  /**
   * `from→to`. The overlay's key, not the layout's: a traversal says which pair a visit
   * arrived over and cannot say which of two parallel edges it was, so this is what
   * `OverlayIndex.edges` is looked up by.
   */
  pair: string;
  /**
   * True when the edge runs back into a layer it has already passed: the review-to-build
   * loop, a `loop` body's return. Drawn around the layers rather than through them.
   */
  isBack: boolean;
  path: string;
  /** Where the `when` expression or the author's label is printed, when there is one. */
  labelX: number;
  labelY: number;
}

export interface GraphLayout<N extends GraphNode = WorkflowNodeView, E extends GraphEdge = WorkflowEdgeView> {
  nodes: readonly PlacedNode<N>[];
  edges: readonly PlacedEdge<E>[];
  /** The whole drawing's extent, for the SVG `viewBox` and for a fit-to-window zoom. */
  width: number;
  height: number;
  /** How many layers the graph has; 0 for a workflow with no nodes. */
  layers: number;
}

/** An edge whose ends both exist. An edge into a node that is not here is not drawn. */
const isDrawable = (edge: GraphEdge, ids: ReadonlySet<string>): boolean => ids.has(edge.from) && ids.has(edge.to);

/**
 * The edges that close a cycle, found by depth-first search from `start` and then from
 * anything the search has not reached.
 *
 * A back edge cannot be defined by depth before the depths exist — that is circular, and the
 * first cut of this module was: relaxing every edge until nothing moved walked a cycle until
 * its bound and produced layers nobody could read. So the cycles are cut here, by the
 * ordinary definition — an edge into a node that is still open on the search stack — which
 * leaves a DAG for the layering. The depth test in `layoutWorkflow` afterwards is then a
 * second, cheaper net that catches an edge the search entered a node by but which still ends
 * up pointing left once the longest paths are settled.
 *
 * Iterative rather than recursive: a workflow is a file a person wrote and a deep chain must
 * not be able to overflow the stack of the window drawing it.
 */
function backEdges(nodes: readonly GraphNode[], edges: readonly GraphEdge[], starts: readonly string[]): Set<string> {
  /* Keyed by `edgeKey`, so two edges between one pair are two entries here and one of them
     can be a back edge without the other becoming one. */
  const out = new Map<string, { edge: GraphEdge; key: string }[]>();
  edges.forEach((edge, index) => {
    const entry = { edge, key: edgeKey(edge, index) };
    const list = out.get(edge.from);
    if (list) list.push(entry);
    else out.set(edge.from, [entry]);
  });

  const back = new Set<string>();
  /** `open` is the DFS stack as a set: an edge into one of these is an edge into a cycle. */
  const open = new Set<string>();
  const done = new Set<string>();

  const roots = [...starts, ...nodes.map((n) => n.id)];
  for (const root of roots) {
    if (done.has(root) || !nodes.some((n) => n.id === root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    open.add(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const outgoing = out.get(frame.id) ?? [];
      if (frame.next >= outgoing.length) {
        stack.pop();
        open.delete(frame.id);
        done.add(frame.id);
        continue;
      }
      const { edge, key } = outgoing[frame.next++]!;
      if (open.has(edge.to)) back.add(key);
      else if (!done.has(edge.to)) {
        open.add(edge.to);
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }
  return back;
}

/**
 * Longest-path depth from `start` over a DAG — the edges left once the cycles are cut.
 *
 * Relaxation in topological order, so one pass is exact: a node's depth is final before
 * anything reads it. A node no forward edge reaches keeps no depth at all, which is what
 * `layoutWorkflow` turns into the trailing layer unreachable nodes go in.
 */
function depths(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  starts: readonly string[] | undefined,
): Map<string, number> {
  const depth = new Map<string, number>();

  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    const list = out.get(edge.from);
    if (list) list.push(edge);
    else out.set(edge.from, [edge]);
  }

  /* Given roots, the first of them present — or the first node — is where depth is counted
     from, which is a workflow's `start`. No roots given, every source of the DAG is layer 0:
     a plan has as many independent chains as it has items nothing waits on. */
  if (starts === undefined) {
    for (const [id, n] of indegree) if (n === 0) depth.set(id, 0);
  } else {
    const present = starts.filter((id) => nodes.some((n) => n.id === id));
    const root = present.length > 0 ? present : nodes[0] ? [nodes[0].id] : [];
    for (const id of root) depth.set(id, 0);
  }
  if (depth.size === 0) return depth;

  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    const from = depth.get(id);
    for (const edge of out.get(id) ?? []) {
      if (from !== undefined) {
        const to = depth.get(edge.to);
        if (to === undefined || to < from + 1) depth.set(edge.to, from + 1);
      }
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  return depth;
}

/**
 * The layout. `metrics` is `GRAPH_GEOMETRY` at runtime.
 *
 * Collapsing is not a parameter, and that is the point: a `subworkflow` or a `parallel` is
 * one box in its parent's graph whether or not its body is on screen, so expanding one
 * cannot move anything around it. An expanded body is a `WorkflowView` of its own and is
 * laid out by another call to this function, inside its own group box.
 */
export function layoutWorkflow(workflow: WorkflowView, metrics: GraphMetrics): GraphLayout {
  return layoutGraph({ nodes: workflow.nodes, edges: workflow.edges, roots: [workflow.start] }, metrics);
}

/** The layout of any graph: `layoutWorkflow`'s contract, over `{ nodes, edges, roots? }`. */
export function layoutGraph<N extends GraphNode, E extends GraphEdge>(
  graph: PlainGraph<N, E>,
  metrics: GraphMetrics,
): GraphLayout<N, E> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((edge) => isDrawable(edge, ids));
  const back = backEdges(graph.nodes, edges, graph.roots ?? []);
  const depth = depths(
    graph.nodes,
    edges.filter((edge, index) => !back.has(edgeKey(edge, index))),
    graph.roots,
  );

  /* An unreachable node is placed after the deepest reachable one, in a layer of its own
     rather than at 0: at 0 it would read as a second `start`, which is the one thing the
     graph's leftmost column means. */
  const deepest = [...depth.values()].reduce((a, b) => Math.max(a, b), -1);
  const layerOf = (id: string): number => depth.get(id) ?? deepest + 1;

  // The second net: an edge the search came into a node by can still end up pointing left
  // once the longest paths settle, and an edge that points left is a back edge whatever
  // found it.
  edges.forEach((edge, index) => {
    if (layerOf(edge.to) <= layerOf(edge.from)) back.add(edgeKey(edge, index));
  });

  // Forward predecessors per node: the barycentre's input, and the reason a back edge does
  // not drag a node back up into the layer it loops to.
  const predecessors = new Map<string, string[]>();
  edges.forEach((edge, index) => {
    if (back.has(edgeKey(edge, index))) return;
    const list = predecessors.get(edge.to);
    if (list) list.push(edge.from);
    else predecessors.set(edge.to, [edge.from]);
  });

  const byLayer = new Map<number, N[]>();
  for (const node of graph.nodes) {
    const layer = layerOf(node.id);
    const list = byLayer.get(layer);
    if (list) list.push(node);
    else byLayer.set(layer, [node]);
  }

  /* One sweep, left to right: a layer is ordered by the mean position of its predecessors in
     the layer that has already been ordered. One sweep rather than the usual several,
     because each layer is final before the next one reads it — with graphs this size a
     second pass moves nothing a person would notice, and a deterministic single sweep is
     what makes the drawing stable when a run is overlaid on it. */
  const orderOf = new Map<string, number>();
  const layerCount = byLayer.size === 0 ? 0 : Math.max(...byLayer.keys()) + 1;
  for (let layer = 0; layer < layerCount; layer += 1) {
    const members = byLayer.get(layer) ?? [];
    const declared = new Map(members.map((node, index) => [node.id, index]));
    const barycentre = (node: N): number => {
      const parents = (predecessors.get(node.id) ?? []).map((id) => orderOf.get(id)).filter((o) => o !== undefined);
      // No placed predecessor: keep file order, which is the one ordering an author chose.
      return parents.length === 0 ? declared.get(node.id)! : parents.reduce((a, b) => a + b, 0) / parents.length;
    };
    const sorted = [...members].sort((a, b) => {
      const delta = barycentre(a) - barycentre(b);
      // The tie-break is the node id, not the declaration index: two nodes with the same
      // barycentre must sort the same way whatever order they arrived in.
      return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    sorted.forEach((node, index) => orderOf.set(node.id, index));
    byLayer.set(layer, sorted);
  }

  const step = { x: metrics.nodeW + metrics.layerGap, y: metrics.nodeH + metrics.rankGap };
  const placed: PlacedNode<N>[] = [];
  for (let layer = 0; layer < layerCount; layer += 1) {
    (byLayer.get(layer) ?? []).forEach((node, order) => {
      placed.push({ node, layer, order, x: layer * step.x, y: order * step.y });
    });
  }

  const tallest = placed.reduce((most, node) => Math.max(most, node.order + 1), 0);
  const boxes = new Map(placed.map((node) => [node.node.id, node]));
  /* The gutter a back edge is routed through: half a rank gap above the top row, so a back
     edge never runs under a node and never leaves the drawing. */
  const gutter = -metrics.rankGap / 2;

  const routed = edges.map((edge, index) => {
    const key = edgeKey(edge, index);
    return route(edge, key, boxes, metrics, back.has(key), gutter);
  });

  return {
    nodes: placed,
    edges: routed,
    width: layerCount === 0 ? 0 : layerCount * step.x - metrics.layerGap,
    height: tallest === 0 ? 0 : tallest * step.y - metrics.rankGap,
    layers: layerCount,
  };
}

/**
 * The key an edge is drawn and marked by: its position in the workflow's edge list and its
 * ends. The index is what makes two edges between one pair two edges — `decision` nodes
 * branching twice to the same target are the ordinary case, and a key of `from→to` alone
 * handed React a duplicate and let a back-edge mark on one bleed onto the other.
 *
 * `edgePair` is the same edge without the index, for the one question that is genuinely
 * about the pair: whether a run's traversal came this way.
 */
export const edgeKey = (edge: GraphEdge, index: number): string => `${index}:${edge.from}→${edge.to}`;

/** `from→to` — what a traversal can say about an edge, and all it can say. */
export const edgePair = (edge: GraphEdge): string => `${edge.from}→${edge.to}`;

/**
 * The node with this id, anywhere in the view — including inside a container's nested graphs,
 * and inside theirs.
 *
 * There is **one selection** (docs/design/70-workflow-editing.md): selecting a node on the
 * canvas, in an expanded group box or (later) in the editor's node list is the same act, so
 * the id the surface holds has to be resolvable wherever the node actually lives. Looking
 * only at `workflow.nodes` made a click inside an expanded `parallel` select a node the
 * inspector could not then find — a selection with nothing on the other end of it.
 *
 * Ids are unique within a graph but a nested graph is its own namespace, so this is
 * first-match in draw order: the outer graph before the bodies hanging off it, which is the
 * order a person reads them in.
 */
export function findNode(workflow: WorkflowView, id: string | undefined): WorkflowNodeView | undefined {
  if (id === undefined) return undefined;
  const here = workflow.nodes.find((node) => node.id === id);
  if (here) return here;
  for (const node of workflow.nodes) {
    for (const nested of node.nested ?? []) {
      const found = findNode(nested, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * One edge as an SVG path.
 *
 * A forward edge leaves the source's right edge and enters the target's left edge as a cubic
 * whose control points are half the horizontal span out — which reads as a wire rather than
 * as a diagram arrow, and never crosses a node in a layered graph.
 *
 * A back edge leaves the *top* of its source, runs level through the gutter above the graph
 * and comes down into the top of its target. That is the shape the design asks for ("the
 * review-to-build loop drawn as a back edge") and it is why it cannot be the same curve: a
 * cubic from a right edge to a left edge that is to its left passes straight back through
 * every node between them.
 */
export function route<E extends GraphEdge>(
  edge: E,
  key: string,
  boxes: ReadonlyMap<string, { x: number; y: number }>,
  metrics: GraphMetrics,
  isBack: boolean,
  gutter: number,
): PlacedEdge<E> {
  const from = boxes.get(edge.from)!;
  const to = boxes.get(edge.to)!;
  const pair = edgePair(edge);

  if (isBack) {
    const x1 = from.x + metrics.nodeW / 2;
    const x2 = to.x + metrics.nodeW / 2;
    const top = Math.min(from.y, to.y) + gutter;
    return {
      edge,
      key,
      pair,
      isBack: true,
      path: `M ${x1} ${from.y} L ${x1} ${top} L ${x2} ${top} L ${x2} ${to.y}`,
      labelX: (x1 + x2) / 2,
      labelY: top,
    };
  }

  const x1 = from.x + metrics.nodeW;
  const y1 = from.y + metrics.nodeH / 2;
  const x2 = to.x;
  const y2 = to.y + metrics.nodeH / 2;
  const bend = (x2 - x1) / 2;
  return {
    edge,
    key,
    pair,
    isBack: false,
    path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2,
  };
}
