/**
 * WorkItem status as a *projection* of the event log.
 *
 * ADR 0001: every state change is an event. A work item's progress is therefore not written
 * as the dispatcher goes along - it is derived from what the fan-out step recorded about the
 * branch that stands for the item (`child.spawned` / `child.finished` / `branch.skipped`) and
 * mirrored into the document store, which is a cache. A crash cannot leave an item stranded
 * in `in-progress`: replaying the parent run's log recomputes every status from scratch.
 */
import { outcomeSucceeded, type RunState, type WorkItemStatus } from "@orca/core";
import type { Stores } from "@orca/store";

export interface WorkItemProgress {
  status: WorkItemStatus;
  runId?: string;
}

/**
 * Derive the status of every work item this run fanned out over. Steps are walked in
 * scheduling order so a later attempt of the same node supersedes an earlier one.
 */
export function deriveWorkItemProgress(state: RunState): Map<string, WorkItemProgress> {
  const out = new Map<string, WorkItemProgress>();
  for (const stepId of state.stepOrder) {
    const step = state.steps[stepId];
    if (!step) continue;
    for (const b of step.skippedBranches) {
      // `claimed` says another run owns the item: its progress is that run's to project, not ours.
      if (b.workItemId && b.reason !== "claimed") out.set(b.workItemId, { status: b.reason === "dependency" ? "blocked" : "pending" });
    }
    for (const c of step.children) {
      if (!c.workItemId) continue;
      // No `child.finished` yet: the child run is (or was) under way.
      const status: WorkItemStatus = !c.status
        ? "in-progress"
        : outcomeSucceeded(c.status, c.outcome)
          ? "done"
          : c.status === "cancelled"
            ? "cancelled"
            : c.status === "failed" || c.status === "completed"
              ? "failed"
              : "in-progress";
      out.set(c.workItemId, { status, runId: c.runId });
    }
  }
  return out;
}

/** Mirror the derived progress onto the WorkItem documents. Writes only what actually changed. */
export async function projectWorkItems(stores: Stores, state: RunState, now: string): Promise<void> {
  const derived = deriveWorkItemProgress(state);
  if (derived.size === 0) return;
  const updated = [];
  for (const [id, p] of derived) {
    const cur = await stores.workItems.get(id);
    if (!cur || (cur.status === p.status && (p.runId === undefined || cur.runId === p.runId))) continue;
    updated.push({ ...cur, status: p.status, ...(p.runId ? { runId: p.runId } : {}), updatedAt: now });
  }
  if (updated.length) await stores.workItems.putMany(updated);
}
