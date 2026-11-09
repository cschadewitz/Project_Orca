/**
 * #701 CHARACTERIZATION of the current inactive strict policy: where a required judge comes from.
 * Pins today's first-match rule delegation so the open contract question (rule-scoped versus a
 * global/profile mandatory judge, and new-grant precedence) cannot be decided by accident.
 * Records behaviour only; it changes no production policy. Proposal tests live separately in
 * mandatory-judge-proposal-701.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateStrictPermission,
  type JudgeResultV1,
  type StrictPermissionRule,
  type StrictPermissionState,
  type StrictRuleDelegation,
} from "@orca/core";
import { createStrictPolicyPort, type StrictPolicyOptions } from "../src/index.js";
import {
  actionFixture,
  complete,
  NOW,
  registerReview,
  ruleFixture,
  stateFixture,
} from "./strict-permission-fixtures.js";

const delegation = (requirement: "required" | "advisory", allowWhenUnavailable = false): StrictRuleDelegation => ({
  requirement,
  projectionPolicyRevision: "projection-1",
  destinationPolicyRef: "destination-1",
  judgeConfigRef: "judge-1",
  maximumDurationMs: 4000,
  onNotFit: "deny",
  onIndeterminate: "require-human",
  allowWhenUnavailable,
});

/** An older rule that also covers the action's resource, so both it and an exact grant match. */
const broadRule = (patch: Partial<ReturnType<typeof ruleFixture>> = {}): StrictPermissionRule => {
  const base = ruleFixture();
  return {
    ...base,
    ruleId: "rule-broad",
    ruleRevision: "revision-broad",
    match: {
      ...base.match,
      resources: [...base.match.resources, { operation: "read", physicalTargetRef: "test:other" }],
    },
    ...patch,
  };
};
/** Mirrors a Save grant: exact action scope and never a delegation (owner rejects one). */
const exactGrant = (): StrictPermissionRule => ({ ...ruleFixture(), ruleId: "grant-new", ruleRevision: "grant-1" });
const withRules = (rules: StrictPermissionRule[]): StrictPermissionState => ({
  ...stateFixture(),
  rules: complete(rules),
});
const evaluate = (state: StrictPermissionState) => evaluateStrictPermission(actionFixture(), state, NOW, "review");

describe("CURRENT #701: required review is selected by the first matching rule only", () => {
  it("an earlier required delegation governs even when a later exact grant also matches", () => {
    // Typed Save appends new records, so a new grant normally sits after older rules.
    const result = evaluate(withRules([broadRule({ delegation: delegation("required") }), exactGrant()]));
    expect(result).toMatchObject({
      phase: "needs-review",
      review: { requirement: "required", delegation: { ruleId: "rule-broad", ruleRevision: "revision-broad" } },
    });
  });

  it("an earlier undelegated allow shadows a later rule's required delegation", () => {
    const result = evaluate(withRules([exactGrant(), broadRule({ delegation: delegation("required") })]));
    expect(result).toMatchObject({
      phase: "final",
      verdict: { outcome: "allow", authorizedBy: { kind: "rule", ruleId: "grant-new" } },
    });
    expect(result.phase === "final" && "judgeResultRef" in result.verdict).toBe(false);
  });

  it("an earlier revoked or deny rule shadows a later exact grant", () => {
    expect(evaluate(withRules([broadRule({ status: "revoked" }), exactGrant()]))).toMatchObject({
      verdict: { outcome: "deny", reason: "rule-revoked" },
    });
    expect(evaluate(withRules([broadRule({ decision: "deny" }), exactGrant()]))).toMatchObject({
      verdict: { outcome: "deny", reason: "rule-deny" },
    });
  });

  it("the profile carries coverage and fact floors only; no profile field requires a judge", () => {
    const state = stateFixture();
    if (state.profile.state !== "complete") throw new Error("fixture");
    expect(Object.keys(state.profile.value).sort()).toEqual(["facts", "minimumCoverage", "profileRef"]);
    // Any matching undelegated allow is an automatic rule allow under that profile.
    expect(evaluate(state)).toMatchObject({ phase: "final", verdict: { outcome: "allow" } });
  });

  it("mandatory denials and the human ceiling are decided before any delegation is consulted", () => {
    const delegated = withRules([broadRule({ delegation: delegation("required") })]);
    expect(evaluate({ ...delegated, mandatoryHuman: complete(true) })).toMatchObject({
      phase: "final",
      verdict: { outcome: "require-human", reason: "mandatory-human" },
    });
    expect(evaluate({ ...delegated, currentAuthority: complete(false) })).toMatchObject({
      phase: "final",
      verdict: { outcome: "deny", reason: "current-authority" },
    });
    // No matching rule: a human decides; a judge is never asked to fill the gap.
    expect(evaluate(withRules([]))).toMatchObject({
      phase: "final",
      verdict: { outcome: "require-human", reason: "no-approved-match" },
    });
  });
});

function harness(initial: StrictPermissionState) {
  let state = initial;
  const options: StrictPolicyOptions = {
    source: { readCurrent: async () => state },
    authorizeProjection: async () => {},
    recordReview: async () => "test:review-result",
    now: () => NOW,
    newReviewId: () => "review-1",
  };
  return { port: createStrictPolicyPort(options), setState: (next: StrictPermissionState) => (state = next) };
}

describe("CURRENT #701: execution judgment outcomes under the matched rule's delegation", () => {
  const verdictFor = async (rule: StrictRuleDelegation, patch: Partial<JudgeResultV1>) => {
    const { port } = harness(withRules([broadRule({ delegation: rule })]));
    const { bound, result, signal } = await registerReview(port);
    return port.completeReview(bound, { ...result, ...patch } as JudgeResultV1, signal);
  };
  const unavailable = { execution: "unavailable", result: "indeterminate" } as const;

  it.each([
    ["required", false, {}, "allow"],
    ["required", false, { result: "not-fit" }, "deny"],
    ["required", false, { result: "indeterminate" }, "require-human"],
    ["required", false, unavailable, "indeterminate"],
    ["required", true, unavailable, "indeterminate"],
    ["advisory", false, unavailable, "indeterminate"],
    ["advisory", true, unavailable, "allow"],
    ["advisory", true, { result: "not-fit" }, "deny"],
  ] as const)("%s (allowWhenUnavailable=%s) with %j -> %s", async (requirement, fallback, patch, outcome) => {
    const verdict = await verdictFor(delegation(requirement, fallback), patch);
    expect(verdict.outcome).toBe(outcome);
    if (verdict.outcome === "allow") expect(verdict.authorizedBy).toMatchObject({ kind: "rule", ruleId: "rule-broad" });
  });

  it("a new grant inserted ahead during a pending review stops it instead of allowing unreviewed", async () => {
    const { port, setState } = harness(withRules([broadRule({ delegation: delegation("required") })]));
    const { bound, result, signal } = await registerReview(port);
    setState(withRules([exactGrant(), broadRule({ delegation: delegation("required") })]));
    expect(await port.completeReview(bound, result, signal)).toMatchObject({
      outcome: "indeterminate",
      reason: "review-delegation-changed",
    });
  });

  it("even a weakened profile during a pending review invalidates the retained review", async () => {
    const initial = withRules([broadRule({ delegation: delegation("required") })]);
    if (initial.profile.state !== "complete") throw new Error("fixture");
    const { port, setState } = harness(initial);
    const { bound, result, signal } = await registerReview(port);
    const facts = { ...initial.profile.value.facts, effectiveCwd: "complete-or-absent" as const };
    setState({ ...initial, profile: complete({ ...initial.profile.value, facts }) });
    expect(await port.completeReview(bound, result, signal)).toMatchObject({
      outcome: "indeterminate",
      reason: "review-eligibility-changed",
    });
  });
});
