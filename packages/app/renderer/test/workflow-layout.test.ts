/**
 * The workflow canvas's layout (#177) — the plain module, on a unit grid.
 *
 * The metrics are a parameter, so every case here lays out on a 10x10 box with gaps of 10
 * and asserts on the shape rather than on `node-w` arithmetic. The one case that uses the
 * real `GRAPH_GEOMETRY` is the last, which is there to prove the tokens reach the module at
 * all and that the grid step they make is a whole number of 16px steps.
 */
import { describe, expect, it } from "vitest";
import { GRAPH_GEOMETRY } from "@orca/design";
import type { WorkflowView } from "@orca/protocol";
import { edgeKey, layoutWorkflow, type GraphMetrics } from "../src/workflow/layout.js";
import { AI_SDLC } from "./fixtures-workflows.js";

/** A unit grid: a 10x10 node, a 10 gap each way, so a layer step is 20 and a rank step 20. */
const UNIT: GraphMetrics = { nodeW: 10, nodeH: 10, layerGap: 10, rankGap: 10 };

/** The real tokens, in the shape the module takes them. `workflow-canvas.tsx` does the same. */
const REAL: GraphMetrics = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};

const graph = (start: string, nodes: readonly string[], edges: readonly [string, string][]): WorkflowView => ({
  id: "w",
  name: "w",
  version: "1",
  start,
  nodes: nodes.map((id) => ({ id, type: id === start ? "start" : "agent", fields: {} })),
  edges: edges.map(([from, to]) => ({ from, to })),
});

const layerOf = (layout: ReturnType<typeof layoutWorkflow>, id: string): number =>
  layout.nodes.find((n) => n.node.id === id)!.layer;
const orderOf = (layout: ReturnType<typeof layoutWorkflow>, id: string): number =>
  layout.nodes.find((n) => n.node.id === id)!.order;

describe("layers are longest-path depth from start", () => {
  it("puts a chain in one node per layer", () => {
    const layout = layoutWorkflow(graph("a", ["a", "b", "c"], [["a", "b"], ["b", "c"]]), UNIT);
    expect([layerOf(layout, "a"), layerOf(layout, "b"), layerOf(layout, "c")]).toEqual([0, 1, 2]);
    expect(layout.layers).toBe(3);
  });

  it("takes the longest path, not the shortest: a node is drawn after everything that reaches it", () => {
    // `a → d` is one hop and `a → b → c → d` is three. A shortest-path layering would draw
    // `d` beside `b`, to the left of its own predecessor `c`.
    const layout = layoutWorkflow(
      graph("a", ["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "d"], ["a", "d"]]),
      UNIT,
    );
    expect(layerOf(layout, "d")).toBe(3);
  });

  it("lays an unreachable node out after the last layer rather than beside start", () => {
    const layout = layoutWorkflow(graph("a", ["a", "b", "orphan"], [["a", "b"]]), UNIT);
    // Drawn, never dropped (the validation panel is what calls it unreachable), and never at
    // layer 0, where it would read as a second entry point.
    expect(layout.nodes.map((n) => n.node.id).sort()).toEqual(["a", "b", "orphan"]);
    expect(layerOf(layout, "orphan")).toBe(2);
  });

  it("terminates on a cycle and lays every node in it out once", () => {
    const layout = layoutWorkflow(graph("a", ["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "b"]]), UNIT);
    expect(layout.nodes).toHaveLength(3);
    expect([layerOf(layout, "b"), layerOf(layout, "c")]).toEqual([1, 2]);
  });
});

describe("back edges", () => {
  it("marks the edge that returns to a layer it has passed, and routes it through the gutter", () => {
    const layout = layoutWorkflow(graph("a", ["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "b"]]), UNIT);
    const backwards = layout.edges.filter((e) => e.isBack).map((e) => e.key);
    expect(backwards).toEqual([edgeKey({ from: "c", to: "b" })]);

    // Out of the top of the source, level through the gutter above the graph, down into the
    // top of the target: an `L` path at a negative y, never the forward cubic.
    const loop = layout.edges.find((e) => e.isBack)!;
    expect(loop.path.startsWith("M ")).toBe(true);
    expect(loop.path).not.toContain("C");
    expect(loop.labelY).toBeLessThan(0);
  });

  it("marks a self edge as a back edge rather than laying a node on top of itself", () => {
    const layout = layoutWorkflow(graph("a", ["a", "b"], [["a", "b"], ["b", "b"]]), UNIT);
    expect(layout.edges.find((e) => e.key === edgeKey({ from: "b", to: "b" }))!.isBack).toBe(true);
  });

  it("leaves a back edge out of the layering, so the loop's head is not dragged forward", () => {
    // `d → b` must not push `b` past `d`. Without excluding back edges from the relaxation
    // this graph would not settle at all.
    const layout = layoutWorkflow(
      graph("a", ["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["c", "d"], ["d", "b"]]),
      UNIT,
    );
    expect([layerOf(layout, "b"), layerOf(layout, "c"), layerOf(layout, "d")]).toEqual([1, 2, 3]);
  });

  it("drops an edge whose end is not in the graph rather than routing to nothing", () => {
    const view = graph("a", ["a", "b"], [["a", "b"]]);
    const layout = layoutWorkflow({ ...view, edges: [...view.edges, { from: "b", to: "ghost" }] }, UNIT);
    expect(layout.edges.map((e) => e.key)).toEqual([edgeKey({ from: "a", to: "b" })]);
  });
});

describe("order within a layer", () => {
  it("is the barycentre of the node's predecessors", () => {
    /* Layer 1 is declared `y, x`; `x` is fed by the first node of layer 0 and `y` by the
       second, so the barycentre turns them round and the edges do not cross. */
    const view: WorkflowView = {
      ...graph("s", ["s", "a", "b", "y", "x"], [["s", "a"], ["s", "b"], ["a", "x"], ["b", "y"]]),
    };
    const layout = layoutWorkflow(view, UNIT);
    expect(orderOf(layout, "a")).toBe(0);
    expect(orderOf(layout, "b")).toBe(1);
    expect(orderOf(layout, "x")).toBe(0);
    expect(orderOf(layout, "y")).toBe(1);
  });

  it("breaks a tie on node id, so the drawing does not depend on declaration order", () => {
    const forwards = layoutWorkflow(graph("s", ["s", "zeta", "alpha"], [["s", "zeta"], ["s", "alpha"]]), UNIT);
    const backwards = layoutWorkflow(graph("s", ["s", "alpha", "zeta"], [["s", "alpha"], ["s", "zeta"]]), UNIT);
    // Both nodes have the same one predecessor, so both barycentres are 0 and the id decides.
    expect(orderOf(forwards, "alpha")).toBe(0);
    expect(orderOf(backwards, "alpha")).toBe(0);
  });

  it("keeps file order for a node with no placed predecessor", () => {
    const layout = layoutWorkflow(graph("s", ["s", "second", "first"], []), UNIT);
    // Nothing reaches either, so both land in the layer after `s` in the order they were
    // written — the one ordering the author chose.
    expect(orderOf(layout, "second")).toBe(0);
    expect(orderOf(layout, "first")).toBe(1);
  });
});

describe("positions and extent", () => {
  it("places each node on the grid the metrics make", () => {
    const layout = layoutWorkflow(graph("s", ["s", "a", "b"], [["s", "a"], ["s", "b"]]), UNIT);
    const a = layout.nodes.find((n) => n.node.id === "a")!;
    const b = layout.nodes.find((n) => n.node.id === "b")!;
    expect([a.x, a.y]).toEqual([20, 0]);
    expect([b.x, b.y]).toEqual([20, 20]);
    // The extent is the boxes, not the trailing gap.
    expect([layout.width, layout.height]).toEqual([30, 30]);
  });

  it("is empty, not broken, for a workflow with no nodes", () => {
    const layout = layoutWorkflow({ ...graph("s", [], []), start: "s" }, UNIT);
    expect(layout).toMatchObject({ nodes: [], edges: [], width: 0, height: 0, layers: 0 });
  });
});

describe("ai-sdlc, the graph the issue names", () => {
  it("lays out all sixteen nodes and draws the review loop as a back edge", () => {
    const layout = layoutWorkflow(AI_SDLC, REAL);
    expect(layout.nodes).toHaveLength(16);
    expect(layerOf(layout, "start")).toBe(0);

    const backwards = layout.edges.filter((e) => e.isBack).map((e) => e.key);
    // Both retry edges return to `bump-build`: the test decision's and the review verdict's.
    expect(backwards).toContain(edgeKey({ from: "review-verdict", to: "bump-build" }));
    expect(backwards).toContain(edgeKey({ from: "tests-passed", to: "bump-build" }));
  });

  it("puts every node on a whole number of 16px grid steps", () => {
    const layout = layoutWorkflow(AI_SDLC, REAL);
    const GRID = 16;
    for (const placed of layout.nodes) {
      expect(placed.x % GRID, `${placed.node.id} x`).toBe(0);
      expect(placed.y % GRID, `${placed.node.id} y`).toBe(0);
    }
  });
});
