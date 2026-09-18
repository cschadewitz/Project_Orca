/**
 * WorkItem status as a *projection* of the event log.
 *
 * ADR 0001: every state change is an event. A work item's progress is therefore not written
 * as the dispatcher goes along - it is derived from what the fan-out step recorded about the
 * branch that stands for the item (`child.spawned` / `child.finished` / `branch.skipped`) and
 * mirrored into the document store, which is a cache. A crash cannot leave an item stranded
 * in `in-progress`: replaying the parent run's log recomputes every status from scratch.
 *
 * This module is the *only* writer of `WorkItem.status` / `runId` for an item that has a run:
 * the planning layer reacts to what is projected here (`PlanService.onWorkItemsProjected`)
 * instead of writing the same fields alongside it. `custom:plan-dispatch` never skips a
 * branch, so under plan dispatch no run log can produce `blocked` - an item the scheduler
 * refused to start never gets a branch - and that one the plan side owns
 * (`PlanService.deferWorkItem`), so the two can never disagree. (A plain `parallel` fan-out
 * does project `blocked`, from `branch.skipped` with reason `dependency`.)
 */
import { outcomeSucceeded, type Run, type RunOutcome, type RunState, type RunStatus, type WorkItem, type WorkItemStatus } from "@orca/core";
import type { Stores } from "@orca/store";

export interface WorkItemProgress {
  status: WorkItemStatus;
  runId?: string;
}

/** A transition this projection mirrored onto a WorkItem document. */
export interface ProjectedWorkItem {
  /** The document as written. */
  workItem: WorkItem;
  previous: WorkItemStatus;
  /** The fields that changed, as a patch (`deferredReason: null` = cleared). */
  changes: { status: WorkItemStatus; runId?: string; deferredReason?: null };
}

/**
 * The work-item status a run in this state implies. The single mapping: used both for the
 * child links a container step records and for an item run projected from its own log, so
 * the two views of one item cannot diverge.
 */
export function workItemStatusOfRun(status: RunStatus | undefined, outcome: RunOutcome | undefined): WorkItemStatus {
  if (!status) return "in-progress"; // spawned, no `child.finished` yet
  if (outcomeSucceeded(status, outcome)) return "done";
  if (status === "cancelled") return "cancelled";
  // `completed` without a success outcome is a run that ran to the end and decided against itself.
  return status === "failed" || status === "completed" ? "failed" : "in-progress";
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
      out.set(c.workItemId, { status: workItemStatusOfRun(c.status, c.outcome), runId: c.runId });
    }
  }
  return out;
}

/** Mirror the derived progress onto the WorkItem documents. Writes only what actually changed. */
export async function projectWorkItems(stores: Stores, state: RunState, now: string): Promise<ProjectedWorkItem[]> {
  const derived = deriveWorkItemProgress(state);
  if (derived.size === 0) return [];
  return mirror(stores, derived, now);
}

/**
 * The same projection for an item run no container step is driving - one started without a
 * parent, or resumed on its own after the program run that dispatched it had finished. Its
 * own log is then the only record of how it ended.
 */
export async function projectWorkItemForRun(stores: Stores, run: Pick<Run, "id" | "workItemId" | "status" | "outcome">, now: string): Promise<ProjectedWorkItem[]> {
  if (!run.workItemId) return [];
  return mirror(stores, new Map([[run.workItemId, { status: workItemStatusOfRun(run.status, run.outcome), runId: run.id }]]), now);
}

async function mirror(stores: Stores, derived: Map<string, WorkItemProgress>, now: string): Promise<ProjectedWorkItem[]> {
  const updated: WorkItem[] = [];
  const projected: ProjectedWorkItem[] = [];
  for (const [id, p] of derived) {
    const cur = await stores.workItems.get(id);
    if (!cur) continue;
    // An item that has started or finished is no longer deferred; whatever reason the
    // scheduler left on it describes a wait that is over.
    const clears = cur.deferredReason !== undefined && p.status !== "pending" && p.status !== "blocked";
    if (cur.status === p.status && (p.runId === undefined || cur.runId === p.runId) && !clears) continue;
    const next: WorkItem = { ...cur, status: p.status, ...(p.runId ? { runId: p.runId } : {}), updatedAt: now };
    if (clears) delete next.deferredReason;
    updated.push(next);
    projected.push({ workItem: next, previous: cur.status, changes: { status: p.status, ...(p.runId ? { runId: p.runId } : {}), ...(clears ? { deferredReason: null } : {}) } });
  }
  if (updated.length) await stores.workItems.putMany(updated);
  return projected;
}
