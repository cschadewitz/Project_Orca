/**
 * The end-to-end check's verifier test receipt (e2e-check.js, #1026): derived from a real
 * receipt without weakening any agent or guard, clearly scoped as a test, and nonqualifying.
 * And the check itself, and the proposal after it, on the committed matrix, whose Claude row
 * carries a scoped claim (#1084): rehearsed on the committed receipt, and on it moved to another
 * build as the next signed run's would be, with only the attestation stood in for.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPO_ROOT,
  assertedCases,
  checkSupportMatrix,
  loadAssertions,
  loadCatalogue,
  loadMatrix,
  releaseProblems,
} from "../guard-qualification/check-support-matrix.js";
import { endToEnd, verifierTestReceipt } from "../guard-qualification/e2e-check.js";
import { recordReceipts } from "../guard-qualification/record-receipts.js";

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

const RECEIPT = "tools/guard-qualification/receipts/claude-claude-native-hook.json";
const committed = JSON.parse(readFileSync(join(REPO_ROOT, RECEIPT), "utf8"));
/** The committed receipt as the next signed run's would be: another build, and the hook program built from it. */
const nextBuild = {
  ...committed,
  build: "0123456789abcdef0123456789abcdef01234567",
  inputs: { ...committed.inputs, hookProgram: { ...committed.inputs.hookProgram, sha256: "9".repeat(64) } },
};
/** Every attestation verifies but the tampered copy's: the signature is what this stands in for. */
const attestation = () => (file) => (file === "tampered.json" ? ["attestation does not verify (stand-in)"] : []);

describe("the end-to-end check, with the row's scoped claim populated", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  /** Lays out a qualifying receipt and its verifier test receipt, each with a stand-in bundle. */
  const layout = (qualifying) => {
    dir = mkdtempSync(join(tmpdir(), "guard-e2e-test-"));
    const q = join(dir, "claude-claude-native-hook.json");
    const t = join(dir, "test-claude-native-hook.json");
    writeFileSync(q, `${JSON.stringify(qualifying, null, 2)}\n`);
    writeFileSync(t, `${JSON.stringify(verifierTestReceipt(qualifying), null, 2)}\n`);
    for (const f of [q, t]) copyFileSync(join(REPO_ROOT, `${RECEIPT}.sigstore.json`), `${f}.sigstore.json`);
    return [q, t];
  };

  it("is rehearsed against a claim, not a row without one", () => {
    expect(loadMatrix().agents.find((a) => a.id === "claude").scoped?.route).toBe("claude-native-hook");
  });

  it("accepts the committed receipt, and the same moved to another build", () => {
    expect(endToEnd(...layout(committed), attestation)).toEqual([]);
    expect(endToEnd(...layout(nextBuild), attestation)).toEqual([]);
  });

  it("holds the qualifying receipt to the claim, not only to the tier", () => {
    const findings = endToEnd(
      ...layout({ ...nextBuild, agentSettings: { ...committed.agentSettings, nativeToolHook: "off" } }),
      attestation,
    );
    expect(findings).toContainEqual(
      expect.stringMatching(
        /^the qualifying receipt was refused: .*scoped: .*agentSettings are not the scoped settings/,
      ),
    );
  });
});

describe("the proposal after it, on the committed matrix", () => {
  it("moves the claim with the row to the new receipt, and the checker accepts it", () => {
    const matrix = recordReceipts(loadMatrix(), [{ file: RECEIPT, receipt: nextBuild }]);
    const claude = matrix.agents.find((a) => a.id === "claude");
    expect(claude.pin.build).toBe(nextBuild.build);
    expect(claude.scoped.pin).toEqual(claude.pin);
    expect(claude.scoped.receipts).toEqual([RECEIPT]);
    const problems = checkSupportMatrix(
      matrix,
      loadCatalogue(),
      () => true,
      (f) => (f === RECEIPT ? nextBuild : JSON.parse(readFileSync(join(REPO_ROOT, f), "utf8"))),
      loadAssertions(),
      () => [],
    );
    expect(problems).toEqual([]);
    // The release gate then measures the claim from the new build, not the old one.
    const asked = [];
    releaseProblems(matrix, REPO_ROOT, (_root, b) => (asked.push(b), []));
    expect(asked).toEqual([nextBuild.build]);
  });
});
