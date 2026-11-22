/**
 * The eight statuses a client renders, and the one mapping onto them.
 *
 * The engine has three vocabularies - `RunStatus` (7 values), `RunOutcome` (3) and
 * `StepStatus` (7) - and the design system has one, `runStatus` in
 * `packages/design/semantics.json`: eight words, each with a glyph and a colour pair. A
 * client must never fold those vocabularies itself, or two screens end up disagreeing about
 * what a finished-but-failed run is called, so the fold happens here, once, and travels on
 * the wire as `DisplayStatus`.
 *
 * `DISPLAY_STATUSES` is the same list, in the same order, as `RUN_STATUSES` in
 * `@orca/design`; `packages/protocol/test` pins the values so the two cannot drift. It is
 * duplicated rather than imported because `protocol` depends on `core` and nothing else -
 * a daemon has no business importing a design package.
 */
import { z } from "zod";
import type { RunOutcome, RunStatus, StepStatus } from "@orca/core";

export const DISPLAY_STATUSES = [
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
  "held",
  "stale",
] as const;
export const DisplayStatusSchema = z.enum(DISPLAY_STATUSES);
export type DisplayStatus = z.infer<typeof DisplayStatusSchema>;

/**
 * What a parked step is parked on, as the engine records it in `step.waiting.on`
 * (`human-input`, `dependencies`, `plan`, `agent-slot`, `child-run`, `agent-turn`). Only the
 * first four change what a person should do about it; the last two are the run working.
 * `agent-slot` (#873) is a step queued for a configured session cap: blocked, like a
 * dependency, because nothing is running for it and a cap somebody set is why.
 */
export type WaitKind = "human" | "dependency" | "work";

export function waitKind(on: string | undefined): WaitKind {
  if (on === "human-input") return "human";
  if (on === "dependencies" || on === "plan" || on === "agent-slot") return "dependency";
  return "work";
}

/** What the display status of a run depends on beyond its own status and outcome. */
export interface RunDisplayContext {
  /** `step.waiting.on` of the step the run is parked on, when it is parked on one. */
  waitingOn?: string | undefined;
  /**
   * True when the run claims to be executing but no live lease backs that claim - the
   * process driving it is gone (see `LeaseStore`). Such a run is `stale`: it is not
   * running, nothing failed, and nobody is being asked.
   */
  leaseLapsed?: boolean | undefined;
}

/**
 * Fold one run's engine state into the status a client shows.
 *
 * - terminal runs follow their outcome: `completed` is `succeeded` only with
 *   `outcome: "success"`, because a workflow may end deliberately in failure;
 * - `paused` is `waiting` - the engine only parks a whole run for a human answer;
 * - engine `waiting` splits on what the step waits for: a person (`waiting`), a
 *   dependency or the plan (`blocked`), or the agent and child runs (`running`);
 * - `created` is `blocked`: it exists, nothing is wrong, and nothing has started;
 * - a `running` or `waiting` run whose lease has lapsed is `stale`, whatever its log says.
 *
 * `held` is never produced here. It is the plan surface's word for an item restrained by
 * risk appetite (`scheduleClass.held`), which is a property of a work item, not of a run.
 */
export function displayStatusForRun(
  run: { status: RunStatus; outcome?: RunOutcome | undefined },
  ctx: RunDisplayContext = {},
): DisplayStatus {
  switch (run.status) {
    case "completed":
      return run.outcome === "failure" ? "failed" : run.outcome === "cancelled" ? "cancelled" : "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "paused":
      return "waiting";
    case "created":
      return ctx.leaseLapsed ? "stale" : "blocked";
    case "running":
      return ctx.leaseLapsed ? "stale" : "running";
    case "waiting": {
      if (ctx.leaseLapsed) return "stale";
      const kind = waitKind(ctx.waitingOn);
      return kind === "human" ? "waiting" : kind === "dependency" ? "blocked" : "running";
    }
  }
}

/**
 * The same fold for one step run. `skipped` is `cancelled`: the run chose not to take that
 * branch, which is not a fault, and the design renders `cancelled` struck through - exactly
 * what a branch never taken should look like. A step that completed is `succeeded` even when
 * it ends the run in failure; the step did its job, and the run's own status says the rest.
 */
export function displayStatusForStep(step: { status: StepStatus; waitingOn?: string | undefined }): DisplayStatus {
  switch (step.status) {
    case "scheduled":
      return "blocked";
    case "running":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
    case "skipped":
      return "cancelled";
    case "waiting": {
      const kind = waitKind(step.waitingOn);
      return kind === "human" ? "waiting" : kind === "dependency" ? "blocked" : "running";
    }
  }
}
