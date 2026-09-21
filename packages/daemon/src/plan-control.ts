/**
 * The plan's writing methods, and `claims.release`.
 *
 * They sit apart from `ControlModel` (control.ts) because they are a different kind of write.
 * A run control takes the run's single-writer lease, drives an interpreter and answers when
 * the run parks; a plan write is one `PlanService` call under that service's own per-plan
 * lock, and it journals. Nothing here starts, resumes or touches a run.
 *
 * **Who did it is recorded.** Every mutation takes a `PlanOrigin`, and the origin these use
 * is `{ kind: "human", actor }` with `actor` defaulting to `"daemon"` - the same shape
 * `orca plan` uses with `actor: "cli"`. The journal is the audit trail, and "a human, through
 * the daemon" is the honest entry: these methods only ever run because a person pressed
 * something. The wire carries no per-connection identity today (`hello.client` is a string
 * for logs and is not retained per connection), so `actor` is settable by the embedder rather
 * than derived from a client that has not told us who it is.
 *
 * **`claims.release` is here and not in `ControlModel` for the same reason.** It is
 * `Orchestrator.releaseClaim` - a compare-and-delete against the store - and it is about a
 * work item, not about driving a run. It keeps the CLI's two behaviours exactly: refuse while
 * the owner could still resume unless `force`, and say so when the item is left `in-progress`
 * by a dead run's log (#88).
 */
import { OrcaError, type Clock, type PlanOrigin } from "@orca/core";
import type { Orchestrator, PlanService } from "@orca/engine";
import type {
  ClaimsReleaseParams,
  ClaimsReleaseResult,
  ClaimView,
  DecisionsDecideParams,
  DecisionsDecideResult,
  DecisionsReopenParams,
  DecisionsReopenResult,
  DependenciesWaiveParams,
  DependenciesWaiveResult,
  RisksUpdateParams,
  RisksUpdateResult,
} from "@orca/protocol";
import type { PlanModel } from "./plan-model.js";
import type { ReadModel } from "./read-model.js";

export interface PlanControlModelOptions {
  plan: PlanService;
  orchestrator: Orchestrator;
  /** The plan projection the results are rendered from: one set of shapes, not two. */
  plans: PlanModel;
  /** The run projection, for the `ClaimView` `claims.release` answers with. */
  reads: ReadModel;
  /**
   * Recorded as `PlanOrigin.actor` on every journal entry these methods write. Defaults to
   * `"daemon"`; an embedder that does know who is connected passes that instead.
   */
  actor?: string | undefined;
  clock?: Clock | undefined;
}

export class PlanControlModel {
  private readonly svc: PlanService;
  private readonly orc: Orchestrator;
  private readonly plans: PlanModel;
  private readonly reads: ReadModel;
  private readonly origin: PlanOrigin;
  private readonly clock: Clock;

  constructor(opts: PlanControlModelOptions) {
    this.svc = opts.plan;
    this.orc = opts.orchestrator;
    this.plans = opts.plans;
    this.reads = opts.reads;
    this.origin = { kind: "human", actor: opts.actor ?? "daemon" };
    this.clock = opts.clock ?? opts.plan.clock;
  }

  /**
   * `dependencies.waive`: a person saying this edge no longer has to hold.
   *
   * The plan is checked before the dependency is, so waiving an id that belongs to another
   * plan is refused rather than silently honoured - the `planId` on the params is not
   * decoration, it is what a client scoped its screen to.
   */
  async waiveDependency(params: DependenciesWaiveParams): Promise<DependenciesWaiveResult> {
    const plan = await this.svc.requirePlan(params.planId);
    const current = await this.orc.stores.plan.dependencies.get(params.dependencyId);
    if (!current || current.planId !== plan.id)
      throw new OrcaError("PLAN_INVALID", `dependency '${params.dependencyId}' is not in plan ${plan.key}`, {
        planId: plan.id,
        dependencyId: params.dependencyId,
      });
    const dependency = await this.svc.resolveDependency(
      params.dependencyId,
      "waived",
      params.rationale ?? "waived via the daemon",
      this.origin,
    );
    return {
      dependency: await this.plans.dependencyViewOf(plan.id, dependency),
      asOf: this.clock.isoNow(),
    };
  }

  /**
   * `decisions.decide`: record a choice a person made, and reconcile what it unblocks.
   *
   * `decidedBy: "human"` and not `"agent"`: this call only happens because somebody pressed
   * something, and the matrix's own recommendation travels back beside the choice so a client
   * can show that the two differ without the daemon deciding what that means.
   *
   * Re-deciding a decision the same way is idempotent in `PlanService` and journals nothing.
   * Deciding one that is already decided *differently* overrides it - which is what a person
   * asking for it means - and `decisions.reopen` is the separate act for clearing a choice
   * without replacing it (#104).
   */
  async decide(params: DecisionsDecideParams): Promise<DecisionsDecideResult> {
    const plan = await this.svc.requirePlan(params.planId);
    // `PlanService.evaluateDecision` falls back to the matrix's recommendation when `chosen`
    // is not one of the options, which is right for an agent submitting a matrix artifact and
    // wrong for a person pressing a button: the answer would be a decision they did not make.
    // So a bad option is refused here, before anything is journalled.
    const decision = await this.requireDecision(plan.id, params.key);
    const keys = decision.options.map((o) => o.key);
    if (keys.length && !keys.includes(params.option))
      throw new OrcaError(
        "PLAN_INVALID",
        `'${params.option}' is not an option of decision '${decision.key}': ${keys.join(", ")}`,
        { planId: plan.id, decisionId: decision.id, options: keys },
      );
    const {
      decision: decided,
      result,
      choice,
    } = await this.svc.evaluateDecision(
      plan.id,
      params.key,
      {
        chosen: params.option,
        decidedBy: "human",
        ...(params.rationale ? { rationale: params.rationale } : {}),
      },
      this.origin,
    );
    return {
      decision: await this.plans.decisionViewOf(plan.id, decided),
      choice,
      ...(result ? { recommended: result.recommended } : {}),
      asOf: this.clock.isoNow(),
    };
  }

  /** A decision of this plan, by key or id. The same lookup `PlanService` does internally. */
  private async requireDecision(planId: string, keyOrId: string) {
    const found =
      (await this.orc.stores.plan.decisions.get(keyOrId)) ??
      (await this.orc.stores.plan.decisions.list((d) => d.planId === planId && d.key === keyOrId))[0];
    if (!found || found.planId !== planId)
      throw new OrcaError("PLAN_INVALID", `decision '${keyOrId}' not found in plan ${planId}`, { planId });
    return found;
  }

  /**
   * `decisions.reopen`: clear a choice, and with it every dependency the choice satisfied.
   *
   * The reopened dependencies are named in the result because they are the consequence: items
   * that were dispatchable a moment ago are not any more, and a client that showed only "the
   * decision is open again" would have hidden the half that matters.
   */
  async reopen(params: DecisionsReopenParams): Promise<DecisionsReopenResult> {
    const plan = await this.svc.requirePlan(params.planId);
    // Read the satisfied-by-this-decision set *before* the reopen, because that is exactly
    // what `reopenDecision` will set back to `open`.
    const before = await this.svc.snapshot(plan.id);
    const decision = await this.svc.reopenDecision(plan.id, params.key, this.origin);
    const reopenedDependencyIds = before.dependencies
      .filter((d) => d.target.kind === "decision" && d.target.decisionId === decision.id && d.status === "satisfied")
      .map((d) => d.id);
    return {
      decision: await this.plans.decisionViewOf(plan.id, decision),
      reopenedDependencyIds,
      asOf: this.clock.isoNow(),
    };
  }

  /** `risks.update`: move a risk along its lifecycle. Accepting one releases what it held. */
  async updateRisk(params: RisksUpdateParams): Promise<RisksUpdateResult> {
    const plan = await this.svc.requirePlan(params.planId);
    const risk = await this.svc.updateRisk(plan.id, params.key, { status: params.status }, this.origin);
    return { risk: await this.plans.riskViewOf(plan.id, risk), asOf: this.clock.isoNow() };
  }

  /**
   * `claims.release`: take a work item away from the run that claimed it (#88).
   *
   * `Orchestrator.releaseClaim` is the whole of the rule - it refuses while the owner could
   * still resume unless `force`, and it compares and deletes against the incumbent it
   * inspected, so a claim another run took in the meantime survives. What is added here is
   * the `ClaimView` the wire speaks and the note `orca claims release` prints: the claim
   * decides who may *launch* the item, and an item left `in-progress` by a dead run's log is
   * still treated as running by the scheduler until that status changes.
   */
  async releaseClaim(params: ClaimsReleaseParams): Promise<ClaimsReleaseResult> {
    const asOf = this.clock.isoNow();
    // The claim as `claims.list` would have shown it, taken before the release, because
    // afterwards there is no claim to project.
    const before = await this.reads.claimsList({ workItemId: params.workItemId });
    const released = await this.orc.releaseClaim(params.workItemId, { force: params.force });
    const claim: ClaimView = before.claims[0] ?? {
      workItemId: released.workItemId,
      branch: released.branch,
      claimedAt: released.at,
      owner: { runId: released.runId, status: "stale", missing: true, releasable: true },
      ...(released.stepRunId ? { stepRunId: released.stepRunId } : {}),
    };
    const item = await this.orc.stores.workItems.get(params.workItemId);
    const note =
      item?.status === "in-progress"
        ? `${params.workItemId} is still in-progress${item.runId ? ` (run ${item.runId})` : ""}; the plan scheduler treats it as running until that status changes`
        : undefined;
    return { claim, ...(note ? { note } : {}), asOf };
  }
}
