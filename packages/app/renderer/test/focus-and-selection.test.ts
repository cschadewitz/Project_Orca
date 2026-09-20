/**
 * The other half of "selection and focus are legible at once" (#167).
 *
 * `a11y-sweep.test.tsx` asserts the behavioural half from the renderer's side: a row stays
 * selected while focus is in the filter field, because selection is `aria-activedescendant`
 * on a single tab stop. That is everything about the contract a rendered tree can see — and
 * it is not the whole contract, because the rest of it is a claim about *pixels*:
 *
 * > `border-focus`, 2px, offset 1px, drawn with `outline` so it never changes layout, and
 * > never suppressed. […] `:focus-visible` governs whether it is drawn after a mouse click,
 * > but it is never removed from the stylesheet.
 * > Selection and focus are separate and look different: selection is `surface-selected`
 * > plus a 2px `accent` left rail, focus is the ring.
 *
 * happy-dom does not do cascade or computed style, so there is no honest way to render a row
 * and *measure* the ring. What can be done honestly is to read the stylesheets as text and
 * hold them to the four structural decisions that make the claim true, which is the same
 * move `type-notes.ts` makes for #211 and for the same reason: the rule is the artefact, so
 * the rule is what the test reads.
 *
 * The four:
 *
 * - **the ring is `outline`**, not a `border` and not a `box-shadow`. A border changes
 *   layout, so every focusable thing would shift by 2px as it was tabbed to; a shadow is
 *   dropped by forced-colours mode, which is exactly the person this ring is for.
 * - **it is keyed on `:focus-visible`**, which *is* the "governs after a click" rule — the
 *   pseudo-class is the browser's own judgement about whether the focus was a keyboard's.
 * - **selection is a different set of properties entirely**, so a row that is both selected
 *   and focused shows both and neither hides the other.
 * - **nothing suppresses the ring**, anywhere — and the one rule that does today is named
 *   here as the open finding it is, so that a *second* one cannot arrive quietly.
 *
 * Scope is the component layer plus every stylesheet this app adds on top of it. `tokens.css`
 * is generated custom properties and declares no `outline` at all.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { componentsCssSource } from "./type-notes.js";

// `node:path` rather than `new URL(relative, import.meta.url)` — the trap `type-notes.ts`
// and `themes.tsx` both document, and this file is plain Node anyway.
const rendererSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every `.css` this app adds on top of the component layer, by path from `renderer/src`. */
function appStylesheets(): { name: string; css: string }[] {
  const found: { name: string; css: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".css"))
        found.push({ name: `${prefix}${entry.name}`, css: readFileSync(path, "utf8") });
    }
  };
  walk(rendererSrc, "");
  return found;
}

interface Rule {
  /** The selector list, whitespace collapsed: `.orca :focus-visible, .orca-focus`. */
  selector: string;
  /** The declarations between the braces, as written. */
  body: string;
}

/**
 * Every `selector { … }` in a stylesheet, comments stripped first — several of the comments
 * here discuss `outline` and `--border-focus` in prose, and a test that counted those would
 * be reading the argument rather than the rule.
 *
 * An `@media` wrapper is not itself a rule and does not appear; the rules nested inside one
 * do, under their own selectors, which is what this asks about.
 */
function rules(css: string): Rule[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim().replace(/\s+/g, " "),
    body: match[2]!.trim(),
  }));
}

/** One declaration's value, or `undefined` when the rule does not set that property. */
function declaration(body: string, property: string): string | undefined {
  for (const line of body.split(";")) {
    const [name, ...rest] = line.split(":");
    if (name?.trim() === property) return rest.join(":").trim();
  }
  return undefined;
}

const COMPONENT_RULES = rules(componentsCssSource);
const APP_SHEETS = appStylesheets();

/** The one rule the whole app's focus ring comes out of. */
const RING = COMPONENT_RULES.find((rule) => rule.selector.includes(":focus-visible"));

describe("the focus ring", () => {
  it("is drawn with outline, in the design's own tokens, so it never changes layout", () => {
    expect(RING, "components.css has no :focus-visible rule at all").toBeDefined();

    const outline = declaration(RING!.body, "outline");
    expect(outline).toBe("var(--stroke-focus) solid var(--border-focus)");
    // The offset the spec names, as a token rather than as 1px.
    expect(declaration(RING!.body, "outline-offset")).toBe("var(--stroke-hairline)");

    /* Not a border and not a shadow. A `border` would move the element it is drawn on, so
       tabbing through a list would shuffle it; a `box-shadow` is dropped entirely by
       forced-colours mode, which would take the ring away from the person most likely to
       be relying on it. */
    expect(declaration(RING!.body, "border")).toBeUndefined();
    expect(declaration(RING!.body, "box-shadow")).toBeUndefined();
  });

  it("is keyed on :focus-visible, which is what makes a mouse click not draw it", () => {
    /* The spec's "`:focus-visible` governs whether it is drawn after a mouse click" is not
       something the app implements — it is a pseudo-class, and the browser's own judgement
       about whether the focus came from a keyboard. What the app has to get right is using
       it instead of bare `:focus`, and that is what this reads. */
    for (const part of RING!.selector.split(",").map((s) => s.trim())) {
      expect(part.endsWith(":focus-visible") || part === ".orca-focus", part).toBe(true);
    }
    // `.orca-focus` is the escape hatch for a ring the app has to draw itself (a composite
    // widget whose focus lives on a child); it is the same declarations, not a second look.
    expect(RING!.selector).toContain(".orca-focus");
  });

  it("is re-declared identically wherever a surface draws its own", () => {
    /* A surface may need the ring on an element the component layer never sees — the
       Attention card body is the tab stop `J`/`K` move between. When it does, it is the
       same two declarations, because two focus rings that differ are two focus rings a
       person has to learn. */
    for (const sheet of APP_SHEETS) {
      for (const rule of rules(sheet.css)) {
        const outline = declaration(rule.body, "outline");
        if (outline === undefined || !rule.selector.includes(":focus")) continue;
        expect(rule.selector, `${sheet.name} — ${rule.selector}`).toContain(":focus-visible");
        expect(outline, `${sheet.name} — ${rule.selector}`).toBe(declaration(RING!.body, "outline"));
      }
    }
  });
});

describe("selection is a different visual from focus", () => {
  it("is a ground and a rail, and never borrows the ring's token", () => {
    const selected = COMPONENT_RULES.filter((rule) => /--selected\b|\[aria-selected="true"\]/.test(rule.selector));
    expect(selected.length).toBeGreaterThan(0);

    for (const rule of selected) {
      /* The spec: "selection is `surface-selected` plus a 2px `accent` left rail, focus is
         the ring". A selected row that reached for `--border-focus` — in an outline or in
         anything else — would be a row that looked focused while focus was in the palette,
         which is the exact confusion the two-visual rule exists to prevent. */
      expect(rule.body, rule.selector).not.toContain("--border-focus");
    }

    // And the tree row — the one the spec describes by name — is both halves of it.
    const treeRow = COMPONENT_RULES.find((rule) => rule.selector === ".orca-tree-row--selected")!;
    expect(treeRow).toBeDefined();
    expect(declaration(treeRow.body, "background")).toBe("var(--surface-selected)");
    expect(declaration(treeRow.body, "border-left-color")).toBe("var(--accent)");
  });

  it("leaves room for the rail on every row, so selecting one moves nothing", () => {
    /* The rail is a transparent border the unselected row already carries, not a border
       that appears with the selection — otherwise every row would shift 2px sideways as
       selection passed over it, which is the same layout bug the ring avoids by being an
       outline. */
    const row = COMPONENT_RULES.find((rule) => rule.selector === ".orca-tree-row")!;
    expect(declaration(row.body, "border-left")).toBe("var(--stroke-rail) solid transparent");
  });
});

/**
 * The rules that switch the ring off. The spec says the ring is "never suppressed", so the
 * honest shape of this test is an allowlist of nil — except that it is not nil today, and a
 * test that failed on a known finding would just be a red build nobody could fix from here.
 *
 * So the one that exists is named, with what is wrong with it, and the assertion is that
 * *this* is the list. A second suppression added anywhere fails here.
 */
const KNOWN_SUPPRESSIONS: readonly { selector: string; why: string }[] = [
  {
    selector: ".orca-palette__input:focus",
    /* An open finding, not an accepted exemption. Rule 10 allows suppressing the ring only
       against a compensating one, and the comment above this rule claims exactly that —
       "the ring belongs to the palette, not to the field inside it". But `.orca-palette`
       has no `:focus-within` rule and the whole component layer references `--border-focus`
       precisely once, in the `:focus-visible` rule above. The compensating ring does not
       exist, so opening the palette with ⌘K puts focus somewhere with no focus indicator
       at all. Reported to the integrator with wave 4; `components.css` is unit T's file,
       not this one's. When it is fixed, delete this entry. */
    why: "suppressed against a palette ring that does not exist (open finding, components.css)",
  },
];

describe("the ring is never suppressed", () => {
  it("is switched off in exactly the places written down here, and nowhere else", () => {
    const sheets = [{ name: "components.css", css: componentsCssSource }, ...APP_SHEETS];
    const suppressing: string[] = [];
    for (const sheet of sheets) {
      for (const rule of rules(sheet.css)) {
        const outline = declaration(rule.body, "outline");
        if (outline === "none" || outline === "0") suppressing.push(`${sheet.name} — ${rule.selector}`);
      }
    }

    expect(suppressing).toEqual(KNOWN_SUPPRESSIONS.map((known) => `components.css — ${known.selector}`));
  });

  it("is not suppressed anywhere in this app's own stylesheets", () => {
    // The finding above is the component layer's. Nothing the renderer adds on top of it
    // takes the ring away, and this is the half of the claim that is this unit's to keep.
    for (const sheet of APP_SHEETS) {
      for (const rule of rules(sheet.css)) {
        expect(declaration(rule.body, "outline"), `${sheet.name} — ${rule.selector}`).not.toBe("none");
      }
    }
  });
});
