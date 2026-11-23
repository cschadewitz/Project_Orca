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
  type StrictReviewTerms,
  type PolicyVerdictV1,
  type ReviewEligibilityV1,
  type StrictPermissionSource,
  type StrictPermissionState,
  type StrictPermissionRule,
  type StrictPreflight,
} from "@orca/core";

interface RetainedReview {
  originalAction: ActionEvidenceV1;
  action: ActionEvidenceV1;
  status: "pending" | "binding" | "bound" | "completing" | "completed" | "terminal";
  verdict?: PolicyVerdictV1;
  normalizedResult?: JudgeResultV1;
  recordRef?: string;
  review: ReviewEligibilityV1;
  rule: StrictPermissionRule;
  terms: StrictReviewTerms;
  state: StrictPermissionState;
  originalSignal: AbortSignal;
  request?: JudgeRequestV1;
  cancel(this: void): void;
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
  const readCurrent = options.source.readCurrent.bind(options.source);
  const authorizeProjection = options.authorizeProjection.bind(options);
  const recordReview = options.recordReview.bind(options);
  const newReviewId = options.newReviewId ?? randomUUID;
  const maximumPending = options.maximumPending ?? 64;
  if (!Number.isSafeInteger(maximumPending) || maximumPending < 1)
    throw new OrcaError("CONFIG_INVALID", "strict policy pending bound must be positive");
  const pending = new Map<PendingReviewV1, RetainedReview>();
  const bound = new Map<BoundReviewV1, RetainedReview>();
  // Weak terminal markers cannot reopen the original object and do not retain dead actions.
  const byAction = new WeakMap<ActionEvidenceV1, RetainedReview | { readonly terminal: PolicyVerdictV1 }>();
  const active = new Set<RetainedReview>();
  const busy = new Set<RetainedReview>();
  let reading = 0; // Independently bound every source read, including completed-review rechecks.
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  const refuse = () => new OrcaError("RUN_STATE", "strict review is unavailable, changed or already consumed");
  const stopped = (action: ActionEvidenceV1, reason: string): PolicyVerdictV1 => ({
    ...strictDecisionBinding(action),
    outcome: "indeterminate",
    reason,
  });
  const recheck = async (
    action: ActionEvidenceV1,
    signal: AbortSignal,
    reviewId: string,
    capture?: (state: StrictPermissionState) => void,
  ): Promise<StrictPreflight> => {
    if (signal.aborted) return { phase: "final", verdict: stopped(action, "invocation-expired") };
    if (reading >= maximumPending) return { phase: "final", verdict: stopped(action, "review-capacity") };
    reading++;
    try {
      const state = structuredClone(await readCurrent(structuredClone(action), signal));
      if (signal.aborted) return { phase: "final", verdict: stopped(action, "invocation-expired") };
      capture?.(state);
      return evaluateStrictPermission(action, state, now(), reviewId);
    } catch {
      return { phase: "final", verdict: stopped(action, "current-policy-unavailable") };
    } finally {
      reading--;
    }
  };
  const live = (entry: RetainedReview, signal: AbortSignal) =>
    !signal.aborted &&
    !entry.originalSignal.aborted &&
    Number.isFinite(now()) &&
    now() < Date.parse(entry.review.deadlineAt);
  const isTerminal = (entry: RetainedReview) => entry.status === "terminal";
  const terminal = (entry: RetainedReview, verdict: PolicyVerdictV1): PolicyVerdictV1 => {
    if (isTerminal(entry)) return entry.verdict!;
    entry.status = "terminal";
    entry.verdict = freeze(structuredClone(verdict));
    byAction.set(entry.originalAction, Object.freeze({ terminal: entry.verdict }));
    entry.dispose();
    if (!busy.has(entry)) active.delete(entry);
    return entry.verdict;
  };
  const eligible = async (entry: RetainedReview, signal: AbortSignal): Promise<StrictPreflight> => {
    if (!isDeepStrictEqual(entry.originalAction, entry.action))
      return { phase: "final", verdict: stopped(entry.action, "original-action-changed") };
    if (!live(entry, signal)) return { phase: "final", verdict: stopped(entry.action, "review-expired") };
    let currentState: StrictPermissionState | undefined;
    const result = await recheck(
      entry.action,
      AbortSignal.any([signal, entry.originalSignal]),
      entry.review.reviewId,
      (state) => {
        currentState = state;
      },
    );
    if (isTerminal(entry)) return { phase: "final", verdict: entry.verdict! };
    if (!live(entry, signal) || !isDeepStrictEqual(entry.originalAction, entry.action))
      return { phase: "final", verdict: stopped(entry.action, "review-expired-or-changed") };
    if (result.phase === "needs-review") {
      // A fresh evaluation computes a new remaining deadline; it must never extend the retained one.
      const { deadlineAt: _fresh, ...current } = result.review;
      const { deadlineAt: _retained, ...retained } = entry.review;
      if (
        !isDeepStrictEqual(current, retained) ||
        !isDeepStrictEqual(result.rule, entry.rule) ||
        !isDeepStrictEqual(result.terms, entry.terms) ||
        !isDeepStrictEqual(currentState, entry.state)
      )
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
      for (const entry of active) {
        if (!live(entry, entry.originalSignal)) terminal(entry, stopped(entry.action, "review-expired"));
      }
      const retained = byAction.get(action);
      if (retained) {
        if ("terminal" in retained) return { phase: "final", verdict: retained.terminal };
        if (isTerminal(retained)) return { phase: "final", verdict: retained.verdict! };
        const current = await eligible(retained, signal);
        if (isTerminal(retained)) return { phase: "final", verdict: retained.verdict! };
        if (current.phase === "final") return { phase: "final", verdict: terminal(retained, current.verdict) };
        if (!live(retained, signal) || !isDeepStrictEqual(action, retained.action))
          return { phase: "final", verdict: terminal(retained, stopped(retained.action, "review-expired-or-changed")) };
        if (retained.status === "completed") return { phase: "final", verdict: retained.verdict! };
        return { phase: "final", verdict: stopped(retained.action, "review-in-progress") };
      }
      const retainedAction = freeze(structuredClone(action)); // Before first await.
      let currentState: StrictPermissionState | undefined;
      const result = await recheck(retainedAction, signal, newReviewId(), (state) => {
        currentState = state;
      });
      // Concurrent initial reads of the same object may not create competing reviews.
      if (byAction.has(action)) return { phase: "final", verdict: stopped(retainedAction, "review-in-progress") };
      if (result.phase === "final") return result;
      if (active.size >= maximumPending) return { phase: "final", verdict: stopped(retainedAction, "review-capacity") };
      const handle = Object.freeze({}) as PendingReviewV1;
      const cancel = () => terminal(entry, stopped(entry.action, "review-expired"));
      const entry: RetainedReview = {
        originalAction: action,
        action: retainedAction,
        status: "pending",
        review: freeze(structuredClone(result.review)),
        rule: freeze(structuredClone(result.rule)),
        terms: freeze(structuredClone(result.terms)),
        state: freeze(structuredClone(currentState!)),
        originalSignal: signal,
        cancel,
        dispose: () => {
          pending.delete(handle);
          signal.removeEventListener("abort", cancel);
        },
      };
      byAction.set(action, entry);
      active.add(entry);
      pending.set(handle, entry);
      signal.addEventListener("abort", cancel, { once: true });
      return { phase: "needs-review", pending: handle, review: structuredClone(result.review) };
    },
    async bindReview(handle, request, signal): Promise<BoundReviewV1> {
      const entry = pending.get(handle);
      if (!entry || entry.status !== "pending") throw refuse();
      busy.add(entry);
      entry.status = "binding"; // Claim before awaiting while retaining the capacity reservation.
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
        if ((await eligible(entry, signal)).phase !== "needs-review" || entry.status !== "binding") throw refuse();
        await authorizeProjection(
          structuredClone(exactRequest),
          structuredClone(entry.action),
          AbortSignal.any([signal, entry.originalSignal]),
        );
        if (
          (await eligible(entry, signal)).phase !== "needs-review" ||
          !live(entry, signal) ||
          entry.status !== "binding"
        )
          throw refuse();
        const registered = Object.freeze({}) as BoundReviewV1;
        entry.dispose();
        entry.request = freeze(exactRequest);
        entry.status = "bound";
        entry.dispose = () => {
          bound.delete(registered);
          entry.originalSignal.removeEventListener("abort", entry.cancel);
        };
        bound.set(registered, entry);
        entry.originalSignal.addEventListener("abort", entry.cancel, { once: true });
        return registered;
      } catch {
        terminal(entry, stopped(entry.action, "review-registration-failed"));
        throw refuse();
      } finally {
        busy.delete(entry);
        if (isTerminal(entry)) active.delete(entry);
      }
    },
    async completeReview(handle, result, signal): Promise<PolicyVerdictV1> {
      const entry = bound.get(handle);
      if (!entry || !entry.request || entry.status !== "bound") throw refuse();
      bound.delete(handle); // Completion cannot race/replay, including malformed/stale failures.
      entry.status = "completing";
      busy.add(entry);
      try {
        let exactResult: JudgeResultV1;
        try {
          exactResult = structuredClone(result);
        } catch {
          return terminal(entry, stopped(entry.action, "invalid-judge-result"));
        }
        const current = await eligible(entry, signal);
        if (isTerminal(entry)) return entry.verdict!;
        if (current.phase === "final") return terminal(entry, current.verdict);
        if (!live(entry, signal)) return terminal(entry, stopped(entry.action, "review-expired"));
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
          return terminal(entry, stopped(entry.action, "invalid-judge-result"));
        // Terms compose the rule's delegation with the profile's judge floor; an unsure or unreachable judge under
        // a floor asks the person.
        const terms = current.terms;
        let verdict: PolicyVerdictV1;
        if (exactResult.execution === "unavailable") {
          if (terms.onUnavailable === "allow") verdict = ruleAllow(entry.action, current.rule);
          else if (terms.onUnavailable === "require-human")
            verdict = { ...strictDecisionBinding(entry.action), outcome: "require-human", reason: "judge-unavailable" };
          else verdict = stopped(entry.action, "judge-unavailable");
        } else if (exactResult.result === "fit") verdict = ruleAllow(entry.action, current.rule);
        else
          verdict = {
            ...strictDecisionBinding(entry.action),
            outcome: exactResult.result === "not-fit" ? terms.onNotFit : terms.onIndeterminate,
            reason: exactResult.result === "not-fit" ? "judge-not-fit" : "judge-indeterminate",
          };
        let resultRef: string;
        try {
          resultRef = await recordReview(
            structuredClone(entry.action),
            structuredClone(request),
            structuredClone(exactResult),
            structuredClone(verdict),
            AbortSignal.any([signal, entry.originalSignal]),
          );
          if (typeof resultRef !== "string" || !resultRef)
            return terminal(entry, stopped(entry.action, "review-record-unavailable"));
        } catch {
          return terminal(entry, stopped(entry.action, "review-record-unavailable"));
        }
        // Recording is a separate await, never an authority reservation or dispatch fence.
        const afterRecord = await eligible(entry, signal);
        if (afterRecord.phase === "final") return terminal(entry, afterRecord.verdict);
        if (!live(entry, signal)) return terminal(entry, stopped(entry.action, "review-expired"));
        // The reference records actual unavailable/evaluated status; it never implies a successful review.
        if (isTerminal(entry)) return entry.verdict!;
        entry.normalizedResult = freeze(exactResult);
        entry.recordRef = resultRef;
        entry.verdict = freeze(verdict.outcome === "allow" ? { ...verdict, judgeResultRef: resultRef } : verdict);
        entry.status = "completed";
        return entry.verdict;
      } finally {
        busy.delete(entry);
        if (isTerminal(entry)) active.delete(entry);
      }
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
