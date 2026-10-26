/** #713 vectors reconciled to canonical admission. Synthetic counterexamples only; no executor or hooks. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  evaluateStrictPermission,
  selectStrictPermissionOption,
  strictDecisionBinding,
  type ActionEvidenceV1,
  type PolicyVerdictV1,
  type StrictPermissionState,
} from "@orca/core";
import { actionFixture, complete, NOW, stateFixture } from "./strict-permission-fixtures.js";

const packet = new URL("../../../docs/preparation/provider-enforcement-704-705/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("vectors.json", packet), "utf8")) as {
  cases: { id: string; canonicalAdmission: string }[];
};
const unknown = { state: "unknown", reason: "offline fixture: qualification unavailable" } as const;

function allow(action: ActionEvidenceV1): PolicyVerdictV1 {
  return {
    ...strictDecisionBinding(action),
    outcome: "allow",
    authorizedBy: { kind: "human", acceptedAnswerRef: "test:answer" },
  };
}

// This is a test input mapping, not a provider adapter or a qualification decision.
// Each row isolates one missing obligation against an otherwise synthetic positive control.
function counterexample(kind: string): {
  action: ActionEvidenceV1;
  state: StrictPermissionState;
  stage: "admission" | "option";
  reason: string;
} {
  let action = actionFixture();
  let state = stateFixture(action);
  let reason = "coverage-or-state-unavailable";
  let stage: "admission" | "option" = "admission";
  switch (kind) {
    case "effectiveCwd":
      action = { ...action, effectiveCwd: unknown };
      reason = "required-fact:effectiveCwd";
      break;
    case "negotiatedHook":
    case "protectedConfiguration":
      action = { ...action, coverage: { ...action.coverage, [kind]: unknown } };
      reason = "insufficient-coverage";
      break;
    case "coverage":
      action = {
        ...action,
        coverage: {
          ...action.coverage,
          level: "observation",
          evidence: { sourceRefs: ["test:pinned-source-only"], installedRefs: [], independentlyObservedEffects: false },
        },
      };
      reason = "insufficient-coverage";
      break;
    case "current-authority":
      state = { ...state, currentAuthority: complete(false) };
      reason = "current-authority";
      break;
    case "final-provenance":
    case "hook-error-policy":
    case "cancelled":
    case "invocation-binding":
      // Capture owner must establish these preconditions. The pure evaluator cannot
      // discover a native rewrite, cancellation or failure contract from action text.
      state = { ...state, coverageAndState: unknown };
      break;
    case "option-effect":
      action = {
        ...action,
        offeredChoices: action.offeredChoices.map((choice) => ({
          ...choice,
          effect: "unknown",
          qualificationRef: unknown,
          grantScopeAndLifetime: unknown,
        })),
      };
      stage = "option";
      reason = "no-qualified-original-option";
      break;
    case "option-membership":
      action = { ...action, offeredChoices: [] };
      stage = "option";
      reason = "no-qualified-original-option";
      break;
    default:
      throw new Error(`Unmapped canonical obligation: ${kind}`);
  }
  return { action, state, stage, reason };
}

it("has a synthetic positive control without certifying a real provider", () => {
  const action = actionFixture();
  const result = evaluateStrictPermission(action, stateFixture(action), NOW, "test:review");
  expect(result.phase).toBe("final");
  if (result.phase !== "final") throw new Error("unexpected review");
  expect(result.verdict.outcome).toBe("allow");
  expect(selectStrictPermissionOption(action, result.verdict, NOW)).toBe("once");
  expect(action.coverage.provider).toBe("synthetic");
});

it.each(vectors.cases)("$id cannot qualify strict enforcement ($canonicalAdmission)", (row) => {
  const { action, state, stage, reason } = counterexample(row.canonicalAdmission);
  if (stage === "option") {
    expect(selectStrictPermissionOption(action, allow(action), NOW), reason).toBeUndefined();
  } else {
    const result = evaluateStrictPermission(action, state, NOW, "test:review");
    expect(result).toMatchObject({ phase: "final", verdict: { reason } });
    if (result.phase !== "final") throw new Error("unexpected review");
    expect(result.verdict.outcome).not.toBe("allow");
    expect(selectStrictPermissionOption(action, result.verdict, NOW)).toBeUndefined();
  }
});

it.each([
  "effectiveCwd",
  "resources",
  "executableAndInterpreter",
  "environmentAndCredentialRefs",
  "relevantStateRefs",
] as const)("unknown final %s cannot inherit a rule", (key) => {
  const action = { ...actionFixture(), [key]: unknown };
  const result = evaluateStrictPermission(action, stateFixture(action), NOW, "test:review");
  expect(result).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: `required-fact:${key}` },
  });
});

it("source evidence alone cannot establish verified-per-execution coverage", () => {
  const base = actionFixture();
  const action = {
    ...base,
    coverage: {
      ...base.coverage,
      evidence: { sourceRefs: ["test:source-function"], installedRefs: [], independentlyObservedEffects: false },
    },
  };
  expect(evaluateStrictPermission(action, stateFixture(action), NOW, "test:review")).toMatchObject({
    phase: "final",
    verdict: { outcome: "indeterminate", reason: "insufficient-coverage" },
  });
});

it.each(["remembered", "unknown"] as const)("allow_once spelling cannot qualify %s effects", (effect) => {
  const base = actionFixture();
  const action = { ...base, offeredChoices: base.offeredChoices.map((choice) => ({ ...choice, effect })) };
  expect(selectStrictPermissionOption(action, allow(action), NOW)).toBeUndefined();
});

it("a checked binding cannot authorize a recaptured post-check transformation", () => {
  const checked = actionFixture();
  const changed = {
    ...checked,
    bindingRef: "test:recaptured-final-input",
    transformations: ["test:later-prefix"],
    dispatch: { ...checked.dispatch, bindingRef: "test:changed-bytes" },
  };
  expect(selectStrictPermissionOption(changed, allow(checked), NOW)).toBeUndefined();
});
