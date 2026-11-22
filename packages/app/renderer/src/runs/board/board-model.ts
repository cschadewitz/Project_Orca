/**
 * The words on a board card (#340), as plain functions so they are tested without a screen.
 *
 * Every line is a fact the daemon sent or the absence of one said plainly: step counts and
 * never a percentage (a workflow branches and loops, so how much is left is not known), a
 * wait named by what it waits on, and the per-run host load and usage the daemon does not
 * measure said to be unavailable rather than drawn as zero (rule 12).
 */
import type { DisplayStatus, FollowPhase, RunSummaryView } from "@orca/protocol";

/** Statuses that are still going somewhere: the ones the board follows by default. */
export const ACTIVE_STATUSES: ReadonlySet<DisplayStatus> = new Set(["running", "waiting", "blocked", "held", "stale"]);

/** How many runs the board follows at once. Past this, the tree is the way to see them. */
export const BOARD_LIMIT = 24;

/** What the follow state says about the data on a card. */
export const PHASE_WORDS: Record<FollowPhase, string> = {
  loading: "Loading",
  live: "Live",
  resyncing: "Catching up",
  reconnecting: "Reconnecting",
  stale: "Not current",
  terminal: "Finished",
  gone: "Not available",
};

/** "4 steps · 2 done · 1 running · 1 failed", zero buckets left out. */
export function progressText(run: RunSummaryView): string | undefined {
  const p = run.operations?.progress;
  if (!p) return undefined;
  const parts = [`${p.attempts} ${p.attempts === 1 ? "step" : "steps"}`];
  if (p.completed) parts.push(`${p.completed} done`);
  if (p.active) parts.push(`${p.active} running`);
  if (p.waiting) parts.push(`${p.waiting} waiting`);
  if (p.failed) parts.push(`${p.failed} failed`);
  if (p.skipped) parts.push(`${p.skipped} skipped`);
  return parts.join(" · ");
}

const WAITS: Record<string, string> = {
  "agent-slot": "Waiting for an agent slot",
  "human-input": "Waiting for a person",
  dependencies: "Waiting on dependencies",
  plan: "Waiting on the plan",
  "child-run": "Waiting on child runs",
  "agent-turn": "Waiting on the agent",
};

/** Why the run is parked, with the engine's detail when it recorded one. */
export function waitText(run: RunSummaryView): string | undefined {
  if (!run.waitingOn) return undefined;
  const what = WAITS[run.waitingOn] ?? `Waiting on ${run.waitingOn}`;
  return run.waitingDetail ? `${what}: ${run.waitingDetail}` : what;
}

/** Who drives the run, from its lease. */
export function ownerText(run: RunSummaryView): string | undefined {
  const ops = run.operations;
  if (!ops) return undefined;
  if (!ops.owner) return run.outcome ? undefined : "No process holds it";
  return ops.owner.lapsed ? `Lease lapsed on ${ops.owner.host}` : `Held on ${ops.owner.host}`;
}

/**
 * Which runs the board follows: the active roots of what the filter shows, newest first,
 * and any run it was already following that has since finished, so a run that ends stays in
 * view saying so instead of vanishing. At most `BOARD_LIMIT`, finished ones dropped first.
 */
export function boardRuns(visible: readonly RunSummaryView[], following: readonly string[]): string[] {
  const shown = new Map(visible.map((run) => [run.id, run]));
  const active = visible.filter((run) => run.parentRunId === undefined && ACTIVE_STATUSES.has(run.status));
  const ids = active.map((run) => run.id);
  const kept = following.filter((id) => shown.has(id) && !ids.includes(id));
  return [...ids, ...kept].slice(0, BOARD_LIMIT);
}
