/**
 * `ScheduleBadge` — a work item's scheduler classification, which is not a run status and
 * is drawn differently on purpose (`orca-badge`, not `orca-chip`).
 *
 * `onExplain` is required rather than optional: every classification in ORCA can say why
 * it is what it is, and a badge that cannot be asked is a dead end for whoever is looking
 * at a work item that will not start.
 */
import type { JSX } from "react";
import { SCHEDULE_PRESENTATION, type ScheduleClass } from "@orca/design";
import { textClass } from "./text.js";

export interface ScheduleBadgeProps {
  classification: ScheduleClass;
  /** Opens the explanation popover. */
  onExplain: () => void;
  className?: string;
}

export function ScheduleBadge({ classification, onExplain, className }: ScheduleBadgeProps): JSX.Element {
  const { word } = SCHEDULE_PRESENTATION[classification];
  return (
    <span
      className={["orca-badge", textClass("caption"), `orca-badge--${classification}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      <span>{word}</span>
      <button
        type="button"
        className={`orca-badge__why ${textClass("caption")}`}
        onClick={onExplain}
        aria-label={`why ${word}`}
      >
        why
      </button>
    </span>
  );
}
