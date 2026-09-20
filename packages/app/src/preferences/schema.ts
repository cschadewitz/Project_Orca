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

/**
 * Which tiers may reach the operating system, and when a neglected window escalates the
 * one that normally waits (#162, docs/design/20-attention-and-gates.md).
 *
 * **Opt-in per tier, defaulting to permission asks only.** A permission ask holds an agent
 * turn open and occupies a host while it waits, which is the one thing in the app worth
 * interrupting for; a gate and a failed run are things a person comes back to. Defaulting
 * the other two on would teach people to dismiss ORCA's notifications, which costs the
 * first tier its meaning.
 */
export const AlertPreferencesSchema = z.object({
  /** Tier 1: an agent is blocked mid-turn. Notified immediately. */
  permission: z.boolean().default(true),
  /** Tier 2: a run is parked on a human decision. Notified 60s after it was asked. */
  gate: z.boolean().default(false),
  /** Tier 3: a run failed. Notified on the failure, never again. */
  failure: z.boolean().default(false),
  /**
   * How long the window may be unfocused before gates escalate to notifications whether
   * or not their tier is on. Five minutes: long enough that stepping away from a screen
   * mid-answer does not fire, short enough that a person who has left is told.
   */
  unfocusedEscalationMs: z.number().int().positive().default(300_000),
});
export type AlertPreferences = z.infer<typeof AlertPreferencesSchema>;

/**
 * The same four fields with no defaults on them, because a patch means "change these and
 * leave the rest". `.partial()` of the schema above would not do: a Zod default fills a
 * field the caller left out, so turning gates on would also write every other tier back to
 * its default and silently undo a choice.
 */
export const AlertPreferencesPatchSchema = z.object({
  permission: z.boolean().optional(),
  gate: z.boolean().optional(),
  failure: z.boolean().optional(),
  unfocusedEscalationMs: z.number().int().positive().optional(),
});

export const PreferencesSchema = z.object({
  theme: ThemePreferenceSchema.default("system"),
  /** Density per surface id (`data-surface`), so the run tree can be compact while the config form stays comfortable. */
  density: z.record(z.string(), DensitySchema).default({}),
  alerts: AlertPreferencesSchema.prefault({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/** What a writer may change at once. `density` and `alerts` merge; `theme` replaces. */
export const PreferencesPatchSchema = z.object({
  theme: ThemePreferenceSchema.optional(),
  density: z.record(z.string(), DensitySchema).optional(),
  /** Merges by tier, so turning gates on says only that. */
  alerts: AlertPreferencesPatchSchema.optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({});

/**
 * The set fields of a patch. The type matters as much as the filter: a patch's fields are
 * `boolean | undefined`, and spreading that over a complete record would widen every field
 * it names back to optional under `exactOptionalPropertyTypes`.
 */
function definedOnly<T extends object>(patch: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export function mergePreferences(current: Preferences, patch: PreferencesPatch): Preferences {
  return {
    theme: patch.theme ?? current.theme,
    density: { ...current.density, ...(patch.density ?? {}) },
    /* Spread of a `Partial`, so an explicitly-undefined tier would overwrite a set one:
       the entries are filtered rather than spread blind. */
    alerts: { ...current.alerts, ...definedOnly(patch.alerts ?? {}) },
  };
}
