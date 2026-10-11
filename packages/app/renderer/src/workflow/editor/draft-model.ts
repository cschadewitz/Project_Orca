/**
 * The workflow editor's arithmetic (#181): the graph a draft holds at one nesting level, how
 * each node differs from the published workflow, what a new node from the palette looks like,
 * and where everything is drawn once some of it has been dragged.
 *
 * A plain module with a plain test, like `layout.ts`. It reads the draft's *document* - the
 * YAML parsed as written, without schema defaults - because that is what the person edits
 * and what the inspector shows; the daemon validates it against the real schema.
 */
import { draftGraphKey, type DraftGraphPath, type DraftIssue, type DraftLayout } from "@orca/protocol";
import {
  DEFAULT_DIRECTION,
  layoutGraph,
  route,
  toDirection,
  type GraphMetrics,
  type LayoutDirection,
  type PlacedEdge,
} from "../layout.js";

/** A node as the YAML holds it. */
export type RawNode = Record<string, unknown> & { type?: unknown };

export interface EditorNode {
  id: string;
  type: string;
  /** The author's display name, when the node has one. */
  name?: string;
  raw: RawNode;
  /** How the draft differs from the published workflow at this node. */
  state?: "added" | "changed" | "removed";
}

export interface EditorEdge {
  /** Index in the graph's `edges` list - the address every edge operation uses. */
  index: number;
  from: string;
  to: string;
  when?: string;
  label?: string;
  /** Not in the published workflow. */
  added: boolean;
}

export interface EditorGraph {
  start: string;
  /** In file order, then the published nodes the draft removed, drawn as ghosts. */
  nodes: EditorNode[];
  edges: EditorEdge[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The inline graph a path names inside a parsed workflow document, or undefined when there is none. */
export function rawGraphAt(document: unknown, path: DraftGraphPath): Record<string, unknown> | undefined {
  let graph: unknown = document;
  for (const step of path) {
    const node = isRecord(graph) && isRecord(graph.nodes) ? graph.nodes[step.node] : undefined;
    if (!isRecord(node)) return undefined;
    const slot =
      node.type === "loop" && step.branch === undefined && !step.forEach
        ? node.body
        : node.type === "parallel" && step.branch !== undefined
          ? isRecord(node.branches)
            ? node.branches[step.branch]
            : undefined
          : node.type === "parallel" && step.forEach && isRecord(node.forEach)
            ? node.forEach.body
            : undefined;
    graph = isRecord(slot) ? slot.graph : undefined;
  }
  return isRecord(graph) ? graph : undefined;
}

function rawEdges(graph: Record<string, unknown> | undefined): EditorEdge[] {
  const list = Array.isArray(graph?.edges) ? graph.edges : [];
  return list.flatMap((edge, index): EditorEdge[] => {
    if (!isRecord(edge) || typeof edge.from !== "string" || typeof edge.to !== "string") return [];
    return [
      {
        index,
        from: edge.from,
        to: edge.to,
        ...(typeof edge.when === "string" ? { when: edge.when } : {}),
        ...(typeof edge.label === "string" ? { label: edge.label } : {}),
        added: false,
      },
    ];
  });
}

const edgeIdentity = (edge: Pick<EditorEdge, "from" | "to" | "when">): string =>
  `${edge.from}\u0000${edge.to}\u0000${edge.when ?? ""}`;

/**
 * The editor's view of one graph: the draft's nodes and edges, each compared with the
 * published workflow's graph at the same path. Nodes the draft removed come last, as ghosts,
 * so a removal is visible on the canvas rather than silent (docs/design/70-workflow-editing.md).
 */
export function editorGraph(document: unknown, base: unknown, path: DraftGraphPath): EditorGraph | undefined {
  const draft = rawGraphAt(document, path);
  if (!draft) return undefined;
  const published = rawGraphAt(base, path);
  const draftNodes = isRecord(draft.nodes) ? draft.nodes : {};
  const baseNodes = isRecord(published?.nodes) ? published.nodes : {};

  const nodes: EditorNode[] = Object.entries(draftNodes).map(([id, value]) => {
    const raw = (isRecord(value) ? value : {}) as RawNode;
    const before = baseNodes[id];
    const state: EditorNode["state"] =
      before === undefined ? "added" : JSON.stringify(before) !== JSON.stringify(value) ? "changed" : undefined;
    return {
      id,
      type: typeof raw.type === "string" ? raw.type : "unknown",
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      raw,
      ...(state ? { state } : {}),
    };
  });
  for (const [id, value] of Object.entries(baseNodes)) {
    if (id in draftNodes) continue;
    const raw = (isRecord(value) ? value : {}) as RawNode;
    nodes.push({
      id,
      type: typeof raw.type === "string" ? raw.type : "unknown",
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      raw,
      state: "removed",
    });
  }

  const publishedEdges = new Set(rawEdges(published).map(edgeIdentity));
  const edges = rawEdges(draft).map((edge) => ({ ...edge, added: !publishedEdges.has(edgeIdentity(edge)) }));
  return { start: typeof draft.start === "string" ? draft.start : "", nodes, edges };
}

/** How many nodes and edges differ from the published workflow, across every graph. */
export function changeCount(document: unknown, base: unknown): number {
  let count = 0;
  const walk = (path: DraftGraphPath) => {
    const graph = editorGraph(document, base, path);
    if (!graph) return;
    count += graph.nodes.filter((node) => node.state !== undefined).length;
    count += graph.edges.filter((edge) => edge.added).length;
    const published = rawEdges(rawGraphAt(base, path));
    const kept = new Set(graph.edges.map(edgeIdentity));
    count += published.filter((edge) => !kept.has(edgeIdentity(edge))).length;
    for (const node of graph.nodes) for (const step of nestedSteps(node)) walk([...path, step]);
  };
  walk([]);
  return count;
}

/** The nested graphs a container node holds, as path steps. */
export function nestedSteps(node: EditorNode): { node: string; branch?: string; forEach?: true; label: string }[] {
  if (node.state === "removed") return [];
  const raw = node.raw;
  if (node.type === "loop" && isRecord(raw.body) && isRecord(raw.body.graph)) return [{ node: node.id, label: "body" }];
  if (node.type !== "parallel") return [];
  const steps: { node: string; branch?: string; forEach?: true; label: string }[] = [];
  if (isRecord(raw.branches))
    for (const [branch, ref] of Object.entries(raw.branches))
      if (isRecord(ref) && isRecord(ref.graph)) steps.push({ node: node.id, branch, label: `branch ${branch}` });
  if (isRecord(raw.forEach) && isRecord(raw.forEach.body) && isRecord(raw.forEach.body.graph))
    steps.push({ node: node.id, forEach: true, label: "each item" });
  return steps;
}

/** The issues that belong to this graph, by node and by edge. */
export function issuesAt(
  issues: readonly DraftIssue[],
  path: DraftGraphPath,
): { byNode: Map<string, DraftIssue[]>; byEdge: Map<number, DraftIssue[]> } {
  const key = draftGraphKey(path);
  const byNode = new Map<string, DraftIssue[]>();
  const byEdge = new Map<number, DraftIssue[]>();
  for (const issue of issues) {
    if (draftGraphKey(issue.graph) !== key) continue;
    if (issue.node !== undefined) byNode.set(issue.node, [...(byNode.get(issue.node) ?? []), issue]);
    if (issue.edge !== undefined) byEdge.set(issue.edge, [...(byEdge.get(issue.edge) ?? []), issue]);
  }
  return { byNode, byEdge };
}

/* ---------- the palette ---------- */

export interface PaletteEntry {
  type: string;
  label: string;
  /** One clause on what the node does, for the palette row and its accessible description. */
  detail: string;
}

/** What can be added, in the order a workflow usually reads. `start` is not here: a graph has one. */
export const PALETTE: readonly PaletteEntry[] = [
  { type: "agent", label: "Agent step", detail: "An agent does a piece of work and produces artifacts" },
  { type: "decision", label: "Decision", detail: "Choose a branch from an expression, an artifact or an agent" },
  { type: "gate", label: "Gate", detail: "Pause for a person to approve or choose" },
  { type: "set", label: "Set variables", detail: "Assign workflow variables" },
  { type: "loop", label: "Loop", detail: "Repeat an inline graph while a condition holds" },
  { type: "parallel", label: "Parallel", detail: "Run branches at the same time" },
  { type: "subworkflow", label: "Subworkflow", detail: "Run another registered workflow" },
  { type: "end", label: "End", detail: "Finish the run with an outcome" },
];

/** The smallest inline graph a container is born with: a start that runs straight to an end. */
const innerGraph = () => ({
  graph: {
    start: "start",
    nodes: { start: { type: "start" }, done: { type: "end" } },
    edges: [{ from: "start", to: "done" }],
  },
});

/**
 * A new node of `type`, filled in enough to be recognisably that node. The placeholders are
 * deliberately plain - validation names whatever still needs a real value.
 */
export function newNode(type: string, context: { workflows?: readonly string[] } = {}): RawNode {
  switch (type) {
    case "agent":
      return { type, agent: { role: "builder" }, prompt: "Describe what this step should do." };
    case "decision":
      return { type, source: { kind: "expression", expr: "true" }, options: ["yes", "no"] };
    case "gate":
      return { type, question: "Approve this step?", options: ["approve", "reject"] };
    case "set":
      return { type, vars: { value: true } };
    case "loop":
      return { type, mode: "while", condition: "false", maxIterations: 3, body: innerGraph() };
    case "parallel":
      return { type, branches: { a: innerGraph(), b: innerGraph() } };
    case "subworkflow":
      return { type, workflow: context.workflows?.[0] ?? "workflow-id" };
    case "end":
      return { type, outcome: "success" };
    default:
      return { type };
  }
}

/** `agent-1`, `agent-2`, … - the first free one in this graph. */
export function freshId(type: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = type.replace(/^custom:/, "").replace(/[^A-Za-z0-9_-]/g, "-") || "node";
  for (let n = 1; ; n += 1) {
    const id = `${stem}-${n}`;
    if (!used.has(id)) return id;
  }
}

/* ---------- placement ---------- */

export interface PlacedEditorNode {
  node: EditorNode;
  x: number;
  y: number;
  pinned: boolean;
}

export interface EditorLayout {
  nodes: PlacedEditorNode[];
  edges: (PlacedEdge<EditorEdge> & { edge: EditorEdge })[];
  width: number;
  height: number;
}

/**
 * Where everything is drawn: the automatic layered layout, with every pinned node moved to
 * where it was dropped and its edges re-routed. `override` is a node mid-drag, which is drawn
 * where the pointer has it before the drop is sent.
 *
 * An edge is routed as a back edge when it runs into a node that is not ahead of it along
 * the flow - not to its right, or not below it when the layers run top to bottom - the same
 * picture the viewer draws, decided by where the boxes now are rather than by depth, because
 * a person may have dragged a later node behind an earlier one.
 *
 * **Pins are kept in the horizontal frame, whichever way the graph is drawn.** The layout
 * record is shared by everybody who edits the workflow and the direction is one person's view
 * of it, so a pin read from it goes through `toDirection` on its way to the screen, and a
 * drop comes back through `fromDirection` before it is sent (`editor-canvas.tsx`). The map is
 * between the two lattices rather than a swap of x and y, so a pinned node keeps its place
 * among its auto-laid-out neighbours either way, and turning the graph writes nothing.
 * `override` is mid-drag and so already in the drawn frame.
 */
export function editorLayout(
  graph: EditorGraph,
  layout: DraftLayout,
  path: DraftGraphPath,
  metrics: GraphMetrics,
  override?: { id: string; x: number; y: number },
  direction: LayoutDirection = DEFAULT_DIRECTION,
): EditorLayout {
  const auto = layoutGraph({ nodes: graph.nodes, edges: graph.edges, roots: [graph.start] }, metrics, direction);
  const pins = layout.graphs[draftGraphKey(path)] ?? {};
  const nodes: PlacedEditorNode[] = auto.nodes.map((placed) => {
    const kept = pins[placed.node.id];
    const pin = override?.id === placed.node.id ? override : kept ? toDirection(kept, direction, metrics) : undefined;
    return pin
      ? { node: placed.node, x: Math.max(0, pin.x), y: Math.max(0, pin.y), pinned: true }
      : { node: placed.node, x: placed.x, y: placed.y, pinned: false };
  });
  const boxes = new Map(nodes.map((placed) => [placed.node.id, placed]));
  const edges = graph.edges
    .filter((edge) => boxes.has(edge.from) && boxes.has(edge.to))
    .map((edge) => {
      const from = boxes.get(edge.from)!;
      const to = boxes.get(edge.to)!;
      const isBack = direction === "vertical" ? to.y <= from.y : to.x <= from.x;
      return route(
        edge,
        `${edge.index}:${edge.from}→${edge.to}`,
        boxes,
        metrics,
        isBack,
        -metrics.rankGap / 2,
        direction,
      );
    });
  const width = nodes.reduce((most, placed) => Math.max(most, placed.x + metrics.nodeW), 0);
  const height = nodes.reduce((most, placed) => Math.max(most, placed.y + metrics.nodeH), 0);
  return { nodes, edges, width, height };
}
