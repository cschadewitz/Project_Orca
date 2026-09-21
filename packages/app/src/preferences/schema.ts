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

/**
 * A dragged pane size, per boundary id (#276), in one of **two shapes** (#281).
 *
 * A boundary between two columns is a length: a whole number of px, because a side pane is
 * sized to what it holds and 520px means the same thing on a laptop and on a 34" display. A
 * boundary between two stacked panes is a ratio of its container: a number strictly between
 * 0 and 1, because neither half is sized to its content and what a person chose is "more
 * tree than timeline" — which a length does not carry from one window height to another.
 *
 * Which shape a given id takes is the renderer's registry (`renderer/src/panes.ts`), not this
 * file's: the schema's job is to accept both and reject everything else. Below 1 is a
 * fraction, 1 and up is px — an unambiguous split, since a pane of half a pixel is not a
 * thing and neither is a pane that is all of its container.
 *
 * A boundary that is back at its default is **absent** from the record rather than set to the
 * default — the size token in `tokens.css` is the default, and a number here would be a
 * second copy of it that the next token change would not reach.
 */
export const PaneSizeSchema = z
  .number()
  .positive()
  .refine((size) => size < 1 || Number.isInteger(size), {
    message: "a pane size is a whole number of px, or a fraction of its container below 1",
  });

export const PreferencesSchema = z.object({
  theme: ThemePreferenceSchema.default("system"),
  /** Density per surface id (`data-surface`), so the run tree can be compact while the config form stays comfortable. */
  density: z.record(z.string(), DensitySchema).default({}),
  /** Pane size per boundary id (`renderer/src/panes.ts`), so a resize survives a relaunch (#276). */
  panes: z.record(z.string(), PaneSizeSchema).default({}),
  alerts: AlertPreferencesSchema.prefault({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

/** What a writer may change at once. `density`, `panes` and `alerts` merge; `theme` replaces. */
export const PreferencesPatchSchema = z.object({
  theme: ThemePreferenceSchema.optional(),
  density: z.record(z.string(), DensitySchema).optional(),
  /**
   * Merges by boundary, and `null` is how a boundary goes back to its default: the record
   * holds only the sizes somebody chose, so restoring one is a deletion and not a write of
   * the token's value (which is what "absent means default" costs — and is worth).
   */
  panes: z.record(z.string(), PaneSizeSchema.nullable()).optional(),
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

/** The panes record with the patch applied: a number sets a boundary, `null` restores it. */
function mergePanes(
  current: Readonly<Record<string, number>>,
  patch: Readonly<Record<string, number | null>> | undefined,
): Record<string, number> {
  const merged: Record<string, number> = { ...current };
  for (const [id, size] of Object.entries(patch ?? {})) {
    if (size === null) delete merged[id];
    else merged[id] = size;
  }
  return merged;
}

export function mergePreferences(current: Preferences, patch: PreferencesPatch): Preferences {
  return {
    theme: patch.theme ?? current.theme,
    density: { ...current.density, ...(patch.density ?? {}) },
    panes: mergePanes(current.panes, patch.panes),
    /* Spread of a `Partial`, so an explicitly-undefined tier would overwrite a set one:
       the entries are filtered rather than spread blind. */
    alerts: { ...current.alerts, ...definedOnly(patch.alerts ?? {}) },
  };
}
