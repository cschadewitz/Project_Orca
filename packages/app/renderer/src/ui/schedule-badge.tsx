/**
 * `ScheduleBadge` — a work item's scheduler classification, which is not a run status and
 * is drawn differently on purpose (`orca-badge`, not `orca-chip`).
 *
 * **Every classification in ORCA can say why it is what it is**, and a badge that cannot be
 * asked is a dead end for whoever is looking at a work item that will not start. That is
 * the rule; `onExplain` is only one of the two ways to keep it. It is *optional* because
 * the other way is the caller drawing its own disclosure — the schedule table's, which is
 * the app's one `Menu` — beside the badge, and a badge whose caller does that has no
 * callback to take. What a badge must never be is drawn with neither: that is the dead
 * end, and it is a thing to catch in review rather than in the type.
 *
 * **The why is beside the badge, never inside it.** It is a control, and a control is
 * `accent` (rule 5); the badge's tint says a classification, and a link drawn inside that
 * ground reads as part of the state. It also broke the column: the schedule table drew a
 * settled item's outcome as a `StatusChip` with the why *after* it, and every other row as
 * a badge with the why *inside* it, so the tint ended before "why" on some rows and after
 * it on others and the links did not line up. Now every row is the mark, then the why, and
 * `aligned` gives the mark one width down the column (`StatusChip`'s `aligned="schedule"`
 * is the same width, for the settled rows), so every why starts at one edge.
 *
 * Glyph **and** word, like `StatusChip` (rule 4): the classification is never carried by
 * the tint alone. The glyphs are `semantics.json`'s and are the ones already bundled in
 * the symbol faces, deliberately reused from the run statuses whose colour each
 * classification already borrows — ◐ running, ▣ blocked/waiting on deps, ⏸ held, ⊘
 * cancelled/unschedulable — with ▸ for `ready`, which is the one that means "next" rather
 * than a state a run can be in.
 *
 * The wire's `ItemClassification` has seven values and this has five: `done` and `failed`
 * are item *outcomes* rather than places in the schedule, and a surface draws those with
 * `StatusChip`'s `succeeded` and `failed` (see `plan/plan-model.ts`).
 */
import type { JSX } from "react";
import { SCHEDULE_PRESENTATION, type ScheduleClass } from "@orca/design";
import { textClass } from "./text.js";

export interface ScheduleBadgeProps {
  classification: ScheduleClass;
  /**
   * Draws a **why** button beside the badge that opens the explanation. A caller that owns
   * its disclosure — the schedule table hangs the app's one `Menu` there (#170) — omits
   * this and draws that trigger beside the badge itself, with `.orca-badge__why`, so the
   * two read the same.
   */
  onExplain?: () => void;
  /**
   * Draw the badge at the longest schedule word's width, so a column of them — and of
   * `StatusChip`s drawn with `aligned="schedule"` — starts and ends at one edge, and
   * whatever follows lines up. A floor, like the chip's: a badge is never narrower than its
   * word.
   */
  aligned?: boolean;
  className?: string;
}

export function ScheduleBadge({
  classification,
  onExplain,
  aligned = false,
  className,
}: ScheduleBadgeProps): JSX.Element {
  const { word, glyph } = SCHEDULE_PRESENTATION[classification];
  const badge = (
    <span
      className={[
        "orca-badge",
        textClass("caption"),
        `orca-badge--${classification}`,
        aligned ? "orca-badge--aligned" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Decorative: the word beside it is what a screen reader says (rules 3 and 4). */}
      <span className="orca-badge__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{word}</span>
    </span>
  );
  /* No callback draws no button: the badge in the inspector stands beside the table's own
     popover, and two triggers for one explanation is one more place to open it than there is
     an explanation. */
  if (onExplain === undefined) return badge;
  return (
    <>
      {badge}
      {/* After the badge's ground, not on it: a control is accent, and accent is never a
          state (rule 5). */}
      <button
        type="button"
        className={`orca-badge__why ${textClass("caption")}`}
        onClick={onExplain}
        aria-label={`why ${word}`}
      >
        why
      </button>
    </>
  );
}
