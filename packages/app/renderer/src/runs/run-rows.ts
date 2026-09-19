/**
 * The Runs surface's list arithmetic, with no React and no bridge in it: order a page of
 * runs, filter it by text, and fold a `run.changed` notification into a row.
 *
 * It is a separate module because all three are the parts most likely to be wrong and the
 * parts a DOM test reads worst. `runs.list` answers a page; every later change arrives as a
 * notification (#151), and a screen that re-read the list on each one would ask the daemon
 * five times a second for a store it already has. So the list is held in the renderer and
 * these functions are what keep it honest.
 *
 * What is *not* here, deliberately: the status filter. That one is a `runs.list` parameter,
 * so the daemon does it — the same code path a paged list will need — and only the text
 * filter is local, because the protocol has no text parameter to send it in.
 */
import type { DisplayStatus, RunChangedParams, RunSummaryView } from "@orca/protocol";

/** Statuses a run does not leave. A row in one of these has a total duration, not an elapsed one. */
const TERMINAL: readonly DisplayStatus[] = ["succeeded", "failed", "cancelled"];

export const isTerminal = (status: DisplayStatus): boolean => TERMINAL.includes(status);

/**
 * Newest first by creation, which is the order `runs.list` documents. Ties break on id so
 * that two runs created in the same millisecond do not swap places between renders —
 * `orca demo` writes a whole store in well under a second, so this is not hypothetical.
 */
export function orderRuns(runs: readonly RunSummaryView[]): RunSummaryView[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The text half of the filter (docs/design/10-information-architecture.md: a per-surface
 * filter field, because there is no global search screen).
 *
 * It matches the fields the row actually shows — name, workflow, agent — plus the run id,
 * which the row does not show but which is how another tool (a CI comment, a `orca://` link)
 * names a run. Matching something invisible is a smaller surprise than a person pasting an
 * id and being told there is nothing here.
 */
export function matchesText(run: RunSummaryView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [run.name, run.id, run.workflowId, run.agentId, run.workItem?.slug].some((field) =>
    field?.toLowerCase().includes(needle),
  );
}

/**
 * A row repainted from one `run.changed`, without asking the daemon anything.
 *
 * The notification carries the folded status, the outcome and the transition's own
 * timestamp, which is enough for every field the row draws except two that have to be
 * derived from it:
 *
 * - `startedAt`, when the transition is the one that started the run — otherwise an elapsed
 *   duration would have nothing to count from;
 * - `finishedAt` and `durationMs` on a terminal transition, so the row stops ticking and
 *   shows a total. The duration is start-to-finish arithmetic on two timestamps we hold, not
 *   an estimate (docs/design/RULES.md rule 12).
 *
 * A notification never says `stale` (see `packages/protocol/src/subscriptions.ts`), so a row
 * that `runs.list` called stale becomes live again the moment an event proves it is.
 */
export function applyRunChanged(run: RunSummaryView, params: RunChangedParams): RunSummaryView {
  const next: RunSummaryView = { ...run, status: params.status };

  if (params.outcome !== undefined) next.outcome = params.outcome;
  if (params.error !== undefined) next.error = params.error;
  if (next.startedAt === undefined && params.status === "running") next.startedAt = params.at;

  if (isTerminal(params.status)) {
    next.finishedAt = params.at;
    const started = next.startedAt;
    if (started !== undefined) {
      // Clamped at zero: a clock that stepped backwards mid-run should cost a duration, not
      // print a negative one.
      next.durationMs = Math.max(0, Date.parse(params.at) - Date.parse(started));
    }
  }
  return next;
}

/** Replace the row with this id, or insert the run in creation order when there is none. */
export function mergeRun(runs: readonly RunSummaryView[], run: RunSummaryView): RunSummaryView[] {
  const known = runs.some((r) => r.id === run.id);
  return orderRuns(known ? runs.map((r) => (r.id === run.id ? run : r)) : [...runs, run]);
}
