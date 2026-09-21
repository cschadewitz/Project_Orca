/// <reference lib="dom" />
/**
 * Theme and density together: the one place the renderer turns the persisted preferences
 * into attributes, and the one place that writes a change back. It sets `data-theme` on
 * `<html>` and `data-density` on surface roots, registers ⌘⇧L and ⌘⇧D with the keyboard
 * map, and exposes actions but no state — the CSS layer is the reader. Framework-free so
 * it runs before React mounts (no first-paint flash) and tests under happy-dom; the React
 * side is `appearance-context.tsx`.
 */
import type { BridgeResult } from "../../src/bridge.js";
import type { Preferences, PreferencesPatch } from "../../src/preferences/schema.js";
import { applyDensities, focusedSurface, toggleDensity, surfaceId } from "./density.js";
import { KeyboardMap } from "./keyboard-map.js";
import { applyTheme, nextTheme } from "./theme.js";

/** The slice of the bridge this needs: `window.orca.preferences`, or a fake in tests. */
export interface AppearanceStore {
  read: () => Preferences;
  write: (patch: PreferencesPatch) => Promise<BridgeResult<Preferences>>;
}

export interface Appearance {
  /** Re-apply remembered densities to surfaces mounted since install (routing, panels). */
  refresh: (scope?: ParentNode) => void;
  cycleTheme: () => void;
  toggleDensity: () => void;
  /**
   * What is remembered right now. The two shortcuts cycle and toggle blind, which is all a
   * shortcut can do; the Config surface's preferences section draws the current choice and
   * has to be able to read it (#175).
   */
  preferences: () => Preferences;
  /**
   * Choose a theme, a density for a named surface, or a size for a named pane boundary,
   * outright. Applied first and persisted after, exactly as the shortcuts are — and through
   * this rather than through `window.orca.preferences` directly, so that the attribute on the
   * document and the file on disk keep one owner (`density.ts` is the only code that touches
   * `data-density`).
   *
   * A pane size is the one field this does not apply itself. A density is an attribute on a
   * surface root, and every surface root in the document can be found from here; a pane size
   * is a custom property on *the container whose grid track reads it*, and only the splitter
   * standing in that container knows which element that is. So `chrome/pane-splitter.tsx`
   * applies it through `panes.ts` and this persists it (#276).
   */
  set: (patch: PreferencesPatch) => void;
  dispose: () => void;
}

export const CYCLE_THEME_KEY = "Mod+Shift+L";
export const TOGGLE_DENSITY_KEY = "Mod+Shift+D";

export function installAppearance(win: Window, store: AppearanceStore, keyboard: KeyboardMap): Appearance {
  const doc = win.document;
  let current = store.read();

  applyTheme(doc.documentElement, current.theme);
  applyDensities(doc, current.density);

  const persist = (patch: PreferencesPatch) => {
    // Apply first, persist after: the attribute is the truth on screen; the file catches up.
    store.write(patch).then(
      (saved) => {
        if (saved.ok) current = saved.result;
        else console.warn(`preferences were not saved: ${saved.error.code}: ${saved.error.message}`);
      },
      (e: unknown) => console.warn("preferences were not saved:", e),
    );
  };

  const cycleTheme = () => {
    const theme = nextTheme(current.theme);
    current = { ...current, theme };
    applyTheme(doc.documentElement, theme);
    persist({ theme });
  };

  const toggle = () => {
    const surface = focusedSurface(doc);
    if (!surface) return;
    const density = toggleDensity(surface);
    current = { ...current, density: { ...current.density, [surfaceId(surface)]: density } };
    persist({ density: { [surfaceId(surface)]: density } });
  };

  const unregister = [
    keyboard.register({
      scope: "global",
      key: CYCLE_THEME_KEY,
      label: "Cycle theme: system, light, dark",
      action: cycleTheme,
    }),
    keyboard.register({
      scope: "global",
      key: TOGGLE_DENSITY_KEY,
      label: "Toggle density on the focused surface",
      action: toggle,
    }),
  ];

  /* The same merge `mergePreferences` performs in the main process, written out here rather
     than imported: `preferences/schema.ts` is a Zod module and the renderer takes its types
     only. A `null` size is a boundary going back to its default, which is a deletion — the
     record holds only what somebody chose (#276). */
  const mergePanes = (patch: NonNullable<PreferencesPatch["panes"]>): Record<string, number> => {
    const merged = { ...current.panes };
    for (const [id, size] of Object.entries(patch)) {
      if (size === null) delete merged[id];
      else merged[id] = size;
    }
    return merged;
  };

  const set = (patch: PreferencesPatch) => {
    current = {
      ...current,
      ...(patch.theme === undefined ? {} : { theme: patch.theme }),
      ...(patch.density === undefined ? {} : { density: { ...current.density, ...patch.density } }),
      ...(patch.panes === undefined ? {} : { panes: mergePanes(patch.panes) }),
    };
    if (patch.theme !== undefined) applyTheme(doc.documentElement, patch.theme);
    if (patch.density !== undefined) applyDensities(doc, current.density);
    persist(patch);
  };

  return {
    refresh: (scope = doc) => applyDensities(scope, current.density),
    cycleTheme,
    toggleDensity: toggle,
    preferences: () => current,
    set,
    dispose: () => unregister.forEach((u) => u()),
  };
}
