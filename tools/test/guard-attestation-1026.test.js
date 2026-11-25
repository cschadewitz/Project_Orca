/**
 * The binding between a support-matrix receipt and the run that produced it (attestation.js):
 * what is asked of `gh attestation verify`, what is refused on top of it, and the release
 * gate's staleness check. `gh` and `git` are injected; the real verification runs in CI
 * (guard-matrix.yml).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECEIPTS_WORKFLOW,
  REPOSITORIES,
  REPOSITORY,
  attestationProblems,
  bundlePathFor,
  preRenamePathFor,
  staleProblems,
} from "../guard-qualification/attestation.js";
import { REPO_ROOT, releaseProblems } from "../guard-qualification/check-support-matrix.js";

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

  it("keeps a receipt attested before the Orrery rename counting, under the old name's own signer", () => {
    // rename-keep-start: the identity receipts from before the rename carry
    const legacy = "cschadewitz/Project_Orca";
    const signer = `https://github.com/${legacy}/.github/workflows/guard-receipts.yml@refs/heads/main`;
    // rename-keep-end
    expect(REPOSITORIES[0]).toBe(REPOSITORY);
    expect(REPOSITORIES).toContain(legacy);
    const asked = [];
    const old = (args) => {
      if (args[0] === "--version") return "gh version 2.102.0";
      const repository = args[args.indexOf("--repo") + 1];
      asked.push(repository);
      if (repository !== legacy) throw Object.assign(new Error("exit 1"), { stderr: "✗ Verification failed" });
      expect(args[args.indexOf("--signer-workflow") + 1]).toBe(`${legacy}/.github/workflows/guard-receipts.yml`);
      return gh(certificate({ buildSignerURI: signer }))(args);
    };
    expect(attestationProblems(repo(), file, receipt, old)).toEqual([]);
    expect(asked).toEqual([...new Set([REPOSITORY, legacy])]);
    // The old name's signer is not accepted for a certificate verified under the current name.
    if (REPOSITORY !== legacy)
      expect(attestationProblems(repo(), file, receipt, gh(certificate({ buildSignerURI: signer })))[0]).toMatch(
        /^signed by/,
      );
  });

  it("verifies a receipt the rename rewrote on its attested bytes, and only when it is exactly their rename", () => {
    // rename-keep-start: the receipt as attested before the rename
    const original = JSON.stringify({ ...receipt, note: "ORCA ran this" });
    const renamed = original.replace("ORCA ran", "Orrery ran").replace("orca-enforcement", "orrery-enforcement");
    // rename-keep-end
    const root = repo();
    writeFileSync(join(root, file), renamed);
    writeFileSync(join(root, preRenamePathFor(file)), original);
    let seen;
    const problems = attestationProblems(root, file, receipt, (args) => {
      if (args[0] !== "--version") seen = args;
      return gh(certificate())(args);
    });
    expect(problems).toEqual([]);
    expect(seen[2]).toBe(join(root, preRenamePathFor(file)));
    writeFileSync(join(root, file), renamed.replace("ran", "edited"));
    expect(attestationProblems(root, file, receipt, gh(certificate()))).toEqual([
      `${file} is not the rename of its attested ${preRenamePathFor(file)}`,
    ]);
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

  it("accepts recording a scoped claim after its checks-only build, in a real repository", () => {
    const root = mkdtempSync(join(tmpdir(), "orca-scoped-"));
    const g = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const at = "tools/guard-qualification/support-matrix.json";
    const write = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const matrix = () => JSON.parse(readFileSync(join(root, at), "utf8"));
    const commit = (message) => {
      g("add", "-A");
      g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message);
      return g("rev-parse", "HEAD").trim();
    };
    g("init", "-q", "-b", "main");
    write(at, `${JSON.stringify(JSON.parse(readFileSync(join(REPO_ROOT, at), "utf8")), null, 2)}\n`);
    write("tools/guard-qualification/cases.json", '{"cases":[]}\n');
    write(
      "tools/guard-qualification/check-support-matrix.js",
      'export const SCOPED_ENABLED = ["claude-native-hook:A"];\n',
    );
    write("packages/agents/src/permissions.ts", "export const x = 1;\n");
    // The checks-only build the receipt pins.
    const pinned = commit("checks-only build");
    // Recording it: the receipt, its bundle and the row's scoped claim, all after the build.
    const m = matrix();
    const claude = m.agents.find((a) => a.id === "claude");
    claude.scoped = { level: "A", route: "claude-native-hook", pin: { build: pinned }, receipts: ["r.json"] };
    write(at, `${JSON.stringify(m, null, 2)}\n`);
    write("tools/guard-qualification/receipts/claude-scoped.json", "{}\n");
    write("docs/agent-support.md", "Claude: scoped A\n");
    commit("record the scoped claim");
    expect(staleProblems(root, pinned)).toEqual([]);

    // Anything the receipt was judged against still counts, one change at a time.
    const changes = {
      "a route's eligibility": () => {
        const n = matrix();
        n.paths.find((p) => p.id === "claude-native-hook").recoveryUnverified = [];
        write(at, `${JSON.stringify(n, null, 2)}\n`);
      },
      "a row's routes": () => {
        const n = matrix();
        n.agents.find((a) => a.id === "claude").routes.push("acp-ask");
        write(at, `${JSON.stringify(n, null, 2)}\n`);
      },
      "a path's cases": () => {
        const n = matrix();
        delete n.paths.find((p) => p.id === "claude-native-hook").excluded.F04;
        write(at, `${JSON.stringify(n, null, 2)}\n`);
      },
      "the case catalogue": () => write("tools/guard-qualification/cases.json", '{"cases":[{"id":"X"}]}\n'),
      "the enabled scopes": () =>
        write(
          "tools/guard-qualification/check-support-matrix.js",
          'export const SCOPED_ENABLED = ["claude-native-hook:B"];\n',
        ),
      "covered source": () => write("packages/agents/src/permissions.ts", "export const x = 2;\n"),
    };
    const recorded = g("rev-parse", "HEAD").trim();
    for (const [what, change] of Object.entries(changes)) {
      change();
      commit(`change ${what}`);
      expect(staleProblems(root, pinned), what).toHaveLength(1);
      expect(staleProblems(root, pinned)[0], what).toContain(`build ${pinned} is stale`);
      g("reset", "-q", "--hard", recorded);
    }
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
