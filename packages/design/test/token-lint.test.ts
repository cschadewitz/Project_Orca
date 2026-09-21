/**
 * The lint that enforces rule 1 of docs/design/RULES.md — no literal colours, sizes, radii,
 * durations or z-values in app code.
 *
 * Two checks, one rule: `checkCss` (run by `pnpm run lint:css`) for stylesheets, and the
 * `orca/design-tokens-only` ESLint rule (run by `pnpm run lint`) for inline `style` objects
 * in TSX. They live with the design system's other tests because what they protect is the
 * token layer, not the app.
 *
 * The fixtures are written in pairs: the literal fails, the same declaration written as a
 * token reference passes. The renderer's own stylesheets are checked here too, so the suite
 * fails the moment a literal lands in them — not only when someone remembers to run lint.
 */
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCss } from "../../../tools/eslint-config/css-tokens.js";
import orca from "../../../tools/eslint-config/rules/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The properties `checkCss` objects to, as `property: text` for readable assertions. */
const css = (source: string) => checkCss(source).map((v) => `${v.property}: ${v.text}`);

describe("checkCss", () => {
  test("rejects a hex colour and accepts the token that names it", () => {
    assert.deepEqual(css(".a { color: #a32a24; }"), ["color: #a32a24"]);
    assert.deepEqual(css(".a { color: var(--status-failed); }"), []);
  });

  test("rejects rgb() and hsl()", () => {
    assert.deepEqual(css(".a { background: rgba(0, 0, 0, 0.4); }"), ["background: rgba"]);
    assert.deepEqual(css(".a { background: hsl(210 20% 50%); }"), ["background: hsl"]);
    assert.deepEqual(css(".a { background: var(--surface-overlay); }"), []);
  });

  test("rejects a named colour but not `transparent` or `currentColor`", () => {
    assert.deepEqual(css(".a { border: var(--stroke-hairline) solid black; }"), ["border: black"]);
    assert.deepEqual(css(".a { border: var(--stroke-hairline) solid transparent; }"), []);
    assert.deepEqual(css(".a { fill: currentColor; }"), []);
  });

  test("rejects bare px, rem and ms values", () => {
    assert.deepEqual(css(".a { padding: 12px; }"), ["padding: 12px"]);
    assert.deepEqual(css(".a { font-size: 0.875rem; }"), ["font-size: 0.875rem"]);
    assert.deepEqual(css(".a { transition: opacity 120ms linear; }"), ["transition: 120ms"]);
    assert.deepEqual(css(".a { transition: opacity 0.2s linear; }"), ["transition: 0.2s"]);
    assert.deepEqual(css(".a { padding: var(--space-3); transition: opacity var(--duration-fast) linear; }"), []);
  });

  test("allows zero, percentages and intrinsic units", () => {
    assert.deepEqual(css(".a { margin: 0; padding: 0px; transition-delay: 0ms; }"), []);
    assert.deepEqual(css(".a { width: 100%; min-height: 100vh; grid-template-columns: 1fr 1fr; }"), []);
    assert.deepEqual(css(".a { flex: 1 1 auto; line-height: 1.4; letter-spacing: 0.06em; }"), []);
  });

  test("rejects a raw z-index and accepts a --z-* token", () => {
    assert.deepEqual(css(".a { z-index: 3; }"), ["z-index: 3"]);
    assert.deepEqual(css(".a { z-index: var(--z-palette); }"), []);
    assert.deepEqual(css(".a { z-index: auto; }"), []);
  });

  test("ignores comments, strings, url() and media query preludes", () => {
    assert.deepEqual(css("/* 12px #fff */ .a { color: var(--ink-primary); }"), []);
    assert.deepEqual(css('.a::after { content: "12px"; }'), []);
    assert.deepEqual(css(".a { background-image: url(a-16px.png); }"), []);
    assert.deepEqual(css("@media (max-width: 900px) { .a { padding: var(--space-2); } }"), []);
    // ...but a literal inside the media query's block is still a literal.
    assert.deepEqual(css("@media (max-width: 900px) { .a { padding: 8px; } }"), ["padding: 8px"]);
  });

  test("honours the `orca-allow-literal` escape hatch on the following line", () => {
    assert.deepEqual(css(".a {\n  /* orca-allow-literal: 1px hairline */\n  border-width: 1px;\n}"), []);
    assert.deepEqual(css(".a {\n  border-width: 1px;\n}"), ["border-width: 1px"]);
  });

  test("`lengths: false` keeps the colour and stacking checks", () => {
    const only = { lengths: false };
    assert.deepEqual(checkCss(".a { padding: 12px; }", "f", only), []);
    assert.equal(checkCss(".a { color: #a32a24; }", "f", only).length, 1);
    assert.equal(checkCss(".a { z-index: 3; }", "f", only).length, 1);
  });

  test("components.css names every colour and every stacking layer", () => {
    // Its literal type sizes and box heights are a separate migration (see checkCss's note),
    // but a hex colour or a bare z-index there would be a regression, and lint rejects one.
    const source = readFileSync(join(repoRoot, "packages/design/css/components.css"), "utf8");
    assert.deepEqual(
      checkCss(source, "components.css", { lengths: false }).map((v) => `${v.line}: ${v.message}`),
      [],
    );
  });

  test("the renderer's own stylesheets are clean", () => {
    const root = join(repoRoot, "packages/app/renderer");
    const sheets = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".css"))
      .map((e) => join(e.parentPath, e.name))
      .filter((f) => !f.includes("node_modules") && !f.includes("/dist/"));

    assert.ok(sheets.length > 0, "expected the renderer to have stylesheets to check");
    for (const sheet of sheets) {
      const found = checkCss(readFileSync(sheet, "utf8"), sheet);
      assert.deepEqual(
        found.map((v) => `${v.file}:${v.line} ${v.message}`),
        [],
      );
    }
  });

  /* `ch` is an intrinsic unit, so `checkCss` lets it through — it is a ratio to the type
     rather than a measurement. Rule 1 is still about it when it is a *box*: a column of a
     fixed width is a size the design system names, and a number in a stylesheet is one it
     does not. The lint cannot tell the two apart; this says which one the policy panel is. */
  test("the policy inspector's column is a named size, not a number in a stylesheet", () => {
    const sheet = readFileSync(join(repoRoot, "packages/app/renderer/src/config/policy.css"), "utf8");
    assert.match(sheet, /flex:\s*0 0 var\(--panel-w-policy\)/);
    assert.doesNotMatch(sheet, /flex:\s*0 0 \d/);
    const tokens = readFileSync(join(repoRoot, "packages/design/css/tokens.css"), "utf8");
    assert.match(tokens, /--panel-w-policy:/);
  });
});

/**
 * The rule is purely syntactic, so espree with JSX enabled parses the fixtures — no
 * TypeScript parser needed, and the fixtures stay readable.
 */
const linter = new Linter();
const tsx = (code: string) =>
  linter
    .verify(code, {
      plugins: { orca },
      languageOptions: { ecmaVersion: 2023, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
      rules: { "orca/design-tokens-only": "error" },
    })
    .map((m) => m.message);

/** The first message, or a marker that reads well in a failed assertion. */
const first = (messages: string[]) => messages[0] ?? "(no violation reported)";

describe("orca/design-tokens-only", () => {
  test("rejects a colour literal in a style prop and accepts the token", () => {
    assert.equal(tsx('const a = <div style={{ color: "#a32a24" }} />;').length, 1);
    assert.match(first(tsx('const a = <div style={{ color: "#a32a24" }} />;')), /Literal colour `#a32a24`/);
    assert.deepEqual(tsx('const a = <div style={{ color: "var(--status-failed)" }} />;'), []);
  });

  test("rejects rgb(), hsl() and named colours", () => {
    assert.equal(tsx('const a = <div style={{ background: "rgb(163 42 36)" }} />;').length, 1);
    assert.equal(tsx('const a = <div style={{ borderColor: "hsl(0 60% 40%)" }} />;').length, 1);
    assert.equal(tsx('const a = <div style={{ background: "white" }} />;').length, 1);
  });

  test("rejects numeric width, height and padding", () => {
    assert.match(first(tsx("const a = <div style={{ width: 240 }} />;")), /renders as `240px`/);
    assert.equal(tsx("const a = <div style={{ height: 32, padding: 8 }} />;").length, 2);
    assert.equal(tsx('const a = <div style={{ padding: "12px" }} />;').length, 1);
    assert.deepEqual(tsx('const a = <div style={{ width: "var(--sidebar-w)", padding: 0 }} />;'), []);
  });

  test("leaves alone what it cannot see, and the design system's own `style` prop", () => {
    assert.deepEqual(tsx("const a = <div style={{ width: computed }} />;"), []);
    assert.deepEqual(tsx("const a = <div style={style} />;"), []);
    assert.deepEqual(tsx('const a = <Text style="caption">hi</Text>;'), []);
    // Not a length: React does not append `px` to these.
    assert.deepEqual(tsx("const a = <div style={{ flex: 1, opacity: 0.5, lineHeight: 1.4 }} />;"), []);
  });

  test("accepts a custom property carrying a token reference, rejects one carrying a literal", () => {
    assert.deepEqual(tsx('const a = <div style={{ "--row-h": "var(--row-compact)" }} />;'), []);
    assert.equal(tsx('const a = <div style={{ "--row-h": "26px" }} />;').length, 1);
  });
});
