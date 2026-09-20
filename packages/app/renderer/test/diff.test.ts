/**
 * The line diff, with no DOM and no dependency: what `spec@v2 → spec@v3` actually renders,
 * plus the edges an LCS gets wrong when nobody looks — an empty side, a file that only
 * grew, a pair too far apart to line up.
 *
 * The first block runs over the real fixture bodies, which are the daemon fixture's three
 * versions of one `spec` (`fixtures-artifacts.ts`), so the numbers below are the ones the
 * panel shows.
 */
import { describe, expect, it } from "vitest";
import {
  ADD_GUTTER,
  DEL_GUTTER,
  MAX_CELLS,
  SAME_GUTTER,
  diffLines,
  diffText,
  gutterFor,
  toLines,
} from "../src/artifacts/diff.js";
import { SPEC_BODIES } from "./fixtures-artifacts.js";

const rendered = (text: string, other: string): string[] =>
  diffText(text, other).lines.map((line) => `${gutterFor(line.op)}${line.text}`);

describe("spec v2 to v3, from the daemon fixture's three versions", () => {
  it("renders the added and the removed lines, each with its gutter", () => {
    const diff = diffText(SPEC_BODIES[2]!, SPEC_BODIES[3]!);

    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.coarse).toBe(false);
    expect(rendered(SPEC_BODIES[2]!, SPEC_BODIES[3]!)).toEqual([
      `${DEL_GUTTER}# Spec v2`,
      `${ADD_GUTTER}# Spec v3`,
      `${SAME_GUTTER}`,
      `${SAME_GUTTER}The SSO callback exchanges the code for a session.`,
      `${SAME_GUTTER}`,
      `${SAME_GUTTER}- Redirect to the provider`,
      `${SAME_GUTTER}- Exchange the code`,
      `${ADD_GUTTER}- Rotate the refresh token`,
      `${SAME_GUTTER}- Set the session cookie`,
    ]);
  });

  it("uses a real minus for a removal, not a hyphen: it is bundled and it is a minus", () => {
    expect(DEL_GUTTER).toBe("−");
    expect(ADD_GUTTER).toBe("+");
  });

  it("numbers both sides, so a line can be cited in either version", () => {
    const [first, second] = diffText(SPEC_BODIES[2]!, SPEC_BODIES[3]!).lines;
    expect(first).toMatchObject({ op: "del", a: 1 });
    expect(first).not.toHaveProperty("b");
    expect(second).toMatchObject({ op: "add", b: 1 });
    expect(second).not.toHaveProperty("a");
  });
});

describe("the edges", () => {
  it("reads a trailing newline as a terminator, not as an empty last line", () => {
    expect(toLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toLines("a\nb")).toEqual(["a", "b"]);
    expect(toLines("")).toEqual([""]);
  });

  it("calls two identical bodies no change at all", () => {
    const diff = diffText(SPEC_BODIES[1]!, SPEC_BODIES[1]!);
    expect([diff.added, diff.removed]).toEqual([0, 0]);
    expect(diff.lines.every((l) => l.op === "same")).toBe(true);
  });

  it("handles an empty side in both directions", () => {
    expect(diffLines([], ["a", "b"])).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines(["a", "b"], [])).toMatchObject({ added: 0, removed: 2 });
  });

  it("matches a moved block rather than calling the whole file replaced", () => {
    const diff = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d"]);
    expect(diff.lines.map((l) => l.op)).toEqual(["same", "del", "add", "same", "same"]);
  });

  it("falls back to a whole-file replacement when the two are too far apart, and says so", () => {
    // Beyond MAX_CELLS with nothing in common: the table is not built at all.
    const side = Math.ceil(Math.sqrt(MAX_CELLS)) + 1;
    const a = Array.from({ length: side }, (_, i) => `a${i}`);
    const b = Array.from({ length: side }, (_, i) => `b${i}`);
    const diff = diffLines(a, b);

    expect(diff.coarse).toBe(true);
    expect(diff.removed).toBe(side);
    expect(diff.added).toBe(side);
  });
});
