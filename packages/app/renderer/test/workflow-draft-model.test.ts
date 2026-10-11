/**
 * The editor's arithmetic (#181): what changed against the published workflow, which ids are
 * free, and where nodes are drawn once some have been dragged. Pure functions, unit grid.
 */
import { describe, expect, it } from "vitest";
import {
  changeCount,
  editorGraph,
  editorLayout,
  freshId,
  nestedSteps,
  newNode,
  rawGraphAt,
} from "../src/workflow/editor/draft-model.js";

const METRICS = { nodeW: 10, nodeH: 4, layerGap: 4, rankGap: 2 };

const base = {
  id: "w",
  start: "start",
  nodes: { start: { type: "start" }, work: { type: "set", vars: { a: 1 } }, done: { type: "end" } },
  edges: [
    { from: "start", to: "work" },
    { from: "work", to: "done" },
  ],
};

describe("editorGraph", () => {
  it("marks added, changed and removed nodes, and new edges, against the published workflow", () => {
    const draft = {
      ...base,
      nodes: { start: { type: "start" }, work: { type: "set", vars: { a: 2 } }, check: { type: "end" } },
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "check" },
      ],
    };
    const graph = editorGraph(draft, base, [])!;
    expect(graph.nodes.map((n) => [n.id, n.state])).toEqual([
      ["start", undefined],
      ["work", "changed"],
      ["check", "added"],
      ["done", "removed"],
    ]);
    expect(graph.edges.map((e) => e.added)).toEqual([false, true]);
    // check added, work changed, done removed, one edge added and one taken away.
    expect(changeCount(draft, base)).toBe(5);
  });

  it("reaches a loop's inline body", () => {
    const loop = newNode("loop");
    const draft = { ...base, nodes: { ...base.nodes, again: loop } };
    const node = editorGraph(draft, base, [])!.nodes.find((n) => n.id === "again")!;
    expect(nestedSteps(node)).toEqual([{ node: "again", label: "body" }]);
    expect(rawGraphAt(draft, [{ node: "again" }])).toMatchObject({ start: "start" });
    expect(editorGraph(draft, base, [{ node: "again" }])!.nodes.map((n) => n.state)).toEqual(["added", "added"]);
  });
});

describe("freshId", () => {
  it("takes the first free number for the type", () => {
    expect(freshId("gate", ["gate-1", "gate-2", "plan"])).toBe("gate-3");
    expect(freshId("custom:plan-await", [])).toBe("plan-await-1");
  });
});

describe("editorLayout", () => {
  it("draws pinned nodes where they were dropped and routes their edges as back edges when they run left", () => {
    const graph = editorGraph(base, base, [])!;
    const auto = editorLayout(graph, { graphs: {} }, [], METRICS);
    expect(auto.nodes.map((n) => [n.node.id, n.x, n.pinned])).toEqual([
      ["start", 0, false],
      ["work", 14, false],
      ["done", 28, false],
    ]);
    const pinned = editorLayout(graph, { graphs: { "": { done: { x: 0, y: 20 } } } }, [], METRICS);
    const done = pinned.nodes.find((n) => n.node.id === "done")!;
    expect([done.x, done.y, done.pinned]).toEqual([0, 20, true]);
    expect(pinned.edges.find((e) => e.edge.to === "done")!.isBack).toBe(true);
    // A drag in progress overrides the pin, and nothing is drawn above or left of the origin.
    const dragging = editorLayout(graph, { graphs: {} }, [], METRICS, { id: "work", x: -5, y: 3 });
    expect(dragging.nodes.find((n) => n.node.id === "work")).toMatchObject({ x: 0, y: 3, pinned: true });
  });
});
