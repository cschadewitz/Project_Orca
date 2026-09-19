/**
 * `StatusChip` — the only thing in the app that renders a run status.
 *
 * Glyph and word, always, colour third (rules 3 and 4). Both come from
 * `STATUS_PRESENTATION`; there is no local list of statuses here and there must never be
 * one, because a ninth status is a design change and should break the build, not render
 * as an unstyled chip.
 *
 * `glyphOnly` is for a dense tree row: the word leaves the page but not the accessible
 * name, so the chip still reads as "failed" to a screen reader and still survives a
 * greyscale screenshot by its glyph.
 */
import type { JSX } from "react";
import { STATUS_PRESENTATION, type RunStatus } from "@orca/design";

export interface StatusChipProps {
  status: RunStatus;
  /** Defaults to the status word. Override only to add a count ("failed ×3"). */
  label?: string;
  glyphOnly?: boolean;
  className?: string;
}

export function StatusChip({ status, label, glyphOnly = false, className }: StatusChipProps): JSX.Element {
  const { word, glyph } = STATUS_PRESENTATION[status];
  const text = label ?? word;

  return (
    <span
      className={["orca-chip", `orca-chip--${status}`, glyphOnly ? "orca-chip--glyph-only" : "", className]
        .filter(Boolean)
        .join(" ")}
      /* The glyph is decorative markup for a sighted reader; the word is the name. When
         the word is hidden the chip has to carry it itself. */
      {...(glyphOnly ? { role: "img", "aria-label": text } : {})}
    >
      <span className="orca-chip__glyph" aria-hidden="true">
        {glyph}
      </span>
      {!glyphOnly && <span className="orca-chip__label">{text}</span>}
    </span>
  );
}
