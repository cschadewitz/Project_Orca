/**
 * The window's own frame: none. The renderer draws the window's only title bar ("no OS
 * chrome relied upon", docs/design/10-information-architecture.md), and the OS keeps just
 * its buttons, inside the room the bar's platform padding leaves for them:
 *
 * - **macOS** — `titleBarStyle: "hidden"`, the traffic lights centred in
 *   `titlebar-inset-traffic-lights` and in the bar's height.
 * - **Windows** — `titleBarStyle: "hidden"` with a Window Controls Overlay: the caption
 *   buttons, painted by the OS over the right end of the bar, which
 *   `titlebar-inset-caption-buttons` is exactly the width of.
 * - **Linux** — the window manager's frame, unchanged. Both insets are zero there by the
 *   tokens' own usage notes, so a frameless Linux window would have no buttons at all.
 *
 * Before this the window kept its OS frame on every platform, and the custom bar sat under
 * a second, native one with its insets padding nothing.
 *
 * Plain functions over a plain platform string, like `app-menu.ts`, so what the window is
 * given can be asserted without an Electron main process (`test/window-chrome.test.ts`).
 */
import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from "electron";
import { rawTokens, TITLEBAR_GEOMETRY, type ThemeId } from "@orca/design";

/**
 * AppKit's three window buttons as one block: 14pt buttons 6pt apart, in a 16pt-tall frame.
 * The OS's geometry rather than a design value — it is what `titlebar-inset-traffic-lights`
 * was sized to clear, and what centring the block inside that inset is arithmetic on.
 */
export const MAC_WINDOW_BUTTONS = { width: 54, height: 16 } as const;

export type WindowChrome = Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "titleBarOverlay" | "trafficLightPosition"
>;

/** One theme colour by name, or a hard failure — a missing token must not paint `undefined`. */
function color(theme: ThemeId, name: string): string {
  const value = rawTokens[theme][name];
  if (!value) throw new Error(`@orca/design has no ${name} for theme ${theme}`);
  return value;
}

/**
 * The Windows caption buttons: on `surface-canvas` like the bar they sit in, glyphs in
 * `ink-primary`, and one hairline short of the bar's height so the rule under the bar runs
 * the full width of the window. The OS paints these from the colours it was handed, not
 * from the renderer's CSS, so a theme change hands them over again (`applyTheme`).
 */
export function titleBarOverlay(theme: ThemeId): Required<TitleBarOverlayOptions> {
  return {
    color: color(theme, "surface-canvas"),
    symbolColor: color(theme, "ink-primary"),
    height: TITLEBAR_GEOMETRY["bar-title"] - TITLEBAR_GEOMETRY["stroke-hairline"],
  };
}

/** What `new BrowserWindow` is given for its frame on `platform`, in `theme`. */
export function windowChrome(platform: NodeJS.Platform, theme: ThemeId): WindowChrome {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: {
        x: Math.round((TITLEBAR_GEOMETRY["titlebar-inset-traffic-lights"] - MAC_WINDOW_BUTTONS.width) / 2),
        y: Math.round((TITLEBAR_GEOMETRY["bar-title"] - MAC_WINDOW_BUTTONS.height) / 2),
      },
    };
  }
  if (platform === "win32") return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay(theme) };
  return {};
}

/** Whether `platform`'s windows carry an overlay that `setTitleBarOverlay` can repaint. */
export const hasTitleBarOverlay = (platform: NodeJS.Platform): boolean => platform === "win32";
