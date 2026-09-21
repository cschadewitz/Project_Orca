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
    // `toLines` keeps its own contract: an empty *string* is one empty line, because a
    // one-line file and an empty file are not the same object. What an empty *body*
    // contributes to a diff is decided in `diffText` (#250, below).
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

  it("sees no change when a re-recorded version differs only by its final newline", () => {
    // `toLines` is where this is decided, but the panel is where it is noticed: an artifact
    // written twice by two tools that disagree about the last byte is not a changed artifact.
    const diff = diffText(SPEC_BODIES[1]!, SPEC_BODIES[1]!.replace(/\n$/, ""));
    expect([diff.added, diff.removed]).toEqual([0, 0]);
  });

  it("numbers an appended block in the newer version only", () => {
    const diff = diffLines(["# Spec", "", "One."], ["# Spec", "", "One.", "Two."]);

    expect([diff.added, diff.removed]).toEqual([1, 0]);
    expect(diff.lines[3]).toMatchObject({ op: "add", text: "Two.", b: 4 });
    // An added line has no line to cite in the older version, so it carries no `a` at all
    // rather than a zero the gutter would have to special-case.
    expect(diff.lines[3]).not.toHaveProperty("a");
  });

  it("numbers a deleted block in the older version only", () => {
    const diff = diffLines(["# Spec", "", "One.", "Two."], ["# Spec", "", "One."]);

    expect([diff.added, diff.removed]).toEqual([0, 1]);
    expect(diff.lines[3]).toMatchObject({ op: "del", text: "Two.", a: 4 });
    expect(diff.lines[3]).not.toHaveProperty("b");
  });

  it("does not match one repeated line twice when the head and the tail would overlap", () => {
    // The prefix and suffix scans are two passes over the same array, so a file whose only
    // change is a duplicated line is where they would both claim it and report no change.
    const diff = diffLines(["a"], ["a", "a"]);

    expect([diff.added, diff.removed]).toEqual([1, 0]);
    expect(diff.lines).toEqual([
      { op: "same", text: "a", a: 1, b: 1 },
      { op: "add", text: "a", b: 2 },
    ]);
  });

  it("numbers a shared tail line by where it sits in each version, not by one offset", () => {
    // The two sides drift apart by the size of the hunk, so the same text is line 2 in the
    // older version and line 3 in the newer — which is the number a person cites.
    const diff = diffLines(["intro", "shared"], ["intro", "added", "shared"]);

    expect(diff.lines).toEqual([
      { op: "same", text: "intro", a: 1, b: 1 },
      { op: "add", text: "added", b: 2 },
      { op: "same", text: "shared", a: 2, b: 3 },
    ]);
  });

  it("reads an empty older body as a creation: lines added, nothing removed (#250)", () => {
    // v1 of an artifact, or a first version compared against nothing. The count sentence
    // the panel draws from this has to read "1 added" — there is no removed line, because
    // there was no line.
    const diff = diffText("", "one\n");

    expect([diff.added, diff.removed]).toEqual([1, 0]);
    expect(diff.lines).toEqual([{ op: "add", text: "one", b: 1 }]);
  });

  it("reads an emptied newer body as a deletion: lines removed, nothing added", () => {
    const diff = diffText("one\ntwo\n", "");

    expect([diff.added, diff.removed]).toEqual([0, 2]);
    expect(diff.lines).toEqual([
      { op: "del", text: "one", a: 1 },
      { op: "del", text: "two", a: 2 },
    ]);
  });

  it("calls two empty bodies no change at all, and draws no row", () => {
    const diff = diffText("", "");

    expect([diff.added, diff.removed]).toEqual([0, 0]);
    expect(diff.lines).toEqual([]);
    expect(diff.coarse).toBe(false);
  });

  it("does not let a trailing newline stand in for content against an empty body", () => {
    // "\n" is one empty line, not nothing: the file has a line in it and the body is not
    // the empty string, so this is a creation of one blank line rather than no change.
    expect([diffText("", "\n").added, diffText("", "\n").removed]).toEqual([1, 0]);
    expect([diffText("\n", "").added, diffText("\n", "").removed]).toEqual([0, 1]);
  });

  it("counts the same change whether or not the newer body ends in a newline", () => {
    const terminated = diffText("one\n", "one\ntwo\n");
    const unterminated = diffText("one", "one\ntwo");

    expect([terminated.added, terminated.removed]).toEqual([1, 0]);
    expect(unterminated.lines).toEqual(terminated.lines);
  });

  it("still counts an explicit empty line a caller passed as an array", () => {
    // The fix is about what an empty *body* contributes; a caller holding `[""]` has
    // already said the line exists, and `diffLines` takes it at its word.
    expect(diffLines([""], [])).toMatchObject({ added: 0, removed: 1 });
    expect(diffLines([], [""])).toMatchObject({ added: 1, removed: 0 });
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
