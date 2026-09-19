/**
 * `claims.list` - who owns which work item.
 *
 * A claim is the only thing that stops two dispatchers launching one work item twice
 * (`packages/store/src/claim-store.ts`), and it deliberately outlives the run that took it.
 * So the question a person actually asks of this list is "is the run holding this still
 * alive?", which is why every entry carries the owning run's display status - including the
 * case where that run's log is gone, which shows as `stale` with `missing: true`.
 */
import { z } from "zod";
import { DisplayStatusSchema } from "./status.js";
import { WorkItemViewSchema } from "./views.js";

export const CLAIMS_LIST_METHOD = "claims.list";

export const ClaimOwnerViewSchema = z.object({
  runId: z.string(),
  /** The owning run's name, when its log is still there. */
  name: z.string().optional(),
  status: DisplayStatusSchema,
  /** True when no log for `runId` exists any more - the store was rolled back under the claim. */
  missing: z.boolean(),
  /** True when the claim may be released without `--force`: the owner cannot resume. */
  releasable: z.boolean(),
});
export type ClaimOwnerView = z.infer<typeof ClaimOwnerViewSchema>;

export const ClaimViewSchema = z.object({
  workItemId: z.string(),
  workItem: WorkItemViewSchema.optional(),
  /** The branch of the owning run's fan-out that holds it; a second branch is not the owner. */
  branch: z.string(),
  /** The step run that took the claim. Informational - a later attempt of the same node still owns it. */
  stepRunId: z.string().optional(),
  claimedAt: z.string(),
  owner: ClaimOwnerViewSchema,
});
export type ClaimView = z.infer<typeof ClaimViewSchema>;

export const ClaimsListParamsSchema = z.object({
  /** Only the claims this run holds. */
  runId: z.string().optional(),
  workItemId: z.string().optional(),
});
export type ClaimsListParams = z.infer<typeof ClaimsListParamsSchema>;

export const ClaimsListResultSchema = z.object({
  /** Oldest claim first. */
  claims: z.array(ClaimViewSchema),
  asOf: z.string(),
});
export type ClaimsListResult = z.infer<typeof ClaimsListResultSchema>;
