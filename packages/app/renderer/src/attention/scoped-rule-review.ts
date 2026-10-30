/** Inactive renderer injection seam, not a persisted rule or protocol command schema. */
import type { GuardDecisionView } from "../../../../protocol/src/guard-decision-projection.js";

const scopeFields = [
  "principal",
  "operation",
  "resources",
  "environment",
  "lifetime",
  "limits",
  "authorizer",
  "coverage",
] as const;

/** `stale` means nothing was sent; `refused` is an owner refusal, which can still follow a claimed handle. */
export type ScopedChoiceResult = "confirmed" | "refused" | "stale" | "uncertain";

export interface ScopedRuleReview {
  /** Already disclosure-approved exact text; never derive these from permission titles or model output. */
  readonly scope: Readonly<Record<(typeof scopeFields)[number], string>>;
  /** Existing #726 safe projection, descriptive only. It never grants an action capability. */
  readonly decision: GuardDecisionView;
  readonly reviewUntil: number;
  /** Owner result for required review of this proposed scope, independent of the descriptive decision view. */
  readonly requiredReview: "passed" | "failed" | "unavailable";
  /** Non-authorizing server projection of retained Save prerequisites. A fresh
   * protected standing review is still required after explicit Save choice. */
  readonly saveEligibility?: "eligible" | "unavailable" | undefined;
  /** Describes an owner-held intent. Approval requests fresh checks; this projection is not authority. */
  readonly pendingExecutionIntent?: true | undefined;
  readonly executionWindowMs?: number | undefined;
  /** Owner checks current workspace/input/review/revision and authority before every invocation. */
  readonly isCurrent: () => boolean;
  readonly cancel?: (() => Promise<void>) | undefined;
  /** Separate owner-supplied capabilities. Ordinary answers cannot call a rule writer. */
  readonly allowOnce?: (() => Promise<ScopedChoiceResult>) | undefined;
  readonly deny?: (() => Promise<ScopedChoiceResult>) | undefined;
  /** Saves only the reviewed rule; must not answer or dispatch the pending invocation. */
  readonly createRule?: (() => Promise<ScopedChoiceResult>) | undefined;
}

export interface ScopedRuleReviewPort {
  /** Workspace + connection generation + input identity + review revision; changes invalidate local review. */
  readonly scopeKey: string;
  /** Must validate explicit input, permissions.grant and revision boundaries in the eventual owner adapter. */
  readonly review: () => Promise<ScopedRuleReview | undefined>;
}

/** Copy only the disclosure fields this form owns; never render unknown extension data. */
export function copyScopedReviewScope(scope: ScopedRuleReview["scope"]): ScopedRuleReview["scope"] {
  return Object.fromEntries(
    scopeFields.map((field) => [field, typeof scope[field] === "string" ? scope[field] : ""]),
  ) as ScopedRuleReview["scope"];
}

/** Conservative presentation veto only. Positive authority comes exclusively from owner capabilities. */
function scopedReviewCommonUnavailable(review: ScopedRuleReview, now: number): string | undefined {
  if (!Number.isFinite(review.reviewUntil) || review.reviewUntil <= now) return "This review expired. Review again.";
  try {
    if (!review.isCurrent()) return "This review is stale. Review again.";
  } catch {
    return "Current review authority is unavailable.";
  }
  if (
    Object.values(review.scope).length !== 8 ||
    scopeFields.some((field) => typeof review.scope[field] !== "string" || !review.scope[field].trim())
  )
    return "Exact scope disclosure is unavailable.";
  const view = review.decision;
  if (view.disclosure !== "complete") return "Required disclosure is unavailable.";
  if (view.support === "unsupported") return "This execution path is unsupported.";
  if (view.coverage.tier !== "verified-per-execution") return "Per-execution coverage is unverified.";
  if (
    view.authority === "expired" ||
    view.authority === "revoked" ||
    view.revocation === "revoked" ||
    (view.expiry.state === "bounded" &&
      (!Number.isFinite(Date.parse(view.expiry.at)) || Date.parse(view.expiry.at) <= now))
  )
    return "The reviewed grant expired or was revoked.";
  return undefined;
}

/** A coherent descriptive pair only; never an execution capability or review result. */
export function scopedPendingExecutionWindow(review: ScopedRuleReview): number | undefined {
  const window = review.executionWindowMs;
  return review.pendingExecutionIntent === true &&
    typeof window === "number" &&
    Number.isSafeInteger(window) &&
    window >= 1 &&
    window <= 60_000
    ? window
    : undefined;
}

/** An intent may request fresh execution checks, but cannot override a failed review or common veto. */
export function scopedReviewUnavailable(review: ScopedRuleReview, now: number): string | undefined {
  const common = scopedReviewCommonUnavailable(review, now);
  if (common) return common;
  if (review.requiredReview === "failed") return "Required review is unavailable or did not pass.";
  const window = scopedPendingExecutionWindow(review);
  if ((review.pendingExecutionIntent !== undefined || review.executionWindowMs !== undefined) && window === undefined)
    return "The post-approval execution window is unavailable. Review again.";
  return review.requiredReview === "passed" || window !== undefined
    ? undefined
    : "Required review is unavailable or did not pass.";
}

/** Save has independent persistence prerequisites; this remains a presentation
 * veto and cannot manufacture a standing approval or execution permission. */
export function scopedSaveReviewUnavailable(review: ScopedRuleReview, now: number): string | undefined {
  const common = scopedReviewCommonUnavailable(review, now);
  if (common) return common;
  if (review.requiredReview === "failed" || review.saveEligibility === "unavailable")
    return "Required Save review is unavailable or did not pass.";
  if (review.saveEligibility === "eligible" || review.requiredReview === "passed") return undefined;
  // An older server without the projection retains its conservative legacy gate.
  return "Required Save review is unavailable or did not pass.";
}
