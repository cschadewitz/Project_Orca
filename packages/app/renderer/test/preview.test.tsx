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
});
