/** Preparation-only row validation; no installed service or new RPC is implied. */
import { z } from "zod";
import {
  OperatorPageParamsSchema,
  OperatorPageResultSchema,
  OperatorRowSchema,
  OPERATOR_MAX_PAGE_SIZE,
} from "./operator-reads.js";
import { RevisionBoundaryViewSchema } from "./revision-input.js";
const state = z.enum(["available", "unsupported", "unavailable"]);
const additions = ["continuationState", "expectedBoundary", "revisionState", "revision", "revisionActionId"] as const;
export const OperatorBoundaryRowSchema = OperatorRowSchema.extend({
  continuationState: state.optional(),
  revisionState: state.optional(),
  revision: RevisionBoundaryViewSchema.optional(),
  revisionActionId: z.string().min(1).optional(),
})
  .strict()
  .superRefine((row, ctx) => {
    const fail = () => ctx.addIssue({ code: "custom", message: "Inconsistent operator boundary projection" });
    if ((row.continuationState === "available") !== (row.expectedBoundary !== undefined)) fail();
    if ((row.revisionState === "available") !== (row.revision !== undefined)) fail();
    if (row.continuationState && row.kind !== "run") fail();
    if ((row.revisionState || row.revisionActionId) && (row.kind !== "decision" || row.live)) fail();
    if (
      row.revision &&
      (row.revision.target.runId !== row.runId ||
        row.revision.target.requestId !== row.requestId ||
        row.id !== row.requestId ||
        row.revision.target.stepRunId !== row.stepRunId ||
        row.revision.capability.actionId !== row.revisionActionId)
    )
      fail();
    if (row.revisionActionId && !row.options?.some((option) => option.id === row.revisionActionId)) fail();
  });
export type OperatorBoundaryRow = z.infer<typeof OperatorBoundaryRowSchema>;
/** Internal trusted composition validation, never RPC params or proof of authorization.
 * declaredRevisionActionId comes from the pinned declaration, not the requested row.
 */
export const OperatorBoundaryProjectionSchema = z
  .strictObject({
    params: OperatorPageParamsSchema,
    before: OperatorRowSchema.strict(),
    after: OperatorBoundaryRowSchema,
    declaredRevisionActionId: z.string().min(1).optional(),
  })
  .superRefine(({ params, before, after, declaredRevisionActionId }, ctx) => {
    const fail = () =>
      ctx.addIssue({ code: "custom", message: "Operator boundary changed row identity or declared scope" });
    if (
      !params.runId ||
      before.runId !== params.runId ||
      after.runId !== params.runId ||
      !["runs", "inputs"].includes(params.collection)
    )
      fail();
    if ((params.collection === "runs") !== (before.kind === "run")) fail();
    if (before.kind === "run" && before.id !== params.runId) fail();
    for (const field of ["stepRunId", "requestId", "workflowId", "workflowVersion"] as const)
      if (params[field] !== undefined && before[field] !== params[field]) fail();
    const base = (row: object) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !additions.includes(key as (typeof additions)[number])));
    if (JSON.stringify(base(before)) !== JSON.stringify(base(after))) fail();
    if (after.revisionActionId !== declaredRevisionActionId) fail();
    if (after.revision && after.revision.capability.actionId !== declaredRevisionActionId) fail();
  });

/** Consumers opt into this result only when real authorized enrichment is mounted. */
export const OperatorBoundaryPageResultSchema = OperatorPageResultSchema.extend({
  items: z.array(OperatorBoundaryRowSchema).max(OPERATOR_MAX_PAGE_SIZE),
});
export type OperatorBoundaryPageResult = z.infer<typeof OperatorBoundaryPageResultSchema>;
