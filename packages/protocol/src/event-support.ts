/**
 * Which protocol first carries each event type that was added after 2.0 (#357 review).
 *
 * `runs.events` pages and `event.appended` frames hold `OrcaEvent`s, and a client parses them
 * with the event schema it was built with: a closed union, so a type it has never seen fails
 * the whole page or frame. A client therefore says which protocol it reads events in
 * (`protocol` on `runs.events` and `subscribe`), and a daemon withholds the types that came
 * later. Absent means 2.0, the oldest client of this major. A withheld event keeps its place in
 * the sequence: pages keep their cursors and frames simply skip it, as for artifact events.
 */
import type { ProtocolVersion } from "./version.js";

const BASELINE: ProtocolVersion = { major: 2, minor: 0 };

/** Event types newer than the 2.0 schema, and the version that introduced each. */
export const EVENT_TYPES_SINCE: Readonly<Record<string, ProtocolVersion>> = {
  // An operator's side-effect review of a step attempt (#357).
  "step.effect.reviewed": { major: 2, minor: 5 },
};

/** Whether a client reading events in `reader` (2.0 when absent) can parse an event of `type`. */
export function eventTypeReadable(type: string, reader: ProtocolVersion | undefined = BASELINE): boolean {
  const since = EVENT_TYPES_SINCE[type];
  if (!since) return true;
  return reader.major > since.major || (reader.major === since.major && reader.minor >= since.minor);
}
