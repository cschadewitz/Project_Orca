/**
 * Where focus goes when the row holding it leaves a list, without a DOM: the one rule the
 * Agents surface's claims and the permission policy panel's grants share
 * (`renderer/src/ui/focus-after-leaving.ts`). The lists themselves, and the focus they move,
 * are tested where they are drawn: `agents-write.test.tsx` and `policy-editor.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { focusAfterLeaving } from "../src/ui/focus-after-leaving.js";

describe("focusAfterLeaving", () => {
  it("takes the row after the one that left, or the one before it when it was the last", () => {
    expect(focusAfterLeaving(["a", "b", "c"], ["a", "c"], "b")).toBe(1);
    expect(focusAfterLeaving(["a", "b", "c"], ["a", "b"], "c")).toBe(1);
    expect(focusAfterLeaving(["a", "b", "c"], ["b", "c"], "a")).toBe(0);
  });

  it("lands only on a row the person had seen, passing over one the re-read brought", () => {
    expect(focusAfterLeaving(["a", "b", "c"], ["a", "n", "c"], "b")).toBe(2);
    // Two gone in one read: the nearest one that is still there.
    expect(focusAfterLeaving(["a", "b", "c", "d"], ["a", "d"], "b")).toBe(1);
  });

  it("names no row when none of them is left, so the list decides where focus goes", () => {
    expect(focusAfterLeaving(["b"], [], "b")).toBeUndefined();
    expect(focusAfterLeaving(["b"], ["n"], "b")).toBeUndefined();
  });
});
