/**
 * App preferences: the theme, the density of each surface, and the pane boundaries somebody
 * has dragged.
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
 *
 * **The pane widths are listed because they are the one a person can set by accident (#280).**
 * A theme and a density are chosen from a menu; a drag is a drag, and the only other way back
 * to the design's default is `Enter` or a double-click on the boundary itself, which nobody
 * has been told. So a window that opens with a 400px sidebar and no memory of having done it
 * has somewhere to look. Two rules the list follows: **a boundary at its default is not
 * listed**, because five rows all reading "default" would be five rows saying nothing; and
 * **restore is a deletion**, not a write of the token's value, because `panes` holds only what
 * somebody chose and absent is what "default" means (#276).
 */
import { useEffect, useReducer, type JSX } from "react";
import type { Density } from "@orca/design";
import { THEME_PREFERENCES, type ThemePreference } from "../../../src/preferences/schema.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { useAppearance } from "../appearance-context.js";
import { PANE_BOUNDARIES, PANE_IDS } from "../panes.js";
import { Button, ConfigField, Menu, Text } from "../ui/index.js";

/** The surfaces a density is remembered for — `data-surface`'s ids, in sidebar order. */
export interface PreferencesSectionProps {
  surfaces: readonly { id: string; label: string }[];
}

const DENSITIES: readonly Density[] = ["comfortable", "compact"];

export function PreferencesSection({ surfaces }: PreferencesSectionProps): JSX.Element {
  const appearance = useAppearance();
  const announce = useAnnounce();
  /* Read on every render rather than snapshotted once: `⌘⇧L` and `⌘⇧D` change the same
     preferences from the keyboard map, a splitter changes one from the boundary itself, and
     a copy taken at mount would leave this section showing "light" under a dark window. The
     re-render comes from `useAppearanceChanges`. */
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

      {/* A map over the registry rather than a second list of boundaries: a boundary added to
          `panes.ts` is listed here the day it is added, and one removed stops being. */}
      {PANE_IDS.filter((id) => preferences.panes[id] !== undefined).map((id) => (
        <ConfigField
          key={id}
          label={`${PANE_BOUNDARIES[id].label} size`}
          path={`panes.${id}`}
          help="Dragged from its default. Enter or a double-click on the boundary itself does the same thing."
        >
          {(control) => (
            <span className="orca-config__pane-size">
              <Text style="mono-id">{paneSizeLabel(id, preferences.panes[id]!)}</Text>
              {/* Named in full rather than by the word on it: the field's label is what the
                  row is *about*, and "Restore" alone out of a list of commands says which
                  nothing. `aria-label` out-ranks the label the field wires up, which is the
                  right way round here — the control is an action, not the value. */}
              <Button
                size="sm"
                aria-label={`Restore the ${PANE_BOUNDARIES[id].label.toLowerCase()}`}
                onClick={() => {
                  choose({ panes: { [id]: null } });
                  announce(`${PANE_BOUNDARIES[id].label} back to its default size.`);
                }}
                {...control}
              >
                Restore
              </Button>
            </span>
          )}
        </ConfigField>
      ))}
    </section>
  );
}

/**
 * What a remembered size reads as. Two shapes, because there are two (#281): a column
 * boundary is a length and says so in px, and the stacked one is a ratio of its column and
 * says *that* — reporting a fraction as a px count would be inventing a window height, which
 * is the whole reason it is not stored as one.
 */
function paneSizeLabel(id: (typeof PANE_IDS)[number], size: number): string {
  return PANE_BOUNDARIES[id].size === "fraction" ? `${Math.round(size * 100)}% of its column` : `${size}px`;
}

/**
 * Re-render when the appearance changes from anywhere else — the two shortcuts, `⌘⇧L` and
 * `⌘⇧D`, a `PaneSplitter` being dragged, or the palette's restore.
 *
 * Two sources, for two kinds of change. `data-theme` and `data-density` land **on the
 * document**, so watching the attributes reads the same truth the CSS does rather than a
 * second notion of it — including a change made by something that never went through
 * `Appearance`. A pane size lands on a custom property on one container elsewhere in the
 * tree, which is not something this section can watch and not something the document
 * records; `appearance.subscribe` is what says a drag happened (#280).
 */
function useAppearanceChanges(): void {
  const appearance = useAppearance();
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
  useEffect(() => appearance.subscribe(() => bump()), [appearance]);
}
