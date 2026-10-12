/**
 * How one value is set beside its name in a `KeyValueList`: on the line, or as a block of
 * JSON under it. The plain half of `key-value-list.tsx`.
 *
 * Every value that list is handed is whatever a workflow, a plugin or the person who started
 * a run put there — a run's `vars`, a node's `fields` and the `vars` a launch will send are
 * each `Record<string, unknown>` on the wire — so this decides *how* a value is set and
 * never *what* it says:
 *
 * - A string is itself, without the quotes JSON would add: what was typed is what is read.
 * - A number, a boolean, `null`, `{}` or `[]` is its JSON, which is one short line.
 * - Anything else is an object or an array with something in it, and it is its JSON at a
 *   two-space indent — a block with one key per line, not a line.
 *
 * The block is the fix for a run summary that scrolled sideways. An object used to be one
 * compact line, `{"id":"req-…","createdAt":"2026-…","status":"open",…}`, and compact JSON
 * has no break opportunity between its tokens: the line's narrowest rendering was as wide as
 * its longest run of quotes, colons and timestamps, which held the value column open past
 * the pane and gave the whole run summary a horizontal scrollbar. Indented, every key starts
 * a line of its own, and the well it sits in breaks inside a token when it has to.
 *
 * No recognised shape gets a friendlier rendering — a `workItem` read as its title and slug,
 * say, or a gate's `options` as a list of buttons. The protocol declares no type for any of
 * these values, so a reader keyed on field names would be guessing at one, and a guess that
 * is right for one workflow is a misreading in the next (RULES.md rule 12). The keys a value
 * has are printed, verbatim, in the order it has them.
 */

/** One value, set for reading: on the line beside its name, or as a block under it. */
export interface ValueText {
  text: string;
  block: boolean;
}

export function valueText(value: unknown): ValueText {
  if (typeof value === "string") return { text: value, block: false };
  const text = json(value);
  return { text, block: text.includes("\n") };
}

/** The value's JSON at a two-space indent, or what `String` makes of a value that has none. */
function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A cycle or a bigint. Neither survives the wire, but a list that threw on one would
    // take the whole pane with it.
    return String(value);
  }
}
