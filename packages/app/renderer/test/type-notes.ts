/**
 * Reading the `type:` notes out of `components.css` (#211).
 *
 * Since #211 no rule in the component layer writes a `font-size`. A component class
 * carries the ground, the box, the weight and the track; the size arrives as a second
 * class from the generated scale, `orca-text-<style>`. Every rule that expects one says so
 * in a `/* type: <style> *\/` note directly above it, so the expectation is written down
 * next to the rule that has the hole rather than in a table someone has to remember to
 * update.
 *
 * This module turns those notes back into data so a test can hold the renderer to them.
 * The note names a *style*; the rule names the elements it applies to — and the honest way
 * to ask "which elements does this rule apply to" is to hand the selector to
 * `querySelectorAll`, which is what `expectedStyleFor` does. A hand-written map from class
 * name to style would get `.orca-table th` and `.orca-inspector .orca-field__label` wrong,
 * and those are exactly the rules a screen forgets.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `node:path`, not `new URL(relative, import.meta.url)`: under happy-dom the global `URL`
// is happy-dom's and resolves a relative reference to the base unchanged — the same trap
// `themes.tsx` documents.
const componentsCss = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "design",
  "css",
  "components.css",
);

/** The component layer as text, for the assertion that no rule writes a size any more. */
export const componentsCssSource: string = readFileSync(componentsCss, "utf8");

export interface TypeNote {
  /** The `orca-text-*` style the rule's elements must also carry. */
  style: string;
  /** One selector from the rule's selector list, pseudo-classes and all. */
  selector: string;
  /** 1-based line of the note, for a failure message that points at the rule. */
  line: number;
}

const NOTE = /^\s*\/\*\s*type:\s*([a-z-]+)\b[^*]*\*\/\s*$/;

/**
 * Every `type:` note in `components.css`, one entry per selector in the noted rule's
 * selector list, in source order — which is also cascade order, and so the order
 * `expectedStyleFor` resolves an element that matches more than one note by.
 */
export function typeNotes(): TypeNote[] {
  const lines = componentsCssSource.split("\n");
  const notes: TypeNote[] = [];

  for (let i = 0; i < lines.length; i++) {
    const style = NOTE.exec(lines[i] ?? "")?.[1];
    if (style === undefined) continue;

    // A note can be separated from its rule by prose — #212 left a couple of explanatory
    // comments between the two. Skip comment lines and blanks, then take everything up to
    // the brace as the selector list.
    const selector: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = (lines[j] ?? "").trim();
      if (line === "" || (line.startsWith("/*") && line.endsWith("*/"))) continue;
      const brace = line.indexOf("{");
      selector.push(brace === -1 ? line : line.slice(0, brace));
      if (brace !== -1) break;
    }

    for (const one of selector.join(" ").split(",")) {
      const trimmed = one.trim();
      if (trimmed) notes.push({ style, selector: trimmed, line: i + 1 });
    }
  }

  return notes;
}

/* A rule that only styles an interaction or a generated box cannot be checked against a
   rendered tree: nothing in the document is `:hover`, and `::before` is not an element. */
const UNMATCHABLE = /::|:hover|:focus|:active|:has\(/;

export const checkableNotes = (): TypeNote[] => typeNotes().filter((n) => !UNMATCHABLE.test(n.selector));

/**
 * The style `element` is required to carry, or `undefined` if no note applies to it.
 *
 * When two notes both match — `.orca-btn` and `.orca-btn--sm`, `.orca-field__label` and
 * `.orca-inspector .orca-field__label` — the later one in the file wins, because that is
 * what the cascade does with the properties beside the note.
 */
export function expectedStyleFor(element: Element, notes: TypeNote[]): TypeNote | undefined {
  let winner: TypeNote | undefined;
  for (const note of notes) {
    if (element.matches(note.selector)) winner = note;
  }
  return winner;
}

/** The `orca-text-*` classes on an element. More than one is itself a mistake. */
export const textClasses = (element: Element): string[] =>
  [...element.classList].filter((name) => name.startsWith("orca-text-"));

/** `div.orca-chip.orca-chip--plain`, for a failure message that can be grepped for. */
export const describeElement = (element: Element): string =>
  `${element.tagName.toLowerCase()}${[...element.classList].map((c) => `.${c}`).join("")}`;
