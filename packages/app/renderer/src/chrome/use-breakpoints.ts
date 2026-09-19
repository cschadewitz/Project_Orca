/**
 * The window-chrome layout thresholds from docs/design/50-accessibility-and-keyboard.md,
 * read from the design tokens (packages/design/tokens.json's `breakpoint` family) rather
 * than hardcoded here — a CSS media query cannot reference a custom property, so this is
 * the one place they have to be plain numbers.
 */
import { BREAKPOINTS } from "@orca/design";
import { useMediaQuery } from "./use-media-query.js";

export function useSidebarCollapsed(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINTS["bp-sidebar-collapse"] - 1}px)`);
}

export function usePanelOverlay(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINTS["bp-panel-overlay"] - 1}px)`);
}
