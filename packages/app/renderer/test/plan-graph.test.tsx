// @vitest-environment happy-dom
/**
 * The dependency graph as a mode of Plan (#171).
 *
 * The issue's "done when": the planning fixture with a cycle over `blocks` edges highlights
 * the cycle, and a waive from the relationship inspector updates what is on screen without
 * a refetch. Around those, the parts of option B that make it B: the selection shared with
 * the schedule, the deep link, the pinned strip, and one registration of the canvas's keys
 * in their own scope.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { GRAPH_GEOMETRY } from "@orca/design";
import { depNodeDomId } from "../src/plan/dependency-graph.js";
import { buildGraph, cycleDependencies, relationships, ALL_EDGES } from "../src/plan/graph-model.js";
import { scheduleRowId } from "../src/plan/index.js";
import { counterpartUrl, describeRoute, planUrl, resolveRoute } from "../src/route-table.js";
import { layoutGraph } from "../src/workflow/layout.js";
import { AS_OF } from "./fixtures.js";
import { CYCLE_DEPENDENCIES, CYCLE_SCHEDULE, DEPENDENCIES, PLAN_ITEMS } from "./fixtures-plan.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

beforeEach(() => {
  stubMatchMedia(1440);
});

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

function mount(options: { cycle?: boolean; deepLink?: string } = {}): void {
  fake = installBridge(options.deepLink === undefined ? {} : { deepLink: options.deepLink });
  teardown.push(fake.install());
  if (options.cycle) {
    fake.script({
      "dependencies.list": () => ({ ok: true, result: { dependencies: [...CYCLE_DEPENDENCIES], asOf: AS_OF } }),
      "schedule.get": () => ({ ok: true, result: { schedule: CYCLE_SCHEDULE, asOf: AS_OF } }),
    });
  }
  h = harness();
  teardown.push(h.dispose);
  renderChrome(h);
}

async function openGraph(options: { cycle?: boolean } = {}): Promise<HTMLElement> {
  mount(options);
  fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
  await screen.findByRole("grid", { name: "Schedule" });
  fireEvent.click(screen.getByRole("button", { name: "Dependencies" }));
  return screen.findByRole("listbox", { name: "Dependency graph" });
}

const callsTo = (method: string): unknown[] => fake.calls.filter((call) => call.method === method).map((c) => c.params);
const edge = (id: string): SVGPathElement | null =>
  document.querySelector<SVGPathElement>(`g[data-dependency="${id}"] path`);

describe("the graph", () => {
  it("draws every item and every target, with the kind as stroke and the state in words", async () => {
    const graph = await openGraph();
    await waitFor(() => expect(within(graph).getAllByRole("option").length).toBeGreaterThan(0));
    const names = within(graph)
      .getAllByRole("option")
      .map((node) => node.getAttribute("aria-label") ?? "");
    for (const item of PLAN_ITEMS) expect(names.some((n) => n.includes(`work item ${item.slug}`))).toBe(true);
    // A decision and an external target are nodes of their own kind, said in words.
    expect(names.some((n) => n.includes("decision datastore"))).toBe(true);
    expect(names.some((n) => n.includes("external legal-review"))).toBe(true);
    // The state leads the name, so a greyscale reading still has it.
    expect(names.find((n) => n.includes("work item auth-ui"))!.startsWith("open")).toBe(true);

    for (const dependency of DEPENDENCIES) {
      const path = edge(dependency.id)!;
      expect(path.getAttribute("class")).toContain(`orca-dep-edge--${dependency.type}`);
      expect(path.getAttribute("class")).toContain("orca-dep-edge--open");
      expect(path.getAttribute("class")).not.toContain("orca-dep-edge--cycle");
    }
  });

  it("highlights the blocks cycle the schedule reports, and nothing else", async () => {
    const graph = await openGraph({ cycle: true });
    await waitFor(() => expect(edge("dep-ui-docs")).not.toBeNull());
    expect(edge("dep-ui-docs")!.getAttribute("class")).toContain("orca-dep-edge--cycle");
    expect(edge("dep-docs-ui")!.getAttribute("class")).toContain("orca-dep-edge--cycle");
    expect(edge("dep-ui-api")!.getAttribute("class")).not.toContain("orca-dep-edge--cycle");
    // The two nodes on it say so, in words.
    const onCycle = within(graph)
      .getAllByRole("option")
      .filter((node) => (node.getAttribute("aria-label") ?? "").includes("on a cycle"))
      .map((node) => node.id);
    expect(onCycle.sort()).toEqual([depNodeDomId("wi-docs"), depNodeDomId("wi-ui")].sort());
    expect(screen.getByText(/close a cycle of blocks/)).toBeTruthy();
  });

  it("filters edges by kind from its own rail", async () => {
    await openGraph();
    await waitFor(() => expect(edge("dep-ui-api")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "blocks, solid" }));
    await waitFor(() => expect(edge("dep-ui-api")).toBeNull());
  });
});

describe("selection shared with the schedule", () => {
  it("makes the selected row the focused node and the reverse, with the row pinned under it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    const table = await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.click(
      within(table)
        .getAllByRole("row")
        .find((row) => row.id === scheduleRowId("wi-ui"))!,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dependencies" }));
    const graph = await screen.findByRole("listbox", { name: "Dependency graph" });
    await waitFor(() => expect(graph.getAttribute("aria-activedescendant")).toBe(depNodeDomId("wi-ui")));
    expect(screen.getByRole("group", { name: "Selected work item" }).textContent).toContain("auth-ui");

    fireEvent.click(document.getElementById(depNodeDomId("wi-api"))!);
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "Selected work item" }).textContent).toContain("auth-api"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    const back = await screen.findByRole("grid", { name: "Schedule" });
    expect(back.getAttribute("aria-activedescendant")).toBe(scheduleRowId("wi-api"));
  });
});

describe("the relationship inspector", () => {
  it("names itself, and lists what the node is blocked by and what it blocks", async () => {
    await openGraph();
    await waitFor(() => expect(document.getElementById(depNodeDomId("wi-api"))).not.toBeNull());
    fireEvent.click(document.getElementById(depNodeDomId("wi-api"))!);
    const inspector = await screen.findByLabelText("Relationships of auth-api");
    expect(document.querySelector(".orca-panel .orca-pane__head")!.textContent).toContain("Relationships");
    expect(within(inspector).getByLabelText("Blocked by").textContent).toContain("It waits for nothing.");
    const blocks = within(inspector).getByLabelText("Blocks").textContent ?? "";
    expect(blocks).toContain("auth-ui");
    expect(blocks).toContain("auth-docs");
  });

  it("waives with a confirmation naming what it unblocks, and updates without a refetch", async () => {
    await openGraph();
    await waitFor(() => expect(document.getElementById(depNodeDomId("wi-ui"))).not.toBeNull());
    fireEvent.click(document.getElementById(depNodeDomId("wi-ui"))!);
    const inspector = await screen.findByLabelText("Relationships of auth-ui");
    fireEvent.click(within(inspector).getByRole("button", { name: "Waive auth-api…" }));

    const confirm = within(inspector).getByRole("group", { name: "Waive dep-ui-api" });
    expect(confirm.textContent).toContain("auth-ui stops waiting for it");
    expect(callsTo("dependencies.waive")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Waive, unblocking auth-ui" }));

    await waitFor(() =>
      expect(callsTo("dependencies.waive")).toEqual([{ planId: "plan-sso", dependencyId: "dep-ui-api" }]),
    );
    await waitFor(() => expect(edge("dep-ui-api")!.getAttribute("class")).toContain("orca-dep-edge--waived"));
    expect((await screen.findByLabelText("Relationships of auth-ui")).textContent).toContain("blocks, waived");
    // Folded in from the waive's own answer: the graph read once, and only once.
    expect(
      callsTo("dependencies.list").filter((p) => (p as { workItemId?: string }).workItemId === undefined),
    ).toHaveLength(1);
  });
});

describe("keys and links", () => {
  it("registers the canvas's keys once, in the plan-graph scope", async () => {
    await openGraph();
    const mine = h.keyboard.list().filter((s) => s.scope === "plan-graph");
    expect(mine.filter((s) => s.key === "ArrowDown")).toHaveLength(1);
    expect(mine.map((s) => s.key)).toEqual(
      expect.arrayContaining(["ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "+", "-", "0", "Shift+ArrowUp"]),
    );
    expect(
      screen
        .getByRole("listbox", { name: "Dependency graph" })
        .closest("[data-kbd-scope]")!
        .getAttribute("data-kbd-scope"),
    ).toBe("plan-graph");
  });

  it("lands on orca://plan?mode=deps&focus=<slug> with that item focused", async () => {
    mount({ deepLink: planUrl("deps", "auth-docs") });
    const graph = await screen.findByRole("listbox", { name: "Dependency graph" });
    await waitFor(() => expect(graph.getAttribute("aria-activedescendant")).toBe(depNodeDomId("wi-docs")));
  });

  it("resolves, describes and builds the link, and the item's dependencies counterpart follows it", () => {
    const url = "orca://plan?mode=deps&focus=auth-ui";
    expect(resolveRoute(url)).toEqual({ kind: "plan", surface: "plan", mode: "deps", focus: "auth-ui" });
    expect(planUrl("deps", "auth-ui")).toBe(url);
    expect(describeRoute({ kind: "plan", surface: "plan", mode: "deps", focus: "auth-ui" })).toEqual({
      type: "dependencies of",
      id: "auth-ui",
    });
    expect(resolveRoute("orca://plan/extra")).toBeUndefined();
    expect(
      counterpartUrl([], { type: "item", id: "wi-ui", label: "Wire the login button" }, { id: "dependencies" }),
    ).toBe("orca://plan?mode=deps&focus=wi-ui");
  });
});

describe("the model and the layout", () => {
  it("inverts blocks from the from-side list, and finds the cycle's edges", () => {
    const { blocks } = relationships("wi-api", DEPENDENCIES);
    expect(blocks.map((d) => d.from).sort()).toEqual(["wi-docs", "wi-ui"]);
    expect([...cycleDependencies([["auth-ui", "auth-docs"]], CYCLE_DEPENDENCIES)].sort()).toEqual([
      "dep-docs-ui",
      "dep-ui-docs",
    ]);
  });

  it("lays out a graph with many roots, each at layer 0, and a cycle without dropping a node", () => {
    const metrics = {
      nodeW: GRAPH_GEOMETRY["node-w"],
      nodeH: GRAPH_GEOMETRY["node-h"],
      layerGap: GRAPH_GEOMETRY["layer-gap"],
      rankGap: GRAPH_GEOMETRY["rank-gap"],
    };
    const graph = buildGraph(PLAN_ITEMS, CYCLE_DEPENDENCIES, ALL_EDGES);
    const layout = layoutGraph(graph, metrics);
    expect(layout.nodes).toHaveLength(graph.nodes.length);
    const layer = (id: string): number => layout.nodes.find((p) => p.node.id === id)!.layer;
    // Three independent roots — an item, a decision and an external target — side by side.
    expect(layer("wi-api")).toBe(0);
    expect(layer("decision:dec-datastore")).toBe(0);
    expect(layer("external:legal-review")).toBe(0);
    expect(layer("wi-store")).toBe(1);
    // Exactly one edge of the two-node cycle is drawn backwards.
    const back = layout.edges.filter((e) => e.isBack).map((e) => e.edge.dependency.id);
    expect(back.filter((id) => id === "dep-ui-docs" || id === "dep-docs-ui")).toHaveLength(1);
  });
});
