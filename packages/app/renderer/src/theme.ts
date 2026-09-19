/// <reference lib="dom" />
/**
 * Theme is one attribute, `data-theme` on `<html>`, and this module is the only code in the
 * renderer that touches it. Absent means "follow the OS": `tokens.css` carries a
 * `prefers-color-scheme` block for that case, and `color-scheme` travels with each block so
 * native scrollbars and form controls match. Nothing else reads the theme in JavaScript —
 * every colour is a custom property, and the cascade does the rest
 * (docs/design/60-implementation.md).
 */
import type { ThemePreference } from "../../src/preferences/schema.js";

export const THEME_ATTRIBUTE = "data-theme";

/** What ⌘⇧L walks through, in this order. Mirrors `THEME_PREFERENCES` in the schema. */
export const THEME_CYCLE = ["system", "light", "dark"] as const satisfies readonly ThemePreference[];

export function applyTheme(root: Element, theme: ThemePreference): void {
  if (theme === "system") root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, theme);
}

export function nextTheme(theme: ThemePreference): ThemePreference {
  const at = THEME_CYCLE.indexOf(theme);
  return THEME_CYCLE[(at + 1) % THEME_CYCLE.length] ?? THEME_CYCLE[0];
}
