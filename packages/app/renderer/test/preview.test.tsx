import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RUN_STATUSES, SCHEDULE_CLASSES, STATE_VIEW_KINDS, THEMES } from "@orca/design";
import { Preview } from "../src/preview/preview.js";

/* The preview is the review surface for the rest of the milestone (#147), so it has to
   keep rendering even though nobody imports it from a screen. These assertions are about
   its completeness — every theme, every status, every state — not about how it looks. */
describe("the primitive preview", () => {
  const markup = renderToStaticMarkup(<Preview />);

  it("renders both themes side by side, as attributed subtrees", () => {
    for (const theme of THEMES) expect(markup).toContain(`data-theme="${theme}"`);
    expect(markup.match(/class="preview__theme /g)).toHaveLength(THEMES.length);
  });

  it("renders every status, schedule class and state view, in each theme", () => {
    for (const status of RUN_STATUSES) {
      expect(markup.match(new RegExp(`orca-chip--${status}`, "g")), status).not.toBeNull();
    }
    for (const classification of SCHEDULE_CLASSES) {
      expect(markup, classification).toContain(`orca-badge--${classification}`);
    }
    for (const kind of STATE_VIEW_KINDS) {
      expect(markup, kind).toContain(`orca-state--${kind}`);
    }
  });

  it("renders the graph canvas's corner — the controls and the minimap — in each theme", () => {
    expect(markup.match(/class="orca-canvasctl"/g)).toHaveLength(THEMES.length);
    expect(markup.match(/class="orca-graphmap"/g)).toHaveLength(THEMES.length);
    expect(markup).toContain('aria-label="Lay out top to bottom"');
  });

  it("shows a menu's every kind of item, the danger one last, on the raised surface", () => {
    expect(markup.match(/orca-menu__item orca-menu__item--danger/g)).toHaveLength(THEMES.length);
    expect(markup.match(/orca-menu__machine/g)?.length).toBeGreaterThanOrEqual(THEMES.length);
    expect(markup.match(/class="orca-menu__note/g)).toHaveLength(THEMES.length);
  });

  it("shows a release confirmed in place: the row at rest and armed", () => {
    expect(markup.match(/class="orca-agents__claim"/g)).toHaveLength(THEMES.length);
    expect(markup.match(/orca-agents__claim--armed/g)).toHaveLength(THEMES.length);
    expect(markup).toContain('aria-label="Release Database schema?"');
  });

  it("shows text that does not fit: a one-line save bar whose sentence gives way, and counts as units", () => {
    expect(markup.match(/aria-label="Unsaved configuration changes"/g)).toHaveLength(THEMES.length);
    expect(markup).toContain("orca-truncate");
    expect(markup).toContain("4\u00a0changes");
    expect(markup).toContain("+2\u00a0nodes · 1\u00a0changed · 1\u00a0removed · 3\u00a0edges");
  });
});
