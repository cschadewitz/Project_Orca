/**
 * What the palette lists, and in what order.
 *
 * Three sections in the order docs/design/10-information-architecture.md sets: actions on
 * the current object, navigation, search — with a jump row above them when the query is a
 * run id or an `orca://` URL. Every shortcut in the keyboard map appears in one of the
 * first two with its key beside it; that is the whole point of the registry.
 */
import { shortcutLabel, type Shortcut, type ShortcutScope } from "../keyboard-map.js";

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
  /** Second column: the id, path or explanation. */
  detail?: string;
  /** True when `detail` is machine text and must be set in mono (docs/design/RULES.md rule 8). */
  detailIsMachine?: boolean;
  /** The shortcut, already rendered for this platform: `⌘⇧L` or `Ctrl+Shift+L`. */
  shortcut?: string;
  /** Present when the entry cannot be run yet; the string says why, and the row is disabled. */
  unavailable?: string;
  run: () => void;
}

/**
 * Every registered shortcut as an entry. All of them, not just the ones in scope: a
 * shortcut is only registered while the component that owns it is mounted, so what is in
 * the map is exactly what the person can reach right now. `activeScopes` only orders them,
 * putting the scope focus is in first so "actions on the current object" means what it says.
 */
export function commandEntries(
  shortcuts: readonly Shortcut[],
  platform: string,
  activeScopes: readonly ShortcutScope[],
): readonly PaletteEntry[] {
  const rank = (scope: ShortcutScope): number => {
    const at = activeScopes.indexOf(scope);
    return at === -1 ? activeScopes.length : at;
  };
  return (
    [...shortcuts]
      .map((shortcut, index) => ({ shortcut, index }))
      // Stable within a scope: registration order is mount order, which is reading order.
      .sort((a, b) => rank(a.shortcut.scope) - rank(b.shortcut.scope) || a.index - b.index)
      .map(({ shortcut }) => ({
        id: `command:${shortcut.scope}:${shortcut.key}`,
        section: shortcut.section ?? "actions",
        label: shortcut.label,
        ...(shortcut.detail ? { detail: shortcut.detail } : {}),
        shortcut: shortcutLabel(shortcut.key, platform),
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
