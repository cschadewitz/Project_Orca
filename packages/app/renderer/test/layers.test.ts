/**
 * `Esc` closes the topmost transient layer and never loses an unsent draft
 * (docs/design/50-accessibility-and-keyboard.md). Both halves, on the stack itself.
 */
import { describe, expect, it } from "vitest";
import { LayerStack } from "../src/layers.js";

describe("the transient layer stack", () => {
  it("closes the layer that opened last, not the one underneath", () => {
    const stack = new LayerStack();
    const closed: string[] = [];
    stack.push({ name: "panel", close: () => closed.push("panel") });
    stack.push({ name: "palette", close: () => closed.push("palette") });

    expect(stack.closeTop()).toBe("closed");
    expect(closed).toEqual(["palette"]);
    expect(stack.closeTop()).toBe("closed");
    expect(closed).toEqual(["palette", "panel"]);
  });

  it("says `none` when nothing transient is open, so Esc belongs to whatever is beneath", () => {
    expect(new LayerStack().closeTop()).toBe("none");
  });

  it("keeps a layer holding an unsent draft, and closes it once the draft is gone", () => {
    const stack = new LayerStack();
    let draft = "a note nobody has sent";
    let closed = false;
    stack.push({ name: "gate-card", close: () => (closed = true), hasUnsentDraft: () => draft !== "" });

    expect(stack.closeTop()).toBe("kept");
    expect(closed).toBe(false);
    expect(stack.depth).toBe(1);

    draft = "";
    expect(stack.closeTop()).toBe("closed");
    expect(closed).toBe(true);
  });

  it("pops a layer that closes itself exactly once", () => {
    const stack = new LayerStack();
    // What a React layer does: `close` sets state, the component unmounts, and its effect
    // cleanup runs the pop it was handed at push time.
    let pop = (): void => {};
    pop = stack.push({ name: "palette", close: () => pop() });

    expect(stack.closeTop()).toBe("closed");
    expect(stack.depth).toBe(0);
    expect(stack.closeTop()).toBe("none");
  });

  it("lets a layer be popped out of order without disturbing the rest", () => {
    const stack = new LayerStack();
    const popPanel = stack.push({ name: "panel", close: () => {} });
    stack.push({ name: "palette", close: () => {} });

    popPanel();
    expect(stack.top()?.name).toBe("palette");
    expect(stack.depth).toBe(1);
  });
});
