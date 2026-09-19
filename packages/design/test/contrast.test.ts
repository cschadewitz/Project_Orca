/**
 * WCAG 2 contrast for every documented token pairing, in every theme, plus the system
 * invariants (eight statuses, unique token names, usage notes). Runs with the rest of
 * the suite under vitest; it reads the JSON sources, not the generated output.
 *
 * A failure here is a design bug, not a test bug: if a new colour cannot meet
 * its floor, the colour is wrong. The one deliberate exemption is
 * `border-hairline`, which is decorative — it never distinguishes a control,
 * and anything that must be seen to be used takes `border-control`.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The slice of tokens.json / semantics.json these tests read. */
interface Token {
  name: string;
  value: string | Record<string, string>;
  usage?: string;
}
interface TokenFile {
  color: { themes: { id: string }[]; tokens: Token[] };
  [family: string]: unknown;
}
interface Semantics {
  runStatus: Record<string, { word?: string; glyph?: string; fg: string; bg: string }>;
}

const design = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = JSON.parse(readFileSync(join(design, "tokens.json"), "utf8")) as TokenFile;
const S = JSON.parse(readFileSync(join(design, "semantics.json"), "utf8")) as Semantics;

const THEMES = T.color.themes.map((t) => t.id);
const FIRST = THEMES[0]!;
const COLOR: Record<string, Token["value"]> = Object.fromEntries(T.color.tokens.map((t) => [t.name, t.value]));

const value = (name: string, theme: string): string => {
  const v = COLOR[name];
  assert.ok(v, `no such colour token: ${name}`);
  return typeof v === "string" ? v : (v[theme] ?? v[FIRST])!;
};

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const h = hex.replace("#", "").slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/* text: 4.5:1 — non-text that carries meaning: 3:1 (WCAG 1.4.11) */
const TEXT = 4.5;
const MARK = 3;
const PANES = ["surface-canvas", "surface-base", "surface-raised", "surface-sunken"];
const STATUS = Object.keys(S.runStatus);

/** [foreground, background, floor, why] */
type Pair = [fg: string, bg: string, floor: number, why: string];
const PAIRS = [
  ...["ink-primary", "ink-secondary", "ink-tertiary"].flatMap((ink) =>
    PANES.map((g) => [ink, g, TEXT, "body text on a pane"]),
  ),
  ...["accent", "accent-hover"].flatMap((a) =>
    ["surface-canvas", "surface-base", "surface-raised"].map((g) => [a, g, TEXT, "link text"]),
  ),
  ["on-accent", "accent", TEXT, "text on an accent fill"],
  ["ink-inverse", "ink-primary", TEXT, "text on an inverse fill"],
  ["ink-primary", "surface-selected", TEXT, "text on selection"],
  ["accent", "surface-selected", TEXT, "link on selection"],
  ["ink-primary", "accent-subtle", TEXT, "text on the accent tint"],
  ["accent", "accent-subtle", TEXT, "link on the accent tint"],

  ...STATUS.flatMap((s) => [
    [`status-${s}`, "surface-base", TEXT, `${s} text on a pane`],
    [`status-${s}`, "surface-canvas", TEXT, `${s} text on the canvas`],
    [`status-${s}`, `status-${s}-bg`, TEXT, `${s} chip text on its tint`],
    ["ink-primary", `status-${s}-bg`, TEXT, `body text on the ${s} tint`],
  ]),

  ...PANES.flatMap((g) => [
    ["border-control", g, MARK, "control boundary"],
    ["border-strong", g, MARK, "emphasis boundary"],
    ["border-focus", g, MARK, "focus ring"],
  ]),
  ...["status-waiting-bg", "status-failed-bg", "status-running-bg", "surface-selected", "accent-subtle"].map((g) => [
    "border-focus",
    g,
    MARK,
    "focus ring on a tint",
  ]),
  ...["surface-canvas", "surface-base", "surface-raised"].flatMap((g) => [
    ["graph-edge", g, MARK, "graph edge"],
    ["graph-edge-active", g, MARK, "traversed graph edge"],
  ]),

  ...["risk-low", "risk-moderate", "risk-high", "risk-severe", "diff-add-bg", "diff-remove-bg"].flatMap((g) => [
    ["ink-primary", g, TEXT, "text on a data ground"],
    ["ink-secondary", g, TEXT, "secondary text on a data ground"],
  ]),
] as Pair[];

for (const theme of THEMES) {
  test(`contrast — ${theme}`, () => {
    const failures: string[] = [];
    for (const [fg, bg, floor, why] of PAIRS) {
      const r = ratio(value(fg, theme), value(bg, theme));
      if (r < floor) failures.push(`${fg} on ${bg} = ${r.toFixed(2)}:1, needs ${floor}:1 (${why})`);
    }
    assert.deepEqual(failures, [], `\n  ${failures.join("\n  ")}\n`);
  });
}

test("every colour token says where it is used", () => {
  const silent = T.color.tokens.filter((t) => !t.usage?.trim()).map((t) => t.name);
  assert.deepEqual(silent, [], "a token without a usage note cannot be reviewed");
});

test("token names are unique across every family but type", () => {
  const seen = new Map<string, string>();
  for (const [family, fam] of Object.entries(T)) {
    const tokens = (fam as { tokens?: unknown } | null)?.tokens;
    if (!Array.isArray(tokens)) continue;
    for (const t of tokens as Token[]) {
      assert.ok(!seen.has(t.name), `duplicate token ${t.name} in ${family} and ${seen.get(t.name)}`);
      assert.match(t.name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, `illegal token name ${t.name}`);
      seen.set(t.name, family);
    }
  }
});

test("there are exactly eight run statuses, each with a word and a glyph", () => {
  assert.equal(Object.keys(S.runStatus).length, 8, "adding a ninth status is a design change, not a patch");
  for (const [name, s] of Object.entries(S.runStatus)) {
    assert.ok(s.word?.trim(), `${name} has no word`);
    assert.ok(s.glyph?.trim(), `${name} has no glyph — status is never colour alone`);
    assert.ok(COLOR[s.fg] && COLOR[s.bg], `${name} points at a token that does not exist`);
  }
});

test("cancelled and stale are distinguishable without hue", () => {
  /* they share the neutral ramp on purpose; the glyphs must differ */
  assert.notEqual(S.runStatus.cancelled!.glyph, S.runStatus.stale!.glyph);
});
