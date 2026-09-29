/**
 * A line diff between two artifact versions, as a plain module with a plain test.
 *
 * It is hand-written rather than taken from a package, and that is the decision this file
 * exists to record: `packages/app` depends on `react`, `react-dom`, `zod` and the two
 * `@orca/*` workspaces, and nothing else (ADR 0008 is about the *workspace* boundary; the
 * npm one is a separate, deliberate line). A diff of two texts is forty lines of Myers or
 * twenty of longest-common-subsequence, and neither is worth a dependency in a process
 * that renders a person's artifacts.
 *
 * The algorithm is LCS over lines, with the two cheap wins in front of it:
 *
 * - **Common prefix and suffix are matched before the table is built.** Two versions of a
 *   spec differ in a paragraph and agree on the rest, so this is not an optimisation for a
 *   pathological case — it is the ordinary case, and it turns a 2,000×2,000 table into a
 *   20×20 one.
 * - **A table larger than {@link MAX_CELLS} is not built at all.** The panel would rather
 *   say "these two versions are too far apart to line up" than lock the renderer's one
 *   thread for a second; the whole-file replacement it falls back to is still a true diff,
 *   just an unhelpful one, and it is marked so the caller can say which it got.
 *
 * Gutters, not colour: every changed line carries `+` or `−` (U+2212, the real minus,
 * which the bundled mono face has) as text. `.orca-diff__line--add` / `--del` tint it as
 * the third channel (rule 4).
 */

export type DiffOp = "same" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the older version; absent on an added line. */
  a?: number;
  /** 1-based line number in the newer version; absent on a removed line. */
  b?: number;
}

export interface Diff {
  lines: readonly DiffLine[];
  added: number;
  removed: number;
  /**
   * True when the two versions were too far apart to line up and the result is a whole-file
   * replacement rather than a matched diff. The panel says so rather than implying the
   * files have nothing in common.
   */
  coarse: boolean;
}

/** The gutter glyphs. U+2212 rather than a hyphen: it is a minus, and it is bundled. */
export const ADD_GUTTER = "+";
export const DEL_GUTTER = "−";
export const SAME_GUTTER = " ";

/**
 * The largest LCS table this will build. 4,000,000 cells is a pair of 2,000-line files
 * that share no prefix or suffix at all, which takes a few milliseconds; ten times that
 * would be a visible stall on the thread that draws the window.
 */
export const MAX_CELLS = 4_000_000;

/**
 * Split a body into lines the way a diff reads it: a trailing newline terminates, it does
 * not add.
 *
 * `toLines("")` is `[""]` and stays that way, deliberately: a one-line file whose line is
 * empty is not the same object as a file with nothing in it, and the split is the wrong
 * place to lose that. What is *diffed* is decided in {@link bodyLines} below.
 */
export function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The lines a *body* contributes to a diff: an empty body contributes none (#250).
 *
 * `"".split("\n")` is `[""]`, so without this a version compared against an empty one —
 * v1 of an artifact, or a body a tool recorded as the empty string — diffs as a file of one
 * blank line, and the panel's sentence reads "1 added, 1 removed" for what is a pure
 * creation. The gutters and the bodies were always right; only the count lied.
 *
 * It is here rather than in {@link toLines} because the distinction is about counting a
 * *change*, not about splitting a string: `diffLines([""], [])` is still one removed empty
 * line, because a caller that passes an array has already said the line exists.
 */
function bodyLines(text: string): string[] {
  return text === "" ? [] : toLines(text);
}

/** The gutter a line takes. Exported so the renderer never restates the three glyphs. */
export function gutterFor(op: DiffOp): string {
  if (op === "add") return ADD_GUTTER;
  if (op === "del") return DEL_GUTTER;
  return SAME_GUTTER;
}

/** Diff two bodies. `a` is the older version, `b` the newer. */
export function diffText(a: string, b: string): Diff {
  return diffLines(bodyLines(a), bodyLines(b));
}

/**
 * Every indexed read below is bounded by the loop it sits in, so it is asserted (`!`) rather
 * than defaulted (#251). A `?? ""` there was never a case, only a way to satisfy
 * `noUncheckedIndexedAccess`, and it counted as an unreachable branch against the renderer's
 * coverage ratchet. The trade is deliberate: `!` is erased at runtime, so an off-by-one that
 * would once have rendered a blank line now renders nothing for that line - louder, and the
 * kind of wrong a test notices.
 */
export function diffLines(a: readonly string[], b: readonly string[]): Diff {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  const emit = (op: DiffOp, text: string, ai: number | undefined, bi: number | undefined): void => {
    if (op === "add") added++;
    if (op === "del") removed++;
    lines.push({ op, text, ...(ai === undefined ? {} : { a: ai }), ...(bi === undefined ? {} : { b: bi }) });
  };

  // The matching head and tail, which is most of two versions of the same document.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  for (let i = 0; i < head; i++) emit("same", a[i]!, i + 1, i + 1);

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const coarse = midA.length * midB.length > MAX_CELLS;

  if (coarse) {
    for (let i = 0; i < midA.length; i++) emit("del", midA[i]!, head + i + 1, undefined);
    for (let i = 0; i < midB.length; i++) emit("add", midB[i]!, undefined, head + i + 1);
  } else {
    for (const step of walk(midA, midB)) {
      emit(
        step.op,
        step.text,
        step.a === undefined ? undefined : head + step.a,
        step.b === undefined ? undefined : head + step.b,
      );
    }
  }

  for (let i = 0; i < tail; i++) {
    const ai = a.length - tail + i;
    emit("same", a[ai]!, ai + 1, b.length - tail + i + 1);
  }

  return { lines, added, removed, coarse };
}

/**
 * The LCS table and the walk back through it. Rows are `a`, columns are `b`; `table[i][j]`
 * is the length of the longest common subsequence of `a[i…]` and `b[j…]`, which makes the
 * walk forwards from `(0, 0)` and so emits removals before additions at a hunk, the order a
 * diff is read in.
 */
function* walk(
  a: readonly string[],
  b: readonly string[],
): Generator<{ op: DiffOp; text: string; a?: number; b?: number }> {
  const rows = a.length;
  const cols = b.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const row = table[i]!;
      row[j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, row[j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      yield { op: "same", text: a[i]!, a: i + 1, b: j + 1 };
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      yield { op: "del", text: a[i]!, a: i + 1 };
      i++;
    } else {
      yield { op: "add", text: b[j]!, b: j + 1 };
      j++;
    }
  }
  while (i < rows) {
    yield { op: "del", text: a[i]!, a: i + 1 };
    i++;
  }
  while (j < cols) {
    yield { op: "add", text: b[j]!, b: j + 1 };
    j++;
  }
}
