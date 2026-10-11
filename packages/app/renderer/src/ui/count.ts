/**
 * A number and the word it counts, as one unit (docs/design/RULES.md rule 15).
 *
 * Two things go wrong with a count written as `${n} nodes`, and both were on screen:
 *
 * - **It disagrees with itself.** "1 edges", "1 nodes", "0 of 1 decisions", "1 changed
 *   sources". `counted` picks the noun the number takes.
 * - **It splits.** A line that breaks between "4" and "changes" leaves a bare number at the end
 *   of one line and a noun at the start of the next, which reads as two facts. The number and
 *   its word are joined by a no-break space (U+00A0), so a line can break only *between* units
 *   — at the spaces around a ` · ` — and never inside one. It is a character rather than a
 *   `nowrap` span so it holds in every place a string goes: a caption, a `title`, an
 *   `aria-label`, a menu hint, the live region.
 *
 * A screen reader reads U+00A0 as a space, and a test that matches the text has to match it
 * as well (` ` in a string, `\s` in a regular expression).
 */

/** U+00A0. Between a number and its word; nowhere a line is meant to be able to break. */
export const NBSP = " ";

/** A number and the word after it as one unit: `unit(3, "waiting")`, `unit("+2", "added")`. */
export function unit(count: number | string, word: string): string {
  return `${count}${NBSP}${word}`;
}

/**
 * "1 node", "3 nodes", "0 nodes": the count and the noun that agrees with it, as one unit.
 * `many` is the plural when it is not the singular and an s ("entry", "entries").
 */
export function counted(count: number, one: string, many = `${one}s`): string {
  return unit(count, count === 1 ? one : many);
}

/**
 * "9 items", or "3 of 9 items" once a filter has narrowed what is held — a list's count line.
 * The noun agrees with the total ("0 of 1 decision"), and the whole phrase is one unit.
 */
export function countedOf(shown: number, total: number, one: string, many = `${one}s`): string {
  const all = counted(total, one, many);
  return shown === total ? all : unit(unit(shown, "of"), all);
}
