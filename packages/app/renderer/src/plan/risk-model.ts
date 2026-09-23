/**
 * The risk mode's arithmetic (#172), with no React in it.
 *
 * Two decisions live here:
 *
 * - **The filter rail is the schedule's.** Classification, status, request and text narrow
 *   the *work items*; a risk is shown while the rail is set only when it holds one of the
 *   items the rail left on screen. An unfiltered rail shows every risk, including one that
 *   affects nothing yet — a risk with no items is still a risk.
 * - **"The journal entries about it" is a match, not a parse.** A plan journal payload is
 *   `core`'s `PlanEvent` union and this app does not keep a second copy of its shapes, so an
 *   entry is about a risk when any string in its payload *is* the risk's id or key — which is
 *   how `risk.raised` (`risk.id`), `risk.updated` (`riskId`) and anything later that names
 *   the risk all come back without a list of event types to keep in step.
 */
import type { PlanItemView, PlanJournalEntryView, RiskView } from "@orca/protocol";

/** Whether any string anywhere in `value` is one of `needles`. Iterative: a payload is data. */
export function mentions(value: unknown, needles: ReadonlySet<string>): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === "string") {
      if (needles.has(next)) return true;
    } else if (Array.isArray(next)) {
      stack.push(...(next as unknown[]));
    } else if (next !== null && typeof next === "object") {
      stack.push(...Object.values(next as Record<string, unknown>));
    }
  }
  return false;
}

/** The journal entries about one risk, newest first. */
export function journalAbout(
  entries: readonly PlanJournalEntryView[],
  risk: Pick<RiskView, "id" | "key">,
): readonly PlanJournalEntryView[] {
  const needles = new Set([risk.id, risk.key]);
  return entries.filter((entry) => mentions(entry.payload, needles)).sort((a, b) => b.seq - a.seq);
}

/**
 * The risks the rail leaves on screen: all of them when nothing is filtered, otherwise the
 * ones holding at least one of the items that are.
 */
export function risksForRail(
  risks: readonly RiskView[],
  filtered: boolean,
  visible: readonly PlanItemView[],
): readonly RiskView[] {
  if (!filtered) return risks;
  const ids = new Set(visible.map((item) => item.id));
  return risks.filter((risk) => risk.affects.some((ref) => ids.has(ref.id)));
}

/** "2 risks", or "1 of 2 risks" once the rail has narrowed them. */
export function riskCountLabel(shown: number, total: number): string {
  const risks = `${total} ${total === 1 ? "risk" : "risks"}`;
  return shown === total ? risks : `${shown} of ${risks}`;
}
