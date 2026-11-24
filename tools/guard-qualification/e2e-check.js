/**
 * The end-to-end check of the receipt chain (#1026), run by guard-receipts.yml after it signs
 * this run's receipts and before it proposes them:
 *
 *   node tools/guard-qualification/e2e-check.js make-test <qualifying.json> <test.json>
 *   node tools/guard-qualification/e2e-check.js <qualifying.json> <test.json>
 *
 * The qualifying receipt is the real one from this run's installed test. `make-test` derives
 * from it a benign, clearly nonqualifying receipt for the verifier alone: scoped
 * `verifier-test` (which the checker always refuses) and with one asserted case marked failed.
 * No agent or guard is weakened to make it. Each is signed in its own attestation, the test one
 * staged apart (`stage-receipts.js`), with its Sigstore bundle beside it. With the agent's row
 * promoted to B and pinned to the receipt as record-receipts.js pins it, the checker, verifying
 * attestations for real, must:
 *
 * - accept the qualifying receipt;
 * - refuse the test receipt, for its failed case and its scope;
 * - refuse a copy of the qualifying receipt with one byte changed, for its attestation.
 *
 * Exit 0 when all three hold; otherwise one line per finding, exit 1.
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestationProblems, bundlePathFor } from "./attestation.js";
import {
  assertedCases,
  checkSupportMatrix,
  loadAssertions,
  loadCatalogue,
  loadMatrix,
} from "./check-support-matrix.js";
import { recordReceipts } from "./record-receipts.js";
import { TEST_SCOPE } from "./stage-receipts.js";

/** The verifier test receipt: the real one, scoped as a test, with its first asserted case failed. */
export function verifierTestReceipt(receipt, matrix = loadMatrix(), catalogue = loadCatalogue()) {
  const route = matrix.paths.find((p) => p.id === receipt.route);
  const first = route && assertedCases(route, catalogue)[0];
  if (!first || !receipt.cases?.some((c) => c.id === first)) throw new Error("the receipt runs no asserted case");
  return {
    ...receipt,
    scope: TEST_SCOPE,
    cases: receipt.cases.map((c) => (c.id === first ? { ...c, result: "fail" } : c)),
  };
}

/**
 * The checker's findings for `agentId` at `tier` with only `file` (under `root`) as its receipt.
 * `verify` is injectable for tests.
 */
export function checkAt(root, file, tier, verify = (f, r) => attestationProblems(root, f, r)) {
  const receipt = JSON.parse(readFileSync(join(root, file), "utf8"));
  const pinned = recordReceipts(loadMatrix(), [{ file, receipt }], () => ({}));
  const matrix = {
    ...pinned,
    agents: pinned.agents.map((a) => (a.id === receipt.agent ? { ...a, tier, receipts: [file] } : a)),
  };
  return checkSupportMatrix(
    matrix,
    loadCatalogue(),
    () => true,
    (p) => JSON.parse(readFileSync(join(root, p), "utf8")),
    loadAssertions(),
    verify,
    // What A and B would accept, checked before either is promotable in the committed checker.
    ["A", "B"],
  );
}

/** Lay the receipts out under a scratch root, with the tampered copy, and run all three checks. */
export function endToEnd(qualifying, failing, verifyFor = (root) => (f, r) => attestationProblems(root, f, r)) {
  const root = mkdtempSync(join(tmpdir(), "guard-e2e-"));
  const place = (from, name) => {
    copyFileSync(from, join(root, name));
    copyFileSync(bundlePathFor(from), join(root, bundlePathFor(name)));
  };
  place(qualifying, "qualifying.json");
  place(failing, "failing.json");
  // One byte changed: the JSON still parses to the same receipt, only the signed bytes differ.
  const text = readFileSync(qualifying, "utf8");
  writeFileSync(join(root, "tampered.json"), text.endsWith("\n") ? `${text.slice(0, -1)} \n` : `${text} `);
  copyFileSync(bundlePathFor(qualifying), join(root, bundlePathFor("tampered.json")));

  const verify = verifyFor(root);
  const findings = [];
  const accepted = checkAt(root, "qualifying.json", "B", verify);
  for (const p of accepted) findings.push(`the qualifying receipt was refused: ${p}`);
  const failed = checkAt(root, "failing.json", "B", verify);
  for (const why of ["a case did not pass", `a ${TEST_SCOPE} receipt, never evidence`])
    if (!failed.some((p) => p.includes(why)))
      findings.push(`the test receipt was not refused for "${why}": ${failed.join("; ") || "accepted"}`);
  const tampered = checkAt(root, "tampered.json", "B", verify);
  if (!tampered.some((p) => p.includes("attestation does not verify")))
    findings.push(`the tampered receipt was not refused for its attestation: ${tampered.join("; ") || "accepted"}`);
  return findings;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  if (args[0] === "make-test" && args.length === 3) {
    const receipt = JSON.parse(readFileSync(args[1], "utf8"));
    writeFileSync(args[2], `${JSON.stringify(verifierTestReceipt(receipt), null, 2)}\n`);
    process.exit(0);
  }
  const [qualifying, failing] = args;
  if (!qualifying || !failing || args.length !== 2) {
    console.error("usage: e2e-check.js make-test <qualifying.json> <test.json> | <qualifying.json> <test.json>");
    process.exit(2);
  }
  const findings = endToEnd(qualifying, failing);
  for (const f of findings) console.error(f);
  if (findings.length === 0) console.log("accepted the qualifying receipt; refused the test and the tampered ones");
  process.exit(findings.length === 0 ? 0 : 1);
}
