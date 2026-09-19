/**
 * Rendering a component in both themes and asserting on the colour it actually resolves to
 * (docs/design/RULES.md rule 7, "both themes, every time").
 *
 * The point of this helper is that the assertion reads the *real* design system. It loads
 * `packages/design/css/tokens.css` and `css/components.css` off disk into the test
 * document, sets `data-theme`, and then asks the DOM for the computed value — so a chip
 * that stopped referencing `--status-failed`, or a theme block that lost a token, fails
 * here. A test that compared against a hand-copied hex would pass in both cases.
 *
 * The expected side comes from `rawTokens` in `@orca/design`, which the same generator
 * writes from the same `tokens.json`. Naming the token rather than the value is what makes
 * the assertion mean "this element is bound to this token", which is the rule being
 * enforced; that it also catches the two generated artefacts drifting apart is a bonus.
 *
 * ## happy-dom vs jsdom
 *
 * happy-dom — already the repo's dev dependency — resolves `var()` against the cascade well
 * enough for this: a rule from a real stylesheet, selected by `[data-theme]`, comes back out
 * of `getComputedStyle(el).color` as the theme's hex. So there is no reason to add jsdom.
 *
 * One happy-dom limitation shapes the API below: it does not inherit custom properties down
 * the tree, so `getComputedStyle(someChild).getPropertyValue("--accent")` is empty even
 * though `var(--accent)` inside a rule on that child resolves correctly. Read a raw token
 * off `document.documentElement` (`themeToken`) and read *bound* properties — `color`,
 * `background-color`, … — off the element (`resolved`). Both are exercised in
 * `themes.test.tsx`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { rawTokens, THEMES, type ColorToken, type ThemeId } from "@orca/design";

// Path arithmetic with `node:path`, not `new URL(relative, import.meta.url)`: in a happy-dom
// environment the global `URL` is happy-dom's, and it resolves a relative reference to the
// base unchanged — so that form would silently read this very file as the stylesheet.
const designCss = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "design", "css");
const css = (name: string): string => readFileSync(join(designCss, name), "utf8");

/** `<style>` id, so a suite that installs per test does not stack twenty copies of the layer. */
const STYLE_ID = "orca-design-system";

/**
 * Put the real design system into the test document, in `main.tsx`'s cascade order: tokens
 * first (the custom properties), then the component layer that references them.
 */
export function installDesignSystem(): void {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${css("tokens.css")}\n${css("components.css")}`;
  document.head.append(style);
}

/** The theme the document is in. `undefined` clears it, which means "follow the OS". */
export function setTheme(theme: ThemeId | undefined): void {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}

/**
 * A resolved CSS property of an element — what the cascade made of it, `var()` and all.
 * Hex is normalised to lower case; happy-dom passes a token's hex straight through where a
 * browser would say `rgb(...)`, and a test should not care which.
 *
 * Standard properties are read through the camel-case accessor rather than
 * `getPropertyValue`: happy-dom's computed declaration answers `getPropertyValue` for
 * custom properties but returns `""` for `color` and friends, which would make every
 * assertion below vacuously compare two empty strings if it were not for this.
 */
export function resolved(element: Element, property: string): string {
  const computed = getComputedStyle(element);
  const value = property.startsWith("--")
    ? computed.getPropertyValue(property)
    : ((computed as unknown as Record<string, string | undefined>)[camelCase(property)] ?? "");
  return value.trim().toLowerCase();
}

const camelCase = (property: string): string => property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** A raw custom property in the theme the document is currently in. */
export function themeToken(token: ColorToken): string {
  return resolved(document.documentElement, `--${token}`);
}

/** What `tokens.json` says this token is in this theme — the expected side of an assertion. */
export function expectedToken(theme: ThemeId, token: ColorToken): string {
  const value = rawTokens[theme][token];
  if (!value) throw new Error(`no ${token} in the ${theme} theme; is @orca/design regenerated?`);
  return value.toLowerCase();
}

export interface ThemedRender extends RenderResult {
  theme: ThemeId;
}

/**
 * Mount `ui` once per theme and hand each mount to `assert`. The element is wrapped in
 * `.orca` — the design system's root class, which `index.html` puts on `<body>` — because
 * the component layer's rules are scoped under it.
 *
 * Each theme gets its own mount and is unmounted afterwards, so a component that reads a
 * colour once on mount is measured in the theme it was mounted in rather than in whichever
 * theme the previous case left behind.
 */
export function inBothThemes(ui: ReactElement, assert: (view: ThemedRender) => void): void {
  installDesignSystem();
  for (const theme of THEMES) {
    setTheme(theme);
    const container = document.createElement("div");
    container.className = "orca";
    document.body.append(container);
    const view = render(ui, { container });
    try {
      assert(Object.assign(view, { theme }));
    } finally {
      view.unmount();
      container.remove();
    }
  }
  setTheme(undefined);
}
