/**
 * `Duration` and `Time` — every elapsed span and every timestamp in the app.
 *
 * Both are shells over `format-time.ts` (the wording) and `ticker.ts` (the 1Hz clock).
 * The type styles are the design's, not a choice made per call site: a duration and an
 * absolute time are machine output and render in `mono-id`; a relative time is a reading
 * aid and renders in `caption` (docs/design/30-long-running-content.md, "Time").
 */
import type { JSX } from "react";
import { formatAbsolute, formatDuration, formatRelative } from "./format-time.js";
import { Text } from "./text.js";
import { useTick } from "./ticker.js";

export interface DurationProps {
  /** A finished span. Ignored when `since` is given. */
  ms?: number;
  /** An accruing span: the moment it started. Ticks at 1Hz until the prop goes away. */
  since?: Date;
  className?: string;
}

export function Duration({ ms, since, className }: DurationProps): JSX.Element {
  const now = useTick(since !== undefined);
  const elapsed = since !== undefined ? now - since.getTime() : (ms ?? 0);
  return (
    <Text style="mono-id" className={className}>
      {formatDuration(elapsed)}
    </Text>
  );
}

export interface TimeProps {
  at: Date;
  /**
   * `both` is "14:02:31 · 6m ago". Drop to `absolute` when the connection is not live:
   * a relative time computed against a stale clock is a lie
   * (docs/design/40-connection-states.md).
   */
  show?: "absolute" | "relative" | "both";
  className?: string;
}

export function Time({ at, show = "both", className }: TimeProps): JSX.Element {
  const relative = show !== "absolute";
  /* Only the relative half moves, so only it subscribes to the clock; the absolute half
     needs "now" as well, but only to decide whether to print the date, which is coarse. */
  const now = useTick(relative);
  const reference = relative ? new Date(now) : new Date();

  return (
    <time className={className} dateTime={at.toISOString()}>
      {show !== "relative" && <Text style="mono-id">{formatAbsolute(at, reference)}</Text>}
      {show === "both" && (
        <Text style="caption" aria-hidden="true">
          {" · "}
        </Text>
      )}
      {relative && <Text style="caption">{formatRelative(at, reference)}</Text>}
    </time>
  );
}
