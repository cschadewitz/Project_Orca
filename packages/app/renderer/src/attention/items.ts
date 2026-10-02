/**
 * What the Attention surface holds, in the order it holds it, and what the main process is
 * told about it — a plain module with a plain test, like `runs/run-rows.ts`.
 *
 * Two orderings, both from docs/design/20-attention-and-gates.md's tier table:
 *
 * - **Permission asks above gates.** A permission ask holds an agent turn open and occupies
 *   a host while it waits; a gate is a run parked, costing nothing but time. Within a tier
 *   the daemon's own order stands — `inputs.list` answers longest-waiting first, and
 *   re-sorting it here would be a second opinion about a thing the daemon already decided.
 * - **Failures below the waits.** They are in this surface because a run that failed needs
 *   a person, but they are not something a person is being *asked*, so they are under the
 *   fold and out of the count.
 */
import type { LiveDecisionTarget, OpenInputView, RunSummaryView } from "@orca/protocol";
import type { AlertItem } from "../../../src/bridge.js";

/** Tier 1 or tier 2. The kinds are the engine's; the tiers are the design's. */
export type WaitTier = "permission" | "gate";

export const tierOf = (input: OpenInputView): WaitTier => (input.kind === "permission" ? "permission" : "gate");

/**
 * Tier 1 first, then tier 2, each keeping the daemon's longest-waiting-first order.
 *
 * A stable partition rather than a sort with a comparator: `Array.prototype.sort` is stable
 * in every engine this app runs on, but saying "these, then those" is what the design says
 * and needs no reader to know that.
 */
export function orderWaits(inputs: readonly OpenInputView[]): readonly OpenInputView[] {
  return [...inputs.filter((i) => tierOf(i) === "permission"), ...inputs.filter((i) => tierOf(i) === "gate")];
}

/** Insert or replace one input, keeping the order above. */
export function mergeInput(inputs: readonly OpenInputView[], input: OpenInputView): readonly OpenInputView[] {
  const without = inputs.filter((i) => i.id !== input.id);
  return orderWaits([...without, input]);
}

/** Correlation includes the whole invocation, never a reusable input/tool-call id alone. */
export function liveInputKey(target: LiveDecisionTarget): string {
  return JSON.stringify([
    target.instanceId,
    target.sessionId,
    target.turnId,
    target.invocationId,
    target.runId,
    target.stepRunId,
    target.requestId,
  ]);
}
/** Keep the recoverable record visible, but never offer an answer to an expired callback. */
export function invalidateLiveInput(input: OpenInputView, invalidated: ReadonlySet<string>): OpenInputView {
  if (input.kind !== "permission" || !input.live || !invalidated.has(liveInputKey(input.live.target))) return input;
  return { ...input, live: { ...input.live, state: "expired" } };
}

/**
 * What the main process posts notifications and sets the badge from (#162).
 *
 * The wording is decided here rather than in the main process because this is the side that
 * knows what the words mean: a run name, a work item title and the question the step asked.
 * The main process decides *when*, which is the half that needs timers.
 */
export function alertItems(
  inputs: readonly OpenInputView[],
  failures: readonly RunSummaryView[],
): readonly AlertItem[] {
  const waits = inputs.map<AlertItem>((input) => ({
    id: input.id,
    tier: tierOf(input),
    title: input.kind === "permission" ? `${input.runName} needs permission` : `${input.runName} is waiting`,
    body: input.question,
    runId: input.runId,
    inputId: input.id,
    // The daemon's `waitingMs` against its own `asOf`, turned back into the instant it was
    // asked: the 60-second gate delay is measured from there and not from when this window
    // happened to hear about it.
    since: input.requestedAt,
  }));
  const failed = failures.map<AlertItem>((run) => ({
    id: run.id,
    tier: "failure",
    title: `${run.name} failed`,
    body: run.error?.message ?? "The run will not proceed.",
    runId: run.id,
    since: run.finishedAt ?? run.createdAt,
  }));
  return [...waits, ...failed];
}
