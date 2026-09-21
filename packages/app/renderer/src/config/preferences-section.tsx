/**
 * App preferences: the theme, and the density of each surface.
 *
 * They are on the Config surface because there is no settings screen separate from Config
 * — "one place to look" (docs/design/10-information-architecture.md) — and they are a
 * section of their own, labelled, because they are not ORCA's configuration at all. They
 * are about the person using this app, they live in a file under the Electron user-data
 * directory, and a workspace cloned onto another machine takes none of them with it.
 *
 * **They save immediately and have no draft.** The save bar exists because writing
 * `orca.config.yaml` is a change to how the workspace runs, worth validating and worth
 * being able to discard. Choosing a dark theme is not that: it is a thing a person does to
 * their own window and sees happen. A Save button here would imply the choice had not taken
 * effect, while it plainly had.
 *
 * The notification tiers (#162) are in the preferences file and are deliberately not here
 * yet: their surface is the Attention side of the app, and a tier list on this screen
 * would be the second place they are set.
 */
import { useEffect, useReducer, type JSX } from "react";
import type { Density } from "@orca/design";
import { THEME_PREFERENCES, type ThemePreference } from "../../../src/preferences/schema.js";
import { useAppearance } from "../appearance-context.js";
import { ConfigField, Menu, Text } from "../ui/index.js";

/** The surfaces a density is remembered for — `data-surface`'s five ids, in sidebar order. */
export interface PreferencesSectionProps {
  surfaces: readonly { id: string; label: string }[];
}

const DENSITIES: readonly Density[] = ["comfortable", "compact"];

export function PreferencesSection({ surfaces }: PreferencesSectionProps): JSX.Element {
  const appearance = useAppearance();
  /* Read on every render rather than snapshotted once: `⌘⇧L` and `⌘⇧D` change the same
     preferences from the keyboard map, and a copy taken at mount would leave this section
     showing "light" under a dark window. The re-render comes from `useAppearanceChanges`,
     which watches the attributes those shortcuts set. */
  const preferences = appearance.preferences();
  useAppearanceChanges();

  const choose = (patch: Parameters<typeof appearance.set>[0]): void => appearance.set(patch);

  return (
    <section className="orca-config__section" aria-label="App preferences">
      <Text style="heading" as="h2">
        App preferences — stored by the app, not in orca.config.yaml
      </Text>
      <Text style="caption">
        These are yours, not the workspace&apos;s: they are kept in this app&apos;s own preferences file and take effect
        as you choose them. There is nothing to save.
      </Text>

      {/* No `onShowRaw`: a preference has a key and no document on this screen to show it
          in, and a **raw** button that did nothing would be worse than none. */}
      <ConfigField label="Theme" path="theme" help="System follows the operating system. ⌘⇧L cycles the three.">
        {(control) => (
          <Menu
            label="Theme"
            items={THEME_PREFERENCES.map((theme) => ({ id: theme, label: theme }))}
            onChoose={(item) => choose({ theme: item.id as ThemePreference })}
            triggerClassName="orca-input"
            /* On the trigger, not on a `<span>`: the button is the control this field
               labels, and ids on a span wire the label to nothing. */
            triggerProps={control}
          >
            {preferences.theme}
          </Menu>
        )}
      </ConfigField>

      {surfaces.map((surface) => (
        <ConfigField
          key={surface.id}
          label={`${surface.label} density`}
          path={`density.${surface.id}`}
          help="Compact fits more rows on the screen; nothing else changes. ⌘⇧D toggles the focused surface."
        >
          {(control) => (
            <Menu
              label={`${surface.label} density`}
              items={DENSITIES.map((density) => ({ id: density, label: density }))}
              onChoose={(item) => choose({ density: { [surface.id]: item.id as Density } })}
              triggerClassName="orca-input"
              triggerProps={control}
            >
              {preferences.density[surface.id] ?? "comfortable"}
            </Menu>
          )}
        </ConfigField>
      ))}
    </section>
  );
}

/**
 * Re-render when the appearance changes from anywhere else — which today means the two
 * shortcuts, `⌘⇧L` and `⌘⇧D`.
 *
 * `Appearance` is actions and a reader, not a store with subscribers: the truth on screen
 * is `data-theme` on the document and `data-density` on each surface (`appearance.ts` is
 * the one owner of both). So this watches exactly those attributes rather than adding a
 * second notion of current preferences that could disagree with the CSS.
 */
function useAppearanceChanges(): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const observer = new MutationObserver(() => bump());
    observer.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-theme", "data-density"],
    });
    return () => observer.disconnect();
  }, []);
}
