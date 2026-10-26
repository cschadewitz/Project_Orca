/** Inactive owner-local #702 review registration. No session/config registration, rule writes or execution capability. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  evaluateStrictPermission,
  OrcaError,
  ruleAllow,
  sameDecisionBinding,
  strictDecisionBinding,
  type ActionEvidenceV1,
  type BoundReviewV1,
  type JudgeRequestV1,
  type JudgeResultV1,
  type PendingReviewV1,
  type PolicyEvaluationV1,
  type PolicyPortV1,
  type PolicyVerdictV1,
  type ReviewEligibilityV1,
  type StrictPermissionSource,
  type StrictPermissionRule,
  type StrictPreflight,
} from "@orca/core";

interface RetainedReview {
  action: ActionEvidenceV1;
  review: ReviewEligibilityV1;
  rule: StrictPermissionRule;
  originalSignal: AbortSignal;
  request?: JudgeRequestV1;
  binding: boolean;
  dispose(this: void): void;
}

export interface StrictPolicyOptions {
  source: StrictPermissionSource;
  /** Existing protected projection/disclosure authority; only called before registration. No egress here. */
  authorizeProjection(request: JudgeRequestV1, action: ActionEvidenceV1, signal: AbortSignal): Promise<void>;
  /** Record normalized attribution through existing protected execution records; no second policy ledger. */
  recordReview(
    action: ActionEvidenceV1,
    request: JudgeRequestV1,
    result: JudgeResultV1,
    verdict: PolicyVerdictV1,
    signal: AbortSignal,
  ): Promise<string>;
  now?: () => number;
  newReviewId?: () => string;
  maximumPending?: number;
}

/** Internal capability only. Source/approval ports must never be constructed from public request fields. */
export function createStrictPolicyPort(options: StrictPolicyOptions): PolicyPortV1 {
  const now = options.now ?? Date.now;
  const newReviewId = options.newReviewId ?? randomUUID;
  const maximumPending = options.maximumPending ?? 64;
  if (!Number.isSafeInteger(maximumPending) || maximumPending < 1)
    throw new OrcaError("CONFIG_INVALID", "strict policy pending bound must be positive");
  const pending = new Map<PendingReviewV1, RetainedReview>();
  const bound = new Map<BoundReviewV1, RetainedReview>();
  const refuse = () => new OrcaError("RUN_STATE", "strict review is unavailable, changed or already consumed");
  const stopped = (action: ActionEvidenceV1, reason: string): PolicyVerdictV1 => ({
    ...strictDecisionBinding(action),
    outcome: "indeterminate",
    reason,
  });
  const recheck = async (action: ActionEvidenceV1, signal: AbortSignal, reviewId: string): Promise<StrictPreflight> => {
    if (signal.aborted) return { phase: "final", verdict: stopped(action, "invocation-expired") };
    try {
      const state = structuredClone(await options.source.readCurrent(structuredClone(action), signal));
      if (signal.aborted) return { phase: "final", verdict: stopped(action, "invocation-expired") };
      return evaluateStrictPermission(action, state, now(), reviewId);
    } catch {
      return { phase: "final", verdict: stopped(action, "current-policy-unavailable") };
    }
  };
  const live = (entry: RetainedReview, signal: AbortSignal) =>
    !signal.aborted &&
    !entry.originalSignal.aborted &&
    Number.isFinite(now()) &&
    now() < Date.parse(entry.review.deadlineAt);
  const eligible = async (entry: RetainedReview, signal: AbortSignal): Promise<StrictPreflight> => {
    if (!live(entry, signal)) return { phase: "final", verdict: stopped(entry.action, "review-expired") };
    const result = await recheck(entry.action, AbortSignal.any([signal, entry.originalSignal]), entry.review.reviewId);
    if (result.phase === "needs-review") {
      // A fresh evaluation computes a new remaining deadline; it must never extend the retained one.
      const { deadlineAt: _fresh, ...current } = result.review;
      const { deadlineAt: _retained, ...retained } = entry.review;
      if (!isDeepStrictEqual(current, retained) || !isDeepStrictEqual(result.rule, entry.rule))
        return { phase: "final", verdict: stopped(entry.action, "review-eligibility-changed") };
    } else if (result.verdict.outcome === "allow") {
      // Removing/changing delegation requires a new evaluation, never an unreviewed completion.
      return { phase: "final", verdict: stopped(entry.action, "review-delegation-changed") };
    }
    return result;
  };
  return {
    version: 1,
    async evaluate(action, signal): Promise<PolicyEvaluationV1> {
      for (const entry of [...pending.values(), ...bound.values()]) {
        if (!live(entry, entry.originalSignal)) entry.dispose();
      }
      const retainedAction = structuredClone(action); // Before first await.
      const result = await recheck(retainedAction, signal, newReviewId());
      if (result.phase === "final") return result;
      if (pending.size + bound.size >= maximumPending)
        return { phase: "final", verdict: stopped(retainedAction, "review-capacity") };
      const handle = Object.freeze({}) as PendingReviewV1;
      const entry: RetainedReview = {
        action: retainedAction,
        review: structuredClone(result.review),
        rule: structuredClone(result.rule),
        originalSignal: signal,
        binding: false,
        dispose: () => {
          pending.delete(handle);
          signal.removeEventListener("abort", entry.dispose);
        },
      };
      pending.set(handle, entry);
      signal.addEventListener("abort", entry.dispose, { once: true });
      return { phase: "needs-review", pending: handle, review: structuredClone(result.review) };
    },
    async bindReview(handle, request, signal): Promise<BoundReviewV1> {
      const entry = pending.get(handle);
      if (!entry || entry.binding) throw refuse();
      entry.binding = true; // Claim before awaiting while retaining the capacity reservation.
      try {
        const exactRequest = structuredClone(request);
        const { approvedProjection, ...eligibility } = exactRequest;
        if (
          !isDeepStrictEqual(eligibility, entry.review) ||
          !live(entry, signal) ||
          !approvedProjection.bindingRef ||
          !approvedProjection.privateRef ||
          !approvedProjection.codecVersion ||
          (approvedProjection.kind !== "utf8-bytes" && approvedProjection.kind !== "parsed-json")
        )
          throw refuse();
        if ((await eligible(entry, signal)).phase !== "needs-review") throw refuse();
        await options.authorizeProjection(
          structuredClone(exactRequest),
          structuredClone(entry.action),
          AbortSignal.any([signal, entry.originalSignal]),
        );
        if ((await eligible(entry, signal)).phase !== "needs-review" || !live(entry, signal)) throw refuse();
        const registered = Object.freeze({}) as BoundReviewV1;
        entry.dispose();
        entry.request = exactRequest;
        entry.dispose = () => {
          bound.delete(registered);
          entry.originalSignal.removeEventListener("abort", entry.dispose);
        };
        bound.set(registered, entry);
        entry.originalSignal.addEventListener("abort", entry.dispose, { once: true });
        return registered;
      } catch {
        entry.dispose();
        throw refuse();
      }
    },
    async completeReview(handle, result, signal): Promise<PolicyVerdictV1> {
      const entry = bound.get(handle);
      if (!entry || !entry.request) throw refuse();
      bound.delete(handle); // Completion cannot race/replay, including malformed/stale failures.
      entry.dispose();
      let exactResult: JudgeResultV1;
      try {
        exactResult = structuredClone(result);
      } catch {
        return stopped(entry.action, "invalid-judge-result");
      }
      const current = await eligible(entry, signal);
      if (current.phase === "final") return current.verdict;
      if (!live(entry, signal)) return stopped(entry.action, "review-expired");
      const request = entry.request;
      if (
        !validResultBinding(exactResult, request) ||
        exactResult.reviewId !== request.reviewId ||
        exactResult.judgeVersion !== request.judgeConfigRef ||
        exactResult.projectionBindingRef !== request.approvedProjection.bindingRef ||
        typeof exactResult.reasonCode !== "string" ||
        !exactResult.reasonCode ||
        exactResult.reasonCode.length > 128 ||
        (exactResult.execution !== "evaluated" && exactResult.execution !== "unavailable") ||
        !["fit", "not-fit", "indeterminate"].includes(exactResult.result) ||
        (exactResult.execution === "unavailable" && exactResult.result !== "indeterminate")
      )
        return stopped(entry.action, "invalid-judge-result");
      const delegation = current.rule.delegation!;
      let verdict: PolicyVerdictV1;
      if (exactResult.execution === "unavailable") {
        if (delegation.requirement === "advisory" && delegation.allowWhenUnavailable)
          verdict = ruleAllow(entry.action, current.rule);
        else verdict = stopped(entry.action, "judge-unavailable");
      } else if (exactResult.result === "fit") verdict = ruleAllow(entry.action, current.rule);
      else
        verdict = {
          ...strictDecisionBinding(entry.action),
          outcome: exactResult.result === "not-fit" ? delegation.onNotFit : delegation.onIndeterminate,
          reason: exactResult.result === "not-fit" ? "judge-not-fit" : "judge-indeterminate",
        };
      let resultRef: string;
      try {
        resultRef = await options.recordReview(
          structuredClone(entry.action),
          structuredClone(request),
          structuredClone(exactResult),
          structuredClone(verdict),
          AbortSignal.any([signal, entry.originalSignal]),
        );
        if (!resultRef) return stopped(entry.action, "review-record-unavailable");
      } catch {
        return stopped(entry.action, "review-record-unavailable");
      }
      // Recording is a separate await, never an authority reservation or dispatch fence.
      const afterRecord = await eligible(entry, signal);
      if (afterRecord.phase === "final") return afterRecord.verdict;
      if (!live(entry, signal)) return stopped(entry.action, "review-expired");
      // The reference records actual unavailable/evaluated status; it never implies a successful review.
      return verdict.outcome === "allow" ? { ...verdict, judgeResultRef: resultRef } : verdict;
    },
  };
}

/** Malformed adapter output cannot become advisory transport-unavailable or escape one-shot completion. */
function validResultBinding(result: JudgeResultV1, request: JudgeRequestV1): boolean {
  try {
    return sameDecisionBinding(result, request);
  } catch {
    return false;
  }
}
