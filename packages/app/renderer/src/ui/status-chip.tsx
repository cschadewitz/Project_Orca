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
 *
 * `aligned` is for a list whose statuses form a column — the run tree, the claims list:
 * every chip takes the longest word's width, so the glyphs line up row to row. It is the
 * only way to size a chip, and there is deliberately no `className` to size one with. The
 * run tree and the claims list each used to pass a class that set `width: 12ch`, which is
 * narrower than "✓ succeeded"; the first was fixed in the run tree's own stylesheet and the
 * same bug stayed in the second. The box is `components.css`'s alone now (`.orca-chip`
 * never draws narrower than its word, `.orca-chip--aligned` is the column), so a fix to it
 * is a fix everywhere a status is drawn.
 *
 * `aligned="schedule"` is the same idea in the one column that mixes chips with schedule
 * badges: the plan's schedule column, where a settled item draws its outcome as a chip and
 * every other item draws a `ScheduleBadge`. There the chip takes the badge's aligned width
 * (`--badge-aligned-width`), so the **why** after either one starts at one edge.
 */
import type { JSX } from "react";
import { STATUS_PRESENTATION, type RunStatus } from "@orca/design";
import { textClass } from "./text.js";

export interface StatusChipProps {
  status: RunStatus;
  /** Defaults to the status word. Override only to add a count ("failed ×3"). */
  label?: string;
  glyphOnly?: boolean;
  /**
   * Draw the chip at the longest status word's width, so a list of them is one column. A
   * floor, not a clamp: a longer `label` still grows its chip. Ignored with `glyphOnly`,
   * which is already one fixed square. `"schedule"` is the column a chip shares with
   * aligned `ScheduleBadge`s, at the badge's width.
   */
  aligned?: boolean | "schedule";
}

export function StatusChip({ status, label, glyphOnly = false, aligned = false }: StatusChipProps): JSX.Element {
  const { word, glyph } = STATUS_PRESENTATION[status];
  const text = label ?? word;

  return (
    <span
      className={[
        "orca-chip",
        textClass("caption"),
        `orca-chip--${status}`,
        glyphOnly
          ? "orca-chip--glyph-only"
          : aligned === "schedule"
            ? "orca-chip--aligned-schedule"
            : aligned
              ? "orca-chip--aligned"
              : "",
      ]
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
