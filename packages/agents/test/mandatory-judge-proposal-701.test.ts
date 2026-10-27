/**
 * #701 PROPOSAL DECISION MATRIX, offline and test-only. These tests describe candidate contracts
 * from docs/preparation/review-judge-701/mandatory-judge-decision.md; they do not change, enable
 * or assert production policy. The one production anchor is that the "rule-scoped" model equals
 * today's strict policy port for every row, so the comparison starts from real behaviour.
 */
import { describe, expect, it } from "vitest";
import type { JudgeResultV1, StrictPermissionRule, StrictPermissionState, StrictRuleDelegation } from "@orca/core";
import { createStrictPolicyPort } from "../src/index.js";
import {
  actionFixture,
  complete,
  NOW,
  registerReview,
  ruleFixture,
  stateFixture,
} from "./strict-permission-fixtures.js";
import {
  completeProposed,
  proposedOutcome,
  proposeStrictPermission,
  type JudgeOutcome,
  type ProposedJudgeFloor,
  type ProposedModel,
} from "./mandatory-judge-proposal-701.js";

type RuleSetting = "none" | "advisory-fallback" | "advisory" | "required";
type FloorSetting = "absent" | "disabled" | "advisory-fallback" | "advisory" | "required";

const RULES: RuleSetting[] = ["none", "advisory-fallback", "advisory", "required"];
const FLOORS: FloorSetting[] = ["absent", "disabled", "advisory-fallback", "advisory", "required"];
const JUDGE: JudgeOutcome[] = ["fit", "not-fit", "indeterminate", "unavailable"];
const MODELS: ProposedModel[] = ["rule-scoped", "global-only", "layered"];

const shared = {
  judgeConfigRef: "judge-1",
  projectionPolicyRevision: "projection-1",
  destinationPolicyRef: "destination-1",
  maximumDurationMs: 4000,
  onNotFit: "deny",
  onIndeterminate: "require-human",
} as const;
const delegation = (setting: RuleSetting): StrictRuleDelegation | undefined =>
  setting === "none"
    ? undefined
    : {
        ...shared,
        requirement: setting === "required" ? "required" : "advisory",
        allowWhenUnavailable: setting === "advisory-fallback",
      };
const floorOf = (setting: FloorSetting, patch: Partial<ProposedJudgeFloor> = {}): ProposedJudgeFloor | undefined =>
  setting === "absent"
    ? undefined
    : {
        ...shared,
        mode: setting === "advisory-fallback" ? "advisory" : setting,
        allowWhenUnavailable: setting === "advisory-fallback",
        ...patch,
      };
const ruleWith = (setting: RuleSetting, patch: Partial<StrictPermissionRule> = {}): StrictPermissionRule => {
  const d = delegation(setting);
  return { ...ruleFixture(), ...(d ? { delegation: d } : {}), ...patch };
};
const withRules = (rules: StrictPermissionRule[]): StrictPermissionState => ({
  ...stateFixture(),
  rules: complete(rules),
});
const exactGrant = () => ruleWith("none", { ruleId: "grant-new", ruleRevision: "grant-1" });
const broad = (setting: RuleSetting) => {
  const base = ruleWith(setting, { ruleId: "rule-broad", ruleRevision: "revision-broad" });
  return {
    ...base,
    match: {
      ...base.match,
      resources: [...base.match.resources, { operation: "read", physicalTargetRef: "test:other" }],
    },
  };
};
const outcome = (model: ProposedModel, state: StrictPermissionState, floor: FloorSetting, judge: JudgeOutcome) =>
  proposedOutcome(model, actionFixture(), state, floorOf(floor), judge, NOW);

/** Drive the real inactive production port to completion for one row. */
async function production(state: StrictPermissionState, judge: JudgeOutcome) {
  const port = createStrictPolicyPort({
    source: { readCurrent: async () => state },
    authorizeProjection: async () => {},
    recordReview: async () => "test:review-result",
    now: () => NOW,
    newReviewId: () => "review-1",
  });
  const evaluation = await port.evaluate(actionFixture(), new AbortController().signal);
  if (evaluation.phase === "final") return { outcome: evaluation.verdict.outcome, judged: false };
  const { bound, result, signal } = await registerReview(port);
  const patch: Partial<JudgeResultV1> =
    judge === "unavailable" ? { execution: "unavailable", result: "indeterminate" } : { result: judge };
  return {
    outcome: (await port.completeReview(bound, { ...result, ...patch } as JudgeResultV1, signal)).outcome,
    judged: true,
  };
}

const rows = RULES.flatMap((rule) => FLOORS.flatMap((floor) => JUDGE.map((judge) => ({ rule, floor, judge }))));

describe("PROPOSAL #701 anchor: the rule-scoped model is today's production behaviour", () => {
  it.each(RULES.flatMap((rule) => JUDGE.map((judge) => [rule, judge] as const)))(
    "rule %s, judge %s",
    async (rule, judge) => {
      const state = withRules([ruleWith(rule)]);
      const actual = await production(state, judge);
      for (const floor of FLOORS) {
        const modelled = outcome("rule-scoped", state, floor, judge);
        expect({ outcome: modelled.verdict.outcome, judged: modelled.judged }).toEqual(actual);
      }
    },
  );
});

describe("PROPOSAL #701 invariants over every rule x floor x judge row", () => {
  it.each(rows)("$rule / floor $floor / judge $judge", ({ rule, floor, judge }) => {
    const state = withRules([ruleWith(rule)]);
    const current = outcome("rule-scoped", state, floor, judge).verdict;
    const layered = outcome("layered", state, floor, judge);
    // A disabled or absent floor is exactly today's contract (compatibility default).
    if (floor === "absent" || floor === "disabled") expect(layered.verdict).toEqual(current);
    // Layered never allows where today's rule-scoped policy would not.
    if (layered.verdict.outcome === "allow") expect(current.outcome).toBe("allow");
    // A required source anywhere means only an actual fit allows; unavailability holds the lane.
    if (rule === "required" || floor === "required") {
      expect(layered.verdict.outcome === "allow").toBe(judge === "fit");
      if (judge === "unavailable")
        expect(layered.verdict).toMatchObject({ outcome: "indeterminate", reason: "judge-unavailable" });
    }
    // Judge output only ever attributes to the production-selected rule; it is never authority.
    if (layered.verdict.outcome === "allow")
      expect(layered.verdict.authorizedBy).toEqual({ kind: "rule", ruleId: "rule-1", ruleRevision: "revision-1" });
  });

  it("global-only silently drops an existing required rule delegation (migration hazard)", () => {
    const state = withRules([ruleWith("required")]);
    expect(outcome("global-only", state, "absent", "unavailable")).toMatchObject({
      verdict: { outcome: "allow" },
      judged: false,
    });
    expect(outcome("rule-scoped", state, "absent", "unavailable").verdict.outcome).toBe("indeterminate");
    expect(outcome("layered", state, "absent", "unavailable").verdict.outcome).toBe("indeterminate");
  });
});

describe("PROPOSAL #701 mandatory limits stay production decisions; no judge or floor reaches them", () => {
  const finals: [string, StrictPermissionState][] = [
    ["mandatory human", { ...withRules([ruleWith("required")]), mandatoryHuman: complete(true) }],
    ["current authority denied", { ...withRules([ruleWith("required")]), currentAuthority: complete(false) }],
    ["captured ceiling denied", { ...withRules([ruleWith("none")]), capturedCeiling: complete(false) }],
    ["no matching rule", withRules([])],
    ["deny rule", withRules([ruleWith("none", { decision: "deny" })])],
    ["revoked first match", withRules([{ ...broad("none"), status: "revoked" }, exactGrant()])],
    ["policy unavailable", { ...stateFixture(), rules: { state: "unknown", reason: "unreadable" } }],
  ];
  it.each(finals.flatMap(([name, state]) => MODELS.map((model) => [name, model, state] as const)))(
    "%s under %s",
    (_name, model, state) => {
      for (const floor of FLOORS)
        for (const judge of JUDGE) {
          const result = outcome(model, state, floor, judge);
          expect(result.judged).toBe(false);
          expect(result.verdict.outcome).not.toBe("allow");
        }
    },
  );
});

describe("PROPOSAL #701 new scoped-grant precedence and explicit human approval", () => {
  it("a newly saved grant appended after an older required delegation stays judged in every model", () => {
    const state = withRules([broad("required"), exactGrant()]);
    for (const model of MODELS) {
      const result = outcome(model, state, model === "global-only" ? "required" : "absent", "unavailable");
      expect(result).toMatchObject({ judged: true, verdict: { outcome: "indeterminate" } });
    }
  });

  it("a profile floor closes the shadowing gap of an earlier undelegated grant; rule-scoped does not", () => {
    const state = withRules([exactGrant(), broad("required")]);
    expect(outcome("rule-scoped", state, "required", "unavailable")).toMatchObject({
      judged: false,
      verdict: { outcome: "allow", authorizedBy: { ruleId: "grant-new" } },
    });
    expect(outcome("layered", state, "required", "unavailable")).toMatchObject({
      judged: true,
      verdict: { outcome: "indeterminate", reason: "judge-unavailable" },
    });
    // The judged allow is still attributed to the grant the human saved, not to the judge.
    expect(outcome("layered", state, "required", "fit").verdict).toMatchObject({
      outcome: "allow",
      authorizedBy: { kind: "rule", ruleId: "grant-new" },
    });
  });

  it("an explicit per-invocation human decision is never routed through the floor", () => {
    const state = { ...withRules([ruleWith("none")]), mandatoryHuman: complete(true) };
    const pre = proposeStrictPermission("layered", actionFixture(), state, floorOf("required"), NOW, "r");
    expect(pre).toMatchObject({ phase: "final", verdict: { outcome: "require-human" } });
  });
});

describe("PROPOSAL #701 layered composition details", () => {
  it("strengthens only: an advisory-with-fallback rule cannot weaken a required floor", () => {
    const pre = proposeStrictPermission(
      "layered",
      actionFixture(),
      withRules([ruleWith("advisory-fallback")]),
      floorOf("required"),
      NOW,
      "r",
    );
    expect(pre).toMatchObject({
      phase: "needs-review",
      review: { requirement: "required", sources: ["rule", "profile"], allowWhenUnavailable: false },
    });
  });

  it("takes the stricter failure handling and the shorter deadline", () => {
    const pre = proposeStrictPermission(
      "layered",
      actionFixture(),
      withRules([ruleWith("advisory")]),
      floorOf("advisory", { onNotFit: "require-human", onIndeterminate: "indeterminate", maximumDurationMs: 1000 }),
      NOW,
      "r",
    );
    expect(pre).toMatchObject({
      review: { onNotFit: "deny", onIndeterminate: "indeterminate", maximumDurationMs: 1000 },
    });
  });

  it("refuses a different floor judge or destination instead of substituting one", () => {
    expect(outcome("layered", withRules([ruleWith("required")]), "required", "fit").verdict.outcome).toBe("allow");
    for (const patch of [{ judgeConfigRef: "judge-2" }, { destinationPolicyRef: "destination-2" }]) {
      const conflicting = proposedOutcome(
        "layered",
        actionFixture(),
        withRules([ruleWith("required")]),
        floorOf("required", patch),
        "fit",
        NOW,
      );
      expect(conflicting).toMatchObject({
        judged: false,
        verdict: { outcome: "indeterminate", reason: "judge-requirement-conflict" },
      });
    }
  });

  it("a floor lowered, a rule revoked or a grant inserted mid-review stops the review", () => {
    const action = actionFixture();
    const state = withRules([ruleWith("none")]);
    const pre = proposeStrictPermission("layered", action, state, floorOf("required"), NOW, "r");
    if (pre.phase !== "needs-review") throw new Error("expected review");
    const lowered = proposeStrictPermission("layered", action, state, floorOf("disabled"), NOW, "r");
    expect(completeProposed(action, pre.review, lowered, "fit")).toMatchObject({
      outcome: "indeterminate",
      reason: "review-requirement-changed",
    });
    const revoked = withRules([ruleWith("none", { status: "revoked" })]);
    const afterRevoke = proposeStrictPermission("layered", action, revoked, floorOf("required"), NOW, "r");
    expect(completeProposed(action, pre.review, afterRevoke, "fit")).toMatchObject({
      outcome: "deny",
      reason: "rule-revoked",
    });
    const inserted = withRules([exactGrant(), ruleWith("none")]);
    const afterInsert = proposeStrictPermission("layered", action, inserted, floorOf("required"), NOW, "r");
    expect(completeProposed(action, pre.review, afterInsert, "fit")).toMatchObject({
      outcome: "indeterminate",
      reason: "review-requirement-changed",
    });
  });
});
