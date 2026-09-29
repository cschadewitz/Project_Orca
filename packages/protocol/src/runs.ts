/**
 * `runs.list`, `runs.get`, `runs.events` - the three methods the run list, the run tree and
 * the timeline read.
 *
 * The results are a read model for display, not `RunState` on the wire (ADR 0008): a run
 * carries the eight-value `DisplayStatus` rather than the engine's status plus outcome, a
 * name rather than the ids a name would have to be assembled from, and durations rather
 * than two timestamps a client would subtract. Everything a screen shows is a field here;
 * anything a screen only *might* show is a second call.
 */
import { z } from "zod";
// The node-free subpath, not the package root: the renderer bundles this package, and the
// root would drag `node:crypto` and `node:fs` into that bundle. See packages/core/src/schemas.ts.
import { RunOutcomeSchema, WorkspaceSchema, OrcaEventSchema } from "@orca/core/schemas";
import { DisplayStatusSchema } from "./status.js";
import { ArtifactViewSchema, ViewErrorSchema, WorkItemViewSchema } from "./views.js";

export const RUNS_LIST_METHOD = "runs.list";
export const RUNS_GET_METHOD = "runs.get";
export const RUNS_EVENTS_METHOD = "runs.events";

/** One run as a row: the run list, the child rows of a run tree, an attention card's origin. */
export const RunSummaryViewSchema = z.object({
  id: z.string(),
  /**
   * What to call this run in a list. The work item's title when it has one, else the
   * request's title, else the workflow id - never an id alone when something better exists,
   * and never invented.
   */
  name: z.string(),
  workflowId: z.string(),
  workflowVersion: z.string(),
  /**
   * `runs.get` only: a version of the run's workflow is on disk and it is not the recorded
   * `workflowVersion`, so the run runs (and resumes) on the stored definition it started with
   * (#179). False when the workflow is not registered at all. Absent on `runs.list`.
   */
  workflowPinned: z.boolean().optional(),
  status: DisplayStatusSchema,
  /** Present once the run has finished; `status` already accounts for it. */
  outcome: RunOutcomeSchema.optional(),
  /** `step.waiting.on` of the step the run is parked on (`human-input`, `dependencies`, ...). */
  waitingOn: z.string().optional(),
  /** Free-text detail of that wait, when the engine recorded one. */
  waitingDetail: z.string().optional(),
  /** When the run entered the wait it is in now. */
  waitingSince: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Finished runs: start to finish. Live runs: start to `asOf` of the result carrying this. */
  durationMs: z.number().int().nonnegative().optional(),
  parentRunId: z.string().optional(),
  parentStepRunId: z.string().optional(),
  requestId: z.string().optional(),
  workItem: WorkItemViewSchema.optional(),
  /** The agent of the most recently opened session in this run. */
  agentId: z.string().optional(),
  error: ViewErrorSchema.optional(),
});
export type RunSummaryView = z.infer<typeof RunSummaryViewSchema>;

export const RunsListParamsSchema = z.object({
  /** Keep only these display statuses. Empty or absent means all of them. */
  status: z.array(DisplayStatusSchema).optional(),
  requestId: z.string().optional(),
  workItemId: z.string().optional(),
  /** Only the children of this run. */
  parentRunId: z.string().optional(),
  /** Only runs with no parent - the top level of the run list. */
  roots: z.boolean().optional(),
  /** Newest first, from `offset`. */
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
});
export type RunsListParams = z.infer<typeof RunsListParamsSchema>;

export const RunsListResultSchema = z.object({
  /** Newest first (by creation), the `limit` runs after `offset`. */
  runs: z.array(RunSummaryViewSchema),
  /** How many runs match the filter, so a client can page without asking again. */
  total: z.number().int().nonnegative(),
  /** The daemon's clock when it answered; the base for every elapsed time in the result. */
  asOf: z.string(),
});
export type RunsListResult = z.infer<typeof RunsListResultSchema>;

/** A child run hanging off a container step, with enough to draw its row without a second call. */
export const ChildRunViewSchema = z.object({
  runId: z.string(),
  name: z.string(),
  status: DisplayStatusSchema,
  outcome: RunOutcomeSchema.optional(),
  /** Loop index, branch name or work-item slug - the key the container fanned out on. */
  branch: z.string().optional(),
  workItemId: z.string().optional(),
  /** True when a resumed attempt re-attached to a child an interrupted attempt had spawned. */
  resumed: z.boolean().optional(),
});
export type ChildRunView = z.infer<typeof ChildRunViewSchema>;

/** A fan-out branch that never became a child run. Part of the tree: the whole fan-out is shown, not just the part that ran. */
export const SkippedBranchViewSchema = z.object({
  branch: z.string(),
  reason: z.enum(["dependency", "failFast", "claimed"]),
  workItemId: z.string().optional(),
});
export type SkippedBranchView = z.infer<typeof SkippedBranchViewSchema>;

/**
 * One step run - that is, one *attempt* at one node. A re-attempted node has one of these
 * per attempt, all with the same `nodeId` and ascending `attempt`; the tree groups them by
 * `nodeId` (and `iteration`, inside a loop) and shows the highest attempt by default.
 */
export const StepViewSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  nodeType: z.string(),
  attempt: z.number().int().positive(),
  iteration: z.number().int().nonnegative().optional(),
  status: DisplayStatusSchema,
  waitingOn: z.string().optional(),
  scheduledAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** Start to finish, or start to `asOf` while the step is still going.  */
  durationMs: z.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  /** The model the step's session was opened on, when the log records one (v0.6.0 on). */
  model: z.string().optional(),
  agentSessionId: z.string().optional(),
  inputArtifactIds: z.array(z.string()),
  outputArtifactIds: z.array(z.string()),
  /** What a decision or gate settled on. */
  choice: z.string().optional(),
  /** Closing message of a terminal step. */
  message: z.string().optional(),
  error: ViewErrorSchema.optional(),
  children: z.array(ChildRunViewSchema),
  skippedBranches: z.array(SkippedBranchViewSchema),
});
export type StepView = z.infer<typeof StepViewSchema>;

/**
 * One node of the workflow as this run actually took it - the overlay the workflow viewer
 * draws over the graph (#177), in the order the run visited the nodes.
 *
 * It is a projection of `steps` and not a second source: one entry per step run, so a node
 * retried three times is three entries with the same `nodeId` and ascending `attempt`, and a
 * node the run never reached has no entry at all (which is what lets the viewer grey the
 * untaken nodes). Its reason for existing beside `steps` is `viaEdge`: which edge of the
 * *definition* the run came in on, which no step run records and which a client could only
 * recover by holding the workflow and the run side by side and re-deriving it.
 */
export const RunTraversalViewSchema = z.object({
  nodeId: z.string(),
  /** The step run this visit is - the id `runs.events({ stepRunId })` pages the output of. */
  stepRunId: z.string(),
  attempt: z.number().int().positive(),
  status: DisplayStatusSchema,
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  /**
   * The definition's edge the run arrived on: the edge from the previously visited node to
   * this one. Absent for the first node, for a visit no edge explains (a retry of the same
   * node, a run resumed into the middle of a graph), and for a run whose workflow this
   * daemon no longer has - the edge is read off the definition, and a definition that is not
   * registered yields no edge rather than an invented one.
   */
  viaEdge: z.object({ from: z.string(), to: z.string() }).optional(),
  /**
   * The child runs this visit spawned, when it is a container node (`loop`, `parallel`,
   * `subworkflow`): `child.spawned` records them, so expanding a subworkflow on the canvas
   * is a link and not a search. Absent when the visit spawned none.
   */
  childRunIds: z.array(z.string()).optional(),
});
export type RunTraversalView = z.infer<typeof RunTraversalViewSchema>;

export const RunsGetParamsSchema = z.object({ runId: z.string().min(1) });
export type RunsGetParams = z.infer<typeof RunsGetParamsSchema>;

export const RunsGetResultSchema = z.object({
  run: RunSummaryViewSchema,
  workspace: WorkspaceSchema,
  /** The run's variables, as the run detail panel shows them. */
  vars: z.record(z.string(), z.unknown()),
  /** Every step run, in scheduling order. */
  steps: z.array(StepViewSchema),
  /**
   * The path this run took through its workflow, in node order (protocol 1.7, #174).
   * Optional on the wire: a daemon older than 1.7 does not send it, and a viewer that has
   * not got it draws the graph without an overlay rather than failing.
   */
  traversal: z.array(RunTraversalViewSchema).optional(),
  /** Every artifact the run recorded, newest last. */
  artifacts: z.array(ArtifactViewSchema),
  /** The sequence number this projection is current as of - the timeline's cursor. */
  lastSeq: z.number().int().nonnegative(),
  asOf: z.string(),
});
export type RunsGetResult = z.infer<typeof RunsGetResultSchema>;

/**
 * One page of a run's event log, by sequence number, in either direction: `after` walks
 * forward (the live timeline tailing a run), `before` walks backward (scrolling up through
 * a long history). Giving both is an error - a page has one anchor.
 *
 * `stepRunId` is how a step's output pane reads: a step's output is its `agent.update`
 * events, so it is a filter on this log rather than a method of its own. One method means
 * one cursor semantics, which is what lets "load earlier output" and "tail the run" be the
 * same paging code (#158).
 */
export const RunsEventsParamsSchema = z
  .object({
    runId: z.string().min(1),
    /** Events with `seq` greater than this, oldest first. */
    after: z.number().int().nonnegative().optional(),
    /** Events with `seq` less than this: the `limit` events *immediately* before it, still oldest first. */
    before: z.number().int().nonnegative().optional(),
    /** Only these event types. An unknown type matches nothing rather than failing. */
    types: z.array(z.string().min(1)).optional(),
    /**
     * Only events about this step run - which is what a step's output *is*: the
     * `agent.update` events it appended, in the run's own sequence. Run-level events
     * (`run.*`, `vars.set`) are about no step and so match nothing. Composes with `types`
     * as an AND, and an unknown step run matches nothing rather than failing.
     */
    stepRunId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(500).default(200),
  })
  .refine((p) => p.after === undefined || p.before === undefined, {
    message: "give either 'after' or 'before', not both",
  });
export type RunsEventsParams = z.infer<typeof RunsEventsParamsSchema>;

export const RunsEventsResultSchema = z.object({
  /** Oldest first, whichever direction the page was taken in. */
  events: z.array(OrcaEventSchema),
  /** Pass as `after` for the next page forward; absent when the page is empty. */
  nextCursor: z.number().int().nonnegative().optional(),
  /** Pass as `before` for the next page backward; absent when the page is empty. */
  prevCursor: z.number().int().nonnegative().optional(),
  /** Whether the log continues past this page, in the direction it was taken. */
  hasMore: z.boolean(),
  /** The highest sequence number in the run, filter or no filter: the timeline's cursor. */
  lastSeq: z.number().int().nonnegative(),
  asOf: z.string(),
});
export type RunsEventsResult = z.infer<typeof RunsEventsResultSchema>;
