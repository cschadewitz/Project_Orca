/**
 * The end-to-end check's verifier test receipt (e2e-check.js, #1026): derived from a real
 * receipt without weakening any agent or guard, clearly scoped as a test, and nonqualifying.
 */
import { describe, expect, it } from "vitest";
import { assertedCases, loadCatalogue, loadMatrix } from "../guard-qualification/check-support-matrix.js";
import { verifierTestReceipt } from "../guard-qualification/e2e-check.js";

const matrix = loadMatrix();
const catalogue = loadCatalogue();
const route = matrix.paths.find((p) => p.id === "claude-native-hook");
const asserted = assertedCases(route, catalogue);
const real = {
  route: "claude-native-hook",
  cases: [
    { id: "F01", via: "program", result: "pass" },
    ...asserted.map((id) => ({ id, via: "live", result: "pass" })),
  ],
};

describe("the verifier test receipt", () => {
  it("is the real receipt, scoped verifier-test, with its first asserted case failed", () => {
    const test = verifierTestReceipt(real);
    expect(test.scope).toBe("verifier-test");
    expect(test.cases.find((c) => c.id === asserted[0]).result).toBe("fail");
    expect(test.cases.filter((c) => c.result === "fail")).toHaveLength(1);
    expect(test.cases.find((c) => c.id === "F01").result).toBe("pass");
    expect(real.cases.every((c) => c.result === "pass")).toBe(true);
  });

  it("refuses a receipt that runs no asserted case", () => {
    expect(() => verifierTestReceipt({ ...real, cases: [] })).toThrow("runs no asserted case");
    expect(() => verifierTestReceipt({ ...real, route: "nowhere" })).toThrow("runs no asserted case");
  });
});
