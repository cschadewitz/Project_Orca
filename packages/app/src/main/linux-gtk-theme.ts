/**
 * The GTK theme a Linux window starts with, for the parts of it Chromium draws from GTK
 * rather than from the renderer: the application menu bar, and the title bar where the
 * window manager takes its colours from the window (#1109).
 *
 * `nativeTheme.themeSource` reaches `prefers-color-scheme` and Chromium's own widgets, but
 * not GTK: in the dark theme the File/Edit/View bar stayed light. GTK reads `GTK_THEME` once,
 * when Electron starts it, so this has to run in the main process before the app is ready,
 * and a theme changed afterwards reaches the menu bar on the next launch. Adwaita is the
 * theme GTK always ships, so `Adwaita:dark` exists on every desktop.
 *
 * Only an explicit dark choice sets it. `system` leaves GTK to follow the desktop, and an
 * explicit light choice leaves the person's GTK theme alone; so does a `GTK_THEME` that is
 * already set, which is somebody's own decision. Pure, so it can be tested without Electron
 * (`test/linux-gtk-theme.test.ts`).
 */
import type { ThemePreference } from "../preferences/schema.js";

export function gtkThemeFor(
  platform: NodeJS.Platform,
  preference: ThemePreference,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (platform !== "linux" || preference !== "dark" || env.GTK_THEME) return undefined;
  return "Adwaita:dark";
}
