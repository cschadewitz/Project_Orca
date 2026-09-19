/**
 * Where a popover goes: below its trigger and aligned to its start edge unless that would
 * put it off screen, in which case it flips rather than being clipped
 * (docs/design/50-accessibility-and-keyboard.md — a crumb near the right edge and a
 * control near the bottom are the two cases that bite).
 *
 * This is a pure function over rectangles on purpose. happy-dom has no layout engine, so
 * `getBoundingClientRect()` there is all zeros and flip logic written inline in a
 * component would be untestable: no test could ever make it choose `above`. Keeping the
 * decision here means the rule is unit-tested against real numbers, and `Menu` only has to
 * be trusted to hand it measurements — which it takes through an injectable measurer, so
 * a DOM test can assert the class the decision produces as well.
 *
 * All-zero measurements (the happy-dom case) fall through to `below` / `start`, which is
 * also the correct answer for a menu that has not been measured yet.
 */

export interface Box {
  readonly width: number;
  readonly height: number;
}

export interface Rect extends Box {
  readonly top: number;
  readonly left: number;
}

/** What the menu is measured against: its trigger, its own size, and the window. */
export interface MenuMeasurement {
  readonly trigger: Rect;
  readonly menu: Box;
  readonly viewport: Box;
}

/**
 * `block` is the vertical side the menu hangs off; `inline` is the edge it aligns to.
 * Both are written as CSS modifier suffixes, so the component only has to concatenate.
 */
export interface MenuPlacement {
  readonly block: "below" | "above";
  readonly inline: "start" | "end";
}

export const DEFAULT_PLACEMENT: MenuPlacement = { block: "below", inline: "start" };

/**
 * Flip only when the preferred side does not fit *and* the other side fits better —
 * a menu taller than the window is clipped either way, and flipping it then would move it
 * for no gain and lose the connection to its trigger.
 */
export function placeMenu({ trigger, menu, viewport }: MenuMeasurement): MenuPlacement {
  const roomBelow = viewport.height - (trigger.top + trigger.height);
  const roomAbove = trigger.top;
  const block = menu.height > roomBelow && roomAbove > roomBelow ? "above" : "below";

  // Aligned to the trigger's leading edge; the flipped form aligns its trailing edge, so
  // what matters is whether the menu's right edge clears the window when it starts there.
  const roomFromStart = viewport.width - trigger.left;
  const roomFromEnd = trigger.left + trigger.width;
  const inline = menu.width > roomFromStart && roomFromEnd > roomFromStart ? "end" : "start";

  return { block, inline };
}

/** The class list for a placed menu: `.orca-menu` plus a modifier per flipped axis. */
export function placementClass(placement: MenuPlacement): string {
  const classes = ["orca-menu"];
  if (placement.block === "above") classes.push("orca-menu--above");
  if (placement.inline === "end") classes.push("orca-menu--end");
  return classes.join(" ");
}
