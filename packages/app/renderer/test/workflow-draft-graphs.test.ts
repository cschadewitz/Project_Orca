/**
 * The editor's arithmetic (#181) on the shapes a hand-written workflow can take: nested
 * graphs inside loops and parallel nodes, edges and nodes the YAML holds in a form the schema
 * would refuse, and the issues filed under each graph. Everything here is read leniently -
 * the daemon is what validates, and the editor still has to draw a draft that does not.
 */
import { describe, expect, it } from "vitest";
import type { DraftIssue } from "@orca/protocol";
import {
  PALETTE,
  changeCount,
  editorGraph,
  freshId,
  issuesAt,
  nestedSteps,
  newNode,
  rawGraphAt,
} from "../src/workflow/editor/draft-model.js";

const inner = (end = "done") => ({
  graph: {
    start: "start",
    nodes: { start: { type: "start" }, [end]: { type: "end" } },
    edges: [{ from: "start", to: end }],
  },
});

const document = {
  start: "start",
  nodes: {
    start: { type: "start" },
    again: { type: "loop", body: inner() },
    fan: {
      type: "parallel",
      branches: { a: inner(), b: inner("finish"), broken: "not a graph" },
      forEach: { items: "=vars.list", body: inner() },
    },
  },
  edges: [],
};

describe("rawGraphAt", () => {
  it("reaches a loop's body, a parallel branch and a parallel for-each body", () => {
    expect(rawGraphAt(document, [{ node: "again" }])).toMatchObject({ start: "start" });
    expect(rawGraphAt(document, [{ node: "fan", branch: "b" }])?.nodes).toHaveProperty("finish");
    expect(rawGraphAt(document, [{ node: "fan", forEach: true }])?.nodes).toHaveProperty("done");
  });

  it("finds nothing where a path does not lead to a graph", () => {
    // No such node, a node that is not a container of that kind, a branch that is not a graph.
    expect(rawGraphAt(document, [{ node: "missing" }])).toBeUndefined();
    expect(rawGraphAt(document, [{ node: "start" }])).toBeUndefined();
    expect(rawGraphAt(document, [{ node: "again", branch: "a" }])).toBeUndefined();
    expect(rawGraphAt(document, [{ node: "fan" }])).toBeUndefined();
    expect(rawGraphAt(document, [{ node: "fan", branch: "broken" }])).toBeUndefined();
    expect(rawGraphAt(document, [{ node: "fan", branch: "missing" }])).toBeUndefined();
    expect(rawGraphAt({ nodes: { fan: { type: "parallel" } } }, [{ node: "fan", branch: "a" }])).toBeUndefined();
    expect(rawGraphAt({ nodes: { fan: { type: "parallel" } } }, [{ node: "fan", forEach: true }])).toBeUndefined();
    expect(rawGraphAt({ nodes: "none" }, [{ node: "fan" }])).toBeUndefined();
    expect(rawGraphAt(null, [])).toBeUndefined();
    expect(rawGraphAt([document], [])).toBeUndefined();
  });
});

describe("editorGraph on a draft the schema would refuse", () => {
  it("skips edges it cannot draw and keeps their indexes for the ones it can", () => {
    const draft = {
      start: 7,
      nodes: { a: "not a node", b: { type: 3, name: "Bee" }, c: { type: "set", name: 4 } },
      edges: [{ from: "a", to: "b", when: "x", label: "go" }, "loose", { from: "b" }, { from: "b", to: "c", when: 1 }],
    };
    const graph = editorGraph(draft, { nodes: "none", edges: "none" }, [])!;
    expect(graph.start).toBe("");
    expect(graph.nodes.map((n) => [n.id, n.type, n.name, n.state])).toEqual([
      ["a", "unknown", undefined, "added"],
      ["b", "unknown", "Bee", "added"],
      ["c", "set", undefined, "added"],
    ]);
    expect(graph.edges).toEqual([
      { index: 0, from: "a", to: "b", when: "x", label: "go", added: true },
      { index: 3, from: "b", to: "c", added: true },
    ]);
  });

  it("draws a graph with no nodes, and a removed node however it was written", () => {
    const base = { nodes: { old: "text", named: { type: "set", name: "Named" } }, edges: [] };
    const graph = editorGraph({ nodes: [], edges: [] }, base, [])!;
    expect(graph.nodes.map((n) => [n.id, n.type, n.name, n.state])).toEqual([
      ["old", "unknown", undefined, "removed"],
      ["named", "set", "Named", "removed"],
    ]);
    expect(editorGraph(document, document, [{ node: "missing" }])).toBeUndefined();
  });
});

describe("changeCount", () => {
  it("counts changes inside nested graphs, and skips paths the draft no longer has", () => {
    const draft = structuredClone(document);
    draft.nodes.fan.branches.a.graph.nodes = { start: { type: "start" }, done: { type: "end" }, more: { type: "end" } };
    draft.nodes.again.body.graph.edges = [];
    // Both containers changed, a node added inside one and an edge taken away inside the other.
    expect(changeCount(draft, document)).toBe(4);
    expect(changeCount(document, document)).toBe(0);
    expect(changeCount("not a workflow", document)).toBe(0);
  });
});

describe("nestedSteps", () => {
  const steps = (id: string, doc: unknown = document, base: unknown = document) =>
    nestedSteps(editorGraph(doc, base, [])!.nodes.find((n) => n.id === id)!);

  it("lists a parallel node's branches that are graphs, then its for-each body", () => {
    expect(steps("fan")).toEqual([
      { node: "fan", branch: "a", label: "branch a" },
      { node: "fan", branch: "b", label: "branch b" },
      { node: "fan", forEach: true, label: "each item" },
    ]);
  });

  it("lists nothing for a removed container, a loop with no body, or a parallel node with neither", () => {
    expect(steps("again", { ...document, nodes: { start: document.nodes.start } })).toEqual([]);
    const bare = { nodes: { again: { type: "loop" }, fan: { type: "parallel", forEach: { body: "x" } } }, edges: [] };
    expect(steps("again", bare)).toEqual([]);
    expect(steps("fan", bare)).toEqual([]);
    expect(steps("start")).toEqual([]);
  });
});

describe("issuesAt", () => {
  it("files issues by node and by edge for the graph they belong to, and leaves the rest out", () => {
    const at = (graph: DraftIssue["graph"], extra: Partial<DraftIssue>): DraftIssue => ({
      severity: "error",
      message: "m",
      path: "p",
      graph,
      ...extra,
    });
    const issues = [
      at([], { node: "a" }),
      at([], { node: "a", edge: 1 }),
      at([], { edge: 1 }),
      at([], {}),
      at([{ node: "again" }], { node: "a" }),
    ];
    const root = issuesAt(issues, []);
    expect(root.byNode.get("a")).toHaveLength(2);
    expect(root.byEdge.get(1)).toHaveLength(2);
    const body = issuesAt(issues, [{ node: "again" }]);
    expect([...body.byNode.keys()]).toEqual(["a"]);
    expect(body.byEdge.size).toBe(0);
  });
});

describe("newNode and freshId", () => {
  it("gives every palette type a recognisable starting body", () => {
    for (const entry of PALETTE) expect(newNode(entry.type).type).toBe(entry.type);
    expect(newNode("decision")).toMatchObject({ options: ["yes", "no"] });
    expect(newNode("gate")).toMatchObject({ options: ["approve", "reject"] });
    expect(newNode("set")).toEqual({ type: "set", vars: { value: true } });
    expect(Object.keys(newNode("parallel").branches as object)).toEqual(["a", "b"]);
    expect(newNode("end")).toEqual({ type: "end", outcome: "success" });
    expect(newNode("custom:thing")).toEqual({ type: "custom:thing" });
  });

  it("points a new subworkflow at the first registered workflow, or a placeholder", () => {
    expect(newNode("subworkflow", { workflows: ["triage", "ship"] })).toEqual({
      type: "subworkflow",
      workflow: "triage",
    });
    expect(newNode("subworkflow", { workflows: [] })).toEqual({ type: "subworkflow", workflow: "workflow-id" });
    expect(newNode("subworkflow")).toEqual({ type: "subworkflow", workflow: "workflow-id" });
  });

  it("makes an id from any type, falling back to node", () => {
    expect(freshId("custom:", [])).toBe("node-1");
    expect(freshId("my type!", ["my-type--1"])).toBe("my-type--2");
  });
});
