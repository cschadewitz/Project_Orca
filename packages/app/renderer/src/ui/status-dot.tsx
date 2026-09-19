/**
 * `StatusDot` — the chip's minimap form: a status where there is room for a swatch and
 * nothing else (the scrollbar gutter's ticks, a legend, a nav count).
 *
 * This is the one place colour carries a status alone, which is why the dot is never the
 * only rendering of that status on screen: it sits beside a row whose name and chip say
 * the same thing. On its own it is decorative and `aria-hidden`; give it a `label` and it
 * becomes an image with a name.
 */
import type { JSX } from "react";
import { STATUS_PRESENTATION, type RunStatus } from "@orca/design";

export interface StatusDotProps {
  status: RunStatus;
  /** Set when the dot is the only rendering of the status, e.g. a standalone legend. */
  label?: string;
  className?: string;
}

export function StatusDot({ status, label, className }: StatusDotProps): JSX.Element {
  const named = label ?? STATUS_PRESENTATION[status].word;
  return (
    <span
      className={["orca-dot", `orca-dot--${status}`, className].filter(Boolean).join(" ")}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": named })}
    />
  );
}
