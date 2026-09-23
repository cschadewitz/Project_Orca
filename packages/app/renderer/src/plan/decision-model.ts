/**
 * The decision mode's arithmetic (#173), with no React in it.
 *
 * Nothing here ranks anything. The weighted totals, the recommendation, the margin and the
 * confidence are the matrix's own (`result`, `core`'s `evaluateDecisionMatrix`), stored or
 * previewed by the daemon; a client that re-derived them would be a second matrix to keep
 * true. What is decided here is only how they are said, and what a write sends:
 *
 * - **`decideParams` is the CLI's request.** `orca plan decide <key> <option> --rationale`
 *   sends `{ planId, key, option, rationale }`, and a rationale nobody typed is left out
 *   rather than sent empty — so the journal entry the app produces is the one the CLI does.
 * - **Reopening names what it reopens before it is asked.** The wire answers with
 *   `reopenedDependencyIds` only *after* the reopen, and "asks once and names the
 *   dependencies" has to be said before. The dependencies a decision satisfied are the ones
 *   whose `from` is in its `blocks`, so the confirmation names those items.
 */
import type { DecisionView, DecisionsDecideParams, ItemRef, PlanItemView } from "@orca/protocol";

/** The confidence word said beside the recommendation, or nothing when the call was clear. */
export function confidenceWord(decision: DecisionView): "close" | "tie" | undefined {
  const confidence = decision.result?.confidence;
  return confidence === "close" || confidence === "tie" ? confidence : undefined;
}

/** The option the matrix recommends, when it has a result at all. */
export const recommendedOf = (decision: DecisionView): string | undefined => decision.result?.recommended;

/** An option's name, falling back to its key for a choice the matrix no longer lists. */
export function optionName(decision: DecisionView, option: string): string {
  return decision.options.find((o) => o.key === option)?.name ?? option;
}

/** `decisions.decide`'s parameters, exactly as the CLI sends them. */
export function decideParams(planId: string, key: string, option: string, rationale: string): DecisionsDecideParams {
  const said = rationale.trim();
  return { planId, key, option, ...(said === "" ? {} : { rationale: said }) };
}

/** The sentence a reopen is confirmed with: the decision, and the items it will hold again. */
export function reopenQuestion(decision: DecisionView): string {
  const items = decision.blocks.map((ref: ItemRef) => ref.slug);
  const what =
    items.length === 0
      ? "No dependency is waiting on it."
      : `It reopens the ${items.length === 1 ? "dependency" : "dependencies"} of ${items.join(", ")} on it, which wait again.`;
  return `Reopen ${decision.key} and clear the choice of ${optionName(decision, decision.chosen ?? "")}? ${what}`;
}

/** The decisions the rail leaves on screen: all of them, or those gating an item that is. */
export function decisionsForRail(
  decisions: readonly DecisionView[],
  filtered: boolean,
  visible: readonly PlanItemView[],
): readonly DecisionView[] {
  if (!filtered) return decisions;
  const ids = new Set(visible.map((item) => item.id));
  return decisions.filter((decision) => decision.blocks.some((ref) => ids.has(ref.id)));
}
