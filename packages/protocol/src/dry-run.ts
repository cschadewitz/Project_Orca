/**
 * Dry runs (#183, protocol 2.9): simulate the caller's workflow draft with fixtures, and read back
 * what the simulation did.
 *
 * - `workflowDrafts.dryRun` simulates the exact revision of the caller's own draft it names:
 *   fixtures in place of agent turns and gate answers, and nothing outside ORCA touched (no agent
 *   session, workspace, secret, Request, work item or plugin node). It is a configuration write,
 *   like every other draft method but `get`, and it also needs `runs.start`, because what it
 *   leaves behind is a run tree. It answers once the tree has stopped - a dry run is bounded by a
 *   step budget - with the root's row and the report.
 * - `runs.dryRunReport` reads that report again for any dry run the caller can see: the choices
 *   made and by whom, the options, edges and nodes never reached, the assumptions, the failures.
 *   It writes nothing, so a read-only daemon answers it.
 *
 * A dry run's rows carry `dryRun` (`RunSummaryView`), and `runs.list` leaves them out unless
 * asked (`dryRuns`): they are never work. New method names and optional fields: a 2.7 client
 * never calls the methods, and strips the field.
 */
import { z } from "zod";
import { DryRunFixturesSchema, DryRunReportSchema } from "@orca/core/schemas";
import { RunSummaryViewSchema } from "./runs.js";

export const WORKFLOW_DRAFTS_DRY_RUN_METHOD = "workflowDrafts.dryRun";
export const RUNS_DRY_RUN_REPORT_METHOD = "runs.dryRunReport";

export { DryRunFixturesSchema, DryRunReportSchema, type DryRunFixtures, type DryRunReport } from "@orca/core/schemas";

export const WorkflowDraftDryRunParamsSchema = z.strictObject({
  workflowId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(128),
  /** The draft revision to simulate; a later edit is `CONFIG_STALE`, as for every draft write. */
  expectedRevision: z.number().int().nonnegative(),
  /** Launch inputs, validated as a live launch validates them. */
  vars: z.record(z.string(), z.unknown()).optional(),
  fixtures: DryRunFixturesSchema.optional(),
  /** Most steps across the whole tree; 500 when absent. */
  maxSteps: z.number().int().min(1).max(5_000).optional(),
});
export type WorkflowDraftDryRunParams = z.infer<typeof WorkflowDraftDryRunParamsSchema>;

export const WorkflowDraftDryRunResultSchema = z.object({
  runId: z.string(),
  /** The root's row, marked `dryRun`. */
  run: RunSummaryViewSchema,
  report: DryRunReportSchema,
  asOf: z.string(),
});
export type WorkflowDraftDryRunResult = z.infer<typeof WorkflowDraftDryRunResultSchema>;

export const RunsDryRunReportParamsSchema = z.strictObject({ runId: z.string().min(1) });
export type RunsDryRunReportParams = z.infer<typeof RunsDryRunReportParamsSchema>;

export const RunsDryRunReportResultSchema = z.object({ report: DryRunReportSchema, asOf: z.string() });
export type RunsDryRunReportResult = z.infer<typeof RunsDryRunReportResultSchema>;
