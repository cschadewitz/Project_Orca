/**
 * How long an ask has waited, counting up while the card is on screen (#1194).
 *
 * The daemon sends `waitingMs` against its own `asOf`, so the age a card starts from never
 * depends on this machine's clock agreeing with the daemon's. It is only a snapshot, though:
 * an ask that arrived by notification carries the age it had when it was pushed, usually 0,
 * and nothing read it again, so every such card said "waiting 0s" for as long as it stayed
 * open. The card now anchors the daemon's age to this window's clock the first time it sees
 * the ask, and counts on from there with the renderer's shared 1Hz tick. Only elapsed time on
 * this machine is added, which a skewed clock does not change.
 */
import type { JSX } from "react";
import type { OpenInputView } from "@orca/protocol";
import { textClass, useTick } from "../ui/index.js";
import { waitedLabel } from "./card-model.js";

/** When each ask began waiting, on this window's clock. The earliest anchor wins. */
const anchors = new Map<string, number>();
/** Enough for every ask a session sees; the oldest anchors go first past it. */
const ANCHOR_LIMIT = 2000;

/** The instant `input` began waiting, on this window's clock. */
export function waitingSince(input: Pick<OpenInputView, "id" | "waitingMs">, now: number = Date.now()): number {
  const at = now - input.waitingMs;
  const known = anchors.get(input.id);
  const since = known === undefined ? at : Math.min(known, at);
  if (known === undefined && anchors.size >= ANCHOR_LIMIT) {
    const oldest = anchors.keys().next().value;
    if (oldest !== undefined) anchors.delete(oldest);
  }
  anchors.set(input.id, since);
  return since;
}

export function WaitedAge({ input }: { input: Pick<OpenInputView, "id" | "waitingMs"> }): JSX.Element {
  const now = useTick(true);
  const since = waitingSince(input, now);
  return (
    /* `.orca-attn__age` is noted `type: mono-id` in components.css: a duration is machine text
       and takes tabular numerals (#211, rule 8). */
    <span className={`orca-attn__age ${textClass("mono-id")}`}>{waitedLabel(Math.max(0, now - since))}</span>
  );
}
