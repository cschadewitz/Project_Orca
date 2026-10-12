// @vitest-environment happy-dom
/**
 * The surface nav, and in particular the rail it collapses to below 960px (#261).
 *
 * What is being held here is that the rail draws the *designed* glyphs — `semantics.json`'s
 * `surface` map, reached through `@orca/design` — rather than characters picked in
 * `surfaces.ts`, and that losing the label on screen loses nothing else: every button keeps
 * its name and its `⌘<n>` digit at every width. The expected side is read from the design
 * package, so a glyph changed there fails here until the app follows it, and a glyph written
 * back into the app as a literal fails here too.
 */
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { SURFACE_IDS, SURFACE_PRESENTATION } from "@orca/design";
import { Sidebar } from "../src/chrome/sidebar.js";
import { SURFACES } from "../src/chrome/surfaces.js";
import { inBothThemes, resolved } from "./themes.js";

/** The nav inside the shell element the collapsed rules select on. */
const rail = (collapsed: boolean): ReactElement => (
  <div className="orca-body" {...(collapsed ? { "data-sidebar": "collapsed" } : {})}>
    <Sidebar active="attention" onSelect={() => undefined} waitingCount={2} />
  </div>
);

const buttons = (container: HTMLElement): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>("button.orca-nav"),
];

describe("the surface nav", () => {
  it("takes its order, words and glyphs from @orca/design, not from the app", () => {
    expect(SURFACES.map((s) => s.id)).toEqual([...SURFACE_IDS]);
    for (const surface of SURFACES) {
      const presentation = SURFACE_PRESENTATION[surface.id];
      expect(surface.label, surface.id).toBe(presentation.word);
      expect(surface.glyph, surface.id).toBe(presentation.glyph);
    }
  });

  it("gives the six surfaces the digits ⌘1–⌘6 in sidebar order", () => {
    expect(SURFACES.map((s) => s.shortcut)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("the collapsed rail", () => {
  it("renders six named items, each with its designed glyph, in both themes", () => {
    inBothThemes(rail(true), ({ container, theme }) => {
      const items = buttons(container);
      expect(items, theme).toHaveLength(6);

      items.forEach((item, index) => {
        const surface = SURFACES[index]!;
        const presentation = SURFACE_PRESENTATION[surface.id];

        /* Still named: the glyph is decorative and the title is what a screen reader
           falls back to, so the button says "Attention" at every width. */
        expect(item.title, `${theme} ${surface.id}`).toBe(presentation.word);

        const glyph = item.querySelector(".orca-nav__glyph");
        expect(glyph?.textContent, `${theme} ${surface.id}`).toBe(presentation.glyph);
        expect(glyph?.getAttribute("aria-hidden"), `${theme} ${surface.id}`).toBe("true");
        /* The glyph is what is left on screen, so it is the one thing that must not be
           hidden by the collapsed rules. */
        expect(resolved(glyph!, "display"), `${theme} ${surface.id}`).not.toBe("none");

        /* …and the word is hidden rather than removed. */
        const label = item.querySelector(".orca-nav__label");
        expect(label?.textContent, `${theme} ${surface.id}`).toBe(presentation.word);
        expect(resolved(label!, "display"), `${theme} ${surface.id}`).toBe("none");
      });
    });
  });

  it("draws no glyph the design system has not declared", () => {
    inBothThemes(rail(true), ({ container }) => {
      const drawn = buttons(container).map((item) => item.querySelector(".orca-nav__glyph")?.textContent);
      const declared = SURFACE_IDS.map((id) => SURFACE_PRESENTATION[id].glyph);
      expect(drawn).toEqual(declared);
      /* Six destinations told apart by shape alone once the labels go. */
      expect(new Set(drawn).size).toBe(6);
    });
  });
});

describe("the expanded sidebar", () => {
  it("still shows the words, and the waiting count on Attention", () => {
    inBothThemes(rail(false), ({ container, theme }) => {
      const items = buttons(container);
      const label = items[0]?.querySelector(".orca-nav__label");
      expect(label?.textContent, theme).toBe(SURFACE_PRESENTATION.attention.word);
      expect(resolved(label!, "display"), theme).not.toBe("none");
      expect(items[0]?.querySelector(".orca-nav__count")?.textContent, theme).toBe("2");
    });
  });
});
