// @vitest-environment happy-dom
/* The type and glyph proof surface (#194). The page exists to be looked at, so these tests
   are not about how it looks — they are about it staying *complete* and staying *derived*:
   every type style tokens.json declares, every status, every connection state, every glyph
   semantics.json renders, in both themes, and a fallback toggle that really does take the
   bundled faces out of the stacks.

   The expected side is read from the design package's own sources on disk, not from the
   module under test, so a style or a glyph added there fails here until the page covers it.
   That is what keeps the surface honest as the sources grow. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHROME_GLYPHS, CONNECTION_PRESENTATION, RUN_STATUSES, STATUS_PRESENTATION, THEMES } from "@orca/design";
import { TypeProof } from "../src/preview/type-proof.js";
import { BUNDLED_FAMILIES, FALLBACK_STACKS, FONT_STACKS, TYPE_STYLES } from "../src/preview/type-sources.js";

const designDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "design");
const tokens = JSON.parse(readFileSync(join(designDir, "tokens.json"), "utf8")) as {
  type: { fonts: { family: string }[]; groups: { styles: { name: string }[] }[] };
};
const semantics = JSON.parse(readFileSync(join(designDir, "semantics.json"), "utf8")) as Record<string, unknown>;

/** Every style name in tokens.json, in declaration order. */
const declaredStyles = tokens.type.groups.flatMap((group) => group.styles.map((style) => style.name));

/** Every glyph anywhere in semantics.json — the same walk build-fonts.js does. */
const declaredGlyphs = ((): string[] => {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.glyph === "string") found.add(record.glyph);
    for (const value of Object.values(record)) walk(value);
  };
  walk(semantics);
  return [...found];
})();

afterEach(cleanup);

describe("what the proof surface is derived from", () => {
  it("takes the scale from tokens.css, and it matches tokens.json", () => {
    expect(TYPE_STYLES.map((style) => style.name)).toEqual(declaredStyles);
    for (const style of TYPE_STYLES) {
      expect(style.track, style.name).toMatch(/^(sans|mono)$/);
      expect(style.fontSize, style.name).not.toBe("");
      expect(style.fontWeight, style.name).not.toBe("");
    }
  });

  it("takes the bundled families from the @font-face rules, and they match tokens.json", () => {
    expect([...BUNDLED_FAMILIES].sort()).toEqual([...new Set(tokens.type.fonts.map((f) => f.family))].sort());
  });

  it("builds the fallback stacks by subtracting the bundled families from the real ones", () => {
    for (const [name, stack] of Object.entries(FONT_STACKS)) {
      const fallback = FALLBACK_STACKS[name] ?? "";
      /* Something is left — a fallback stack that resolved to nothing would render the OS
         default and prove nothing about the declared fallbacks. */
      expect(fallback.length, name).toBeGreaterThan(0);
      /* Something was actually removed, and nothing bundled survived. */
      expect(fallback.length, name).toBeLessThan(stack.length);
      for (const family of BUNDLED_FAMILIES) {
        expect(fallback, `${name} fallback must not name ${family}`).not.toContain(family);
      }
    }
  });
});

describe("what the proof surface shows", () => {
  const markup = renderToStaticMarkup(<TypeProof />);

  it("renders both themes side by side, as attributed subtrees", () => {
    for (const theme of THEMES) expect(markup).toContain(`data-theme="${theme}"`);
    expect(markup.match(/class="type-proof__theme /g)).toHaveLength(THEMES.length);
  });

  it("sets a sample in every type style tokens.json declares, in each theme", () => {
    for (const name of declaredStyles) {
      expect(markup.match(new RegExp(`data-style="${name}"`, "g")), name).toHaveLength(THEMES.length);
      expect(markup, name).toContain(`orca-text-${name}`);
    }
  });

  it("renders every run status as a chip, with its word and its glyph", () => {
    for (const status of RUN_STATUSES) {
      const { word, glyph } = STATUS_PRESENTATION[status];
      expect(markup, status).toContain(`orca-chip--${status}`);
      expect(markup, status).toContain(word);
      expect(markup, status).toContain(glyph);
    }
  });

  it("renders every connection state", () => {
    for (const [state, presentation] of Object.entries(CONNECTION_PRESENTATION)) {
      expect(markup, state).toContain(`orca-conn--${state}`);
      expect(markup, state).toContain(presentation.word);
    }
  });

  it("shows every glyph semantics.json renders, with its codepoint", () => {
    for (const glyph of [...declaredGlyphs, ...Object.values(CHROME_GLYPHS)]) {
      const codepoint = `U+${(glyph.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
      expect(markup, `${glyph} ${codepoint}`).toContain(codepoint);
    }
  });

  it("puts two ids side by side in mono-id, and box drawing in mono-log", () => {
    expect(markup.match(/class="orca-text-mono-id"/g)?.length ?? 0).toBeGreaterThan(2 * THEMES.length);
    expect(markup).toContain("orca-text-mono-log");
    /* The rules the stream draws: a frame, a tree guide, and the reconnect seam. */
    for (const rule of ["┌─", "│", "└─", "├─", "── reconnected"]) expect(markup, rule).toContain(rule);
  });
});

describe("the fallback toggle", () => {
  it("swaps the bundled faces out of both stacks, and back in", () => {
    render(<TypeProof />);
    const surface = document.querySelector<HTMLElement>(".type-proof");
    const toggle = screen.getByRole("button");

    expect(surface?.dataset.faces).toBe("bundled");
    expect(surface?.getAttribute("style") ?? "").toBe("");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(surface?.dataset.faces).toBe("fallback");
    const style = surface?.getAttribute("style") ?? "";
    for (const family of BUNDLED_FAMILIES) expect(style, family).not.toContain(family);
    /* …but still a stack: the declared per-OS fallbacks, which is what a machine that
       failed to load the woff2 files would use. */
    expect(style).toContain("--font-sans");
    expect(style).toContain("--font-mono");

    fireEvent.click(toggle);
    expect(surface?.dataset.faces).toBe("bundled");
    expect(surface?.getAttribute("style") ?? "").toBe("");
  });
});
