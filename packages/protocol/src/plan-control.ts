/**
 * The plan's writing methods: `dependencies.waive`, `decisions.decide`, `decisions.reopen`
 * and `risks.update`.
 *
 * They sit behind the same `runs.control` gate as the run controls (`control.ts`): a daemon
 * started `--read-only` leaves them out of the dispatch table *and* out of `hello.methods`,
 * so a palette hides the action rather than discovering at the moment of pressing that there
 * is nothing behind it.
 *
 * They are not, however, guarded by a run lease, because a plan is not a run. What serialises
 * them is `PlanService`'s own per-plan lock, and the journal records who did each one:
 * `PlanOrigin { kind: "human", actor }`, with the daemon as the actor. A plan write from here
 * is therefore exactly `orca plan waive|decide|risk` with a different actor string.
 *
 * **A decided decision is reopened explicitly, never overwritten** (#104). `decisions.decide`
 * on a decision already decided *differently* re-decides it and says so in the journal;
 * re-deciding it the same way is idempotent and writes nothing. `decisions.reopen` is the
 * separate act that clears the choice and reopens every dependency it had satisfied, which is
 * what makes "somebody changed their mind" visible in the audit trail instead of silent.
 */
import { z } from "zod";
// The node-free subpath, not the package root: the renderer bundles this package. See runs.ts.
import { RiskStatusSchema } from "@orca/core/schemas";
import { DecisionViewSchema, DependencyViewSchema, RiskViewSchema } from "./plan.js";

export const DEPENDENCIES_WAIVE_METHOD = "dependencies.waive";
export const DECISIONS_DECIDE_METHOD = "decisions.decide";
export const DECISIONS_REOPEN_METHOD = "decisions.reopen";
export const RISKS_UPDATE_METHOD = "risks.update";

// ------------------------------------------------------------- dependencies.waive

/**
 * Waive a dependency: a person saying "this no longer has to hold". It is the one dependency
 * status a human sets - `satisfied` and `failed` are the scheduler's to decide from the plan
 * - and it is irreversible from here on the same grounds `orca plan waive` is: the way back
 * is to add the dependency again, which the journal then shows as two acts and not one.
 */
export const DependenciesWaiveParamsSchema = z.object({
  planId: z.string().min(1),
  dependencyId: z.string().min(1),
  /** Why. Recorded as the dependency's `resolution` and shown wherever it is explained. */
  rationale: z.string().optional(),
});
export type DependenciesWaiveParams = z.infer<typeof DependenciesWaiveParamsSchema>;

export const DependenciesWaiveResultSchema = z.object({
  /** The dependency as it now stands, with the live evaluation recomputed. */
  dependency: DependencyViewSchema,
  asOf: z.string(),
});
export type DependenciesWaiveResult = z.infer<typeof DependenciesWaiveResultSchema>;

// ---------------------------------------------------------------- decisions.decide

export const DecisionsDecideParamsSchema = z.object({
  planId: z.string().min(1),
  /** The decision's key within the plan, or its id. */
  key: z.string().min(1),
  /** An option's `key`. It must be one the decision offers; the daemon does not invent one. */
  option: z.string().min(1),
  rationale: z.string().optional(),
});
export type DecisionsDecideParams = z.infer<typeof DecisionsDecideParamsSchema>;

export const DecisionsDecideResultSchema = z.object({
  decision: DecisionViewSchema,
  /** What was recorded. Equal to `option`; present so a caller need not re-read the view. */
  choice: z.string(),
  /**
   * What the weighted matrix would have chosen, when the decision has one. A person is
   * entitled to decide against it, and a client that shows the disagreement is showing
   * something true rather than warning about it.
   */
  recommended: z.string().optional(),
  asOf: z.string(),
});
export type DecisionsDecideResult = z.infer<typeof DecisionsDecideResultSchema>;

// ---------------------------------------------------------------- decisions.reopen

export const DecisionsReopenParamsSchema = z.object({
  planId: z.string().min(1),
  key: z.string().min(1),
});
export type DecisionsReopenParams = z.infer<typeof DecisionsReopenParamsSchema>;

export const DecisionsReopenResultSchema = z.object({
  decision: DecisionViewSchema,
  /**
   * The dependencies this reopened - every `satisfied` one that was satisfied *by* the
   * choice. They are back to `open`, so the items they gate stop being dispatchable, which
   * is the consequence a person has to see before they reopen anything.
   */
  reopenedDependencyIds: z.array(z.string()),
  asOf: z.string(),
});
export type DecisionsReopenResult = z.infer<typeof DecisionsReopenResultSchema>;

// -------------------------------------------------------------------- risks.update

/**
 * Move a risk along its lifecycle: `open -> mitigating -> mitigated | accepted | realized ->
 * closed`. Accepting one is how an item held above the plan's appetite is released without
 * changing the appetite, which is why this is a write the palette needs and not an admin
 * task.
 *
 * Only `status` may be set from here. A risk's likelihood and impact are ratings the
 * decomposition or a human author gave it, and re-scoring one from a list is the kind of
 * change that wants the whole record in front of it.
 */
export const RisksUpdateParamsSchema = z.object({
  planId: z.string().min(1),
  /** The risk's key within the plan, or its id. */
  key: z.string().min(1),
  status: RiskStatusSchema,
});
export type RisksUpdateParams = z.infer<typeof RisksUpdateParamsSchema>;

export const RisksUpdateResultSchema = z.object({
  risk: RiskViewSchema,
  asOf: z.string(),
});
export type RisksUpdateResult = z.infer<typeof RisksUpdateResultSchema>;
