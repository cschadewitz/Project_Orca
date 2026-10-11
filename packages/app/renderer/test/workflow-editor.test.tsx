// @vitest-environment happy-dom
/**
 * The visual workflow editor (#181, #182), through the chrome that mounts it: the viewer's
 * Edit button, then the gestures a person makes - palette, drop, drag, delete, review and
 * publish - asserted as the draft operations they send. The draft service itself is the
 * daemon's and tested there (`packages/daemon/test/workflow-drafts-service.test.ts`); the
 * bridge here is an in-memory stand-in that applies the few operations these tests make.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DraftIssue } from "@orca/protocol";
import { GRAPH_GEOMETRY } from "@orca/design";
import { NODE_TYPE_MIME } from "../src/workflow/editor/editor-canvas.js";
import { fromDirection, type GraphMetrics, type LayoutDirection } from "../src/workflow/layout.js";
import { harness, installBridge, renderChrome, stubMatchMedia } from "./harness.js";
import { draftBridge } from "./fixtures-workflow-drafts.js";

const EDIT_METRICS: GraphMetrics = {
  nodeW: GRAPH_GEOMETRY["node-w"],
  nodeH: GRAPH_GEOMETRY["node-h"],
  layerGap: GRAPH_GEOMETRY["layer-gap"],
  rankGap: GRAPH_GEOMETRY["rank-gap"],
};

const teardown: (() => void)[] = [];
beforeEach(() => stubMatchMedia(1440));
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

/** The viewer on ai-sdlc, then Edit: the editor on its draft. */
async function openEditor(options: { owner?: string; issues?: DraftIssue[]; direction?: LayoutDirection } = {}) {
  const fake = installBridge({ deepLink: "orca://workflow/ai-sdlc" });
  teardown.push(fake.install());
  const drafts = draftBridge(fake, options);
  const h = harness();
  teardown.push(h.dispose);
  // The direction is the person's, remembered before the window ever opened.
  if (options.direction) h.appearance.set({ canvases: { workflow: { direction: options.direction } } });
  renderChrome(h);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const canvas = await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  await act(async () => {});
  return { canvas, drafts };
}

describe("the workflow editor", () => {
  it("opens a draft from the viewer's Edit button, with the validation panel always shown", async () => {
    const { drafts } = await openEditor();
    expect(drafts.calls.map((c) => c.method)).toContain("workflowDrafts.open");
    expect(screen.getByRole("group", { name: "Workflow draft" }).textContent).toContain("Draft of ai-sdlc v1");
    expect(screen.getByRole("region", { name: "Validation" }).textContent).toContain("No problems");
    // The outline lists the draft's nodes in file order.
    const outline = screen.getByRole("list", { name: "Nodes, in file order" });
    expect(
      within(outline)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([expect.stringContaining("start"), expect.stringContaining("plan"), expect.stringContaining("done")]);
  });

  it("puts a palette node after the selected one by inserting it on that node's only edge", async () => {
    const { drafts } = await openEditor();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Gate/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    expect(drafts.ops()[0]).toMatchObject({ op: "insertNode", id: "gate-1", edge: 1, node: { type: "gate" } });
    // The new node is selected, and the inspector is on it.
    await screen.findByRole("complementary", { name: "Inspector" });
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Inspector" }).textContent).toContain("gate-1"),
    );
  });

  it("drops a palette item on empty canvas as a new node placed where it landed", async () => {
    const { canvas, drafts } = await openEditor();
    const dataTransfer = {
      types: [NODE_TYPE_MIME],
      getData: (type: string) => (type === NODE_TYPE_MIME ? "set" : ""),
      dropEffect: "",
    };
    fireEvent.dragOver(canvas, { dataTransfer, clientX: 400, clientY: 300 });
    fireEvent.drop(canvas, { dataTransfer, clientX: 400, clientY: 300 });
    await waitFor(() => expect(drafts.ops()).toHaveLength(2));
    expect(drafts.ops()[0]).toMatchObject({ op: "addNode", id: "set-1", node: { type: "set" } });
    expect(drafts.ops()[1]).toMatchObject({ op: "place", id: "set-1" });
  });

  it("moves a dragged node with a layout-only place operation", async () => {
    const { canvas, drafts } = await openEditor();
    const box = canvas.querySelector<HTMLElement>('[data-node-id="plan"]')!;
    fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 180, clientY: 160 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 180, clientY: 160 });
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    const [op] = drafts.ops();
    expect(op).toMatchObject({ op: "place", id: "plan" });
    expect(drafts.ops().some((o) => o.op !== "place")).toBe(false);
  });

  it("sends a drop in a top-to-bottom graph in the horizontal frame the shared layout keeps", async () => {
    /* The pins in `.layout/<id>.json` are everybody's and the direction is one person's, so a
       drop on a turned graph is mapped back onto the horizontal lattice before it is sent —
       and a teammate reading left to right sees the node beside the same neighbours. */
    const { canvas, drafts } = await openEditor({ direction: "vertical" });
    expect(canvas.closest(".orca-wfcanvas")!.getAttribute("data-direction")).toBe("vertical");
    const box = canvas.querySelector<HTMLElement>('[data-node-id="plan"]')!;
    // `plan` is the second layer: one layer step down the canvas, in the first column.
    const origin = { x: 0, y: EDIT_METRICS.nodeH + EDIT_METRICS.layerGap };
    expect([box.style.left, box.style.top]).toEqual([
      `${origin.x + EDIT_METRICS.rankGap}px`,
      `${origin.y + EDIT_METRICS.rankGap}px`,
    ]);

    fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 180, clientY: 160 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 180, clientY: 160 });
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    const kept = fromDirection({ x: origin.x + 80, y: origin.y + 60 }, "vertical", EDIT_METRICS);
    expect(drafts.ops()[0]).toEqual({ op: "place", id: "plan", x: kept.x, y: kept.y });
    // Further along the flow than its auto place, which left to right is to the right of it.
    expect(kept.x).toBeGreaterThan(EDIT_METRICS.nodeW + EDIT_METRICS.layerGap);
  });

  it("deletes the selected node with Delete and leaves its edges for validation to name", async () => {
    const { canvas, drafts } = await openEditor();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
    );
    act(() => canvas.focus());
    fireEvent.keyDown(canvas, { key: "Delete", code: "Delete" });
    await waitFor(() => expect(drafts.ops()).toEqual([{ op: "removeNode", id: "plan" }]));
  });

  it("rests quiet: the inspector's Delete and Delete edge wear no danger tone", async () => {
    await openEditor();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
    );
    const inspector = screen.getByRole("complementary", { name: "Inspector" });

    /* Both only edit the draft, which Undo takes back and only Review and publish writes, so
       they are ordinary buttons: status colour is the only saturation a resting screen
       carries (the brand book). */
    const remove = await within(inspector).findByRole("button", { name: "Delete" });
    expect(remove.className).not.toContain("orca-btn--danger");
    expect(inspector.querySelector(".orca-btn--danger")).toBeNull();

    fireEvent.click(within(inspector).getByRole("button", { name: "→ done" }));
    const removeEdge = await within(inspector).findByRole("button", { name: "Delete edge" });
    expect(removeEdge.className).not.toContain("orca-btn--danger");
    // Nowhere in the editor at rest: Discard takes the tone only once it is armed.
    expect(document.querySelector(".orca-btn--danger")).toBeNull();
  });

  it("deletes from the inspector in one press, into the draft, and ⌘Z brings the node back", async () => {
    const { canvas, drafts } = await openEditor();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
    );
    const inspector = screen.getByRole("complementary", { name: "Inspector" });
    fireEvent.click(await within(inspector).findByRole("button", { name: "Delete" }));

    // One press is one draft operation: nothing to arm, nothing to confirm, nothing published.
    await waitFor(() => expect(drafts.ops()).toEqual([{ op: "removeNode", id: "plan" }]));
    await waitFor(() => expect(inspector.textContent).toContain("This node is removed in the draft."));
    expect(screen.queryByRole("button", { name: /^(Keep|Confirm)/ })).toBeNull();
    expect(drafts.calls.some((call) => call.method === "workflowDrafts.publish")).toBe(false);

    act(() => canvas.focus());
    fireEvent.keyDown(canvas, { key: "z", code: "KeyZ", metaKey: true });
    await waitFor(() => expect(drafts.calls.map((call) => call.method)).toContain("workflowDrafts.undo"));
    await waitFor(() => expect(inspector.textContent).not.toContain("This node is removed in the draft."));
    expect(within(inspector).getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("deletes an edge from the inspector in one press, and Undo puts it back", async () => {
    const { drafts } = await openEditor();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
    );
    const inspector = screen.getByRole("complementary", { name: "Inspector" });
    fireEvent.click(within(inspector).getByRole("button", { name: "→ done" }));
    fireEvent.click(await within(inspector).findByRole("button", { name: "Delete edge" }));

    await waitFor(() => expect(drafts.ops()).toEqual([{ op: "removeEdge", index: 1 }]));
    // The selection goes with the edge, and the nothing-selected inspector counts the graph.
    await waitFor(() => expect(inspector.textContent).toMatch(/3 nodes, 1 edge/));
    expect(screen.queryByRole("button", { name: /^(Keep|Confirm)/ })).toBeNull();

    fireEvent.click(
      within(screen.getByRole("group", { name: "Workflow draft" })).getByRole("button", { name: "Undo" }),
    );
    await waitFor(() => expect(drafts.calls.map((call) => call.method)).toContain("workflowDrafts.undo"));
    await waitFor(() => expect(inspector.textContent).toContain("3 nodes, 2 edges"));
  });

  it("reviews the exact diff and publishes it, then returns to the viewer", async () => {
    const { drafts } = await openEditor();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /End/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    const review = screen.getByRole("button", { name: "Review and publish" });
    await waitFor(() => expect(review.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(review);
    const panel = await screen.findByRole("region", { name: "Publish v2" });
    expect(within(panel).getByLabelText("Changes to the workflow file").textContent).toContain('+ version: "2"');
    fireEvent.click(within(panel).getByRole("button", { name: "Publish v2" }));
    await waitFor(() =>
      expect(drafts.calls.find((c) => c.method === "workflowDrafts.publish")?.params).toMatchObject({
        reviewToken: "token-1",
      }),
    );
    await screen.findByRole("listbox", { name: /AI-native SDLC loop graph|ai-sdlc graph|graph$/ });
  });

  it("shows somebody else's draft read-only: no palette, no publish, no edits from the keys", async () => {
    const { canvas, drafts } = await openEditor({ owner: "robin" });
    expect(screen.getByRole("group", { name: "Workflow draft" }).textContent).toContain("robin's draft, read-only");
    expect(screen.queryByRole("button", { name: /Gate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review and publish" })).toBeNull();
    fireEvent.click(
      within(screen.getByRole("list", { name: "Nodes, in file order" })).getByRole("button", { name: /plan/ }),
    );
    act(() => canvas.focus());
    fireEvent.keyDown(canvas, { key: "Delete", code: "Delete" });
    await act(async () => {});
    expect(drafts.ops()).toEqual([]);
  });

  it("lists validation findings and goes to the node a row names", async () => {
    await openEditor({
      issues: [
        {
          severity: "error",
          message: "node 'plan' has no outgoing edges",
          path: "nodes.plan",
          graph: [],
          node: "plan",
        },
        {
          severity: "warning",
          message: "'vars' is not used by a end node.",
          path: "nodes.done.vars",
          graph: [],
          node: "done",
        },
      ],
    });
    const panel = screen.getByRole("region", { name: "Validation" });
    expect(panel.textContent).toContain("1 error · 1 warning · 0 notes");
    fireEvent.click(within(panel).getByRole("button", { name: "plan" }));
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Inspector" }).textContent).toContain("has no outgoing edges"),
    );
  });
});

describe("the Workflows surface", () => {
  async function onTheList() {
    const fake = installBridge();
    teardown.push(fake.install());
    const drafts = draftBridge(fake);
    const h = harness();
    teardown.push(h.dispose);
    renderChrome(h);
    fireEvent.click(await screen.findByRole("button", { name: "Workflows" }));
    const table = await screen.findByRole("table");
    return { drafts, table };
  }

  it("lists every registered workflow from the rail, with its version and size", async () => {
    const { table } = await onTheList();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBeGreaterThan(1);
    const row = within(table).getByText("ai-sdlc").closest("tr")!;
    expect(row.textContent).toMatch(/v\d/);
  });

  it("opens a workflow in the viewer, and straight into the editor from Edit", async () => {
    const { table, drafts } = await onTheList();
    const row = () => within(table).getByText("ai-sdlc").closest("tr")!;
    fireEvent.click(await within(row()).findByRole("button", { name: "Edit" }));
    await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
    expect(drafts.calls.map((c) => c.method)).toContain("workflowDrafts.open");

    // The rail's Workflows item goes back to the list, rather than reopening the workflow.
    fireEvent.click(screen.getByRole("button", { name: "Workflows" }));
    const again = await screen.findByRole("table");
    fireEvent.click(within(within(again).getByText("ai-sdlc").closest("tr")!).getByRole("button", { name: "Open" }));
    await screen.findByRole("listbox", { name: /graph$/ });
  });
});
