/** Canonical resource-kind negatives; no physical or installed-provider qualification. */
import { describe, expect, it } from "vitest";
import { evaluateStrictPermission, type ActionResourceV1 } from "@orca/core";
import { actionFixture, complete, NOW, ruleFixture, stateFixture } from "./strict-permission-fixtures.js";

const memory: ActionResourceV1 = {
  operation: "read",
  targetKind: "disposable-memory",
  ownerRef: "owner:original-lifetime",
  resourceRef: "cell",
  resourceRevision: "revision:1",
};
function evaluate(resource: unknown, allowed: unknown = memory) {
  const action = actionFixture();
  Object.assign(action, { resources: complete([resource]) });
  const rule = ruleFixture();
  Object.assign(rule.match, { resources: [allowed] });
  return evaluateStrictPermission(action, { ...stateFixture(), rules: complete([rule]) }, NOW, "review");
}
describe("canonical physical and disposable-memory resources", () => {
  it("preserves physical predicates and exactly matches a canonical memory predicate", () => {
    expect(evaluateStrictPermission(actionFixture(), stateFixture(), NOW, "review")).toMatchObject({
      verdict: { outcome: "allow" },
    });
    expect(evaluate(memory)).toMatchObject({ verdict: { outcome: "allow" } });
  });
  it.each([
    {},
    { operation: "read" },
    { ...memory, physicalTargetRef: "physical" },
    { ...memory, targetKind: "unknown" },
    { ...memory, ownerRef: "" },
    { ...memory, resourceRef: "" },
    { ...memory, resourceRevision: "" },
    { ...memory, ownerRef: undefined },
    { operation: "read", physicalTargetRef: "" },
    { operation: "read", physicalTargetRef: "p", ownerRef: "mixed" },
    null,
  ])("fails closed on malformed resource %j in either action or required rule", (malformed) => {
    expect(evaluate(malformed)).toMatchObject({ verdict: { outcome: "indeterminate", reason: "invalid-resource" } });
    expect(evaluate(memory, malformed)).toMatchObject({
      verdict: { outcome: "indeterminate", reason: "invalid-rule-resource" },
    });
  });
  it.each(["ownerRef", "resourceRef", "resourceRevision", "operation"])("does not match changed %s", (field) => {
    expect(evaluate({ ...memory, [field]: "other" })).toMatchObject({ verdict: { outcome: "require-human" } });
  });
  it("cannot match across target kinds or missing identities", () => {
    expect(evaluate(memory, { operation: "read", physicalTargetRef: "cell" })).toMatchObject({
      verdict: { outcome: "require-human" },
    });
    expect(evaluate({ operation: "read", physicalTargetRef: "cell" }, memory)).toMatchObject({
      verdict: { outcome: "require-human" },
    });
    expect(evaluate({ operation: "read" }, { operation: "read" })).toMatchObject({
      verdict: { outcome: "indeterminate" },
    });
  });
  it("rejects mixed shapes at compile time as well as runtime", () => {
    const mixed: ActionResourceV1 = {
      operation: "read",
      physicalTargetRef: "p",
      // @ts-expect-error A physical target may not carry disposable-memory identity.
      targetKind: "disposable-memory",
      ownerRef: "o",
      resourceRef: "r",
      resourceRevision: "v",
    };
    // @ts-expect-error Missing revision is never an unknown-equals-unknown match.
    const missing: ActionResourceV1 = {
      operation: "read",
      targetKind: "disposable-memory",
      ownerRef: "o",
      resourceRef: "r",
    };
    expect(evaluate(mixed)).toMatchObject({ verdict: { outcome: "indeterminate" } });
    expect(evaluate(missing)).toMatchObject({ verdict: { outcome: "indeterminate" } });
  });
});

it("rejects hidden mixed fields and accessor-based identity frames", () => {
  const hidden = Object.defineProperty({ ...memory }, "physicalTargetRef", { value: "mixed", enumerable: false });
  expect(evaluate(hidden)).toMatchObject({ verdict: { outcome: "indeterminate" } });
  const accessor = Object.defineProperty({ ...memory }, "ownerRef", {
    get: () => "owner:original-lifetime",
    enumerable: true,
  });
  expect(evaluate(accessor)).toMatchObject({ verdict: { outcome: "indeterminate" } });
});
