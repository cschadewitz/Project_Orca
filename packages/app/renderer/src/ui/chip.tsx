/**
 * `Chip` — a chip that is not a status: a count, a filter, a role, an agent name.
 *
 * It is `orca-chip--plain` on purpose. The eight tinted chip variants belong to
 * `StatusChip` and to nothing else, so that a tinted chip on screen always means a run
 * status and never "this label happened to want some colour".
 */
import type { JSX, ReactNode } from "react";
import { textClass } from "./text.js";

export interface ChipProps {
  children?: ReactNode;
  /** Decorative; the label beside it carries the meaning. */
  glyph?: string;
  className?: string;
}

export function Chip({ children, glyph, className }: ChipProps): JSX.Element {
  return (
    <span className={["orca-chip", textClass("caption"), "orca-chip--plain", className].filter(Boolean).join(" ")}>
      {glyph !== undefined && (
        <span className="orca-chip__glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      <span className="orca-chip__label">{children}</span>
    </span>
  );
}
