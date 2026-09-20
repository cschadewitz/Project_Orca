/// <reference lib="dom" />
/**
 * One question, asked of the DOM rather than answered from memory: how tall is a row?
 *
 * Rule 9 says a row's height is `--row-h`, and `components.css` binds it on `.orca-surface`
 * and rebinds it under `data-density="compact"`. The substrate needs that height as a
 * number to do any arithmetic at all — but writing the number here would be a second
 * statement of it, which is the thing the rule exists to prevent: the token would change,
 * the CSS would follow, and the virtual list would quietly scroll by the old height
 * forever. So the number is read back out of the cascade, from the scroller itself, which
 * inherits whatever the surface above it currently binds. Density is then not a special
 * case — it is the same read, taken again.
 *
 * A custom property's computed value has its `var()` references substituted, so the scroller
 * answers `32px` rather than `var(--row-comfortable)`. When it answers nothing — no
 * stylesheet, no layout, a test environment that resolves no cascade — the answer is zero,
 * and `list-window.ts` windows by row count instead. Zero is "not measured", never a height.
 */

/** The custom property the row height is bound to. One statement of the name. */
export const ROW_HEIGHT_PROPERTY = "--row-h";

/**
 * A computed `--row-h` as a number of pixels, or 0 for anything that is not one.
 *
 * Only `px` is accepted. A computed length is always absolute, so a `--row-h` in any other
 * unit is a value that never went through the cascade — and guessing at it would be worse
 * than windowing by count until something real can be measured.
 */
export function parseRowHeight(value: string): number {
  const px = /^\s*(-?\d*\.?\d+)px\s*$/.exec(value);
  if (!px) return 0;
  const height = Number.parseFloat(px[1]!);
  return Number.isFinite(height) && height > 0 ? height : 0;
}

/** `--row-h` as it resolves on this element, in pixels; 0 when nothing resolves it. */
export function measureRowHeight(element: Element): number {
  const view = element.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return 0;
  return parseRowHeight(view.getComputedStyle(element).getPropertyValue(ROW_HEIGHT_PROPERTY));
}
