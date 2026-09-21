/**
 * `ScheduleBadge` — a work item's scheduler classification, which is not a run status and
 * is drawn differently on purpose (`orca-badge`, not `orca-chip`).
 *
 * **Every classification in ORCA can say why it is what it is**, and a badge that cannot be
 * asked is a dead end for whoever is looking at a work item that will not start. That is
 * the rule; `onExplain` is only one of the two ways to keep it. It is *optional* because
 * the other way is `explanation`, which is the caller hanging its own disclosure — the
 * app's one `Menu` — off the badge, and a badge given one of those has no callback to
 * take. What a badge must never be is drawn with neither: that is the dead end, and it is
 * a thing to catch in review rather than in the type, because the type cannot say "one of
 * these two" without making both of them lies.
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
import type { JSX, ReactNode } from "react";
import { SCHEDULE_PRESENTATION, type ScheduleClass } from "@orca/design";
import { textClass } from "./text.js";

export interface ScheduleBadgeProps {
  classification: ScheduleClass;
  /** Opens the explanation popover. Ignored when `explanation` supplies its own trigger. */
  onExplain?: () => void;
  /**
   * The disclosure itself, when the caller owns it: the schedule table hangs the app's one
   * `Menu` off this slot so that the explanation's lines, its focus contract and its
   * placement are the primitive's rather than a second popover grown beside the badge
   * (#170). Given, it replaces the built-in **why** button; the `Menu`'s trigger takes
   * `.orca-badge__why` so the badge reads the same either way.
   */
  explanation?: ReactNode;
  className?: string;
}

export function ScheduleBadge({ classification, onExplain, explanation, className }: ScheduleBadgeProps): JSX.Element {
  const { word, glyph } = SCHEDULE_PRESENTATION[classification];
  return (
    <span
      className={["orca-badge", textClass("caption"), `orca-badge--${classification}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Decorative: the word beside it is what a screen reader says (rules 3 and 4). */}
      <span className="orca-badge__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{word}</span>
      {/* The disclosure, whoever owns it. Neither prop given draws none at all: the badge
          in the inspector stands beside the table's own popover, and two triggers for one
          explanation is one more place to open it than there is an explanation. */}
      {explanation ??
        (onExplain === undefined ? null : (
          <button
            type="button"
            className={`orca-badge__why ${textClass("caption")}`}
            onClick={onExplain}
            aria-label={`why ${word}`}
          >
            why
          </button>
        ))}
    </span>
  );
}
