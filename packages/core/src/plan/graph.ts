/**
 * Dependency graph algorithms over work items: cycle detection, topological
 * waves, transitive dependents and longest (critical) downstream paths.
 *
 * Edges point from the *dependent* item to the item it waits for
 * (`from` -> `target`), matching `Dependency`. Only work-item targets that are
 * part of the node set become edges; decisions and externals are leaves the
 * scheduler evaluates separately.
 */
import type { Dependency, DependencyType } from "../model/plan.js";

export interface GraphEdge {
  /** Dependent item. */
  from: string;
  /** Upstream item the dependent waits for. */
  to: string;
  type: DependencyType;
  dependencyId: string;
  stage?: string;
}

export interface DependencyGraph {
  nodes: string[];
  edges: GraphEdge[];
  /** Edges leaving a node: what it depends on. */
  upstreamOf: Map<string, GraphEdge[]>;
  /** Edges entering a node: who depends on it. */
  downstreamOf: Map<string, GraphEdge[]>;
}

export interface BuildGraphOptions {
  /** Edge types that impose ordering. Default: blocks + soft. */
  orderingTypes?: readonly DependencyType[];
}

export function buildDependencyGraph(
  nodeIds: readonly string[],
  dependencies: readonly Dependency[],
  opts: BuildGraphOptions = {},
): DependencyGraph {
  const ordering = new Set(opts.orderingTypes ?? ["blocks", "soft"]);
  const nodes = [...new Set(nodeIds)];
  const known = new Set(nodes);
  const edges: GraphEdge[] = [];
  for (const d of dependencies) {
    if (d.target.kind !== "work-item" || !ordering.has(d.type)) continue;
    if (!known.has(d.from) || !known.has(d.target.workItemId)) continue;
    if (d.status === "waived") continue;
    edges.push({
      from: d.from,
      to: d.target.workItemId,
      type: d.type,
      dependencyId: d.id,
      ...(d.target.stage ? { stage: d.target.stage } : {}),
    });
  }
  return graphFromEdges(nodes, edges);
}

function graphFromEdges(nodes: readonly string[], edges: readonly GraphEdge[]): DependencyGraph {
  const upstreamOf = new Map<string, GraphEdge[]>(nodes.map((n) => [n, []]));
  const downstreamOf = new Map<string, GraphEdge[]>(nodes.map((n) => [n, []]));
  for (const e of edges) {
    upstreamOf.get(e.from)!.push(e);
    downstreamOf.get(e.to)!.push(e);
  }
  return { nodes: [...nodes], edges: [...edges], upstreamOf, downstreamOf };
}

export interface RelaxedGraph {
  graph: DependencyGraph;
  /** The optional edges that were left out because they closed a cycle. */
  dropped: GraphEdge[];
}

/**
 * Drop the edges of type `optional` that close a cycle, keeping every other
 * edge (and therefore every cycle the required edges already form).
 *
 * Ordering *hints* must never make work unschedulable: a `soft` edge that
 * points back into a `blocks` chain is a preference that cannot be honoured,
 * not a planning error. Edges are considered in input order, so the result is
 * deterministic and earlier hints win.
 */
export function dropCycleClosingEdges(graph: DependencyGraph, optional: readonly DependencyType[]): RelaxedGraph {
  const droppable = new Set(optional);
  const dropped: GraphEdge[] = [];
  const upstream = new Map<string, string[]>(graph.nodes.map((n) => [n, []]));
  for (const e of graph.edges) if (!droppable.has(e.type)) upstream.get(e.from)!.push(e.to);
  // Can `to` already reach `from` by following upstream edges? Then `from -> to` closes a cycle.
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === from) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(upstream.get(cur) ?? []));
    }
    return false;
  };
  for (const e of graph.edges) {
    if (!droppable.has(e.type)) continue;
    if (reaches(e.from, e.to)) dropped.push(e);
    else upstream.get(e.from)!.push(e.to);
  }
  if (!dropped.length) return { graph, dropped };
  const out = new Set(dropped.map((e) => e.dependencyId));
  return {
    graph: graphFromEdges(
      graph.nodes,
      graph.edges.filter((e) => !out.has(e.dependencyId)),
    ),
    dropped,
  };
}

/** Strongly connected components with more than one node, plus self-loops (Tarjan). */
export function findCycles(graph: DependencyGraph): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const e of graph.upstreamOf.get(v) ?? []) {
      const w = e.to;
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      const selfLoop = scc.length === 1 && (graph.upstreamOf.get(v) ?? []).some((e) => e.to === v);
      if (scc.length > 1 || selfLoop) cycles.push(inEdgeOrder(graph, scc));
    }
  };
  for (const n of graph.nodes) if (!idx.has(n)) visit(n);
  return cycles;
}

/**
 * Members of a strongly connected component in edge order: starting from the
 * smallest id (so the result does not depend on input order), follow
 * `from -> to` edges inside the component. For a simple cycle that is the ring
 * itself, so `a -> b -> c` reads "a waits for b, which waits for c, which waits for a".
 */
function inEdgeOrder(graph: DependencyGraph, members: readonly string[]): string[] {
  const inside = new Set(members);
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (v: string) => {
    seen.add(v);
    out.push(v);
    for (const e of graph.upstreamOf.get(v) ?? []) if (inside.has(e.to) && !seen.has(e.to)) visit(e.to);
  };
  visit([...members].sort()[0]!);
  return out;
}

/** Every item that (transitively) depends on `id`. */
export function transitiveDownstream(graph: DependencyGraph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.downstreamOf.get(cur) ?? []) {
      if (out.has(e.from)) continue;
      out.add(e.from);
      stack.push(e.from);
    }
  }
  out.delete(id);
  return out;
}

/** Every item `id` (transitively) depends on. */
export function transitiveUpstream(graph: DependencyGraph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.upstreamOf.get(cur) ?? []) {
      if (out.has(e.to)) continue;
      out.add(e.to);
      stack.push(e.to);
    }
  }
  out.delete(id);
  return out;
}

export interface Waves {
  /** Layers: everything in wave n depends only on items in waves < n. */
  waves: string[][];
  /** Nodes that could not be layered because they sit in (or behind) a cycle. */
  cyclic: string[];
}

/** Kahn layering. Deterministic: nodes keep their input order within a wave. */
export function topologicalWaves(graph: DependencyGraph): Waves {
  const remaining = new Map<string, number>(graph.nodes.map((n) => [n, (graph.upstreamOf.get(n) ?? []).length]));
  const placed = new Set<string>();
  const waves: string[][] = [];
  for (;;) {
    const wave = graph.nodes.filter((n) => !placed.has(n) && remaining.get(n) === 0);
    if (wave.length === 0) break;
    for (const n of wave) {
      placed.add(n);
      for (const e of graph.downstreamOf.get(n) ?? []) remaining.set(e.from, remaining.get(e.from)! - 1);
    }
    waves.push(wave);
  }
  return { waves, cyclic: graph.nodes.filter((n) => !placed.has(n)) };
}

export interface PathInfo {
  /** Sum of node weights along the heaviest downstream chain starting at (and including) the node. */
  length: number;
  path: string[];
}

/**
 * Share (0..1) of an upstream node's weight that must elapse before the
 * dependent on `edge` can begin: 1 for a plain edge (wait for all of it), less
 * for an edge that allows overlap (a stage-level dependency).
 */
export type EdgeLag = (edge: GraphEdge) => number;

/**
 * For each node, the heaviest chain of dependents starting at it. The maximum
 * over all nodes is the plan's critical path. Nodes inside cycles get length 0.
 *
 * A chain through an edge costs `lag(edge) * weight(node) + length(dependent)`
 * and a node alone costs its own weight, so with every lag at 1 (the default)
 * this is the plain longest path over node weights.
 */
export function longestDownstreamPaths(
  graph: DependencyGraph,
  weight: (id: string) => number,
  lag: EdgeLag = () => 1,
): Map<string, PathInfo> {
  const cyclic = new Set(findCycles(graph).flat());
  const memo = new Map<string, PathInfo>();
  const visiting = new Set<string>();
  const visit = (id: string): PathInfo => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { length: 0, path: [] };
    if (cyclic.has(id)) {
      const none = { length: 0, path: [] };
      memo.set(id, none);
      return none;
    }
    visiting.add(id);
    const own = weight(id);
    let best: PathInfo = { length: own, path: [id] };
    for (const e of graph.downstreamOf.get(id) ?? []) {
      const p = visit(e.from);
      const length = Math.min(1, Math.max(0, lag(e))) * own + p.length;
      if (length > best.length) best = { length, path: [id, ...p.path] };
    }
    visiting.delete(id);
    memo.set(id, best);
    return best;
  };
  for (const n of graph.nodes) visit(n);
  return memo;
}

export function criticalPath(paths: Map<string, PathInfo>): PathInfo {
  let best: PathInfo = { length: 0, path: [] };
  for (const p of paths.values()) if (p.length > best.length) best = p;
  return best;
}
