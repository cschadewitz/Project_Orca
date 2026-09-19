/**
 * Durations and timestamps as words, with no DOM and no clock of its own — the components
 * in `time.tsx` are a thin shell over these, and the tests read this file.
 *
 * The rule from docs/design/30-long-running-content.md: two units at most (`1h 12m`,
 * `4.2s`). Never three, because the third unit is never what the reader wanted, and never
 * one where the second carries information — `2h` hides the 59 minutes after it.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A duration, to two units. Sub-second is milliseconds because that is the resolution a
 * step's own timings have; under ten seconds keeps one decimal because the difference
 * between 4.2s and 4.9s is visible to whoever is waiting.
 */
export function formatDuration(ms: number): string {
  const d = Math.max(0, Math.round(ms));
  if (d < SECOND) return `${d}ms`;
  if (d < 10 * SECOND) return `${(d / SECOND).toFixed(1)}s`;
  if (d < MINUTE) return `${Math.floor(d / SECOND)}s`;
  if (d < HOUR) return pair(Math.floor(d / MINUTE), "m", Math.floor((d % MINUTE) / SECOND), "s");
  if (d < DAY) return pair(Math.floor(d / HOUR), "h", Math.floor((d % HOUR) / MINUTE), "m");
  return pair(Math.floor(d / DAY), "d", Math.floor((d % DAY) / HOUR), "h");
}

/** `1h 12m`, or `1h` when the smaller unit is zero — a trailing `0m` says nothing. */
const pair = (big: number, bigUnit: string, small: number, smallUnit: string): string =>
  small === 0 ? `${big}${bigUnit}` : `${big}${bigUnit} ${small}${smallUnit}`;

/**
 * Recency, in the same two units. "just now" below five seconds rather than "4s ago",
 * because a counter that ticks 1s/2s/3s at the top of a screen pulls the eye off the work.
 */
export function formatRelative(at: Date, now: Date = new Date()): string {
  const delta = now.getTime() - at.getTime();
  if (Math.abs(delta) < 5 * SECOND) return "just now";
  const magnitude = formatDuration(Math.abs(delta));
  return delta > 0 ? `${magnitude} ago` : `in ${magnitude}`;
}

/**
 * Wall-clock time, for correlating with another tool's logs. Seconds always, because the
 * events this labels can be a second apart; the date only when it is not today, so a
 * timeline of one run is not a column of repeated dates.
 */
export function formatAbsolute(at: Date, now: Date = new Date()): string {
  /* `hourCycle: h23` rather than `hour12: false`: the latter still yields a 24 o'clock in
     some locales, and a log line stamped 24:05:01 is a bug report waiting to happen. */
  const clock = at.toLocaleTimeString(undefined, {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return sameDay(at, now) ? clock : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}`;
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
