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

const certificate = (extra = {}) => {
  const ref = extra.sourceRepositoryRef ?? "refs/heads/main";
  return {
    sourceRepositoryDigest: build,
    sourceRepositoryRef: ref,
    runnerEnvironment: "github-hosted",
    buildSignerURI: `https://github.com/${RECEIPTS_WORKFLOW}@${ref}`,
    buildSignerDigest: build,
    ...extra,
  };
};
/** A gh that is new enough and answers verify with these certificates. */
const gh =
  (cert, version = "gh version 2.102.0 (2026-10-01)") =>
  (args) =>
    args[0] === "--version" ? version : JSON.stringify([{ verificationResult: { signature: { certificate: cert } } }]);

describe("a receipt counts only when its attestation verifies", () => {
  it("asks gh for this repository, the receipts workflow, the receipt's build and a hosted runner", () => {
    const root = repo();
    let seen;
    const problems = attestationProblems(root, file, receipt, (args) => {
      if (args[0] !== "--version") seen = args;
      return gh(certificate())(args);
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
    const fails = (args) => {
      if (args[0] === "--version") return "gh version 2.102.0";
      const e = new Error("exit 1");
      e.stderr = "✗ Verification failed\nmore";
      throw e;
    };
    expect(attestationProblems(repo(), file, receipt, fails)).toEqual([
      "attestation does not verify: ✗ Verification failed",
    ]);
    const answers = (out) => (args) => (args[0] === "--version" ? "gh version 2.102.0" : out);
    expect(attestationProblems(repo(), file, receipt, answers("not json"))).toEqual([
      "attestation verification printed no JSON",
    ]);
    expect(attestationProblems(repo(), file, receipt, answers("[]"))).toEqual([
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

describe("the verifier and the signer identity", () => {
  it("refuses a gh older than 2.102.0, which matched --signer-workflow as a prefix", () => {
    for (const v of ["gh version 2.101.0 (2026-09-01)", "gh version 2.89.0 (2026-03-26)", "gh version 1.99.9"])
      expect(attestationProblems(repo(), file, receipt, gh(certificate(), v))[0]).toMatch(/older than 2\.102\.0/);
    expect(attestationProblems(repo(), file, receipt, gh(certificate(), "gh version 2.103.1"))).toEqual([]);
    expect(attestationProblems(repo(), file, receipt, gh(certificate(), "gh version 3.0.0"))).toEqual([]);
    expect(attestationProblems(repo(), file, receipt, gh(certificate(), "nothing"))).toEqual(["gh printed no version"]);
  });

  it("checks the signer workflow exactly: this file, at its ref, at the receipt's commit", () => {
    const signer = `https://github.com/${RECEIPTS_WORKFLOW}@refs/heads/main`;
    for (const uri of [
      `https://github.com/${RECEIPTS_WORKFLOW.replace(".yml", "-evil.yml")}@refs/heads/main`,
      `https://github.com/${RECEIPTS_WORKFLOW}@refs/heads/main-evil`,
      undefined,
    ])
      expect(attestationProblems(repo(), file, receipt, gh(certificate({ buildSignerURI: uri })))).toEqual([
        `signed by ${uri ?? "an unknown workflow"}, not ${signer}`,
      ]);
    const other = "e".repeat(40);
    expect(attestationProblems(repo(), file, receipt, gh(certificate({ buildSignerDigest: other })))).toEqual([
      `signer workflow at ${other}, not ${build}`,
    ]);
  });
});

describe("the release gate refuses a certification that is not current", () => {
  const git =
    ({ ancestor = true, changed = "", files = {} } = {}) =>
    (args) => {
      if (args[0] === "merge-base") {
        if (!ancestor) throw new Error("not ancestor");
        return "";
      }
      if (args[0] === "show") {
        const text = files[args[1]];
        if (text === undefined) throw new Error("missing");
        return text;
      }
      return changed;
    };

  it("holds when only exempt files changed since the build", () => {
    expect(staleProblems("/r", build, git())).toEqual([]);
    expect(
      staleProblems(
        "/r",
        build,
        git({ changed: "docs/a.md\nREADME.md\nchangelog.d/1-x.added.md\ntools/guard-qualification/receipts/r.json\n" }),
      ),
    ).toEqual([]);
  });

  it("refuses a build HEAD does not contain, or any other changed file, workflows included", () => {
    expect(staleProblems("/r", build, git({ ancestor: false }))).toEqual([`build ${build} is not an ancestor of HEAD`]);
    expect(staleProblems("/r", build, git({ changed: "packages/agents/src/permissions.ts\n" }))).toEqual([
      `build ${build} is stale: 1 certified file(s) changed since (packages/agents/src/permissions.ts)`,
    ]);
    expect(staleProblems("/r", build, git({ changed: ".github/workflows/desktop.yml\n" }))[0]).toContain(
      ".github/workflows/desktop.yml",
    );
  });

  it("lets a package.json change only its version", () => {
    const pkg = (extra) =>
      JSON.stringify({ name: "@orca/agents", version: "0.8.0", scripts: { build: "tsc" }, ...extra });
    const files = (head) => ({
      [`${build}:packages/agents/package.json`]: pkg(),
      "HEAD:packages/agents/package.json": head,
    });
    const changed = "packages/agents/package.json\n";
    expect(staleProblems("/r", build, git({ changed, files: files(pkg({ version: "0.8.1" })) }))).toEqual([]);
    expect(
      staleProblems("/r", build, git({ changed, files: files(pkg({ scripts: { build: "tsc && evil" } })) }))[0],
    ).toContain("packages/agents/package.json");
    expect(staleProblems("/r", build, git({ changed, files: files(pkg({ dependencies: { x: "1" } })) }))[0]).toContain(
      "packages/agents/package.json",
    );
  });

  it("lets the matrix change only a row's tier, pin and receipts", () => {
    const m = (row) =>
      JSON.stringify({ paths: [{ id: "acp-ask", excluded: {} }], agents: [{ id: "claude", routes: ["x"], ...row }] });
    const at = "tools/guard-qualification/support-matrix.json";
    const changed = `${at}\n`;
    const files = (head) => ({
      [`${build}:${at}`]: m({ tier: "none", pin: null, receipts: [] }),
      [`HEAD:${at}`]: head,
    });
    expect(
      staleProblems(
        "/r",
        build,
        git({ changed, files: files(m({ tier: "B", pin: { build }, receipts: ["r.json"] })) }),
      ),
    ).toEqual([]);
    expect(staleProblems("/r", build, git({ changed, files: files(m({ tier: "B", routes: ["y"] })) }))[0]).toContain(
      at,
    );
    expect(
      staleProblems(
        "/r",
        build,
        git({ changed, files: { ...files(m({})), [`HEAD:${at}`]: JSON.stringify({ paths: [], agents: [] }) } }),
      )[0],
    ).toContain(at);
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

  it("checks a scoped claim's build too, whatever the base tier", () => {
    const matrix = { agents: [{ id: "claude", tier: "none", pin: null, scoped: { pin: { build } } }] };
    expect(releaseProblems(matrix, "/r", (_root, b) => [`stale ${b}`])).toEqual([
      `agent claude: scoped: stale ${build}`,
    ]);
  });
});
