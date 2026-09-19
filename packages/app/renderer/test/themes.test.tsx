// @vitest-environment happy-dom
/**
 * The dual-theme helper, proving itself against the real design system: every status chip
 * resolves to the token `tokens.json` names for it, in light and in dark, and the two
 * themes actually differ.
 *
 * This doubles as the worked example for `themes.tsx` — a screen test asserting on colour
 * should look like `renders every status in its own token` below.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { RUN_STATUSES, STATUS_PRESENTATION, THEMES, type ColorToken } from "@orca/design";
import { StatusChip } from "../src/ui/status-chip.js";
import { Well } from "../src/ui/well.js";
import { expectedToken, inBothThemes, installDesignSystem, resolved, setTheme, themeToken } from "./themes.js";

afterEach(() => {
  cleanup();
  setTheme(undefined);
});

const chip = (): Element => screen.getByText(STATUS_PRESENTATION.failed.word).closest(".orca-chip")!;

describe("dual-theme rendering", () => {
  it("resolves a component's colours from the real tokens.css, per theme", () => {
    const seen: string[] = [];

    inBothThemes(<StatusChip status="failed" />, ({ theme }) => {
      expect(resolved(chip(), "color"), theme).toBe(expectedToken(theme, "status-failed"));
      expect(resolved(chip(), "background-color"), theme).toBe(expectedToken(theme, "status-failed-bg"));
      seen.push(resolved(chip(), "color"));
    });

    // Both themes ran, and they are not the same colour: a helper that silently rendered
    // one theme twice would pass every assertion above.
    expect(seen).toHaveLength(THEMES.length);
    expect(new Set(seen).size).toBe(THEMES.length);
  });

  it("renders every status in its own token, in both themes", () => {
    for (const status of RUN_STATUSES) {
      const colour = `status-${status}` as ColorToken;
      const background = `status-${status}-bg` as ColorToken;
      inBothThemes(<StatusChip status={status} />, ({ theme, container }) => {
        const el = container.querySelector(`.orca-chip--${status}`)!;
        expect(resolved(el, "color"), `${status} in ${theme}`).toBe(expectedToken(theme, colour));
        expect(resolved(el, "background-color"), `${status} in ${theme}`).toBe(expectedToken(theme, background));
      });
    }
  });

  it("themes a surface primitive, not just a status colour", () => {
    inBothThemes(<Well>body</Well>, ({ theme, container }) => {
      const well = container.querySelector(".orca-well")!;
      expect(resolved(well, "background-color"), theme).toBe(expectedToken(theme, "surface-sunken"));
    });
  });

  it("reads raw custom properties off the document root", () => {
    installDesignSystem();
    for (const theme of THEMES) {
      setTheme(theme);
      expect(themeToken("surface-canvas"), theme).toBe(expectedToken(theme, "surface-canvas"));
      expect(themeToken("accent"), theme).toBe(expectedToken(theme, "accent"));
    }
  });
});
