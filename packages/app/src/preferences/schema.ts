/**
 * The app's own preferences: the theme choice and the density of each surface. These are
 * about the person using the app, not about ORCA, so they live in their own file under the
 * Electron user-data directory and never in the ORCA YAML (docs/design/10-information-
 * architecture.md, "No settings screen separate from Config"). Both processes share these
 * types; the renderer imports them as types only, because it loads as a plain ES module
 * without a bundler and cannot resolve `zod`.
 */
import { z } from "zod";
import type { Density, ThemeId } from "@orca/design";

/** `system` follows the OS; the two named themes are the ones `tokens.css` declares. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const satisfies readonly (ThemeId | "system")[];
export const ThemePreferenceSchema = z.enum(THEME_PREFERENCES);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;

/** The two densities `components.css` knows; `comfortable` is the absence of the attribute. */
export const DENSITIES = ["comfortable", "compact"] as const satisfies readonly Density[];
export const DensitySchema = z.enum(DENSITIES);

export const PreferencesSchema = z.object({
  theme: ThemePreferenceSchema.default("system"),
  /** Density per surface id (`data-surface`), so the run tree can be compact while the config form stays comfortable. */
  density: z.record(z.string(), DensitySchema).default({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/** What a writer may change at once. `density` merges by surface; `theme` replaces. */
export const PreferencesPatchSchema = z.object({
  theme: ThemePreferenceSchema.optional(),
  density: z.record(z.string(), DensitySchema).optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({});

export function mergePreferences(current: Preferences, patch: PreferencesPatch): Preferences {
  return {
    theme: patch.theme ?? current.theme,
    density: { ...current.density, ...(patch.density ?? {}) },
  };
}
