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
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { GRAPH_GEOMETRY } from "@orca/design";
import { depNodeDomId } from "../src/plan/dependency-graph.js";
import { buildGraph, cycleDependencies, relationships, ALL_EDGES } from "../src/plan/graph-model.js";
import { scheduleRowId } from "../src/plan/index.js";
import { counterpartUrl, describeRoute, planUrl, resolveRoute } from "../src/route-table.js";
import { layoutGraph, type PlacedNode } from "../src/workflow/layout.js";
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
  const graph = await screen.findByRole("listbox", { name: "Dependency graph" });
  /* The canvas registers its keys in a passive effect, which runs after the DOM `findByRole`
     resolved on — the same first-press window `workflow-surface.test.tsx` describes. One
     empty `act` flushes it, so a press below always meets a registered map. */
  await act(async () => {});
  return graph;
}

/** A key, pressed where the focus is: the `plan-graph` scope is resolved from the canvas outwards. */
function press(canvas: HTMLElement, key: string, code: string, shiftKey = false): void {
  act(() => canvas.focus());
  fireEvent.keyDown(canvas, { key, code, shiftKey });
}

const METRICS = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};

/** `plan.changed` for the dependencies, the way the daemon pushes it. */
const dependenciesChanged = (seq: number): void =>
  fake.notify({
    kind: "notification",
    method: "plan.changed",
    params: { subscriptionId: "sub-1", planId: "plan-sso", kinds: ["dependencies"], seq, at: AS_OF },
  });

const callsTo = (method: string): unknown[] => fake.calls.filter((call) => call.method === method).map((c) => c.params);
const edge = (id: string): SVGPathElement | null =>
  document.querySelector<SVGPathElement>(`g[data-dependency="${id}"] path`);
const focused = (graph: HTMLElement): string | null => graph.getAttribute("aria-activedescendant");

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

  it("has the workflow canvas's view controls and minimap, with a direction of its own", async () => {
    const graph = await openGraph();
    const controls = screen.getByRole("group", { name: "Dependency graph view" });
    const scene = graph.querySelector<HTMLElement>(".orca-wfcanvas__scene")!;
    // The same zoom as the keys: a click, then a press back.
    fireEvent.click(within(controls).getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(scene.style.transform).toContain("scale(1.5)"));
    press(graph, "-", "Minus");
    await waitFor(() => expect(scene.style.transform).toContain("scale(1)"));
    expect(document.querySelector(".orca-plan__canvas .orca-graphmap")?.getAttribute("aria-hidden")).toBe("true");

    // Turned top to bottom here, and only here: the plan is read apart from the workflows.
    fireEvent.click(within(controls).getByRole("button", { name: "Lay out top to bottom" }));
    await waitFor(() => expect(h.appearance.preferences().canvases?.["plan-graph"]?.direction).toBe("vertical"));
    expect(h.appearance.preferences().canvases?.workflow).toBeUndefined();
    const down = h.keyboard.list().find((s) => s.scope === "plan-graph" && s.key === "ArrowDown")!;
    expect(down.label).toBe("Next layer");
  });

  it("lands on orca://plan?mode=deps&focus=<slug> with that item focused", async () => {
    mount({ deepLink: planUrl("deps", "auth-docs") });
    const graph = await screen.findByRole("listbox", { name: "Dependency graph" });
    await waitFor(() => expect(graph.getAttribute("aria-activedescendant")).toBe(depNodeDomId("wi-docs")));
  });

  it("still lands on the mode when the focus names an item this plan does not have", async () => {
    mount({ deepLink: planUrl("deps", "no-such-item") });
    const graph = await screen.findByRole("listbox", { name: "Dependency graph" });
    expect(graph.getAttribute("aria-activedescendant")).toBeNull();
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
  it("draws a work item the rail hid in its own state, not as satisfied", () => {
    const ui = PLAN_ITEMS.find((item) => item.id === "wi-ui")!;
    // auth-api, hidden by the rail, is itself waiting on something that failed.
    const failing = {
      ...DEPENDENCIES[1]!,
      id: "dep-api-vendor",
      from: "wi-api",
      fromSlug: "auth-api",
      target: { kind: "external" as const, key: "vendor" },
      evaluation: { state: "failed" as const, detail: "vendor said no" },
    };
    const graph = buildGraph([ui], [...DEPENDENCIES, failing], ALL_EDGES);
    const api = graph.nodes.find((node) => node.id === "wi-api")!;
    expect(api.target).toBe("item");
    expect(api.state).toBe("failed");
  });

  it("inverts blocks from the from-side list, and finds the cycle's edges", () => {
    const { blocks } = relationships("wi-api", DEPENDENCIES);
    expect(blocks.map((d) => d.from).sort()).toEqual(["wi-docs", "wi-ui"]);
    expect([...cycleDependencies([["auth-ui", "auth-docs"]], CYCLE_DEPENDENCIES)].sort()).toEqual([
      "dep-docs-ui",
      "dep-ui-docs",
    ]);
  });

  it("lays out a graph with many roots, each at layer 0, and a cycle without dropping a node", () => {
    const graph = buildGraph(PLAN_ITEMS, CYCLE_DEPENDENCIES, ALL_EDGES);
    const layout = layoutGraph(graph, METRICS);
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

describe("the canvas's keys", () => {
  /* The placement the canvas navigates over, computed the way the surface computes it: the
     whole plan, every kind of edge. The keys' rule is the workflow canvas's, so what is
     asserted is where the rule lands on *this* graph, not the rule again. */
  const placed = layoutGraph(buildGraph(PLAN_ITEMS, DEPENDENCIES, ALL_EDGES), METRICS).nodes;
  const at = (layer: number, order: number): PlacedNode<{ id: string }> =>
    placed.find((p) => p.layer === layer && p.order === order)!;
  const nearest = (layer: number, order: number): PlacedNode<{ id: string }> =>
    placed
      .filter((p) => p.layer === layer)
      .reduce((best, p) => (Math.abs(p.order - order) < Math.abs(best.order - order) ? p : best));

  it("selects the first node when nothing is selected, then walks layers and ranks", async () => {
    const graph = await openGraph();
    await waitFor(() => expect(within(graph).getAllByRole("option").length).toBe(placed.length));
    expect(focused(graph)).toBeNull();
    // One tab stop: the canvas, and no node of its own.
    expect(graph.getAttribute("tabindex")).toBe("0");
    expect(
      within(graph)
        .getAllByRole("option")
        .some((node) => node.hasAttribute("tabindex")),
    ).toBe(false);

    // With nothing selected any arrow lands on the first placed node, which is a root.
    press(graph, "ArrowRight", "ArrowRight");
    await waitFor(() => expect(focused(graph)).toBe(depNodeDomId(placed[0]!.node.id)));
    expect(placed[0]!.layer).toBe(0);
    const start = placed[0]!;

    // Down and up move within the layer; up past the first rank stays put.
    press(graph, "ArrowDown", "ArrowDown");
    await waitFor(() => expect(focused(graph)).toBe(depNodeDomId(at(0, start.order + 1).node.id)));
    press(graph, "ArrowUp", "ArrowUp");
    await waitFor(() => expect(focused(graph)).toBe(depNodeDomId(start.node.id)));
    press(graph, "ArrowUp", "ArrowUp");
    await act(async () => {});
    expect(focused(graph)).toBe(depNodeDomId(start.node.id));

    // Left of layer 0 is nowhere; right lands on the nearest rank in the next layer.
    press(graph, "ArrowLeft", "ArrowLeft");
    await act(async () => {});
    expect(focused(graph)).toBe(depNodeDomId(start.node.id));
    press(graph, "ArrowRight", "ArrowRight");
    const next = nearest(1, start.order);
    await waitFor(() => expect(focused(graph)).toBe(depNodeDomId(next.node.id)));
    press(graph, "ArrowLeft", "ArrowLeft");
    await waitFor(() => expect(focused(graph)).toBe(depNodeDomId(nearest(0, next.order).node.id)));
  });

  it("selects a decision or an external target by key too, without making it the item selection", async () => {
    const graph = await openGraph();
    await waitFor(() => expect(within(graph).getAllByRole("option").length).toBe(placed.length));
    const decision = placed.find((p) => p.node.id === "decision:dec-datastore")!;
    // Walk down layer 0 until the decision is the focused node.
    press(graph, "ArrowRight", "ArrowRight");
    for (let order = placed[0]!.order; order < decision.order; order++) press(graph, "ArrowDown", "ArrowDown");
    await waitFor(() => expect(focused(graph)).toBe(depNodeDomId("decision:dec-datastore")));
    // The strip still asks for a work item: a decision is a node, not a row.
    expect(screen.getByRole("group", { name: "Selected work item" }).textContent).toContain("Select a work item");
  });

  it("opens the relationships on Enter, and asks nothing when nothing is selected", async () => {
    const graph = await openGraph();
    await waitFor(() => expect(document.getElementById(depNodeDomId("wi-api"))).not.toBeNull());
    press(graph, "Enter", "Enter");
    await act(async () => {});
    expect(screen.queryByLabelText(/^Relationships of/)).toBeNull();

    fireEvent.click(document.getElementById(depNodeDomId("wi-api"))!);
    await screen.findByLabelText("Relationships of auth-api");
    fireEvent.click(screen.getByRole("button", { name: /Close panel/ }));
    await waitFor(() => expect(screen.queryByLabelText("Relationships of auth-api")).toBeNull());

    // Enter is the ask that re-opens the dock a person closed.
    press(graph, "Enter", "Enter");
    await screen.findByLabelText("Relationships of auth-api");
  });

  it("zooms with + and -, pans with a shifted arrow, and 0 puts both back", async () => {
    const graph = await openGraph();
    const scene = graph.querySelector<HTMLElement>(".orca-wfcanvas__scene")!;
    const rest = scene.style.transform;
    expect(rest).toContain("scale(1)");

    press(graph, "+", "Equal", true);
    await waitFor(() => expect(scene.style.transform).toContain("scale(1.5)"));
    press(graph, "-", "Minus");
    await waitFor(() => expect(scene.style.transform).toBe(rest));
    // The zoom is clamped at both ends rather than running off the table: a quarter, which is
    // what zoom to fit needs to show a wide graph whole, and twice.
    press(graph, "-", "Minus");
    press(graph, "-", "Minus");
    press(graph, "-", "Minus");
    press(graph, "-", "Minus");
    await waitFor(() => expect(scene.style.transform).toContain("scale(0.25)"));
    for (let i = 0; i < 6; i++) press(graph, "+", "Equal", true);
    await waitFor(() => expect(scene.style.transform).toContain("scale(2)"));

    press(graph, "ArrowRight", "ArrowRight", true);
    press(graph, "ArrowDown", "ArrowDown", true);
    await waitFor(() => expect(scene.style.transform).toMatch(/translate\(-\d+px, -\d+px\)/));
    press(graph, "ArrowLeft", "ArrowLeft", true);
    press(graph, "ArrowUp", "ArrowUp", true);
    await waitFor(() => expect(scene.style.transform).toContain("translate(0px, 0px)"));
    // Panning selected nothing: the two are different verbs.
    expect(focused(graph)).toBeNull();

    press(graph, "0", "Digit0");
    await waitFor(() => expect(scene.style.transform).toBe(rest));
  });

  it("pans on a drag of the empty canvas, and never on a press that started on a node", async () => {
    const graph = await openGraph();
    await waitFor(() => expect(document.getElementById(depNodeDomId("wi-api"))).not.toBeNull());
    const scene = graph.querySelector<HTMLElement>(".orca-wfcanvas__scene")!;
    const rest = scene.style.transform;

    // A move with no press before it is nothing.
    fireEvent.pointerMove(graph, { clientX: 40, clientY: 40, pointerId: 1 });
    await act(async () => {});
    expect(scene.style.transform).toBe(rest);

    // A press on a node is a selection, and the move after it does not pan.
    fireEvent.pointerDown(document.getElementById(depNodeDomId("wi-api"))!, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(graph, { clientX: 50, clientY: 30, pointerId: 1 });
    await act(async () => {});
    expect(scene.style.transform).toBe(rest);

    // A press on the canvas itself drags it by the pointer's own delta, in two moves.
    fireEvent.pointerDown(graph, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(graph, { clientX: 50, clientY: 30, pointerId: 1 });
    await waitFor(() => expect(scene.style.transform).toContain("translate(40px, 20px)"));
    fireEvent.pointerMove(graph, { clientX: 60, clientY: 30, pointerId: 1 });
    await waitFor(() => expect(scene.style.transform).toContain("translate(50px, 20px)"));

    // Released with the capture the press took, when the platform has one, and without.
    let released = 0;
    Object.assign(graph, {
      hasPointerCapture: () => true,
      releasePointerCapture: () => {
        released += 1;
      },
    });
    fireEvent.pointerUp(graph, { clientX: 60, clientY: 30, pointerId: 1 });
    expect(released).toBe(1);
    Object.assign(graph, { hasPointerCapture: () => false });
    fireEvent.pointerCancel(graph, { pointerId: 1 });
    expect(released).toBe(1);
    // And after the release, a move is no longer a drag.
    fireEvent.pointerMove(graph, { clientX: 90, clientY: 90, pointerId: 1 });
    await act(async () => {});
    expect(scene.style.transform).toContain("translate(50px, 20px)");
  });
});

describe("the mode's states", () => {
  it("says it is loading until the dependencies answer", async () => {
    mount();
    const release = fake.hold("dependencies.list");
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.click(screen.getByRole("button", { name: "Dependencies" }));
    await screen.findByText("Loading the dependencies");
    expect(screen.queryByRole("listbox", { name: "Dependency graph" })).toBeNull();
    release();
    await screen.findByRole("listbox", { name: "Dependency graph" });
  });

  it("names the error and offers a retry while live, and calls it disconnected when nothing answers", async () => {
    await openGraph();
    fake.fail("dependencies.list", { code: "STORE_READ", message: "the plan store is unreadable" });
    await act(async () => dependenciesChanged(50));
    await screen.findByText("Could not load the dependencies");
    expect(screen.getByText("STORE_READ: the plan store is unreadable")).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "Dependency graph" })).toBeNull();

    const before = callsTo("dependencies.list").length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(callsTo("dependencies.list").length).toBe(before + 1));
    await screen.findByText("Could not load the dependencies");

    /* The daemon went away: the same daemon, so its capabilities stay on the snapshot — a
       snapshot with none would read as a daemon that serves no plan at all. */
    fake.connect({ ...fake.connection, state: "disconnected", since: AS_OF });
    await screen.findByText("No daemon to read the dependencies from");
    expect(screen.getByText("Start one with orca serve, then try again.")).toBeTruthy();
  });

  it("says there is nothing to draw when the filter leaves no item", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    await screen.findByRole("grid", { name: "Schedule" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter work items" }), {
      target: { value: "no-such-item" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Dependencies" }));
    await screen.findByText("Nothing to draw");
    expect(screen.queryByRole("listbox", { name: "Dependency graph" })).toBeNull();
  });

  it("pins a settled item's row under the canvas with its status rather than a schedule class", async () => {
    const graph = await openGraph();
    await waitFor(() => expect(document.getElementById(depNodeDomId("wi-spike"))).not.toBeNull());
    fireEvent.click(document.getElementById(depNodeDomId("wi-spike"))!);
    const strip = screen.getByRole("group", { name: "Selected work item" });
    await waitFor(() => expect(strip.textContent).toContain("auth-spike"));
    expect(strip.textContent).toContain("Spike the provider SDK");
    // Done: the strip says the status, and there is no score to print.
    expect(strip.textContent).toContain("done");
    expect(strip.querySelector(".orca-plan__score")).toBeNull();
    expect(focused(graph)).toBe(depNodeDomId("wi-spike"));
  });
});
