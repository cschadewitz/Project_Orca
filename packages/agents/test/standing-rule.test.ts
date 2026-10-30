/** Until-revoked grants remain separate from every fresh, expiring execution action. */
import { expect, it } from "vitest";
import { evaluateStrictPermission, type StrictPermissionRule } from "@orca/core";
import { strictPermissionRuleRevision, validStrictPermissionRule } from "../src/strict-permission-source.js";
import { actionFixture, complete, NOW, ruleFixture, stateFixture } from "./strict-permission-fixtures.js";

function standing(): StrictPermissionRule {
  const value: StrictPermissionRule = { ...ruleFixture(), version: 2, expiresAt: null };
  return { ...value, ruleRevision: strictPermissionRuleRevision(value) };
}

it("recognizes only the versioned explicit until-revoked representation", () => {
  const rule = standing();
  expect(validStrictPermissionRule(rule)).toBe(true);
  const { version: _version, ...fields } = rule;
  expect(validStrictPermissionRule(Object.assign(Object.create({ version: 2 }) as object, fields))).toBe(false);
  for (const invalid of [
    { ...rule, version: 3 },
    { ...rule, version: undefined },
    { ...rule, expiresAt: new Date(NOW + 60000).toISOString() },
    { ...ruleFixture(), expiresAt: null },
    { ...ruleFixture(), version: undefined },
  ])
    expect(validStrictPermissionRule(invalid)).toBe(false);
});

it("until-revoked delegation remains bounded by the fresh action and judge duration", () => {
  const action = actionFixture();
  const rule: StrictPermissionRule = {
    ...standing(),
    delegation: {
      requirement: "required",
      projectionPolicyRevision: "projection",
      destinationPolicyRef: "destination",
      judgeConfigRef: "judge",
      maximumDurationMs: 60000,
      onNotFit: "deny",
      onIndeterminate: "require-human",
      allowWhenUnavailable: false,
    },
  };
  const state = { ...stateFixture(), rules: complete([rule]) };
  const result = evaluateStrictPermission(action, state, NOW, "review");
  expect(result).toMatchObject({ phase: "needs-review", review: { deadlineAt: action.expiresAt } });
  expect(
    evaluateStrictPermission(
      action,
      {
        ...state,
        rules: complete([{ ...rule, delegation: { ...rule.delegation!, maximumDurationMs: 1000 } }]),
      },
      NOW,
      "review",
    ),
  ).toMatchObject({ phase: "needs-review", review: { deadlineAt: new Date(NOW + 1000).toISOString() } });
});

it("uses the same standing grant for a fresh action after the old action expires", () => {
  const rule = standing(),
    now = NOW + 120000;
  const old = actionFixture();
  const fresh = {
    ...old,
    actionId: "fresh-action",
    bindingRef: "fresh-binding",
    invocation: { ...old.invocation, invocationId: "fresh-invocation" },
    expiresAt: new Date(now + 30000).toISOString(),
  };
  const state = { ...stateFixture(), rules: complete([rule]) };
  expect(evaluateStrictPermission(old, state, now, "review")).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "action-expired" },
  });
  expect(evaluateStrictPermission(fresh, state, now, "review")).toMatchObject({
    phase: "final",
    verdict: {
      outcome: "allow",
      authorizedBy: {
        kind: "rule",
        ruleId: rule.ruleId,
        ruleRevision: rule.ruleRevision,
      },
    },
  });
  expect(evaluateStrictPermission(fresh, state, Date.parse(fresh.expiresAt), "review")).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "action-expired" },
  });
});

it("revocation and mandatory human review still override a standing grant", () => {
  const rule = standing(),
    action = actionFixture();
  expect(
    evaluateStrictPermission(
      action,
      { ...stateFixture(), rules: complete([{ ...rule, status: "revoked" }]) },
      NOW,
      "r",
    ),
  ).toMatchObject({ phase: "final", verdict: { outcome: "deny", reason: "rule-revoked" } });
  expect(
    evaluateStrictPermission(
      action,
      { ...stateFixture(), rules: complete([rule]), mandatoryHuman: complete(true) },
      NOW,
      "r",
    ),
  ).toMatchObject({ phase: "final", verdict: { outcome: "require-human" } });
});
