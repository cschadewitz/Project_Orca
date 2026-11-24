/**
 * The binding between a support-matrix receipt and the run that produced it (attestation.js):
 * what is asked of `gh attestation verify`, what is refused on top of it, and the release
 * gate's staleness check. `gh` and `git` are injected; the real verification runs in CI
 * (guard-matrix.yml).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECEIPTS_WORKFLOW,
  REPOSITORY,
  attestationProblems,
  bundlePathFor,
  staleProblems,
} from "../guard-qualification/attestation.js";
import { releaseProblems } from "../guard-qualification/check-support-matrix.js";

const build = "0123456789abcdef0123456789abcdef01234567";
const receipt = { format: "orca-enforcement-receipt/1", build };
const file = "tools/guard-qualification/receipts/claude-acp-ask.json";

function repo({ bundle = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orca-attest-"));
  mkdirSync(join(root, "tools/guard-qualification/receipts"), { recursive: true });
  writeFileSync(join(root, file), JSON.stringify(receipt));
  if (bundle) writeFileSync(join(root, bundlePathFor(file)), "{}");
  return root;
}

const certificate = (extra = {}) => ({
  sourceRepositoryDigest: build,
  sourceRepositoryRef: "refs/heads/main",
  runnerEnvironment: "github-hosted",
  ...extra,
});
const gh = (cert) => () => JSON.stringify([{ verificationResult: { signature: { certificate: cert } } }]);

describe("a receipt counts only when its attestation verifies", () => {
  it("asks gh for this repository, the receipts workflow, the receipt's build and a hosted runner", () => {
    const root = repo();
    let seen;
    const problems = attestationProblems(root, file, receipt, (args) => {
      seen = args;
      return gh(certificate())();
    });
    expect(problems).toEqual([]);
    expect(seen.slice(0, 3)).toEqual(["attestation", "verify", join(root, file)]);
    const flag = (name) => seen[seen.indexOf(name) + 1];
    expect(flag("--bundle")).toBe(join(root, bundlePathFor(file)));
    expect(flag("--repo")).toBe(REPOSITORY);
    expect(flag("--signer-workflow")).toBe(RECEIPTS_WORKFLOW);
    expect(flag("--source-digest")).toBe(build);
    expect(seen).toContain("--deny-self-hosted-runners");
  });

  it("accepts a release line as well as main", () => {
    expect(
      attestationProblems(repo(), file, receipt, gh(certificate({ sourceRepositoryRef: "refs/heads/release/0.8" }))),
    ).toEqual([]);
  });

  it("refuses a receipt with no committed bundle, or no exact build", () => {
    expect(attestationProblems(repo({ bundle: false }), file, receipt, gh(certificate()))).toEqual([
      `no attestation bundle ${bundlePathFor(file)}`,
    ]);
    expect(attestationProblems(repo(), file, { ...receipt, build: "main" }, gh(certificate()))).toEqual([
      "names no exact build to verify against",
    ]);
  });

  it("refuses when gh does not verify it: hand-written, edited, forked or self-hosted", () => {
    const fails = () => {
      const e = new Error("exit 1");
      e.stderr = "✗ Verification failed\nmore";
      throw e;
    };
    expect(attestationProblems(repo(), file, receipt, fails)).toEqual([
      "attestation does not verify: ✗ Verification failed",
    ]);
    expect(attestationProblems(repo(), file, receipt, () => "not json")).toEqual([
      "attestation verification printed no JSON",
    ]);
    expect(attestationProblems(repo(), file, receipt, () => "[]")).toEqual([
      "attestation verification returned no result",
    ]);
  });

  it("re-checks the commit, the ref and the runner in what gh verified", () => {
    const other = "f".repeat(40);
    expect(attestationProblems(repo(), file, receipt, gh(certificate({ sourceRepositoryDigest: other })))).toEqual([
      `attested at ${other}, not ${build}`,
    ]);
    expect(
      attestationProblems(repo(), file, receipt, gh(certificate({ sourceRepositoryRef: "refs/heads/claude/x" }))),
    ).toEqual(["attested from refs/heads/claude/x, not main or a release line"]);
    expect(
      attestationProblems(repo(), file, receipt, gh(certificate({ sourceRepositoryRef: "refs/pull/1/merge" }))),
    ).toEqual(["attested from refs/pull/1/merge, not main or a release line"]);
    expect(attestationProblems(repo(), file, receipt, gh(certificate({ runnerEnvironment: "self-hosted" })))).toEqual([
      "attested on a self-hosted runner",
    ]);
  });
});

describe("the release gate refuses a certification that is not current", () => {
  const git =
    ({ ancestor = true, changed = "" } = {}) =>
    (args) => {
      if (args[0] === "merge-base") {
        if (!ancestor) throw new Error("not ancestor");
        return "";
      }
      return changed;
    };

  it("holds when no certified path changed since the build", () => {
    expect(staleProblems("/r", build, git())).toEqual([]);
  });

  it("refuses a build HEAD does not contain, or one whose certified files changed", () => {
    expect(staleProblems("/r", build, git({ ancestor: false }))).toEqual([`build ${build} is not an ancestor of HEAD`]);
    expect(staleProblems("/r", build, git({ changed: "packages/agents/src/permissions.ts\n" }))).toEqual([
      `build ${build} is stale: 1 certified file(s) changed since (packages/agents/src/permissions.ts)`,
    ]);
  });

  it("checks only promoted rows", () => {
    const matrix = {
      agents: [
        { id: "claude", tier: "B", pin: { build } },
        { id: "pi", tier: "none", pin: null },
      ],
    };
    expect(releaseProblems(matrix, "/r", (_root, b) => [`stale ${b}`])).toEqual([`agent claude: stale ${build}`]);
  });
});
