/**
 * `claims.list` - who owns which work item - and `claims.release`, the way to take one back.
 *
 * A claim is the only thing that stops two dispatchers launching one work item twice
 * (`packages/store/src/claim-store.ts`), and it deliberately outlives the run that took it.
 * So the question a person actually asks of this list is "is the run holding this still
 * alive?", which is why every entry carries the owning run's display status - including the
 * case where that run's log is gone, which shows as `stale` with `missing: true`.
 *
 * `claims.release` is the operator's answer to that question (#88). It is a *write*, so it
 * lives behind `runs.control` with the rest of them, and it is refused while the owning run
 * could still resume unless `force` is given - taking an item away from a run that is merely
 * paused-and-forgotten is a decision a person makes, not one a second dispatcher makes for
 * them.
 */
import { z } from "zod";
import { DisplayStatusSchema } from "./status.js";
import { WorkItemViewSchema } from "./views.js";

export const CLAIMS_LIST_METHOD = "claims.list";
export const CLAIMS_RELEASE_METHOD = "claims.release";

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

// ----------------------------------------------------------------- claims.release

export const ClaimsReleaseParamsSchema = z.object({
  workItemId: z.string().min(1),
  /**
   * Release even though the owning run could still resume. Without it a live, paused or
   * waiting owner is refused with `RUN_STATE` and that run's status, which is the same
   * refusal `orca claims release` gives and the same one `ClaimView.owner.releasable`
   * predicts - so a client can grey the action out rather than call it and be told.
   */
  force: z.boolean().default(false),
});
export type ClaimsReleaseParams = z.infer<typeof ClaimsReleaseParamsSchema>;

export const ClaimsReleaseResultSchema = z.object({
  /** The claim as it stood when it was taken away, with the owner it was taken from. */
  claim: ClaimViewSchema,
  /**
   * What releasing did *not* fix, in words, when there is something. The claim decides who
   * may launch the item; the item's own status is projected from the owning run's log, and a
   * dead run's log never moves on - so an item left `in-progress` is still treated as running
   * by the scheduler. `orca claims release` prints exactly this to stderr; a client shows it
   * rather than letting a person wonder why the item did not become ready.
   */
  note: z.string().optional(),
  asOf: z.string(),
});
export type ClaimsReleaseResult = z.infer<typeof ClaimsReleaseResultSchema>;
