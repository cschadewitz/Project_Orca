/** Pure opt-in strict policy phases. Legacy policy ordering/defaults and all production wiring stay elsewhere. */
import type {
  ActionEvidenceV1,
  ActionResourceV1,
  AuthorityStampV1,
  DecisionBindingV1,
  PolicyVerdictV1,
  ReviewEligibilityV1,
} from "./model/tool-execution-guards.js";
import type {
  StrictJudgeFloor,
  StrictPermissionRule,
  StrictPermissionState,
  StrictRuleDelegation,
} from "./model/strict-permission.js";

/**
 * How a judge's answer becomes a verdict, composed from the matched rule's delegation and the profile's judge floor
 * (#701, option C). Strengthen-only: each field is the stricter of its sources.
 */
export interface StrictReviewTerms {
  /** What asked for this review: the matched rule's delegation, the profile's judge floor, or both. */
  readonly requiredBy: readonly ("rule" | "profile")[];
  readonly onNotFit: "deny" | "require-human";
  readonly onIndeterminate: "indeterminate" | "require-human";
  /** A judge that could not be reached: allow only for an advisory rule that says so and no floor. */
  readonly onUnavailable: "allow" | "require-human" | "indeterminate";
}

export type StrictPreflight =
  | { readonly phase: "final"; readonly verdict: PolicyVerdictV1 }
  | {
      readonly phase: "needs-review";
      readonly review: ReviewEligibilityV1;
      readonly rule: StrictPermissionRule;
      readonly terms: StrictReviewTerms;
    };

/** Internal comparison only: an unbounded rule never makes an action or permit
 * unbounded. Unknown/mixed encodings remain unavailable, rather than legacy. */
export function strictRuleExpiry(rule: StrictPermissionRule): number | undefined {
  if (Object.hasOwn(rule, "version")) return rule.version === 2 && rule.expiresAt === null ? Infinity : undefined;
  if (typeof rule.expiresAt !== "string") return undefined;
  const expiry = Date.parse(rule.expiresAt);
  return Number.isFinite(expiry) ? expiry : undefined;
}

const AUTHORITY_KEYS = [
  "capturedGeneration",
  "currentPolicyRevision",
  "authorityRevision",
  "revocationEpoch",
  "leaseEpoch",
] as const;

export function sameAuthority(left: AuthorityStampV1, right: AuthorityStampV1): boolean {
  return AUTHORITY_KEYS.every((key) => left[key] !== "" && left[key] === right[key]);
}

export function strictDecisionBinding(action: ActionEvidenceV1, authority = action.authority): DecisionBindingV1 {
  return {
    version: 1,
    actionBindingRef: action.bindingRef,
    authority: { ...authority },
    coverageId: action.coverage.coverageId,
  };
}

export function sameDecisionBinding(left: DecisionBindingV1, right: DecisionBindingV1): boolean {
  return (
    left.version === 1 &&
    right.version === 1 &&
    left.actionBindingRef === right.actionBindingRef &&
    left.coverageId === right.coverageId &&
    sameAuthority(left.authority, right.authority)
  );
}

export function ruleAllow(
  action: ActionEvidenceV1,
  rule: StrictPermissionRule,
): Extract<PolicyVerdictV1, { outcome: "allow" }> {
  return {
    ...strictDecisionBinding(action),
    outcome: "allow",
    authorizedBy: {
      kind: "rule",
      ruleId: rule.ruleId,
      ruleRevision: rule.ruleRevision,
    },
  };
}

/** Runtime frames may not mix resource kinds or match missing identities to one another. */
function validResource(value: unknown): value is ActionResourceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const resource = value as Record<string, unknown>;
  const keys =
    resource.targetKind === "disposable-memory"
      ? ["operation", "targetKind", "ownerRef", "resourceRef", "resourceRevision"]
      : ["operation", "physicalTargetRef"];
  return (
    Reflect.ownKeys(resource).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(resource, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(resource, key)!, "value") &&
        typeof resource[key] === "string" &&
        resource[key] !== "",
    ) &&
    (!Object.hasOwn(resource, "targetKind") || resource.targetKind === "disposable-memory")
  );
}

function sameResource(left: ActionResourceV1, right: ActionResourceV1): boolean {
  if (left.operation !== right.operation) return false;
  if (left.targetKind === "disposable-memory" && right.targetKind === "disposable-memory")
    return (
      left.ownerRef === right.ownerRef &&
      left.resourceRef === right.resourceRef &&
      left.resourceRevision === right.resourceRevision
    );
  return (
    left.targetKind === undefined &&
    right.targetKind === undefined &&
    left.physicalTargetRef === right.physicalTargetRef
  );
}

function matches(rule: StrictPermissionRule, action: ActionEvidenceV1): boolean {
  const m = rule.match;
  return (
    m.principalRef === action.invocation.principalRef &&
    m.agentId === action.invocation.agentId &&
    m.hostId === action.invocation.hostId &&
    m.runnerId === action.invocation.runnerId &&
    m.operation === action.operation &&
    m.profileRef === action.profileRef &&
    m.coverageId === action.coverage.coverageId &&
    action.effectiveCwd.state === "complete" &&
    m.effectiveCwd === action.effectiveCwd.value &&
    action.workspaceRef.state === "complete" &&
    m.workspaceRef === action.workspaceRef.value &&
    action.resources.state === "complete" &&
    action.resources.value.every((resource) => m.resources.some((allowed) => sameResource(allowed, resource))) &&
    action.environmentAndCredentialRefs.state === "complete" &&
    action.environmentAndCredentialRefs.value.every((ref) => m.environmentAndCredentialRefs.includes(ref))
  );
}

/** No authority, fact or qualification can be supplied by a judge or widened by a saved rule. */
export function evaluateStrictPermission(
  action: ActionEvidenceV1,
  state: StrictPermissionState,
  now: number,
  reviewId: string,
): StrictPreflight {
  const finish = (outcome: "deny" | "require-human" | "indeterminate", reason: string): StrictPreflight => ({
    phase: "final",
    verdict: { ...strictDecisionBinding(action, state.authority), outcome, reason },
  });
  for (const [name, fact] of [
    ["current-authority", state.currentAuthority],
    ["captured-ceiling", state.capturedCeiling],
    ["protected-access", state.protectedAccess],
  ] as const) {
    if (fact.state === "complete" && !fact.value) return finish("deny", name);
  }
  if (
    ![state.currentAuthority, state.capturedCeiling, state.protectedAccess].every((fact) => fact.state === "complete")
  )
    return finish("indeterminate", "authority-unavailable");
  if (!sameAuthority(action.authority, state.authority)) return finish("indeterminate", "stale-authority");
  if (
    action.version !== 1 ||
    !action.actionId ||
    !action.bindingRef ||
    !action.operation ||
    !action.profileRef ||
    Object.values(action.invocation).some((value) => !value)
  )
    return finish("indeterminate", "incomplete-action-identity");
  if (!Number.isFinite(now) || !Number.isFinite(Date.parse(action.expiresAt)) || Date.parse(action.expiresAt) <= now)
    return finish("indeterminate", "action-expired");
  if (state.coverageAndState.state !== "complete" || !state.coverageAndState.value)
    return finish("indeterminate", "coverage-or-state-unavailable");
  if (state.profile.state !== "complete" || state.profile.value.profileRef !== action.profileRef)
    return finish("indeterminate", "required-profile-unavailable");
  if (state.rules.state !== "complete") return finish("indeterminate", "required-policy-unavailable");
  const profile = state.profile.value;
  const coverage = action.coverage;
  if (
    coverage.version !== 1 ||
    coverage.hostId !== action.invocation.hostId ||
    coverage.boundaryId !== action.capturedByBoundaryId ||
    (coverage.level !== "verified-per-execution" && coverage.level !== profile.minimumCoverage) ||
    coverage.negotiatedHook.state !== "complete" ||
    coverage.protectedConfiguration.state !== "complete" ||
    !coverage.negotiatedHook.value ||
    !coverage.protectedConfiguration.value ||
    [
      coverage.coverageId,
      coverage.boundaryId,
      coverage.provider,
      coverage.providerVersion,
      coverage.adapterVersion,
      coverage.tool,
      coverage.toolSchemaVersion,
      coverage.hostId,
      coverage.platform,
    ].some((value) => value === "") ||
    coverage.evidence.sourceRefs.length === 0 ||
    (coverage.level === "verified-per-execution" &&
      (coverage.evidence.installedRefs.length === 0 || !coverage.evidence.independentlyObservedEffects))
  )
    return finish("indeterminate", "insufficient-coverage");
  for (const key of Object.keys(profile.facts) as (keyof typeof profile.facts)[]) {
    const fact = action[key];
    if (fact.state !== "complete" && !(fact.state === "absent" && profile.facts[key] === "complete-or-absent"))
      return finish("indeterminate", `required-fact:${key}`);
  }
  if (
    action.resources.state === "complete" &&
    (!Array.isArray(action.resources.value) || !action.resources.value.every(validResource))
  )
    return finish("indeterminate", "invalid-resource");
  if (
    !state.rules.value.every((rule) => Array.isArray(rule.match.resources) && rule.match.resources.every(validResource))
  )
    return finish("indeterminate", "invalid-rule-resource");
  const rule = state.rules.value.find((candidate) => matches(candidate, action));
  if (!rule) return finish("require-human", "no-approved-match");
  if (rule.status === "revoked") return finish("deny", "rule-revoked");
  const ruleExpiry = strictRuleExpiry(rule);
  if (
    rule.status !== "approved" ||
    !rule.ruleId ||
    !rule.ruleRevision ||
    !Number.isFinite(Date.parse(rule.notBefore)) ||
    ruleExpiry === undefined ||
    Date.parse(rule.notBefore) > now ||
    ruleExpiry <= now
  )
    return finish("indeterminate", "rule-not-current");
  if (rule.decision === "deny") return finish("deny", "rule-deny");
  if (state.mandatoryHuman.state !== "complete") return finish("indeterminate", "human-ceiling-unavailable");
  if (state.mandatoryHuman.value || rule.decision === "require-human")
    return finish("require-human", "mandatory-human");
  if (rule.decision !== "allow") return finish("indeterminate", "invalid-rule-decision");
  const delegation = rule.delegation;
  const floor = profile.judgeFloor;
  if (!delegation && floor === undefined) return { phase: "final", verdict: ruleAllow(action, rule) };
  if (!reviewId) return finish("indeterminate", delegation ? "invalid-delegation" : "invalid-judge-floor");
  if (delegation && !validDelegation(delegation)) return finish("indeterminate", "invalid-delegation");
  if (floor !== undefined && !validFloor(floor)) return finish("indeterminate", "invalid-judge-floor");
  const sources = [delegation, floor].filter((source) => source !== undefined);
  const [first] = sources as [StrictRuleDelegation | StrictJudgeFloor];
  // Two sources naming different judges, projections or destinations are refused, never merged or substituted.
  if (
    !sources.every(
      (source) =>
        source.judgeConfigRef === first.judgeConfigRef &&
        source.projectionPolicyRevision === first.projectionPolicyRevision &&
        source.destinationPolicyRef === first.destinationPolicyRef,
    )
  )
    return finish("indeterminate", "judge-requirement-conflict");
  const terms: StrictReviewTerms = {
    requiredBy: [...(delegation ? (["rule"] as const) : []), ...(floor ? (["profile"] as const) : [])],
    onNotFit: delegation?.onNotFit === "deny" || floor?.onNotFit === "deny" ? "deny" : "require-human",
    onIndeterminate: delegation?.onIndeterminate === "indeterminate" ? "indeterminate" : "require-human",
    onUnavailable: !floor
      ? delegation!.requirement === "advisory" && delegation!.allowWhenUnavailable === true
        ? "allow"
        : "indeterminate"
      : delegation && !(delegation.requirement === "advisory" && delegation.allowWhenUnavailable === true)
        ? "indeterminate"
        : "require-human",
  };
  return {
    phase: "needs-review",
    rule,
    terms,
    review: {
      ...strictDecisionBinding(action),
      reviewId,
      delegation: { ruleId: rule.ruleId, ruleRevision: rule.ruleRevision },
      requirement: floor || delegation!.requirement === "required" ? "required" : "advisory",
      projectionPolicyRevision: first.projectionPolicyRevision,
      destinationPolicyRef: first.destinationPolicyRef,
      judgeConfigRef: first.judgeConfigRef,
      deadlineAt: new Date(
        Math.min(Date.parse(action.expiresAt), ruleExpiry, now + Math.min(...sources.map((x) => x.maximumDurationMs))),
      ).toISOString(),
    },
  };
}

function validReviewSource(source: StrictRuleDelegation | StrictJudgeFloor): boolean {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof source.judgeConfigRef === "string" &&
    source.judgeConfigRef !== "" &&
    typeof source.projectionPolicyRevision === "string" &&
    source.projectionPolicyRevision !== "" &&
    typeof source.destinationPolicyRef === "string" &&
    source.destinationPolicyRef !== "" &&
    Number.isFinite(source.maximumDurationMs) &&
    source.maximumDurationMs > 0 &&
    (source.onNotFit === "deny" || source.onNotFit === "require-human")
  );
}

function validDelegation(delegation: StrictRuleDelegation): boolean {
  return (
    validReviewSource(delegation) &&
    (delegation.requirement === "required" || delegation.requirement === "advisory") &&
    (delegation.onIndeterminate === "indeterminate" || delegation.onIndeterminate === "require-human")
  );
}

/** A floor that is present but malformed never means "off": it holds the call instead. */
function validFloor(floor: StrictJudgeFloor): boolean {
  return validReviewSource(floor);
}

/** A strict native response is eligible only for a qualified, bounded, original invocation option. */
export function selectStrictPermissionOption(
  action: ActionEvidenceV1,
  verdict: PolicyVerdictV1,
  now: number,
): string | undefined {
  if (
    verdict.outcome !== "allow" ||
    !sameDecisionBinding(verdict, strictDecisionBinding(action)) ||
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(action.expiresAt)) ||
    Date.parse(action.expiresAt) <= now
  )
    return undefined;
  const ids = action.offeredChoices.map((choice) => choice.optionId);
  if (new Set(ids).size !== ids.length) return undefined;
  return action.offeredChoices.find((choice) => {
    const grant = choice.grantScopeAndLifetime;
    return (
      choice.optionId !== "" &&
      choice.kind === "allow_once" &&
      choice.effect === "this-invocation" &&
      choice.qualificationRef.state === "complete" &&
      choice.qualificationRef.value !== "" &&
      grant.state === "complete" &&
      grant.value.scopeRef === action.invocation.invocationId &&
      grant.value.maximumUses === 1 &&
      grant.value.expiresAt !== null &&
      Number.isFinite(Date.parse(grant.value.expiresAt)) &&
      Date.parse(grant.value.expiresAt) > now &&
      Date.parse(grant.value.expiresAt) <= Date.parse(action.expiresAt)
    );
  })?.optionId;
}
