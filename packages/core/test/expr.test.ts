import { describe, expect, it } from "vitest";
import { checkExpression, evaluateCondition, evaluateExpression } from "@orca/core";

const ctx = {
  vars: { buildAttempt: 2, maxBuildAttempts: 3, failures: [] },
  artifacts: { review: { data: { verdict: "approve" } }, spec: { data: { risk: "high" } } },
  choice: "approve",
  item: { kind: "feature", slug: "auth" },
  steps: { build: { result: { data: { testsPassed: true } } } },
};

describe("expression language", () => {
  it("preserves explicit workflow string coercion independently of event display", () => {
    const values = { object: { a: 1 }, array: [1, null, "Two"], absent: null };
    expect(evaluateExpression("lower(object)", values)).toBe("[object object]");
    expect(evaluateExpression("upper(array)", values)).toBe("1,,TWO");
    expect(evaluateExpression("trim(absent)", values)).toBe("");
    expect(evaluateExpression("'value=' + object", values)).toBe("value=[object Object]");
    expect(evaluateExpression("object startsWith '[object'", values)).toBe(true);
    expect(evaluateExpression("object endsWith 'Object]'", values)).toBe(true);
    expect(evaluateExpression("object matches 'Object'", values)).toBe(true);
    expect(evaluateExpression("join([1, 2], object)", values)).toBe("1[object Object]2");
    expect(evaluateExpression("str(object)", values)).toBe('{"a":1}');
  });
  it("evaluates comparisons and logic", () => {
    expect(evaluateCondition("choice == 'approve'", ctx)).toBe(true);
    expect(evaluateCondition("vars.buildAttempt < vars.maxBuildAttempts && choice != 'reject'", ctx)).toBe(true);
    expect(
      evaluateCondition(
        "artifacts.review.data.verdict == 'changes-requested' or steps.build.result.data.testsPassed",
        ctx,
      ),
    ).toBe(true);
    expect(evaluateCondition("!exists(artifacts.plan)", ctx)).toBe(true);
    expect(evaluateCondition("len(vars.failures) > 0", ctx)).toBe(false);
  });
  it("supports in / contains / matches / ternary / arithmetic", () => {
    expect(evaluateExpression("item.kind in ['feature', 'task']", ctx)).toBe(true);
    expect(evaluateExpression("'auth-api' contains 'auth'", ctx)).toBe(true);
    expect(evaluateExpression("artifacts.spec.data.risk matches '^(high|critical)$'", ctx)).toBe(true);
    expect(evaluateExpression("exists(artifacts.plan) ? 'ready' : 'blocked'", ctx)).toBe("blocked");
    expect(evaluateExpression("vars.buildAttempt + 1", ctx)).toBe(3);
    expect(evaluateExpression("'attempt ' + vars.buildAttempt", ctx)).toBe("attempt 2");
    expect(evaluateExpression("artifacts['review'].data.verdict", ctx)).toBe("approve");
  });
  it("does not treat '-' as part of an identifier (#8)", () => {
    expect(evaluateExpression("vars.buildAttempt-1", ctx)).toBe(1);
    expect(evaluateExpression("vars.buildAttempt - 1", ctx)).toBe(1);
    expect(evaluateExpression("vars.maxBuildAttempts-vars.buildAttempt", ctx)).toBe(1);
    expect(evaluateExpression("iteration-1", { iteration: 5 })).toBe(4);
    expect(evaluateCondition("vars.buildAttempt-1 < vars.maxBuildAttempts", ctx)).toBe(true);
    // Hyphenated keys remain reachable via bracket access.
    expect(
      evaluateExpression("steps['review-verdict'].result", { steps: { "review-verdict": { result: "ok" } } }),
    ).toBe("ok");
  });
  it("is sandboxed", () => {
    expect(evaluateExpression("vars.__proto__", ctx)).toBeUndefined();
    expect(evaluateExpression("constructor", {})).toBeUndefined();
    expect(() => evaluateExpression("eval('1')", ctx)).toThrow(/unknown function/);
  });
  it("reports syntax errors without evaluating", () => {
    expect(checkExpression("a ==")).toMatch(/unexpected token/);
    expect(checkExpression("a == 1")).toBeUndefined();
    expect(checkExpression("'unterminated")).toMatch(/unterminated/);
  });
});
