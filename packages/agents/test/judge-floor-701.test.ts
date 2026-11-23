/**
 * #701 option C, the profile judge floor (owner decision 2026-11-23): opt-in per profile, off by default; when on,
 * every automatic rule allow must also pass the judge, and an unsure or unreachable judge asks the person. Driven
 * through the real inactive strict policy port. Nothing here wires the floor into a live permission path.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateStrictPermission,
  type JudgeResultV1,
  type PolicyVerdictV1,
  type StrictJudgeFloor,
  type StrictPermissionRule,
  type StrictPermissionState,
  type StrictRuleDelegation,
} from "@orca/core";
import { createStrictPolicyPort } from "../src/index.js";
import {
  actionFixture,
  complete,
  NOW,
  registerReview,
  ruleFixture,
  stateFixture,
} from "./strict-permission-fixtures.js";

type RuleSetting = "none" | "advisory-fallback" | "advisory" | "required";
type FloorSetting = "off" | "ask" | "deny";
type Judge = "fit" | "not-fit" | "indeterminate" | "unavailable";

const RULES: RuleSetting[] = ["none", "advisory-fallback", "advisory", "required"];
const FLOORS: FloorSetting[] = ["off", "ask", "deny"];
const JUDGES: Judge[] = ["fit", "not-fit", "indeterminate", "unavailable"];

const refs = {
  judgeConfigRef: "judge-1",
  projectionPolicyRevision: "projection-1",
  destinationPolicyRef: "destination-1",
} as const;

const delegationOf = (
  setting: RuleSetting,
  patch: Partial<StrictRuleDelegation> = {},
): StrictRuleDelegation | undefined =>
  setting === "none"
    ? undefined
    : {
        ...refs,
        maximumDurationMs: 4000,
        requirement: setting === "required" ? "required" : "advisory",
        allowWhenUnavailable: setting === "advisory-fallback",
        onNotFit: "require-human",
        onIndeterminate: "require-human",
        ...patch,
      };

const floorOf = (setting: FloorSetting, patch: Partial<StrictJudgeFloor> = {}): StrictJudgeFloor | undefined =>
  setting === "off"
    ? undefined
    : { ...refs, maximumDurationMs: 2000, onNotFit: setting === "deny" ? "deny" : "require-human", ...patch };

function stateWith(
  rules: StrictPermissionRule[],
  floor: StrictJudgeFloor | undefined,
  patch: Partial<StrictPermissionState> = {},
): StrictPermissionState {
  const base = stateFixture();
  if (base.profile.state !== "complete") throw new Error("fixture profile");
  return {
    ...base,
    rules: complete(rules),
    profile: complete({ ...base.profile.value, ...(floor ? { judgeFloor: floor } : {}) }),
    ...patch,
  };
}

const ruleWith = (setting: RuleSetting, patch: Partial<StrictPermissionRule> = {}): StrictPermissionRule => {
  const delegation = delegationOf(setting);
  return { ...ruleFixture(), ...(delegation ? { delegation } : {}), ...patch } as StrictPermissionRule;
};

async function run(state: StrictPermissionState, judge: Judge): Promise<{ verdict: PolicyVerdictV1; judged: boolean }> {
  const port = createStrictPolicyPort({
    source: { readCurrent: async () => state },
    authorizeProjection: async () => {},
    recordReview: async () => "test:review-result",
    now: () => NOW,
    newReviewId: () => "review-1",
  });
  const evaluation = await port.evaluate(actionFixture(), new AbortController().signal);
  if (evaluation.phase === "final") return { verdict: evaluation.verdict, judged: false };
  const { bound, result, signal } = await registerReview(port);
  const patch: Partial<JudgeResultV1> =
    judge === "unavailable" ? { execution: "unavailable", result: "indeterminate" } : { result: judge };
  return { verdict: await port.completeReview(bound, { ...result, ...patch } as JudgeResultV1, signal), judged: true };
}

const rows = RULES.flatMap((rule) => FLOORS.flatMap((floor) => JUDGES.map((judge) => ({ rule, floor, judge }))));

describe("#701 judge floor: every rule x floor x judge row through the real port", () => {
  it.each(rows)("rule $rule / floor $floor / judge $judge", async ({ rule, floor, judge }) => {
    const withFloor = await run(stateWith([ruleWith(rule)], floorOf(floor)), judge);
    const today = await run(stateWith([ruleWith(rule)], undefined), judge);
    if (floor === "off") {
      // Off is exactly today's behaviour.
      expect(withFloor).toEqual(today);
      return;
    }
    // On: every automatic rule allow is judged, and only an actual "fit" still allows.
    expect(withFloor.judged).toBe(true);
    expect(withFloor.verdict.outcome === "allow").toBe(judge === "fit");
    // The floor never allows where today's policy would not.
    if (withFloor.verdict.outcome === "allow") {
      expect(today.verdict.outcome).toBe("allow");
      expect(withFloor.verdict).toMatchObject({
        authorizedBy: { kind: "rule", ruleId: "rule-1", ruleRevision: "revision-1" },
        judgeResultRef: "test:review-result",
      });
    }
    if (judge === "not-fit") expect(withFloor.verdict.outcome).toBe(floor === "deny" ? "deny" : "require-human");
    // Unsure asks the person.
    if (judge === "indeterminate") expect(withFloor.verdict.outcome).toBe("require-human");
    if (judge === "unavailable") {
      // Unreachable asks the person, unless the rule itself already holds the lane (a stricter answer).
      const ruleHolds = rule === "advisory" || rule === "required";
      expect(withFloor.verdict).toMatchObject({
        outcome: ruleHolds ? "indeterminate" : "require-human",
        reason: "judge-unavailable",
      });
    }
  });
});

describe("#701 judge floor: strengthen-only composition and limits", () => {
  it("a rule's stricter answers survive the floor", async () => {
    const strict = ruleWith("required", {
      delegation: delegationOf("required", { onNotFit: "deny", onIndeterminate: "indeterminate" }),
    });
    expect((await run(stateWith([strict], floorOf("ask")), "not-fit")).verdict.outcome).toBe("deny");
    expect((await run(stateWith([strict], floorOf("ask")), "indeterminate")).verdict.outcome).toBe("indeterminate");
  });

  it("a saved, undelegated grant ahead of a delegated rule is still judged under the floor", async () => {
    const grant = ruleWith("none", { ruleId: "grant-new", ruleRevision: "grant-1" });
    const delegated = ruleWith("required", { ruleId: "rule-later", ruleRevision: "later-1" });
    const today = await run(stateWith([grant, delegated], undefined), "not-fit");
    expect(today).toMatchObject({ judged: false, verdict: { outcome: "allow" } });
    const floored = await run(stateWith([grant, delegated], floorOf("ask")), "not-fit");
    expect(floored).toMatchObject({ judged: true, verdict: { outcome: "require-human", reason: "judge-not-fit" } });
  });

  it("never applies to a deny, a mandatory ask, a rule that asks, or no match", async () => {
    const floor = floorOf("ask");
    const cases: [StrictPermissionState, string][] = [
      [stateWith([ruleWith("none", { decision: "deny" })], floor), "deny"],
      [stateWith([ruleWith("none", { decision: "require-human" })], floor), "require-human"],
      [stateWith([ruleWith("none")], floor, { mandatoryHuman: complete(true) }), "require-human"],
      [stateWith([], floor), "require-human"],
      [stateWith([ruleWith("none", { status: "revoked" })], floor), "deny"],
    ];
    for (const [state, outcome] of cases) {
      expect(await run(state, "fit")).toMatchObject({ judged: false, verdict: { outcome } });
    }
  });

  it("refuses a rule and a floor that name different judges, projections or destinations", async () => {
    for (const key of ["judgeConfigRef", "projectionPolicyRevision", "destinationPolicyRef"] as const) {
      const state = stateWith([ruleWith("advisory")], floorOf("ask", { [key]: "other" }));
      expect(await run(state, "fit")).toMatchObject({
        judged: false,
        verdict: { outcome: "indeterminate", reason: "judge-requirement-conflict" },
      });
    }
  });

  it("a malformed floor holds the call instead of meaning off", async () => {
    const bad: Partial<Record<keyof StrictJudgeFloor, unknown>>[] = [
      { judgeConfigRef: "" },
      { projectionPolicyRevision: "" },
      { destinationPolicyRef: "" },
      { maximumDurationMs: 0 },
      { maximumDurationMs: Number.NaN },
      { onNotFit: "allow" },
    ];
    for (const patch of bad) {
      const state = stateWith([ruleWith("none")], floorOf("ask", patch as Partial<StrictJudgeFloor>));
      expect(await run(state, "fit")).toMatchObject({
        judged: false,
        verdict: { outcome: "indeterminate", reason: "invalid-judge-floor" },
      });
    }
    const nullFloor = stateWith([ruleWith("none")], null as unknown as StrictJudgeFloor);
    if (nullFloor.profile.state !== "complete") throw new Error("fixture");
    const withNull = { ...nullFloor, profile: complete({ ...nullFloor.profile.value, judgeFloor: null }) };
    expect(await run(withNull as unknown as StrictPermissionState, "fit")).toMatchObject({
      verdict: { outcome: "indeterminate", reason: "invalid-judge-floor" },
    });
  });

  it("records what asked for review, and takes the shorter deadline", () => {
    const evaluate = (state: StrictPermissionState) => evaluateStrictPermission(actionFixture(), state, NOW, "r-1");
    const floorOnly = evaluate(stateWith([ruleWith("none")], floorOf("ask")));
    const both = evaluate(stateWith([ruleWith("advisory-fallback")], floorOf("ask")));
    const ruleOnly = evaluate(stateWith([ruleWith("advisory-fallback")], undefined));
    if (floorOnly.phase !== "needs-review" || both.phase !== "needs-review" || ruleOnly.phase !== "needs-review")
      throw new Error("expected review");
    expect(floorOnly.terms).toEqual({
      requiredBy: ["profile"],
      onNotFit: "require-human",
      onIndeterminate: "require-human",
      onUnavailable: "require-human",
    });
    expect(floorOnly.review).toMatchObject({ requirement: "required", ...refs });
    expect(both.terms.requiredBy).toEqual(["rule", "profile"]);
    expect(both.review.requirement).toBe("required");
    expect(ruleOnly.terms).toMatchObject({ requiredBy: ["rule"], onUnavailable: "allow" });
    expect(ruleOnly.review.requirement).toBe("advisory");
    // The floor's 2 s is shorter than the rule's 4 s.
    expect(Date.parse(both.review.deadlineAt)).toBe(NOW + 2000);
    expect(Date.parse(ruleOnly.review.deadlineAt)).toBe(NOW + 4000);
  });

  it("turning the floor off or changing it during a review stops the review instead of completing it", async () => {
    let state = stateWith([ruleWith("none")], floorOf("ask"));
    const port = createStrictPolicyPort({
      source: { readCurrent: async () => state },
      authorizeProjection: async () => {},
      recordReview: async () => "test:review-result",
      now: () => NOW,
      newReviewId: () => "review-1",
    });
    const { bound, result, signal } = await registerReview(port);
    state = stateWith([ruleWith("none")], undefined);
    expect(await port.completeReview(bound, result, signal)).toMatchObject({ outcome: "indeterminate" });

    state = stateWith([ruleWith("none")], floorOf("ask"));
    const port2 = createStrictPolicyPort({
      source: { readCurrent: async () => state },
      authorizeProjection: async () => {},
      recordReview: async () => "test:review-result",
      now: () => NOW,
      newReviewId: () => "review-2",
    });
    const second = await registerReview(port2);
    state = stateWith([ruleWith("none")], floorOf("deny"));
    expect(await port2.completeReview(second.bound, second.result, second.signal)).toMatchObject({
      outcome: "indeterminate",
    });
  });
});
