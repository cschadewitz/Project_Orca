// @vitest-environment happy-dom
/** C7-03: local inspector text and parse errors belong to a graph, selection and field. */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DraftGraphPath, DraftOperation } from "@orca/protocol";
import { editorGraph, type EditorGraph } from "../src/workflow/editor/draft-model.js";
import { EditorInspector, type EditorInspectorProps } from "../src/workflow/editor/editor-inspector.js";
import { harness } from "./harness.js";

const teardown: (() => void)[] = [];
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

const raw = {
  start: "start",
  nodes: {
    start: { type: "start" },
    a: { type: "agent", prompt: "Same prompt", agent: { role: "builder" }, maxAttempts: 2, custom: { a: 1 } },
    b: { type: "agent", prompt: "Same prompt", agent: { role: "builder" }, maxAttempts: 2, custom: { a: 1 } },
    done: { type: "end" },
  },
  edges: [
    { from: "a", to: "done" },
    { from: "b", to: "done" },
  ],
};
const graph = () => editorGraph(structuredClone(raw), raw, [])!;
const field = (label: string) =>
  screen.getByLabelText<HTMLInputElement | HTMLTextAreaElement>(new RegExp(`^${label}(nodes\\.|edges\\[)`));

function mount(initial: Partial<EditorInspectorProps> = {}) {
  const h = harness();
  teardown.push(h.dispose);
  const onApply = vi.fn(async (_ops: DraftOperation[]) => true);
  let props: EditorInspectorProps = {
    graph: graph(),
    path: [],
    yamlPrefix: "",
    selection: { kind: "node", id: "a" },
    issues: { byNode: new Map(), byEdge: new Map() },
    readOnly: false,
    workflow: { name: "Flow" },
    workflows: [],
    onApply,
    onSelect: vi.fn(),
    onOpenNested: vi.fn(),
    onDelete: vi.fn(),
    ...initial,
  };
  const view = () => (
    <h.Providers>
      <EditorInspector {...props} />
    </h.Providers>
  );
  const rendered = render(view());
  return {
    onApply,
    update(next: Partial<EditorInspectorProps>) {
      props = { ...props, ...next };
      rendered.rerender(view());
    },
  };
}

const nodeFields = [
  ["Prompt", "Only A", "Same prompt"],
  ["Display name", "Only A", ""],
  ["Description", "Only A", ""],
  ["Template", "Only A", ""],
  ["Agent", "only-a", "builder"],
  ["Attempts", "7", "2"],
  ["Inputs", "- only-a", ""],
  ["custom", "a: 7", "a: 1"],
] as const;

describe("inspector field ownership", () => {
  it.each(nodeFields)("does not commit A's %s to B after selection changes before blur", (label, typed, committed) => {
    const m = mount();
    field(label).focus();
    fireEvent.change(field(label), { target: { value: typed } });
    expect(m.onApply).not.toHaveBeenCalled();
    m.update({ selection: { kind: "node", id: "b" } });
    const b = field(label);
    b.focus();
    fireEvent.blur(b);
    expect(m.onApply).not.toHaveBeenCalled();
    expect(b.value).toBe(committed);
  });

  it("commits to A when blur happens first, then leaves equal-valued B clean", () => {
    const m = mount();
    const a = field("Prompt");
    fireEvent.change(a, { target: { value: "Only A" } });
    fireEvent.blur(a);
    expect(m.onApply).toHaveBeenCalledExactlyOnceWith([{ op: "updateNode", id: "a", set: { prompt: "Only A" } }]);
    // Keep the acknowledgement held: B still has the same committed value as A's old value.
    m.update({ selection: { kind: "node", id: "b" } });
    fireEvent.blur(field("Prompt"));
    expect(m.onApply).toHaveBeenCalledTimes(1);
    expect(field("Prompt").value).toBe("Same prompt");
  });

  it.each([
    ["Label", "Only A"],
    ["Only when", "vars.onlyA"],
  ])("does not commit an edge's %s to another edge", (label, text) => {
    const m = mount({ selection: { kind: "edge", index: 0 } });
    fireEvent.change(field(label), { target: { value: text } });
    m.update({ selection: { kind: "edge", index: 1 } });
    fireEvent.blur(field(label));
    expect(m.onApply).not.toHaveBeenCalled();
    expect(field(label).value).toBe("");
  });

  it.each(["Label", "Only when"])(
    "commits an edge's %s only to its original index when blur happens first",
    (label) => {
      const m = mount({ selection: { kind: "edge", index: 0 } });
      fireEvent.change(field(label), { target: { value: "only-a" } });
      fireEvent.blur(field(label));
      expect(m.onApply).toHaveBeenCalledExactlyOnceWith([
        { op: "updateEdge", index: 0, [label === "Label" ? "label" : "when"]: "only-a" },
      ]);
      m.update({ selection: { kind: "edge", index: 1 } });
      fireEvent.blur(field(label));
      expect(m.onApply).toHaveBeenCalledTimes(1);
      expect(field(label).value).toBe("");
    },
  );

  it("resets edge condition across nested graphs with matching index and endpoints", () => {
    const m = mount({ selection: { kind: "edge", index: 0 } });
    fireEvent.change(field("Only when"), { target: { value: "vars.onlyA" } });
    m.update({ path: [{ node: "loop" }], yamlPrefix: "nodes.loop.body.graph." });
    fireEvent.blur(field("Only when"));
    expect(m.onApply).not.toHaveBeenCalled();
    expect(field("Only when").value).toBe("");
  });

  it("resets equal-valued list fields between nodes", () => {
    const next = graph();
    next.nodes = next.nodes.map((node) =>
      ["a", "b"].includes(node.id) ? { ...node, type: "gate", raw: { type: "gate", options: ["yes", "no"] } } : node,
    );
    const m = mount({ graph: next });
    fireEvent.change(field("Options"), { target: { value: "only-a" } });
    m.update({ selection: { kind: "node", id: "b" } });
    fireEvent.blur(field("Options"));
    expect(m.onApply).not.toHaveBeenCalled();
    expect(field("Options").value).toBe("yes, no");
  });

  it("retains focused unsent edge text on a fresh snapshot of the same selection", () => {
    const m = mount({ selection: { kind: "edge", index: 0 } });
    const label = field("Label");
    label.focus();
    fireEvent.change(label, { target: { value: "Still typing" } });
    m.update({ graph: graph(), path: [] });
    expect(field("Label")).toBe(label);
    expect(document.activeElement).toBe(label);
    expect(label.value).toBe("Still typing");
    expect(m.onApply).not.toHaveBeenCalled();
  });

  it("clears a local YAML parse error when selecting an equal-valued field", () => {
    const m = mount();
    fireEvent.change(field("Inputs"), { target: { value: "key: [unclosed" } });
    fireEvent.blur(field("Inputs"));
    expect(screen.getByText(/^This is not valid YAML/)).toBeTruthy();
    m.update({ selection: { kind: "node", id: "b" } });
    expect(screen.queryByText(/^This is not valid YAML/)).toBeNull();
    expect(field("Inputs").value).toBe("");
    fireEvent.blur(field("Inputs"));
    expect(m.onApply).not.toHaveBeenCalled();
  });

  it.each(["Prompt", "Id"])("resets %s across graph paths with the same selected id", (label) => {
    const m = mount();
    fireEvent.change(field(label), { target: { value: "only-a" } });
    const path: DraftGraphPath = [{ node: "loop" }];
    m.update({ graph: graph(), path, yamlPrefix: "nodes.loop.body.graph." });
    fireEvent.blur(field(label));
    expect(m.onApply).not.toHaveBeenCalled();
    expect(field(label).value).toBe(label === "Id" ? "a" : "Same prompt");
  });

  it("resets edge fields when the same index names different endpoints", () => {
    const m = mount({ selection: { kind: "edge", index: 0 } });
    fireEvent.change(field("Label"), { target: { value: "Old edge" } });
    const next = graph();
    next.edges[0] = { ...next.edges[0]!, from: "b" };
    m.update({ graph: next });
    fireEvent.blur(field("Label"));
    expect(m.onApply).not.toHaveBeenCalled();
    expect(field("Label").value).toBe("");
  });

  it("preserves focused unsent text for the same graph, node and field on a fresh snapshot", () => {
    const m = mount();
    const prompt = field("Prompt");
    prompt.focus();
    fireEvent.change(prompt, { target: { value: "Still typing" } });
    m.update({ graph: graph(), path: [], issues: { byNode: new Map(), byEdge: new Map() } });
    expect(field("Prompt")).toBe(prompt);
    expect(document.activeElement).toBe(prompt);
    expect(prompt.value).toBe("Still typing");
    expect(m.onApply).not.toHaveBeenCalled();
  });

  it("keeps the Id input focused through an acknowledged Enter rename and reselection", async () => {
    const h = harness();
    teardown.push(h.dispose);
    const onApply = vi.fn();
    function Renaming() {
      const [current, setCurrent] = useState<EditorGraph>(graph);
      const [id, setId] = useState("a");
      return (
        <EditorInspector
          graph={current}
          path={[]}
          yamlPrefix=""
          selection={{ kind: "node", id }}
          issues={{ byNode: new Map(), byEdge: new Map() }}
          readOnly={false}
          workflow={{ name: "Flow" }}
          workflows={[]}
          onApply={async (ops) => {
            onApply(ops);
            return true;
          }}
          onSelect={(selection) => {
            if (selection?.kind === "node") {
              setCurrent((old) => ({
                ...old,
                nodes: old.nodes.map((n) => (n.id === id ? { ...n, id: selection.id } : n)),
              }));
              setId(selection.id);
            }
          }}
          onDelete={vi.fn()}
          onOpenNested={vi.fn()}
        />
      );
    }
    render(
      <h.Providers>
        <Renaming />
      </h.Providers>,
    );
    const input = field("Id");
    input.focus();
    fireEvent.change(input, { target: { value: "renamed" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(field("Id")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("renamed");
    fireEvent.blur(input);
    expect(onApply).toHaveBeenCalledExactlyOnceWith([{ op: "renameNode", id: "a", to: "renamed" }]);
  });
});
