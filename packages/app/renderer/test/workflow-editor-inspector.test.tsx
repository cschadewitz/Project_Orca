// @vitest-environment happy-dom
/**
 * The editor's inspector (#181) on its own: each node type's fields, an edge, the workflow,
 * and what a commit sends. Every field commits once - on Enter or when it is left - as one
 * draft operation, so the assertions are the operations `onApply` receives.
 */
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DraftGraphPath, DraftIssue } from "@orca/protocol";
import { editorGraph, newNode, type EditorGraph } from "../src/workflow/editor/draft-model.js";
import type { EditorSelection } from "../src/workflow/editor/editor-canvas.js";
import { EditorInspector, type InspectorHandle } from "../src/workflow/editor/editor-inspector.js";
import { harness } from "./harness.js";

const teardown: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

const inner = () => newNode("loop").body;
const published = {
  id: "flow",
  name: "Flow",
  start: "start",
  nodes: {
    start: { type: "start" },
    plan: { type: "agent", agent: { role: "planner" }, prompt: "Plan the work.", maxAttempts: 2, custom: { a: 1 } },
    choose: { type: "decision", source: { kind: "expression", expr: "true" }, options: ["yes", "no"] },
    gone: { type: "set", vars: { a: 1 } },
    done: { type: "end", outcome: "success" },
  },
  edges: [
    { from: "start", to: "plan" },
    { from: "plan", to: "choose" },
    { from: "choose", to: "done", when: "choice == 'yes'", label: "yes" },
  ],
};
const draft = {
  ...published,
  nodes: {
    start: published.nodes.start,
    plan: published.nodes.plan,
    choose: published.nodes.choose,
    review: { type: "gate", question: "Ship it?", options: [{ id: "ok" }], autoApproveWhen: "vars.safe" },
    again: { type: "loop", mode: "while", condition: "false", maxIterations: 3, breakOnFailure: true, body: inner() },
    fan: { type: "parallel", branches: { a: inner(), b: inner() }, forEach: { items: "=vars.list", body: inner() } },
    sub: { type: "subworkflow" },
    alt: { type: "start" },
    done: published.nodes.done,
  },
  edges: [...published.edges, { from: "choose", to: "review", when: "choice == 'no'" }],
};

const GRAPH = editorGraph(draft, published, [])!;

function mount(
  options: {
    selection?: EditorSelection;
    readOnly?: boolean;
    graph?: EditorGraph;
    path?: DraftGraphPath;
    issues?: DraftIssue[];
    workflow?: { name?: string; description?: string } | undefined;
    apply?: boolean;
  } = {},
) {
  const onApply = vi.fn(async () => options.apply ?? true);
  const onSelect = vi.fn();
  const onOpenNested = vi.fn();
  const ref = createRef<InspectorHandle>();
  const issues = options.issues ?? [];
  const byNode = new Map<string, DraftIssue[]>();
  const byEdge = new Map<number, DraftIssue[]>();
  for (const issue of issues) {
    if (issue.node !== undefined) byNode.set(issue.node, [...(byNode.get(issue.node) ?? []), issue]);
    if (issue.edge !== undefined) byEdge.set(issue.edge, [...(byEdge.get(issue.edge) ?? []), issue]);
  }
  const h = harness();
  teardown.push(h.dispose);
  render(
    <h.Providers>
      <EditorInspector
        ref={ref}
        graph={options.graph ?? GRAPH}
        path={options.path ?? []}
        yamlPrefix=""
        selection={options.selection}
        issues={{ byNode, byEdge }}
        readOnly={options.readOnly ?? false}
        workflow={"workflow" in options ? options.workflow : { name: "Flow" }}
        workflows={["other", "triage"]}
        onApply={onApply}
        onSelect={onSelect}
        onOpenNested={onOpenNested}
      />
    </h.Providers>,
  );
  const inspector = screen.getByRole("complementary", { name: "Inspector" });
  return { inspector, onApply, onSelect, onOpenNested, ref };
}

const node = (id: string, options: Parameters<typeof mount>[0] = {}) =>
  mount({ ...options, selection: { kind: "node", id } });

/** Type into a one-line field and press Enter. */
function enter(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: "Enter" });
}
/** Type into a field and leave it. */
function leave(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}
/** A field by its label, which reads as the label and then the YAML path it edits. */
const field = (label: string) => screen.getByLabelText(new RegExp(`^${label}(nodes\\.|edges\\[|name$|description$)`));
function choose(menu: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: menu }));
  fireEvent.click(within(screen.getByRole("menu", { name: menu })).getByRole("menuitem", { name: item }));
}

describe("the inspector with nothing selected", () => {
  it("edits the workflow's name and description, and counts the graph", () => {
    const { inspector, onApply } = mount({ workflow: { name: "Flow", description: "Old" } });
    expect(within(inspector).getByText("workflow")).toBeTruthy();
    expect(inspector.textContent).toContain("9 nodes, 4 edges, starting at start — more than one start node");
    enter(field("Name"), "");
    expect(onApply).not.toHaveBeenCalled();
    enter(field("Name"), "Renamed");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "setWorkflow", name: "Renamed" }]);
    leave(field("Description"), "");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "setWorkflow", description: null }]);
    leave(field("Description"), "New words");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "setWorkflow", description: "New words" }]);
  });

  it("names an inline graph by its path and leaves the workflow's own fields out", () => {
    const path = [{ node: "again" }];
    const graph = editorGraph(draft, published, path)!;
    const { inspector } = mount({ graph, path, workflow: undefined });
    expect(within(inspector).getByText("inline graph")).toBeTruthy();
    expect(within(inspector).getByText("again")).toBeTruthy();
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    expect(inspector.textContent).toContain("2 nodes, 1 edges, starting at start");
  });

  it("says a graph with no start starts at nothing, and a workflow with no fields is blank", () => {
    const graph = { ...GRAPH, start: "" };
    const { inspector } = mount({ graph, workflow: undefined });
    expect(inspector.textContent).toContain("starting at nothing");
    expect((field("Name") as HTMLInputElement).value).toBe("");
  });
});

describe("a node", () => {
  it("renames on Enter and follows the new id, but keeps an id that is not one", async () => {
    const { onApply, onSelect } = node("plan");
    const id = field("Id") as HTMLInputElement;
    enter(id, "not an id!");
    expect(onApply).not.toHaveBeenCalled();
    expect(id.value).toBe("plan");
    enter(id, "plan-2");
    expect(onApply).toHaveBeenCalledWith([{ op: "renameNode", id: "plan", to: "plan-2" }]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "plan-2" }));
  });

  it("keeps the old selection when a rename is refused, and Escape puts the text back", async () => {
    const { onApply, onSelect } = node("plan", { apply: false });
    const id = field("Id") as HTMLInputElement;
    fireEvent.change(id, { target: { value: "half" } });
    fireEvent.keyDown(id, { key: "Escape" });
    expect(id.value).toBe("plan");
    fireEvent.blur(id);
    expect(onApply).not.toHaveBeenCalled();
    enter(id, "plan-2");
    await act(async () => {});
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("changes the type from the menu, and choosing the same type sends nothing", () => {
    const { onApply } = node("plan");
    choose("Node type", "agent");
    expect(onApply).not.toHaveBeenCalled();
    choose("Node type", "gate");
    expect(onApply).toHaveBeenCalledWith([{ op: "changeType", id: "plan", type: "gate" }]);
  });

  it("sets and unsets an agent step's plain fields", () => {
    const { onApply } = node("plan");
    enter(field("Display name"), "Planner");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", set: { name: "Planner" } }]);
    enter(field("Template"), "plan-template");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", set: { template: "plan-template" } }]);
    const prompt = field("Prompt");
    fireEvent.change(prompt, { target: { value: "" } });
    fireEvent.keyDown(prompt, { key: "Enter", ctrlKey: true });
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", unset: ["prompt"] }]);
    const description = field("Description");
    fireEvent.change(description, { target: { value: "Draft" } });
    fireEvent.keyDown(description, { key: "Escape" });
    fireEvent.blur(description);
    expect(onApply).toHaveBeenCalledTimes(3);
  });

  it("parses a number, refuses text that is not one, and unsets an empty one", () => {
    const { onApply } = node("plan");
    const attempts = field("Attempts") as HTMLInputElement;
    expect(attempts.value).toBe("2");
    enter(attempts, "lots");
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a number.")).toBeTruthy();
    enter(attempts, "4");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", set: { maxAttempts: 4 } }]);
    enter(attempts, "");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", unset: ["maxAttempts"] }]);
  });

  it("edits structured values as YAML, and keeps text that does not parse in the field", () => {
    const { onApply } = node("plan");
    const inputs = field("Inputs");
    leave(inputs, "- design\n- notes");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", set: { inputs: ["design", "notes"] } }]);
    leave(inputs, "key: [unclosed");
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^This is not valid YAML/)).toBeTruthy();
    leave(inputs, "   ");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", unset: ["inputs"] }]);
    // A key the type does not take is still shown, as YAML.
    expect((field("custom") as HTMLTextAreaElement).value).toBe("a: 1");
  });

  it("edits the agent by role or by id, and keeps the value when switching", () => {
    const { onApply } = node("plan");
    const agent = field("Agent") as HTMLInputElement;
    expect(agent.value).toBe("planner");
    enter(agent, "builder");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", set: { agent: { role: "builder" } } }]);
    choose("Agent by", "agent id");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", set: { agent: { id: "planner" } } }]);
    enter(agent, "");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", unset: ["agent"] }]);
  });

  it("shows an agent named by id, or by a bare string", () => {
    const byId = { ...draft, nodes: { ...draft.nodes, plan: { type: "agent", agent: { id: "codex" } } } };
    node("plan", { graph: editorGraph(byId, published, [])! });
    expect((field("Agent") as HTMLInputElement).value).toBe("codex");
    expect(screen.getByRole("button", { name: "Agent by" }).textContent).toBe("agent id");
    cleanup();
    const bare = { ...draft, nodes: { ...draft.nodes, plan: { type: "agent", agent: "planner" } } };
    const { onApply } = node("plan", { graph: editorGraph(bare, published, [])! });
    expect((field("Agent") as HTMLInputElement).value).toBe("planner");
    choose("Agent by", "role");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "plan", set: { agent: { role: "planner" } } }]);
    cleanup();
    const none = { ...draft, nodes: { ...draft.nodes, plan: { type: "agent" } } };
    const unset = node("plan", { graph: editorGraph(none, published, [])! });
    choose("Agent by", "agent id");
    expect(unset.onApply).not.toHaveBeenCalled();
  });

  it("lists the node's problems and puts an error on the field it names", () => {
    const { inspector } = node("plan", {
      issues: [
        { severity: "error", message: "unknown template", path: "nodes.plan.template", graph: [], node: "plan" },
        { severity: "warning", message: "prompt is long", path: "nodes.plan.prompt", graph: [], node: "plan" },
        { severity: "note", message: "custom is ignored", path: "nodes.plan.custom", graph: [], node: "plan" },
      ],
    });
    const problems = within(inspector).getByRole("list", { name: "Problems with this node" });
    expect(problems.textContent).toContain("Error: unknown template");
    expect(problems.textContent).toContain("Warning: prompt is long");
    expect(problems.textContent).toContain("Note: custom is ignored");
    expect(field("Template").getAttribute("aria-invalid")).toBe("true");
    expect(field("Prompt").getAttribute("aria-invalid")).toBeNull();
  });

  it("lists connections out, selects one, and connects to another node", () => {
    const { inspector, onApply, onSelect } = node("choose");
    fireEvent.click(within(inspector).getByRole("button", { name: "→ done" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "edge", index: 2 });
    expect(inspector.textContent).toContain("yes");
    expect(inspector.textContent).toContain("choice == 'no'");
    fireEvent.click(screen.getByRole("button", { name: "Connect to" }));
    const items = within(screen.getByRole("menu", { name: "Connect to" }))
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    // Not itself, not the start, and not a node the draft removed.
    expect(items.some((item) => item?.startsWith("choose"))).toBe(false);
    expect(items.some((item) => item?.startsWith("start"))).toBe(false);
    expect(items.some((item) => item?.startsWith("gone"))).toBe(false);
    fireEvent.click(within(screen.getByRole("menu", { name: "Connect to" })).getByRole("menuitem", { name: /^sub/ }));
    expect(onApply).toHaveBeenCalledWith([{ op: "addEdge", from: "choose", to: "sub" }]);
  });

  it("says when nothing follows a node, and deletes it with or without its connections", () => {
    const { inspector, onApply } = node("sub");
    expect(inspector.textContent).toContain("Nothing follows this node yet.");
    fireEvent.click(within(inspector).getByRole("button", { name: "Delete" }));
    expect(onApply).toHaveBeenLastCalledWith([{ op: "removeNode", id: "sub" }]);
    fireEvent.click(within(inspector).getByRole("button", { name: "Delete with its connections" }));
    expect(onApply).toHaveBeenLastCalledWith([{ op: "removeNode", id: "sub", detach: true }]);
  });

  it("offers a second start node to become the start, and keeps the start's type and deletion", () => {
    const { inspector, onApply } = node("alt");
    fireEvent.click(within(inspector).getByRole("button", { name: "Make this the start" }));
    expect(onApply).toHaveBeenCalledWith([{ op: "setStart", id: "alt" }]);
    cleanup();
    const start = node("start");
    expect(screen.queryByRole("button", { name: "Node type" })).toBeNull();
    expect(within(start.inspector).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(start.inspector).queryByRole("button", { name: "Make this the start" })).toBeNull();
  });

  it("edits a decision's options as a list, and a list of records as YAML", () => {
    const { onApply } = node("choose");
    const options = field("Options") as HTMLInputElement;
    expect(options.value).toBe("yes, no");
    enter(options, " a, ,b ");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "choose", set: { options: ["a", "b"] } }]);
    enter(options, " , ");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "choose", unset: ["options"] }]);
    cleanup();
    node("review");
    expect((field("Options") as HTMLTextAreaElement).value).toBe("- id: ok");
    expect((field("Approve itself when") as HTMLInputElement).value).toBe("vars.safe");
  });

  it("chooses a loop's mode and booleans from menus, and opens its body", () => {
    const { inspector, onApply, onOpenNested } = node("again");
    expect(screen.getByRole("button", { name: "Stop on failure" }).textContent).toBe("true");
    choose("Mode", "until");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "again", set: { mode: "until" } }]);
    choose("Stop on failure", "false");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "again", set: { breakOnFailure: false } }]);
    choose("Stop on failure", "true");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "again", set: { breakOnFailure: true } }]);
    choose("Mode", "(not set)");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "again", unset: ["mode"] }]);
    expect((field("At most") as HTMLInputElement).value).toBe("3");
    fireEvent.click(within(inspector).getByRole("button", { name: "Open body" }));
    expect(onOpenNested).toHaveBeenCalledWith({ node: "again", label: "body" });
  });

  it("opens each of a parallel node's branches and its for-each body", () => {
    const { inspector, onOpenNested } = node("fan");
    expect(screen.getByRole("button", { name: "Finish when" }).textContent).toBe("(not set)");
    fireEvent.click(within(inspector).getByRole("button", { name: "Open branch b" }));
    expect(onOpenNested).toHaveBeenLastCalledWith({ node: "fan", branch: "b", label: "branch b" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Open each item" }));
    expect(onOpenNested).toHaveBeenLastCalledWith({ node: "fan", forEach: true, label: "each item" });
  });

  it("picks a subworkflow from the registered workflows", () => {
    const { onApply } = node("sub");
    expect(screen.getByRole("button", { name: "Workflow to run" }).textContent).toBe("Choose");
    choose("Workflow to run", "triage");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateNode", id: "sub", set: { workflow: "triage" } }]);
  });

  it("gives an end node no connections out", () => {
    const { inspector } = node("done");
    expect(within(inspector).queryByText("Connections out")).toBeNull();
    expect(screen.getByRole("button", { name: "Outcome" }).textContent).toBe("success");
  });

  it("shows a removed node locked, with a way back named", () => {
    const { inspector } = node("gone");
    expect(inspector.textContent).toContain("This node is removed in the draft.");
    expect(within(inspector).getByText("removed")).toBeTruthy();
    expect((field("Id") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Node type" })).toBeNull();
    expect(within(inspector).queryByText("Connections out")).toBeNull();
    expect(within(inspector).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows every control read-only on somebody else's draft", () => {
    const { inspector } = node("again", { readOnly: true });
    expect(screen.queryByRole("button", { name: "Mode" })).toBeNull();
    expect(inspector.textContent).toContain("while");
    expect(within(inspector).queryByText("Actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect to" })).toBeNull();
    cleanup();
    node("sub", { readOnly: true });
    expect(screen.queryByRole("button", { name: "Workflow to run" })).toBeNull();
    cleanup();
    node("plan", { readOnly: true });
    expect(screen.queryByRole("button", { name: "Agent by" })).toBeNull();
    expect((field("Agent") as HTMLInputElement).readOnly).toBe(true);
  });

  it("puts the cursor in the name on F2, and opens the connect menu on C", () => {
    const { ref } = node("plan");
    act(() => ref.current!.focusName());
    expect(document.activeElement).toBe(field("Id"));
    act(() => ref.current!.openConnect());
    expect(screen.getByRole("menu", { name: "Connect to" })).toBeTruthy();
  });
});

describe("an edge", () => {
  it("re-ends the edge, sets and clears its condition and label, and deletes it", async () => {
    const { inspector, onApply, onSelect } = mount({ selection: { kind: "edge", index: 3 } });
    expect(inspector.textContent).toContain("choose → review");
    expect(within(inspector).getByText("added")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edge source" }));
    expect(
      within(screen.getByRole("menu", { name: "Edge source" }))
        .getAllByRole("menuitem")
        .some((item) => item.textContent?.startsWith("gone")),
    ).toBe(false);
    fireEvent.click(within(screen.getByRole("menu", { name: "Edge source" })).getByRole("menuitem", { name: /^plan/ }));
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateEdge", index: 3, from: "plan" }]);
    choose("Edge target", "done end");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateEdge", index: 3, to: "done" }]);
    enter(field("Only when"), "");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateEdge", index: 3, when: null }]);
    enter(field("Label"), "no");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateEdge", index: 3, label: "no" }]);
    fireEvent.click(within(inspector).getByRole("button", { name: "Delete edge" }));
    expect(onApply).toHaveBeenLastCalledWith([{ op: "removeEdge", index: 3 }]);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(undefined));
  });

  it("names the edge's problems, and clears a label and sets a condition", () => {
    const { inspector, onApply } = mount({
      selection: { kind: "edge", index: 2 },
      issues: [{ severity: "error", message: "no such option", path: "edges[2].when", graph: [], edge: 2 }],
    });
    expect(inspector.textContent).toContain("Error: no such option");
    enter(field("Label"), "");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateEdge", index: 2, label: null }]);
    enter(field("Only when"), "choice == 'no'");
    expect(onApply).toHaveBeenLastCalledWith([{ op: "updateEdge", index: 2, when: "choice == 'no'" }]);
  });

  it("keeps a refused delete selected, and shows a read-only edge as text", async () => {
    const { inspector, onSelect } = mount({ selection: { kind: "edge", index: 0 }, apply: false });
    fireEvent.click(within(inspector).getByRole("button", { name: "Delete edge" }));
    await act(async () => {});
    expect(onSelect).not.toHaveBeenCalled();
    cleanup();
    const readOnly = mount({ selection: { kind: "edge", index: 0 }, readOnly: true });
    expect(screen.queryByRole("button", { name: "Edge source" })).toBeNull();
    expect(within(readOnly.inspector).queryByRole("button", { name: "Delete edge" })).toBeNull();
    expect(readOnly.inspector.textContent).toContain("start → plan");
  });

  it("falls back to the workflow when the selection names nothing in this graph", () => {
    const { inspector } = mount({ selection: { kind: "edge", index: 99 } });
    expect(within(inspector).getByText("workflow")).toBeTruthy();
  });
});
