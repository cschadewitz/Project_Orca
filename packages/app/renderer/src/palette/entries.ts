/**
 * What the palette lists, and in what order.
 *
 * Three sections in the order docs/design/10-information-architecture.md sets: actions on
 * the current object, navigation, search — with a jump row above them when the query is a
 * run id or an `orca://` URL. Every shortcut in the keyboard map appears in one of the
 * first two with its key beside it; that is the whole point of the registry.
 */
import { shortcutLabel, type RegisteredShortcut, type ShortcutPicker, type ShortcutScope } from "../keyboard-map.js";

export type PaletteSection = "jump" | "actions" | "navigation" | "search";

/** The section headers, in render order. `jump` is deliberately unlabelled. */
export const PALETTE_SECTIONS: readonly { id: PaletteSection; label?: string }[] = [
  { id: "jump" },
  { id: "actions", label: "Actions" },
  { id: "navigation", label: "Navigation" },
  { id: "search", label: "Search" },
];

export interface PaletteEntry {
  /** Unique across the whole list: it becomes the option's DOM id for `aria-activedescendant`. */
  id: string;
  section: PaletteSection;
  label: string;
  /**
   * The substring of `label` (or of `confirm`) that is machine text, drawn in mono where
   * it occurs (docs/design/RULES.md rule 8). The label stays one string: it is what the
   * query matches and what the option is named by.
   */
  labelMachine?: string;
  /** Second column: the id, path or explanation. */
  detail?: string;
  /** True when `detail` is machine text and must be set in mono (docs/design/RULES.md rule 8). */
  detailIsMachine?: boolean;
  /**
   * The shortcut, already rendered for this platform: `⌘⇧L` or `Ctrl+Shift+L`. Absent for
   * a command with no key (#205): the row renders with no chip, and the palette is then
   * the whole of how that command is reached.
   */
  shortcut?: string;
  /** Present when the entry cannot be run yet; the string says why, and the row is disabled. */
  unavailable?: string;
  /**
   * The row's second state, for a destructive command (#178). Present means the first
   * `Enter` *arms* the row rather than running it: the label is replaced by this one, the
   * row draws in the danger tone, and a second `Enter` runs it.
   *
   * **Why the confirmation is a row and not a dialog.** A palette write is reached with the
   * hands on the keyboard and the eyes on one line of text; a modal over a modal would move
   * focus out of the query field, put a second layer on the stack for `Esc` to unwind, and
   * ask the question somewhere other than where it was asked. Re-labelling the row asks it
   * exactly where the person is looking, and the way out is the way out of everything else
   * — move the selection, keep typing, or `Esc`.
   */
  confirm?: string;
  /** `danger` for a destructive row: the label takes the status colour, armed or not. */
  tone?: "danger";
  /** A command that asks which one first; choosing the row opens a `Menu` of the choices. */
  picker?: ShortcutPicker;
  run: () => void;
}

/**
 * Every registered shortcut as an entry. All of them, not just the ones in scope: a
 * shortcut is only registered while the component that owns it is mounted, so what is in
 * the map is exactly what the person can reach right now. `activeScopes` only orders them,
 * putting the scope focus is in first so "actions on the current object" means what it says.
 *
 * **A destructive command sinks below every other one (#178).** "Never the first item" is
 * the issue's rule and the reason is the same one `card-model.ts` binds digits by: the
 * first row is where `Enter` lands and where a held key repeats, and the row a person did
 * not read should not be the row a person can run by being fast. It out-ranks the scope
 * order deliberately — all the safe commands in scope order, then the dangerous ones in
 * scope order — because a destructive action on the object in focus is exactly the one this
 * is about.
 */
export function commandEntries(
  shortcuts: readonly RegisteredShortcut[],
  platform: string,
  activeScopes: readonly ShortcutScope[],
): readonly PaletteEntry[] {
  const danger = (shortcut: RegisteredShortcut): number => (shortcut.tone === "danger" ? 1 : 0);
  const rank = (scope: ShortcutScope): number => {
    const at = activeScopes.indexOf(scope);
    return at === -1 ? activeScopes.length : at;
  };
  return (
    [...shortcuts]
      .map((shortcut, index) => ({ shortcut, index }))
      // Stable within a scope: registration order is mount order, which is reading order.
      .sort(
        (a, b) =>
          danger(a.shortcut) - danger(b.shortcut) ||
          rank(a.shortcut.scope) - rank(b.shortcut.scope) ||
          a.index - b.index,
      )
      .map(({ shortcut }) => ({
        // The map's own slot, because `scope:key` is not a name two keyless commands
        // could differ by and this id becomes a DOM id for `aria-activedescendant`.
        id: `command:${shortcut.id}`,
        section: shortcut.section ?? "actions",
        label: shortcut.label,
        ...(shortcut.labelMachine === undefined ? {} : { labelMachine: shortcut.labelMachine }),
        ...(shortcut.detail ? { detail: shortcut.detail } : {}),
        // No chip rather than an empty one: a keyless command has nothing to press (#205).
        ...(shortcut.key === undefined ? {} : { shortcut: shortcutLabel(shortcut.key, platform) }),
        // The write rows' three extras (#178). Each is absent unless the command set it, so
        // `exactOptionalPropertyTypes` holds and an ordinary command is unchanged.
        ...(shortcut.unavailable === undefined ? {} : { unavailable: shortcut.unavailable }),
        ...(shortcut.confirm === undefined ? {} : { confirm: shortcut.confirm }),
        ...(shortcut.tone === undefined ? {} : { tone: shortcut.tone }),
        ...(shortcut.picker === undefined ? {} : { picker: shortcut.picker }),
        run: shortcut.action,
      }))
  );
}

/** Lower is better. -1 means the entry does not match at all. */
function score(entry: PaletteEntry, needle: string): number {
  const haystacks = [entry.label, entry.detail ?? ""].map((s) => s.toLowerCase());
  let best = -1;
  for (const [i, text] of haystacks.entries()) {
    const at = text.indexOf(needle);
    if (at === -1) continue;
    // A match at the start of the label beats one in the middle, which beats one in the detail.
    const here = (at === 0 ? 0 : /\s/.test(text[at - 1] ?? "") ? 1 : 2) + i * 3;
    if (best === -1 || here < best) best = here;
  }
  return best;
}

/**
 * Filter to what matches `query`, keeping the section order. Matching is a plain
 * case-insensitive substring: a palette that guesses at abbreviations is a palette whose
 * top entry moves while you type, and the top entry is what `Enter` runs.
 */
export function filterEntries(entries: readonly PaletteEntry[], query: string): readonly PaletteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  /* The score re-sorts, so "never first" holds for the unfiltered list and not for this
     one: typing "cancel" can put a danger row at the top, where `Enter` lands. That is the
     query asking for it, and all `Enter` does there is *arm* the row — the second press is
     still a second press. */
  return entries
    .map((entry, index) => ({ entry, index, score: score(entry, needle) }))
    .filter((m) => m.score !== -1)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((m) => m.entry);
}

/** The entries grouped for rendering, in section order, with empty sections dropped. */
export function groupEntries(
  entries: readonly PaletteEntry[],
): readonly { id: PaletteSection; label?: string; entries: readonly PaletteEntry[] }[] {
  return PALETTE_SECTIONS.map((section) => ({
    ...section,
    entries: entries.filter((entry) => entry.section === section.id),
  })).filter((section) => section.entries.length > 0);
}
