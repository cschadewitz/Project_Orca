// @vitest-environment happy-dom
/**
 * The visual workflow editor (#181) beyond its first gestures: the canvas's keys, the
 * pointer gestures that are not a plain drag, the draft bar, the editor's own failure states,
 * and nested graphs. Each is asserted as what reaches the draft - the operations sent, the
 * calls made - or as what the person is told.
 *
 * Most tests use the in-memory draft service from `fixtures-workflow-drafts.ts`. The nested
 * graph and refusal tests need a document and answers that one does not have, so they swap
 * in `scripted`, which records every call and answers from a fixed document.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { DraftIssue, DraftOperation, WorkflowDraftView } from "@orca/protocol";
import { ZOOM_MAX, ZOOM_MIN } from "../src/ui/canvas-view.js";
import { NODE_TYPE_MIME } from "../src/workflow/editor/editor-canvas.js";
import { newNode } from "../src/workflow/editor/draft-model.js";
import type { WorkflowDraftBridge } from "../../src/workflow-draft-bridge.js";
import type { FakeBridge } from "./fake-bridge.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import { draftBridge } from "./fixtures-workflow-drafts.js";

const teardown: (() => void)[] = [];
beforeEach(() => stubMatchMedia(1440));
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

type Answer = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
type Call = { method: string; params: Record<string, unknown> };

const loopBody = () => newNode("loop").body;
const NESTED = {
  id: "ai-sdlc",
  name: "AI-native SDLC loop",
  version: "1",
  start: "start",
  nodes: {
    start: { type: "start" },
    again: newNode("loop"),
    fan: { type: "parallel", branches: { a: loopBody() }, forEach: { items: "=vars.list", body: loopBody() } },
    choose: newNode("decision"),
    done: { type: "end" },
  },
  edges: [
    { from: "start", to: "again" },
    { from: "again", to: "fan" },
    { from: "fan", to: "choose" },
    { from: "choose", to: "done", when: "choice == 'yes'" },
    { from: "choose", to: "done", when: "choice == 'no'", label: "no" },
  ],
};

/**
 * A draft service with a fixed document: every write is recorded and answered with the next
 * revision of `document` (which a test may swap), unless `answers` says otherwise.
 */
function scripted(
  fake: FakeBridge,
  options: {
    document?: unknown;
    answers?: Record<string, (params: Record<string, unknown>) => Answer | undefined>;
    issues?: DraftIssue[];
    current?: boolean;
  } = {},
) {
  draftBridge(fake); // advertises the draft methods on the connection
  let document: unknown = "document" in options ? options.document : NESTED;
  let revision = 0;
  /** Whether a draft exists: the viewer offers Edit before one does, Continue editing after. */
  let opened = false;
  const calls: Call[] = [];
  const view = (): WorkflowDraftView => ({
    workflowId: "ai-sdlc",
    owner: { principalId: "local", you: true },
    revision,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:00:00.000Z",
    base: { version: "1", revision: "sha256:base", current: options.current ?? true, text: "", document: NESTED },
    text: "",
    document: structuredClone(document),
    layout: { graphs: {} },
    issues: options.issues ?? [],
    dirty: revision > 0,
    canUndo: revision > 0,
    canRedo: false,
  });
  const call = async (method: string, params: Record<string, unknown>): Promise<Answer> => {
    calls.push({ method, params });
    const answer = options.answers?.[method]?.(params);
    if (answer) return answer;
    if (method === "workflowDrafts.get")
      return { ok: true, result: { draft: opened ? view() : null, layout: { graphs: {} }, editable: true } };
    if (method === "workflowDrafts.discard") {
      opened = false;
      return { ok: true, result: { discarded: true } };
    }
    if (method === "workflowDrafts.open") opened = true;
    else revision += 1;
    return { ok: true, result: view() };
  };
  fake.bridge.workflowDrafts = { call } as unknown as WorkflowDraftBridge;
  return {
    calls,
    ops: () =>
      calls.filter((c) => c.method === "workflowDrafts.apply").flatMap((c) => c.params.ops as DraftOperation[]),
    setDocument: (next: unknown) => (document = next),
  };
}

/** The viewer on ai-sdlc, with the draft service `setup` installs, then Edit. */
async function openEditor<T>(
  setup: (fake: FakeBridge) => T,
  beforeEdit?: (fake: FakeBridge) => void,
): Promise<{ drafts: T; h: Harness; said: string[] }> {
  const fake = installBridge({ deepLink: "orca://workflow/ai-sdlc" });
  teardown.push(fake.install());
  const drafts = setup(fake);
  const h = harness();
  teardown.push(h.dispose);
  const said: string[] = [];
  teardown.push(h.announcements.subscribe((sentence) => said.push(sentence)));
  renderChrome(h);
  const edit = await screen.findByRole("button", { name: "Edit" });
  beforeEdit?.(fake);
  fireEvent.click(edit);
  await act(async () => {});
  return { drafts, h, said };
}

async function onCanvas<T>(setup: (fake: FakeBridge) => T) {
  const opened = await openEditor(setup);
  const canvas = await screen.findByRole("listbox", { name: "ai-sdlc draft graph" });
  act(() => canvas.focus());
  return { ...opened, canvas };
}

const outline = () => screen.getByRole("list", { name: "Nodes, in file order" });
const pick = (id: string) =>
  fireEvent.click(within(outline()).getByRole("button", { name: new RegExp(`\\b${id}\\b`) }));
const inspector = () => screen.getByRole("complementary", { name: "Inspector" });
const bar = () => screen.getByRole("group", { name: "Workflow draft" });
const scene = (canvas: HTMLElement) => canvas.querySelector<HTMLElement>(".orca-wfcanvas__scene")!;
const box = (canvas: HTMLElement, id: string) => canvas.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
const key = (canvas: HTMLElement, init: KeyboardEventInit) => act(() => void fireEvent.keyDown(canvas, init));
const PALETTE_DROP = (type: string) => ({
  types: [NODE_TYPE_MIME],
  getData: (format: string) => (format === NODE_TYPE_MIME ? type : ""),
  dropEffect: "",
});

describe("the canvas's keys", () => {
  it("walks the selection with the arrows, starting from the start node", async () => {
    const { canvas } = await onCanvas((fake) => draftBridge(fake));
    const active = () => canvas.getAttribute("aria-activedescendant");
    expect(active()).toBeNull();
    key(canvas, { key: "ArrowRight" });
    expect(active()).toBe("orca-wfedit-node-start");
    key(canvas, { key: "ArrowRight" });
    expect(active()).toBe("orca-wfedit-node-plan");
    key(canvas, { key: "ArrowRight" });
    key(canvas, { key: "ArrowRight" });
    expect(active()).toBe("orca-wfedit-node-done");
    key(canvas, { key: "ArrowLeft" });
    expect(active()).toBe("orca-wfedit-node-plan");
    key(canvas, { key: "ArrowDown" });
    key(canvas, { key: "ArrowUp" });
    expect(active()).toBe("orca-wfedit-node-plan");
  });

  it("removes a selected edge, keeps the start node, and deletes with connections on Shift+Delete", async () => {
    const { canvas, drafts, said } = await onCanvas((fake) => draftBridge(fake));
    fireEvent.click(canvas.querySelector('[data-edge-index="1"]')!);
    expect(inspector().textContent).toContain("plan → done");
    key(canvas, { key: "Backspace" });
    await waitFor(() => expect(drafts.ops()).toEqual([{ op: "removeEdge", index: 1 }]));
    // The selection moves to the node the edge left from.
    await waitFor(() => expect(canvas.getAttribute("aria-activedescendant")).toBe("orca-wfedit-node-plan"));
    pick("start");
    key(canvas, { key: "Delete" });
    expect(said).toContain("The start node stays. Connect it to something else instead.");
    pick("plan");
    key(canvas, { key: "Delete", shiftKey: true });
    await waitFor(() => expect(drafts.ops()).toHaveLength(2));
    expect(drafts.ops()[1]).toEqual({ op: "removeNode", id: "plan", detach: true });
  });

  it("renames on F2, connects on C, and goes to the palette on Mod+Enter", async () => {
    const { canvas } = await onCanvas((fake) => draftBridge(fake));
    pick("plan");
    key(canvas, { key: "F2" });
    expect(document.activeElement).toBe(within(inspector()).getByLabelText(/^Id/));
    key(canvas, { key: "c", code: "KeyC" });
    expect(screen.getByRole("menu", { name: "Connect to" })).toBeTruthy();
    key(canvas, { key: "Enter", metaKey: true });
    expect(document.activeElement?.textContent).toContain("Agent step");
  });

  it("reorders the selected node with Alt and the arrows, and undoes and redoes from the keys", async () => {
    const { canvas, drafts } = await onCanvas((fake) => draftBridge(fake));
    pick("start");
    key(canvas, { key: "ArrowUp", altKey: true });
    pick("plan");
    key(canvas, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(drafts.ops()).toEqual([{ op: "moveNode", id: "plan", before: "start" }]));
    key(canvas, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(drafts.ops()[1]).toEqual({ op: "moveNode", id: "plan" }));
    key(canvas, { key: "z", code: "KeyZ", metaKey: true });
    key(canvas, { key: "z", code: "KeyZ", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(drafts.calls.map((c) => c.method).filter((m) => m.endsWith("do"))).toEqual([
        "workflowDrafts.undo",
        "workflowDrafts.redo",
      ]),
    );
  });

  it("zooms and pans from the keys, and 0 puts both back", async () => {
    const { canvas } = await onCanvas((fake) => draftBridge(fake));
    const transform = () => scene(canvas).style.transform;
    expect(transform()).toBe("translate(0px, 0px) scale(1)");
    for (let i = 0; i < 3; i += 1) key(canvas, { key: "+", code: "Equal", shiftKey: true });
    expect(transform()).toContain(`scale(${ZOOM_MAX})`);
    for (let i = 0; i < 6; i += 1) key(canvas, { key: "-", code: "Minus" });
    expect(transform()).toContain(`scale(${ZOOM_MIN})`);
    key(canvas, { key: "ArrowRight", shiftKey: true });
    key(canvas, { key: "ArrowDown", shiftKey: true });
    expect(transform()).not.toContain("translate(0px, 0px)");
    key(canvas, { key: "ArrowLeft", shiftKey: true });
    key(canvas, { key: "ArrowUp", shiftKey: true });
    expect(transform()).toBe(`translate(0px, 0px) scale(${ZOOM_MIN})`);
    key(canvas, { key: "ArrowRight", shiftKey: true });
    key(canvas, { key: "0", code: "Digit0" });
    expect(transform()).toBe("translate(0px, 0px) scale(1)");
  });

  it("does nothing that writes on somebody else's draft", async () => {
    const { canvas, drafts } = await onCanvas((fake) => draftBridge(fake, { owner: "robin" }));
    pick("plan");
    key(canvas, { key: "F2" });
    key(canvas, { key: "c", code: "KeyC" });
    key(canvas, { key: "ArrowUp", altKey: true });
    key(canvas, { key: "z", code: "KeyZ", metaKey: true });
    key(canvas, { key: "Enter", metaKey: true });
    await act(async () => {});
    expect(screen.queryByRole("menu", { name: "Connect to" })).toBeNull();
    const reads = new Set(["workflowDrafts.get", "workflowDrafts.open"]);
    expect(drafts.calls.filter((c) => !reads.has(c.method))).toEqual([]);
    // Nor can a node be dragged or wired.
    expect(canvas.querySelector(".orca-wfedit__port")).toBeNull();
    fireEvent.pointerDown(box(canvas, "plan"), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(box(canvas, "plan"), { pointerId: 1, clientX: 90, clientY: 90 });
    fireEvent.pointerUp(box(canvas, "plan"), { pointerId: 1, clientX: 90, clientY: 90 });
    await act(async () => {});
    expect(drafts.ops()).toEqual([]);
  });

  it("opens a container on Enter or a double-click, and Enter on a plain node does nothing", async () => {
    const { canvas, drafts } = await onCanvas((fake) => scripted(fake));
    pick("choose");
    key(canvas, { key: "Enter" });
    expect(screen.queryByRole("navigation", { name: "Graph" })).toBeNull();
    pick("again");
    key(canvas, { key: "Enter" });
    const trail = await screen.findByRole("navigation", { name: "Graph" });
    expect(trail.textContent).toContain("again");
    fireEvent.click(within(trail).getByRole("button", { name: "ai-sdlc" }));
    expect(screen.queryByRole("navigation", { name: "Graph" })).toBeNull();
    fireEvent.doubleClick(box(canvas, "start"));
    expect(screen.queryByRole("navigation", { name: "Graph" })).toBeNull();
    fireEvent.doubleClick(box(canvas, "fan"));
    expect((await screen.findByRole("navigation", { name: "Graph" })).textContent).toContain("fan [a]");
    expect(drafts.ops()).toEqual([]);
  });
});

describe("the canvas's pointer gestures", () => {
  it("connects two nodes by dragging from one node's port onto another", async () => {
    const { canvas, drafts } = await onCanvas((fake) => draftBridge(fake));
    const had = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    let under: Element | null = box(canvas, "done");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => under });
    teardown.push(() =>
      had
        ? Object.defineProperty(document, "elementFromPoint", had)
        : delete (document as Partial<Document>).elementFromPoint,
    );
    const port = box(canvas, "start").querySelector<HTMLElement>(".orca-wfedit__port")!;
    fireEvent.pointerDown(port, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(port, { pointerId: 2, clientX: 300, clientY: 40 });
    expect(port.className).toContain("orca-port--armed");
    fireEvent.pointerUp(port, { pointerId: 2, clientX: 300, clientY: 40 });
    await waitFor(() => expect(drafts.ops()).toEqual([{ op: "addEdge", from: "start", to: "done" }]));
    // Onto itself, onto nothing, or with another button: no edge.
    under = box(canvas, "start");
    fireEvent.pointerDown(port, { button: 0, pointerId: 3 });
    fireEvent.pointerUp(port, { pointerId: 3 });
    under = null;
    fireEvent.pointerDown(port, { button: 0, pointerId: 4 });
    fireEvent.pointerUp(port, { pointerId: 4 });
    fireEvent.pointerDown(port, { button: 2, pointerId: 5 });
    fireEvent.pointerMove(port, { pointerId: 5, clientX: 1, clientY: 1 });
    fireEvent.pointerUp(port, { pointerId: 5 });
    await act(async () => {});
    expect(drafts.ops()).toHaveLength(1);
    expect(canvas.querySelector(".orca-port--armed")).toBeNull();
  });

  it("takes a press that hardly moves, or with another button, as no drag at all", async () => {
    const { canvas, drafts } = await onCanvas((fake) => draftBridge(fake));
    const plan = box(canvas, "plan");
    fireEvent.pointerDown(plan, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(plan, { pointerId: 9, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(plan, { pointerId: 1, clientX: 101, clientY: 100 });
    fireEvent.pointerUp(plan, { pointerId: 1, clientX: 101, clientY: 100 });
    fireEvent.pointerDown(plan, { button: 1, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(plan, { pointerId: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(plan, { pointerId: 2, clientX: 300, clientY: 300 });
    await act(async () => {});
    expect(drafts.ops()).toEqual([]);
  });

  it("pans by dragging the empty canvas, which also clears the selection", async () => {
    const { canvas } = await onCanvas((fake) => draftBridge(fake));
    pick("plan");
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerDown(box(canvas, "plan"), { button: 0, pointerId: 7, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(box(canvas, "plan"), { pointerId: 7, clientX: 5, clientY: 5 });
    expect(within(inspector()).getByText("plan")).toBeTruthy();
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(within(inspector()).getByText("workflow")).toBeTruthy();
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 40, clientY: 30 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 40, clientY: 30 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 90 });
    expect(scene(canvas).style.transform).toBe("translate(30px, 20px) scale(1)");
  });

  it("inserts a palette item dropped on an edge into that edge, and ignores drops it cannot use", async () => {
    const { canvas, drafts } = await onCanvas((fake) => draftBridge(fake));
    const edge = canvas.querySelector<SVGElement>('[data-edge-index="1"]')!;
    fireEvent.dragOver(edge, { dataTransfer: PALETTE_DROP("gate") });
    expect(canvas.querySelector(".orca-wfedit__edge--drop")).not.toBeNull();
    fireEvent.dragLeave(canvas);
    expect(canvas.querySelector(".orca-wfedit__edge--drop")).toBeNull();
    // Something that is not a palette item, and a palette drag with no type in it.
    fireEvent.dragOver(canvas, { dataTransfer: { types: ["text/plain"], getData: () => "x", dropEffect: "" } });
    fireEvent.drop(canvas, { dataTransfer: { types: ["text/plain"], getData: () => "x", dropEffect: "" } });
    fireEvent.drop(canvas, { dataTransfer: PALETTE_DROP("") });
    await act(async () => {});
    expect(drafts.ops()).toEqual([]);
    fireEvent.drop(edge, { dataTransfer: PALETTE_DROP("gate") });
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    expect(drafts.ops()[0]).toMatchObject({ op: "insertNode", id: "gate-1", edge: 1, node: { type: "gate" } });
  });

  it("refuses palette drops on somebody else's draft", async () => {
    const { canvas, drafts } = await onCanvas((fake) => draftBridge(fake, { owner: "robin" }));
    fireEvent.dragOver(canvas, { dataTransfer: PALETTE_DROP("set") });
    fireEvent.drop(canvas, { dataTransfer: PALETTE_DROP("set") });
    await act(async () => {});
    expect(drafts.ops()).toEqual([]);
  });
});

describe("the draft bar", () => {
  it("counts changes, undoes, redoes and tidies", async () => {
    const { drafts } = await openEditor((fake) => draftBridge(fake));
    expect(bar().textContent).toContain("your draft · 0 changes");
    fireEvent.click(screen.getByRole("button", { name: /Set variables/ }));
    await waitFor(() => expect(bar().textContent).toContain("1 change"));
    expect(drafts.ops()).toEqual([expect.objectContaining({ op: "addNode", id: "set-1" })]);
    expect(bar().textContent).toContain("Saved in the draft");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(2));
    expect(drafts.ops()[1]).toEqual({ op: "tidy" });
    expect(drafts.calls.map((c) => c.method)).toContain("workflowDrafts.undo");
    expect(screen.getByRole("button", { name: "Redo" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("says when only the layout changed", async () => {
    const { canvas, drafts } = await onCanvas((fake) => draftBridge(fake));
    const plan = box(canvas, "plan");
    fireEvent.pointerDown(plan, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(plan, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(plan, { pointerId: 1, clientX: 200, clientY: 200 });
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    await waitFor(() => expect(bar().textContent).toContain("0 changes to the layout"));
    expect(plan.textContent).toContain("pinned");
  });

  it("asks before discarding, forgets the question when focus leaves, and closes once the draft is gone", async () => {
    const { drafts, said } = await openEditor((fake) => scripted(fake));
    const discard = () => within(bar()).getByRole("button", { name: /^Discard/ });
    fireEvent.click(discard());
    expect(discard().textContent).toBe("Discard every change");
    fireEvent.blur(discard());
    expect(discard().textContent).toBe("Discard draft");
    fireEvent.click(discard());
    fireEvent.click(discard());
    await screen.findByRole("listbox", { name: /graph$/ });
    expect(drafts.calls.map((c) => c.method)).toContain("workflowDrafts.discard");
    expect(said).toContain("Draft discarded.");
    expect(screen.queryByRole("group", { name: "Workflow draft" })).toBeNull();
  });

  it("stays open when a discard is refused, and says why", async () => {
    await openEditor((fake) =>
      scripted(fake, {
        answers: { "workflowDrafts.discard": () => ({ ok: false, error: { code: "X", message: "Kept." } }) },
      }),
    );
    const discard = () => within(bar()).getByRole("button", { name: /^Discard/ });
    fireEvent.click(discard());
    fireEvent.click(discard());
    await waitFor(() => expect(bar().textContent).toContain("Kept."));
  });

  it("closes the editor back to the viewer, keeping the draft", async () => {
    const { drafts } = await openEditor((fake) => draftBridge(fake));
    fireEvent.click(screen.getByRole("button", { name: "Close the editor" }));
    await screen.findByRole("button", { name: "Edit" });
    expect(drafts.calls.map((c) => c.method)).not.toContain("workflowDrafts.discard");
  });

  it("goes back from a review, and will not publish while there are errors", async () => {
    const issues: DraftIssue[] = [
      { severity: "error", message: "node 'plan' has no outgoing edges", path: "nodes.plan", graph: [], node: "plan" },
    ];
    const { drafts } = await openEditor((fake) => draftBridge(fake, { issues }));
    fireEvent.click(screen.getByRole("button", { name: /End/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    const review = screen.getByRole("button", { name: "Review and publish" });
    await waitFor(() => expect(review.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(review);
    const panel = await screen.findByRole("region", { name: "Publish v2" });
    expect(within(panel).getByRole("button", { name: "Publish v2" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(panel).getByRole("button", { name: "Back to editing" }));
    expect(screen.queryByRole("region", { name: "Publish v2" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "ai-sdlc draft graph" })).toBeTruthy();
  });

  it("keeps the review open and says why when a publish is refused", async () => {
    const { drafts } = await openEditor((fake) =>
      scripted(fake, {
        answers: {
          "workflowDrafts.review": () => ({
            ok: true,
            result: {
              revision: 0,
              baseVersion: "1",
              nextVersion: "2",
              baseText: "a: 1\n",
              text: "a: 2\n",
              reviewToken: "t",
            },
          }),
          "workflowDrafts.publish": () => ({ ok: false, error: { code: "CONFIG_INVALID", message: "Refused." } }),
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Set variables/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
    const panel = await screen.findByRole("region", { name: "Publish v2" });
    fireEvent.click(within(panel).getByRole("button", { name: "Publish v2" }));
    await waitFor(() => expect(within(panel).getByRole("status").textContent).toBe("Refused."));
    expect(screen.getByRole("region", { name: "Publish v2" })).toBeTruthy();
  });

  it("says a refused review in the bar and stays editing", async () => {
    const { drafts } = await openEditor((fake) =>
      scripted(fake, {
        answers: { "workflowDrafts.review": () => ({ ok: false, error: { code: "X", message: "Not now." } }) },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Set variables/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
    await waitFor(() => expect(bar().textContent).toContain("Not now."));
    expect(screen.queryByRole("region", { name: "Publish v2" })).toBeNull();
  });

  it("says the draft was reloaded when another window moved it on", async () => {
    await openEditor((fake) =>
      scripted(fake, {
        answers: {
          "workflowDrafts.apply": () => ({
            ok: false,
            error: { code: "CONFIG_STALE", message: "The draft changed in another window." },
          }),
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Set variables/ }));
    await waitFor(() => expect(bar().textContent).toContain("Reloaded: The draft changed in another window."));
    expect(bar().className).toContain("orca-draftbar--blocked");
  });

  it("says a draft taken from an older file cannot be published", async () => {
    await openEditor((fake) => scripted(fake, { current: false }));
    expect(bar().textContent).toContain(
      "The workflow file changed since this draft was taken; it cannot be published.",
    );
    expect(bar().className).toContain("orca-draftbar--blocked");
  });
});

describe("opening the editor", () => {
  it("says why a draft could not be opened, and goes back to the viewer", async () => {
    await openEditor((fake) =>
      scripted(fake, {
        answers: { "workflowDrafts.open": () => ({ ok: false, error: { code: "X", message: "Locked." } }) },
      }),
    );
    expect(await screen.findByText("Could not open a draft")).toBeTruthy();
    expect(screen.getByText("Locked.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the viewer" }));
    await screen.findByRole("button", { name: "Edit" });
  });

  it("says editing is not available when the draft bridge is gone by the time the editor opens", async () => {
    await openEditor(
      (fake) => draftBridge(fake),
      (fake) => delete (fake.bridge as { workflowDrafts?: unknown }).workflowDrafts,
    );
    expect(await screen.findByText("Editing is not available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the viewer" }));
    await screen.findByRole("listbox", { name: /graph$/ });
  });

  it("says a draft that does not parse cannot be drawn, and offers Undo", async () => {
    const { drafts } = await openEditor((fake) => scripted(fake, { document: null }));
    expect(await screen.findByText("The draft does not parse")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(drafts.calls.map((c) => c.method)).toContain("workflowDrafts.undo"));
  });
});

describe("nested graphs", () => {
  it("opens a loop's body from the inspector, edits inside it, and walks back by the trail", async () => {
    const { drafts } = await openEditor((fake) => scripted(fake));
    pick("again");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open body" }));
    const trail = await screen.findByRole("navigation", { name: "Graph" });
    expect(within(trail).getByRole("button", { name: "again" }).getAttribute("aria-current")).toBe("location");
    expect(within(inspector()).getByText("inline graph")).toBeTruthy();
    pick("done");
    expect(within(inspector()).getByLabelText(/^Id/).id).toBeTruthy();
    expect(inspector().textContent).toContain("nodes.again.body.graph.nodes.done");
    fireEvent.click(screen.getByRole("button", { name: /Set variables/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(1));
    expect(drafts.calls.at(-1)!.params.ops).toEqual([
      expect.objectContaining({ op: "addNode", id: "set-1", graph: [{ node: "again" }] }),
    ]);
    fireEvent.click(within(trail).getByRole("button", { name: "again" }));
    expect(screen.getByRole("navigation", { name: "Graph" })).toBeTruthy();
    fireEvent.click(within(trail).getByRole("button", { name: "ai-sdlc" }));
    expect(screen.queryByRole("navigation", { name: "Graph" })).toBeNull();
  });

  it("names a parallel branch and a for-each body in the trail, with their field paths", async () => {
    await openEditor((fake) => scripted(fake));
    pick("fan");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open branch a" }));
    expect((await screen.findByRole("navigation", { name: "Graph" })).textContent).toContain("fan [a]");
    pick("start");
    expect(inspector().textContent).toContain("nodes.fan.branches.a.graph.nodes.start");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Graph" })).getByRole("button", { name: "ai-sdlc" }));
    pick("fan");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open each item" }));
    expect(screen.getByRole("navigation", { name: "Graph" }).textContent).toContain("fan [each]");
    pick("start");
    expect(inspector().textContent).toContain("nodes.fan.forEach.body.graph.nodes.start");
  });

  it("falls back to the top graph when the container it was in goes away", async () => {
    const { drafts } = await openEditor((fake) => scripted(fake));
    pick("again");
    fireEvent.click(within(inspector()).getByRole("button", { name: "Open body" }));
    await screen.findByRole("navigation", { name: "Graph" });
    const { again: _gone, ...rest } = NESTED.nodes;
    drafts.setDocument({ ...NESTED, nodes: rest });
    fireEvent.click(screen.getByRole("button", { name: /Set variables/ }));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Graph" })).toBeNull());
    // The loop is still drawn, as the published node the draft removed.
    expect(within(outline()).getByRole("button", { name: /\bagain\b/ }).textContent).toContain("removed");
  });

  it("goes to a problem in another graph, or on an edge, from the validation panel", async () => {
    await openEditor((fake) =>
      scripted(fake, {
        issues: [
          { severity: "warning", message: "never ends", path: "x", graph: [{ node: "again" }], node: "done" },
          { severity: "note", message: "edge note", path: "edges[0]", graph: [], edge: 0 },
          { severity: "error", message: "branch problem", path: "y", graph: [{ node: "fan", branch: "a" }] },
          { severity: "note", message: "nowhere in particular", path: "z", graph: [] },
          { severity: "error", message: "another", path: "w", graph: [], node: "choose" },
        ],
      }),
    );
    const panel = screen.getByRole("region", { name: "Validation" });
    expect(panel.textContent).toContain("2 errors · 1 warning · 2 notes");
    fireEvent.click(within(panel).getByRole("button", { name: "again ▸ done" }));
    expect(screen.getByRole("navigation", { name: "Graph" }).textContent).toContain("again");
    expect(inspector().textContent).toContain("nodes.again.body.graph.nodes.done");
    fireEvent.click(within(panel).getByRole("button", { name: "edge 0" }));
    expect(screen.queryByRole("navigation", { name: "Graph" })).toBeNull();
    expect(inspector().textContent).toContain("start → again");
    fireEvent.click(within(panel).getByRole("button", { name: "fan[a]" }));
    expect(screen.getByRole("navigation", { name: "Graph" }).textContent).toContain("fan [a]");
    expect(within(inspector()).getByText("inline graph")).toBeTruthy();
  });

  it("adds after a node with conditional edges by connecting a new node, and after an end node by itself", async () => {
    const { canvas, drafts } = await onCanvas((fake) => scripted(fake));
    // Two conditional edges out of the decision: labelled where they have a label, else their condition.
    expect(canvas.textContent).toContain("choice == 'yes'");
    expect(canvas.textContent).toContain("no");
    pick("choose");
    fireEvent.click(screen.getByRole("button", { name: /Gate/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(2));
    expect(drafts.ops()).toEqual([
      expect.objectContaining({ op: "addNode", id: "gate-1" }),
      { op: "addEdge", from: "choose", to: "gate-1" },
    ]);
    pick("done");
    fireEvent.click(screen.getByRole("button", { name: /Subworkflow/ }));
    await waitFor(() => expect(drafts.ops()).toHaveLength(3));
    expect(drafts.ops()[2]).toMatchObject({ op: "addNode", id: "subworkflow-1", node: { type: "subworkflow" } });
  });
});
