/**
 * Which crumbs the object header shows when the whole trail does not fit, and which it folds
 * into its `…` control (docs/design/10-information-architecture.md, "chain elision").
 *
 * The rule, in the order things give way as the header narrows:
 *
 *  1. **The whole trail**, every name whole. A wide window shows the whole chain; nothing is
 *     folded because there are a lot of crumbs, only because they do not fit.
 *  2. **The middle folds, nearest the root first.** The crumb after the root goes into `…`,
 *     then the one after that, until what is left is the root, `…`, the parent and the
 *     current crumb: `request ▸ … ▸ run ▸ step`. The root stays because it is where the
 *     chain starts, and the last two because they are the object on screen and the one it
 *     belongs to — the crumb a person most often goes back to.
 *  3. **The parent folds too**: `request ▸ … ▸ step`. Losing it is the last fold because it is
 *     the most useful crumb to keep, and taken only when even the root, `…`, parent and
 *     current do not fit — a narrow pane beside the docked panel, a header with actions.
 *  4. **The current crumb's name is cut at its end**, in CSS (`.orca-objhead__crumb--current`),
 *     once nothing is left to fold. Its name and no other: the surface under the header names
 *     the object on screen whole — its selected row, its detail pane — while the root may be
 *     named nowhere else; and with one name giving way, no crumb is squeezed past what its
 *     name can give. The type label, the id token and the version never are (`.orca-objid` is
 *     `flex: none`) — a tail cut short is another id.
 *
 * Folding before cutting is deliberate. A folded crumb is whole one click away — the `…`
 * menu lists it with its type, its whole name and its token — while a cut name is a crumb
 * that is on screen and cannot be read, and two runs called `Database schema` and `Database
 * migration` are told apart at exactly the end that is cut. It also keeps this decision a
 * function of widths that do not move: every width here is a crumb's *natural* width, so a
 * name being cut at step 4 never makes the trail look as if it fits and unfolds it again.
 *
 * The current crumb is never folded and the root is never folded: the range this returns
 * is always strictly inside the trail. A trail of one or two crumbs has no middle, so it
 * never folds; the current crumb's name is cut instead.
 *
 * A pure function over numbers, for the reason `menu-placement.ts` gives: happy-dom has no
 * layout engine and measures every box as zero, so a decision written inline in the
 * component could never be made to fold by a test. `ObjectHeader` takes its measurements
 * through an injectable measurer and hands them here.
 */

/** What the trail is measured as. Every width is in CSS pixels. */
export interface TrailMeasurement {
  /** The room the trail has: the header less the mode control, the actions and the gaps. */
  readonly available: number;
  /**
   * Each crumb's natural width, in trail order — its name uncut, and its separator and
   * disclosure included. The root has no separator in front of it, so its width has none.
   */
  readonly crumbs: readonly number[];
  /** The `…` control's width, the separator in front of it included. */
  readonly elision: number;
  /** The gap between two items of the trail. */
  readonly gap: number;
}

/** The crumbs folded into `…`: `from` up to, not including, `to`. Always inside the trail. */
export interface Elision {
  readonly from: number;
  readonly to: number;
}

/** Whether these widths fit in `available`, laid out as items `gap` apart. */
function fits(widths: readonly number[], gap: number, available: number): boolean {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  return total <= available;
}

/**
 * The crumbs to fold, or `undefined` to show them all. All-zero measurements — happy-dom, and
 * the frame before the first layout — show them all, which is also right for a header
 * nobody has measured yet.
 */
export function elideTrail({ available, crumbs, elision, gap }: TrailMeasurement): Elision | undefined {
  const count = crumbs.length;
  if (available <= 0 || count < 3) return undefined;
  if (fits(crumbs, gap, available)) return undefined;

  const [root = 0] = crumbs;
  // Fold one more crumb at a time, from the one after the root, while the last two stay.
  for (let to = 2; to <= count - 2; to += 1) {
    if (fits([root, elision, ...crumbs.slice(to)], gap, available)) return { from: 1, to };
  }
  // Root, `…` and the current crumb: the last fold. What still does not fit is cut in CSS.
  return { from: 1, to: count - 1 };
}

/** Two answers are the same answer: a resize that changes nothing must not re-render. */
export function sameElision(a: Elision | undefined, b: Elision | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.from === b.from && a.to === b.to);
}
