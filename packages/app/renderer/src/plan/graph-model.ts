/**
 * The dependency graph's arithmetic (#171), with no React in it.
 *
 * - **An edge points downstream.** A dependency is recorded on the item that waits (`from`)
 *   and names what it waits for (`target`); the graph draws it from the target to the item,
 *   so the layout's left-to-right reads as "this has to happen before that".
 * - **Three kinds of node, one id space.** A work item is its id, a decision is
 *   `decision:<id>`, something outside the plan is `external:<key>` — so a work item can
 *   never collide with a decision that happens to share a string.
 * - **"Blocks" is inverted here.** `dependencies.list` filters by the `from` side only, so the
 *   list is read whole and what a node blocks is every dependency whose target is it.
 * - **The rail filters the items; the graph rail filters the edges.** A dependency is drawn
 *   when the item that waits is on screen and its kind is switched on; an upstream item the
 *   rail hid is still drawn as the far end of that edge, because an edge to nothing would be
 *   a dependency with its reason cut off.
 */
import type { DependencyState } from "@orca/design";
import type { DependencyView, PlanItemView } from "@orca/protocol";
import type { DependencyTarget } from "../ui/index.js";

export type DependencyKind = DependencyView["type"];
export const DEPENDENCY_KINDS: readonly DependencyKind[] = ["blocks", "soft", "informs"];

export interface GraphFilters {
  kinds: readonly DependencyKind[];
  /** Leave out satisfied and waived edges: what is still holding something. */
  unmetOnly: boolean;
}

export const ALL_EDGES: GraphFilters = { kinds: DEPENDENCY_KINDS, unmetOnly: false };

export interface DepNode {
  id: string;
  name: string;
  title?: string;
  target: DependencyTarget;
  state: DependencyState;
  /** Present on a work item. */
  item?: PlanItemView;
}

export interface DepEdge {
  from: string;
  to: string;
  dependency: DependencyView;
}

/** The node a dependency's target is drawn as. */
export function targetNodeId(dependency: DependencyView): string {
  const target = dependency.target;
  switch (target.kind) {
    case "work-item":
      return target.workItemId;
    case "decision":
      return `decision:${target.decisionId}`;
    case "external":
      return `external:${target.key}`;
  }
}

/** The target's name, in the words it is written in. */
export function targetName(dependency: DependencyView): string {
  const target = dependency.target;
  switch (target.kind) {
    case "work-item":
      return target.stage === undefined
        ? (target.slug ?? target.workItemId)
        : `${target.slug ?? target.workItemId}:${target.stage}`;
    case "decision":
      return target.key ?? target.decisionId;
    case "external":
      return target.key;
  }
}

/** The dependent's name: its slug, or its id when the view did not carry one. */
export const fromName = (dependency: DependencyView): string => dependency.fromSlug ?? dependency.from;

/** The one state a node is drawn in, from the live evaluations of the edges around it. */
export function foldState(dependencies: readonly DependencyView[]): DependencyState {
  const states = dependencies.map((d) => d.evaluation.state);
  if (states.includes("failed")) return "failed";
  if (states.includes("waiting")) return "open";
  if (states.length > 0 && states.every((s) => s === "waived")) return "waived";
  return "satisfied";
}

/** A dependency's state as an edge draws it: the live one, with `waiting` said as `open`. */
export const edgeState = (dependency: DependencyView): DependencyState =>
  dependency.evaluation.state === "waiting" ? "open" : dependency.evaluation.state;

export function buildGraph(
  items: readonly PlanItemView[],
  dependencies: readonly DependencyView[],
  filters: GraphFilters,
): { nodes: DepNode[]; edges: DepEdge[] } {
  const shown = new Set(items.map((item) => item.id));
  const drawn = dependencies.filter(
    (d) =>
      shown.has(d.from) &&
      filters.kinds.includes(d.type) &&
      (!filters.unmetOnly || d.evaluation.state === "waiting" || d.evaluation.state === "failed"),
  );

  const nodes = new Map<string, DepNode>();
  for (const item of items) {
    nodes.set(item.id, {
      id: item.id,
      name: item.slug,
      title: item.title,
      target: "item",
      state: foldState(dependencies.filter((d) => d.from === item.id)),
      item,
    });
  }
  for (const d of drawn) {
    const id = targetNodeId(d);
    if (nodes.has(id)) continue;
    const incoming = dependencies.filter((other) => targetNodeId(other) === id);
    nodes.set(id, {
      id,
      name: d.target.kind === "work-item" ? (d.target.slug ?? d.target.workItemId) : targetName(d),
      target: d.target.kind === "work-item" ? "item" : d.target.kind,
      /* A hidden upstream item is still an item: its state is what it waits for, exactly as
         a shown one's is — never assumed satisfied because the rail left it out. */
      state:
        d.target.kind === "work-item"
          ? foldState(dependencies.filter((other) => other.from === id))
          : foldState(incoming),
    });
  }
  return {
    nodes: [...nodes.values()],
    edges: drawn.map((d) => ({ from: targetNodeId(d), to: d.from, dependency: d })),
  };
}

/**
 * The `blocks` dependencies that close a cycle. `schedule.get` names each cycle as a list of
 * slugs; an edge is on one when both of its ends are in the same cycle.
 */
export function cycleDependencies(
  cycles: readonly (readonly string[])[],
  dependencies: readonly DependencyView[],
): Set<string> {
  const on = new Set<string>();
  for (const cycle of cycles) {
    const members = new Set(cycle);
    for (const d of dependencies) {
      if (d.type !== "blocks" || d.target.kind !== "work-item") continue;
      const upstream = d.target.slug ?? d.target.workItemId;
      if (members.has(fromName(d)) && members.has(upstream)) on.add(d.id);
    }
  }
  return on;
}

/** What a node waits for, and what waits for it — the relationship inspector's two lists. */
export function relationships(
  nodeId: string,
  dependencies: readonly DependencyView[],
): { blockedBy: DependencyView[]; blocks: DependencyView[] } {
  return {
    blockedBy: dependencies.filter((d) => d.from === nodeId),
    blocks: dependencies.filter((d) => targetNodeId(d) === nodeId),
  };
}

/** Whether a dependency is still holding its item, which is what makes it worth waiving. */
export const isUnmet = (d: DependencyView): boolean =>
  d.evaluation.state === "waiting" || d.evaluation.state === "failed";

/** The confirmation a waive asks: what it waives and what it unblocks. */
export function waiveQuestion(d: DependencyView): string {
  return `Waive ${fromName(d)}'s ${d.type} dependency on ${targetName(d)}? ${fromName(d)} stops waiting for it; the way back is to add the dependency again.`;
}

/** A dependency replaced by the one the daemon answered a write with. */
export function patchDependency(held: readonly DependencyView[], changed: DependencyView): readonly DependencyView[] {
  return held.map((d) => (d.id === changed.id ? changed : d));
}
