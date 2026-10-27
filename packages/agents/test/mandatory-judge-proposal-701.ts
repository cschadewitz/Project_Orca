/**
 * #701 PROPOSAL MODEL, test-only. Not production policy and not exported from any package.
 * Compares three candidate contracts for where a required execution judge comes from, layered
 * on top of the unchanged production evaluateStrictPermission so every mandatory denial, human
 * ceiling, coverage/fact floor and first-match rule selection stays the production decision.
 * See docs/preparation/review-judge-701/mandatory-judge-decision.md.
 */
import { isDeepStrictEqual } from "node:util";
import {
  evaluateStrictPermission,
  ruleAllow,
  strictDecisionBinding,
  type ActionEvidenceV1,
  type PolicyVerdictV1,
  type StrictPermissionRule,
  type StrictPermissionState,
} from "@orca/core";

export type ProposedModel = "rule-scoped" | "global-only" | "layered";
export type JudgeMode = "disabled" | "advisory" | "required";
export type JudgeOutcome = "fit" | "not-fit" | "indeterminate" | "unavailable";

/** PROPOSED profile-level execution judge floor. No such field exists on StrictActionProfile today. */
export interface ProposedJudgeFloor {
  readonly mode: JudgeMode;
  readonly judgeConfigRef: string;
  readonly projectionPolicyRevision: string;
  readonly destinationPolicyRef: string;
  readonly maximumDurationMs: number;
  readonly onNotFit: "deny" | "require-human";
  readonly onIndeterminate: "indeterminate" | "require-human";
  readonly allowWhenUnavailable: boolean;
}

export interface ProposedReview {
  readonly ruleId: string;
  readonly ruleRevision: string;
  readonly requirement: "advisory" | "required";
  readonly sources: readonly ("rule" | "profile")[];
  readonly judgeConfigRef: string;
  readonly projectionPolicyRevision: string;
  readonly destinationPolicyRef: string;
  readonly maximumDurationMs: number;
  readonly onNotFit: "deny" | "require-human";
  readonly onIndeterminate: "indeterminate" | "require-human";
  readonly allowWhenUnavailable: boolean;
}

export type ProposedPreflight =
  | { readonly phase: "final"; readonly verdict: PolicyVerdictV1 }
  | { readonly phase: "needs-review"; readonly review: ProposedReview };

type Requirement = Omit<ProposedReview, "ruleId" | "ruleRevision" | "sources"> & { source: "rule" | "profile" };

const RANK = { advisory: 1, required: 2 } as const;

function fromRule(rule: StrictPermissionRule): Requirement | undefined {
  const d = rule.delegation;
  if (!d) return undefined;
  const { requirement, judgeConfigRef, projectionPolicyRevision, destinationPolicyRef, maximumDurationMs } = d;
  return {
    source: "rule",
    requirement,
    judgeConfigRef,
    projectionPolicyRevision,
    destinationPolicyRef,
    maximumDurationMs,
    onNotFit: d.onNotFit,
    onIndeterminate: d.onIndeterminate,
    // Production honours the fallback only for advisory delegation.
    allowWhenUnavailable: requirement === "advisory" && d.allowWhenUnavailable,
  };
}

function fromFloor(floor: ProposedJudgeFloor | undefined): Requirement | undefined {
  if (!floor || floor.mode === "disabled") return undefined;
  const { mode, ...rest } = floor;
  return {
    ...rest,
    source: "profile",
    requirement: mode,
    allowWhenUnavailable: mode === "advisory" && floor.allowWhenUnavailable,
  };
}

/** Strengthen-only composition. Different judges/destinations are refused, never merged or substituted. */
function compose(rule: StrictPermissionRule, parts: (Requirement | undefined)[]): ProposedReview | "conflict" {
  const present = parts.filter((part): part is Requirement => part !== undefined);
  const [first] = present;
  if (!first) throw new Error("compose needs a requirement");
  const same = (key: "judgeConfigRef" | "projectionPolicyRevision" | "destinationPolicyRef") =>
    present.every((part) => part[key] === first[key]);
  if (!same("judgeConfigRef") || !same("projectionPolicyRevision") || !same("destinationPolicyRef")) return "conflict";
  return {
    ruleId: rule.ruleId,
    ruleRevision: rule.ruleRevision,
    requirement: present.some((part) => RANK[part.requirement] === RANK.required) ? "required" : "advisory",
    sources: present.map((part) => part.source),
    judgeConfigRef: first.judgeConfigRef,
    projectionPolicyRevision: first.projectionPolicyRevision,
    destinationPolicyRef: first.destinationPolicyRef,
    maximumDurationMs: Math.min(...present.map((part) => part.maximumDurationMs)),
    onNotFit: present.some((part) => part.onNotFit === "deny") ? "deny" : "require-human",
    onIndeterminate: present.some((part) => part.onIndeterminate === "indeterminate")
      ? "indeterminate"
      : "require-human",
    allowWhenUnavailable: present.every((part) => part.allowWhenUnavailable),
  };
}

/** Production first; a proposal can only add review to a production rule allow, never create one. */
export function proposeStrictPermission(
  model: ProposedModel,
  action: ActionEvidenceV1,
  state: StrictPermissionState,
  floor: ProposedJudgeFloor | undefined,
  now: number,
  reviewId: string,
): ProposedPreflight {
  const base = evaluateStrictPermission(action, state, now, reviewId);
  let rule: StrictPermissionRule;
  if (base.phase === "needs-review") rule = base.rule;
  else if (base.verdict.outcome !== "allow" || base.verdict.authorizedBy.kind !== "rule") return base;
  else {
    const { ruleId, ruleRevision } = base.verdict.authorizedBy;
    const found =
      state.rules.state === "complete" &&
      state.rules.value.find((candidate) => candidate.ruleId === ruleId && candidate.ruleRevision === ruleRevision);
    if (!found) throw new Error("production allow must name a current rule");
    rule = found;
  }
  const parts =
    model === "rule-scoped"
      ? [fromRule(rule)]
      : model === "global-only"
        ? [fromFloor(floor)]
        : [fromRule(rule), fromFloor(floor)];
  if (parts.every((part) => part === undefined)) return { phase: "final", verdict: ruleAllow(action, rule) };
  const review = compose(rule, parts);
  if (review === "conflict")
    return {
      phase: "final",
      verdict: { ...strictDecisionBinding(action), outcome: "indeterminate", reason: "judge-requirement-conflict" },
    };
  return { phase: "needs-review", review };
}

/**
 * Completion against a fresh re-evaluation. Any change to the retained requirement (rule order,
 * revocation, floor/profile change) stops the review; it never completes under the new terms.
 */
export function completeProposed(
  action: ActionEvidenceV1,
  retained: ProposedReview,
  current: ProposedPreflight,
  judge: JudgeOutcome,
): PolicyVerdictV1 {
  const stop = (reason: string): PolicyVerdictV1 => ({
    ...strictDecisionBinding(action),
    outcome: "indeterminate",
    reason,
  });
  if (current.phase === "final")
    return current.verdict.outcome === "allow" ? stop("review-requirement-changed") : current.verdict;
  if (!isDeepStrictEqual(current.review, retained)) return stop("review-requirement-changed");
  const allow: PolicyVerdictV1 = {
    ...strictDecisionBinding(action),
    outcome: "allow",
    authorizedBy: { kind: "rule", ruleId: retained.ruleId, ruleRevision: retained.ruleRevision },
    judgeResultRef: "test:proposal-judge-record",
  };
  if (judge === "unavailable") return retained.allowWhenUnavailable ? allow : stop("judge-unavailable");
  if (judge === "fit") return allow;
  return judge === "not-fit"
    ? { ...strictDecisionBinding(action), outcome: retained.onNotFit, reason: "judge-not-fit" }
    : { ...strictDecisionBinding(action), outcome: retained.onIndeterminate, reason: "judge-indeterminate" };
}

/** One-shot outcome for a stable state: evaluate, consult the judge only if review is needed, complete. */
export function proposedOutcome(
  model: ProposedModel,
  action: ActionEvidenceV1,
  state: StrictPermissionState,
  floor: ProposedJudgeFloor | undefined,
  judge: JudgeOutcome,
  now: number,
): { verdict: PolicyVerdictV1; judged: boolean } {
  const first = proposeStrictPermission(model, action, state, floor, now, "proposal-review");
  if (first.phase === "final") return { verdict: first.verdict, judged: false };
  const current = proposeStrictPermission(model, action, state, floor, now, "proposal-review");
  return { verdict: completeProposed(action, first.review, current, judge), judged: true };
}
