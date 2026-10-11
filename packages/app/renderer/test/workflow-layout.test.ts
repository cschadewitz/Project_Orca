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
import {
  arrowLabel,
  arrowMove,
  edgeKey,
  edgePair,
  findNode,
  fromDirection,
  labelTransform,
  lattice,
  layoutWorkflow,
  stepSelection,
  toDirection,
  type GraphMetrics,
} from "../src/workflow/layout.js";
import { AI_SDLC, WORKFLOW_VIEWS } from "./fixtures-workflows.js";

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
    const layout = layoutWorkflow(
      graph(
        "a",
        ["a", "b", "c"],
        [
          ["a", "b"],
          ["b", "c"],
        ],
      ),
      UNIT,
    );
    expect([layerOf(layout, "a"), layerOf(layout, "b"), layerOf(layout, "c")]).toEqual([0, 1, 2]);
    expect(layout.layers).toBe(3);
  });

  it("takes the longest path, not the shortest: a node is drawn after everything that reaches it", () => {
    // `a → d` is one hop and `a → b → c → d` is three. A shortest-path layering would draw
    // `d` beside `b`, to the left of its own predecessor `c`.
    const layout = layoutWorkflow(
      graph(
        "a",
        ["a", "b", "c", "d"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
          ["a", "d"],
        ],
      ),
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
    const layout = layoutWorkflow(
      graph(
        "a",
        ["a", "b", "c"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "b"],
        ],
      ),
      UNIT,
    );
    expect(layout.nodes).toHaveLength(3);
    expect([layerOf(layout, "b"), layerOf(layout, "c")]).toEqual([1, 2]);
  });
});

describe("back edges", () => {
  it("marks the edge that returns to a layer it has passed, and routes it through the gutter", () => {
    const layout = layoutWorkflow(
      graph(
        "a",
        ["a", "b", "c"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "b"],
        ],
      ),
      UNIT,
    );
    const backwards = layout.edges.filter((e) => e.isBack).map((e) => e.pair);
    expect(backwards).toEqual([edgePair({ from: "c", to: "b" })]);

    // Out of the top of the source, level through the gutter above the graph, down into the
    // top of the target: an `L` path at a negative y, never the forward cubic.
    const loop = layout.edges.find((e) => e.isBack)!;
    expect(loop.path.startsWith("M ")).toBe(true);
    expect(loop.path).not.toContain("C");
    expect(loop.labelY).toBeLessThan(0);
  });

  it("marks a self edge as a back edge rather than laying a node on top of itself", () => {
    const layout = layoutWorkflow(
      graph(
        "a",
        ["a", "b"],
        [
          ["a", "b"],
          ["b", "b"],
        ],
      ),
      UNIT,
    );
    expect(layout.edges.find((e) => e.pair === edgePair({ from: "b", to: "b" }))!.isBack).toBe(true);
  });

  it("leaves a back edge out of the layering, so the loop's head is not dragged forward", () => {
    // `d → b` must not push `b` past `d`. Without excluding back edges from the relaxation
    // this graph would not settle at all.
    const layout = layoutWorkflow(
      graph(
        "a",
        ["a", "b", "c", "d"],
        [
          ["a", "b"],
          ["b", "c"],
          ["c", "d"],
          ["d", "b"],
        ],
      ),
      UNIT,
    );
    expect([layerOf(layout, "b"), layerOf(layout, "c"), layerOf(layout, "d")]).toEqual([1, 2, 3]);
  });

  it("drops an edge whose end is not in the graph rather than routing to nothing", () => {
    const view = graph("a", ["a", "b"], [["a", "b"]]);
    const layout = layoutWorkflow({ ...view, edges: [...view.edges, { from: "b", to: "ghost" }] }, UNIT);
    expect(layout.edges.map((e) => e.key)).toEqual([edgeKey({ from: "a", to: "b" }, 0)]);
  });

  it("keys two edges between the same pair apart, and marks only the one that runs back", () => {
    /* A `decision` with two branches to one target is the ordinary case — `ai-sdlc`'s
       `tests-passed` is one — and `from→to` gave both of them the same key: React saw a
       duplicate child, and marking one a back edge marked the other too (#177). */
    const view = graph("a", ["a", "b"], []);
    const layout = layoutWorkflow(
      {
        ...view,
        edges: [
          { from: "a", to: "b", when: "choice == 'yes'" },
          { from: "a", to: "b", when: "choice == 'no'" },
        ],
      },
      UNIT,
    );

    expect(layout.edges).toHaveLength(2);
    expect(new Set(layout.edges.map((e) => e.key)).size).toBe(2);
    // Both are the same pair, and the pair is what an overlay can speak about.
    expect(layout.edges.map((e) => e.pair)).toEqual([
      edgePair({ from: "a", to: "b" }),
      edgePair({ from: "a", to: "b" }),
    ]);
    expect(layout.edges.map((e) => e.edge.when)).toEqual(["choice == 'yes'", "choice == 'no'"]);
    // Neither runs backwards; the marking does not bleed from one onto the other.
    expect(layout.edges.every((e) => !e.isBack)).toBe(true);
  });

  it("marks the back edge of a pair drawn twice without marking its forward twin", () => {
    // `b → a` closes the cycle; `a → b` declared twice must stay two forward edges.
    const view = graph("a", ["a", "b"], []);
    const layout = layoutWorkflow(
      {
        ...view,
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      },
      UNIT,
    );
    expect(layout.edges.filter((e) => e.isBack)).toHaveLength(1);
    expect(layout.edges.find((e) => e.isBack)!.pair).toBe(edgePair({ from: "b", to: "a" }));
  });
});

describe("finding the selected node", () => {
  const sdlc = WORKFLOW_VIEWS.sdlc!;

  it("finds a node in the graph itself and a node inside a container's nested graph", () => {
    expect(findNode(sdlc, "build")!.name).toBe("Build: plan and implement");
    /* The one the canvas could not resolve before: `ui-build` lives inside the `parallel`'s
       `auth-ui` branch, and the surface holds one selection wherever the node is (#177). */
    expect(findNode(sdlc, "ui-build")!.name).toBe("Wire the login button");
    expect(findNode(sdlc, "docs-write")).toBeDefined();
  });

  it("answers nothing for an id no graph has, and for no selection at all", () => {
    expect(findNode(sdlc, "nobody")).toBeUndefined();
    expect(findNode(sdlc, undefined)).toBeUndefined();
  });
});

describe("order within a layer", () => {
  it("is the barycentre of the node's predecessors", () => {
    /* Layer 1 is declared `y, x`; `x` is fed by the first node of layer 0 and `y` by the
       second, so the barycentre turns them round and the edges do not cross. */
    const view: WorkflowView = {
      ...graph(
        "s",
        ["s", "a", "b", "y", "x"],
        [
          ["s", "a"],
          ["s", "b"],
          ["a", "x"],
          ["b", "y"],
        ],
      ),
    };
    const layout = layoutWorkflow(view, UNIT);
    expect(orderOf(layout, "a")).toBe(0);
    expect(orderOf(layout, "b")).toBe(1);
    expect(orderOf(layout, "x")).toBe(0);
    expect(orderOf(layout, "y")).toBe(1);
  });

  it("breaks a tie on node id, so the drawing does not depend on declaration order", () => {
    const forwards = layoutWorkflow(
      graph(
        "s",
        ["s", "zeta", "alpha"],
        [
          ["s", "zeta"],
          ["s", "alpha"],
        ],
      ),
      UNIT,
    );
    const backwards = layoutWorkflow(
      graph(
        "s",
        ["s", "alpha", "zeta"],
        [
          ["s", "alpha"],
          ["s", "zeta"],
        ],
      ),
      UNIT,
    );
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
    const layout = layoutWorkflow(
      graph(
        "s",
        ["s", "a", "b"],
        [
          ["s", "a"],
          ["s", "b"],
        ],
      ),
      UNIT,
    );
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

    const backwards = layout.edges.filter((e) => e.isBack).map((e) => e.pair);
    // Both retry edges return to `bump-build`: the test decision's and the review verdict's.
    expect(backwards).toContain(edgePair({ from: "review-verdict", to: "bump-build" }));
    expect(backwards).toContain(edgePair({ from: "tests-passed", to: "bump-build" }));
    // And every edge in the graph has a key of its own, whatever pairs repeat.
    expect(new Set(layout.edges.map((e) => e.key)).size).toBe(layout.edges.length);
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

describe("top to bottom", () => {
  /* Unit metrics where the box is wider than it is tall, so a test can tell a layout that
     turned from one that merely swapped x and y: a 20x10 node, gaps of 10, so a layer step is
     30 across (horizontal) or 20 down (vertical) and a rank step 20 down or 30 across. */
  const WIDE: GraphMetrics = { nodeW: 20, nodeH: 10, layerGap: 10, rankGap: 10 };
  const fan = graph(
    "s",
    ["s", "a", "b"],
    [
      ["s", "a"],
      ["s", "b"],
    ],
  );
  const at = (layout: ReturnType<typeof layoutWorkflow>, id: string): [number, number] => {
    const placed = layout.nodes.find((n) => n.node.id === id)!;
    return [placed.x, placed.y];
  };

  it("runs the layers down the canvas and the order across it", () => {
    const layout = layoutWorkflow(fan, WIDE, "vertical");
    expect(at(layout, "s")).toEqual([0, 0]);
    // Layer 1 is a row one layer step down, its two nodes a rank step apart across it.
    expect(at(layout, "a")).toEqual([0, 20]);
    expect(at(layout, "b")).toEqual([30, 20]);
    // The extent is the boxes, not the trailing gap: two columns wide, two rows tall.
    expect([layout.width, layout.height]).toEqual([50, 30]);
    // The horizontal layout of the same graph, for the contrast: layers across, order down.
    const across = layoutWorkflow(fan, WIDE);
    expect(at(across, "a")).toEqual([30, 0]);
    expect(at(across, "b")).toEqual([30, 20]);
    expect([across.width, across.height]).toEqual([50, 30]);
  });

  it("lays out the same layers, order and back edges either way: only the positions turn", () => {
    for (const [name, workflow] of Object.entries(WORKFLOW_VIEWS)) {
      const left = layoutWorkflow(workflow, REAL);
      const down = layoutWorkflow(workflow, REAL, "vertical");
      expect(down.layers, name).toBe(left.layers);
      expect(
        down.nodes.map((n) => [n.node.id, n.layer, n.order]),
        name,
      ).toEqual(left.nodes.map((n) => [n.node.id, n.layer, n.order]));
      expect(
        down.edges.map((e) => [e.key, e.isBack]),
        name,
      ).toEqual(left.edges.map((e) => [e.key, e.isBack]));
    }
  });

  it("attaches a forward edge to the bottom of its source and the top of its target", () => {
    const layout = layoutWorkflow(fan, WIDE, "vertical");
    const toB = layout.edges.find((e) => e.pair === edgePair({ from: "s", to: "b" }))!;
    // Out of s's bottom centre (10, 10), into b's top centre (40, 20), bending vertically.
    expect(toB.path).toBe("M 10 10 C 10 15, 40 15, 40 20");
    // Left to right, the same edge leaves s's right side half-way down and enters b's left.
    const across = layoutWorkflow(fan, WIDE).edges.find((e) => e.pair === edgePair({ from: "s", to: "b" }))!;
    expect(across.path).toBe("M 20 5 C 25 5, 25 25, 30 25");
  });

  it("prints a fan-out's labels over their own targets, where two midpoints side by side would collide", () => {
    const layout = layoutWorkflow(fan, WIDE, "vertical");
    const toA = layout.edges.find((e) => e.pair === edgePair({ from: "s", to: "a" }))!;
    const toB = layout.edges.find((e) => e.pair === edgePair({ from: "s", to: "b" }))!;
    // A quarter of the layer gap above each target's top centre: a rank apart, level.
    expect([toA.labelX, toA.labelY]).toEqual([10, 17.5]);
    expect([toB.labelX, toB.labelY]).toEqual([40, 17.5]);
    expect(toB.labelAngle).toBeUndefined();
    expect(labelTransform(toB)).toBeUndefined();
    // Left to right they stay at the midpoints, a rank apart down the gap, as they always were.
    const across = layoutWorkflow(fan, WIDE).edges.find((e) => e.pair === edgePair({ from: "s", to: "b" }))!;
    expect([across.labelX, across.labelY]).toEqual([25, 15]);
  });

  it("routes a back edge out of the left side, through the gutter beside the columns, and still marks it back", () => {
    const loop = graph(
      "a",
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "b"],
      ],
    );
    const layout = layoutWorkflow(loop, WIDE, "vertical");
    const back = layout.edges.find((e) => e.isBack)!;
    expect(back.pair).toBe(edgePair({ from: "c", to: "b" }));
    // c is at (0, 40) and b at (0, 20): out of c's left side half-way down, along the gutter
    // half a rank gap left of the column, and into b's left side. Level segments, never the cubic.
    expect(back.path).toBe("M 0 45 L -5 45 L -5 25 L 0 25");
    // Its label runs up the gutter, half-way along the edge, turned to fit the strip.
    expect([back.labelX, back.labelY, back.labelAngle]).toEqual([-5, 35, -90]);
    expect(labelTransform(back)).toBe("rotate(-90 -5 35)");
    // The forward edges never leave by the left: they keep to the bottom and the top.
    for (const edge of layout.edges.filter((e) => !e.isBack)) expect(edge.path).toContain(" C ");
  });

  it("turns a nested graph the same way, so a group box reads like the graph that holds it", () => {
    // `sdlc`'s `parallel` holds two inline branches, each a three-node chain.
    const branches = WORKFLOW_VIEWS.sdlc!.nodes.find((node) => node.id === "fanout")!.nested!;
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      const down = layoutWorkflow(branch, REAL, "vertical");
      const left = layoutWorkflow(branch, REAL);
      // A chain is a row of three when the graph runs across, and a column of three down.
      expect([left.width, left.height], branch.id).toEqual([
        3 * lattice(REAL, "horizontal").layer - REAL.layerGap,
        REAL.nodeH,
      ]);
      expect([down.width, down.height], branch.id).toEqual([
        REAL.nodeW,
        3 * lattice(REAL, "vertical").layer - REAL.layerGap,
      ]);
      for (const placed of down.nodes) {
        const twin = left.nodes.find((n) => n.node.id === placed.node.id)!;
        expect(toDirection(twin, "vertical", REAL), placed.node.id).toEqual({ x: placed.x, y: placed.y });
      }
    }
  });

  it("keeps every node on the 16px grid, as the horizontal layout does", () => {
    const layout = layoutWorkflow(AI_SDLC, REAL, "vertical");
    for (const placed of layout.nodes) {
      expect(placed.x % 16, `${placed.node.id} x`).toBe(0);
      expect(placed.y % 16, `${placed.node.id} y`).toBe(0);
    }
  });
});

describe("one set of pins for both directions", () => {
  it("maps the whole horizontal layout exactly onto the vertical one", () => {
    const left = layoutWorkflow(AI_SDLC, REAL);
    const down = layoutWorkflow(AI_SDLC, REAL, "vertical");
    for (const placed of left.nodes) {
      const twin = down.nodes.find((n) => n.node.id === placed.node.id)!;
      expect(toDirection(placed, "vertical", REAL), placed.node.id).toEqual({ x: twin.x, y: twin.y });
      expect(fromDirection(twin, "vertical", REAL), placed.node.id).toEqual({ x: placed.x, y: placed.y });
    }
  });

  it("keeps a pin between the lattice points where it was, relative to its neighbours", () => {
    const step = { h: lattice(REAL, "horizontal"), v: lattice(REAL, "vertical") };
    // Half a layer past layer 1 and a quarter rank below rank 2, stored horizontally …
    const pin = { x: 1.5 * step.h.layer, y: 2.25 * step.h.rank };
    // … is half a layer below layer 1 and a quarter rank right of rank 2 when the graph runs down.
    expect(toDirection(pin, "vertical", REAL)).toEqual({ x: 2.25 * step.v.rank, y: 1.5 * step.v.layer });
    // And a drop drawn in the vertical frame goes back to the horizontal frame it is kept in.
    expect(fromDirection(toDirection(pin, "vertical", REAL), "vertical", REAL)).toEqual(pin);
    // Horizontal is the frame itself: nothing moves.
    expect(toDirection(pin, "horizontal", REAL)).toEqual(pin);
    expect(fromDirection(pin, "horizontal", REAL)).toEqual(pin);
  });
});

describe("the arrows point where the selection goes", () => {
  it("moves along a column with up and down, and across layers with left and right, left to right", () => {
    expect(arrowMove("down", "horizontal")).toEqual({ axis: "rank", delta: 1 });
    expect(arrowMove("right", "horizontal")).toEqual({ axis: "layer", delta: 1 });
    expect(arrowLabel("down", "horizontal")).toBe("Next node in this layer");
    expect(arrowLabel("left", "horizontal")).toBe("Previous layer");
  });

  it("moves across layers with up and down, and along a row with left and right, top to bottom", () => {
    expect(arrowMove("down", "vertical")).toEqual({ axis: "layer", delta: 1 });
    expect(arrowMove("up", "vertical")).toEqual({ axis: "layer", delta: -1 });
    expect(arrowMove("right", "vertical")).toEqual({ axis: "rank", delta: 1 });
    expect(arrowLabel("down", "vertical")).toBe("Next layer");
    expect(arrowLabel("right", "vertical")).toBe("Next node in this layer");
  });

  it("steps to the next layer's nearest node, whichever arrow that is", () => {
    const fan = graph(
      "s",
      ["s", "a", "b"],
      [
        ["s", "a"],
        ["s", "b"],
      ],
    );
    for (const direction of ["horizontal", "vertical"] as const) {
      const layout = layoutWorkflow(fan, UNIT, direction);
      const s = layout.nodes.find((n) => n.node.id === "s")!;
      const forward = direction === "horizontal" ? "right" : "down";
      const along = direction === "horizontal" ? "down" : "right";
      const a = stepSelection(layout.nodes, s, forward, direction)!;
      expect(a.node.id, direction).toBe("a");
      expect(stepSelection(layout.nodes, a, along, direction)!.node.id, direction).toBe("b");
      // Past the first layer, back is nowhere.
      expect(stepSelection(layout.nodes, s, direction === "horizontal" ? "left" : "up", direction)).toBeUndefined();
    }
  });
});
