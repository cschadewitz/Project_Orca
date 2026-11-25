/**
 * Binds a support-matrix receipt to the run that produced it (#706, #1026).
 *
 * A receipt only counts toward tier A or B when GitHub's artifact attestation for that exact
 * file verifies: it was signed by the receipts workflow below, through the job's OIDC identity,
 * on a GitHub-hosted runner, in this repository, from `main` or a release line, at the commit
 * the receipt names as its `build`. A receipt written by hand, produced on a laptop, in a fork
 * or on a self-hosted runner, or edited after signing, has no such attestation and is refused.
 *
 * The Sigstore bundle is committed beside the receipt (`<receipt>.sigstore.json`), so the check
 * needs no attestation API lookup; `gh` still needs Sigstore's public trust root and a token,
 * which every GitHub Actions job has. Verification runs in CI (`guard-matrix.yml`), never in
 * the unit tests: they inject a verifier instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const REPOSITORY = "cschadewitz/Project_Orca";
/** The only workflow whose signature makes a receipt count. */
export const RECEIPTS_WORKFLOW = `${REPOSITORY}/.github/workflows/guard-receipts.yml`;
/** Refs a receipt may be produced from: main, or a release line (docs/RELEASING.md). */
export const RECEIPT_REFS = [/^refs\/heads\/main$/, /^refs\/heads\/release\/\d+\.\d+$/];

/** Where a receipt's Sigstore bundle is committed. */
export const bundlePathFor = (receiptPath) => `${receiptPath}.sigstore.json`;

/**
 * Why the receipt at `receiptPath` (repository-relative) is not bound to a trusted run. Empty
 * when `gh attestation verify` accepts its committed bundle under every constraint above.
 * `run` is injectable for tests; it receives gh's argument list and returns its stdout or throws.
 */
export function attestationProblems(repoRoot, receiptPath, receipt, run = runGh) {
  const version = ghVersionProblem(run, repoRoot);
  if (version) return [version];
  const bundle = bundlePathFor(receiptPath);
  if (!existsSync(join(repoRoot, bundle))) return [`no attestation bundle ${bundle}`];
  if (!/^[0-9a-f]{40}$/.test(receipt?.build ?? "")) return ["names no exact build to verify against"];
  let out;
  try {
    out = run(
      [
        "attestation",
        "verify",
        join(repoRoot, receiptPath),
        "--bundle",
        join(repoRoot, bundle),
        "--repo",
        REPOSITORY,
        "--signer-workflow",
        RECEIPTS_WORKFLOW,
        "--source-digest",
        receipt.build,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
      repoRoot,
    );
  } catch (error) {
    return [`attestation does not verify: ${firstLine(error)}`];
  }
  let results;
  try {
    results = JSON.parse(out);
  } catch {
    return ["attestation verification printed no JSON"];
  }
  if (!Array.isArray(results) || results.length === 0) return ["attestation verification returned no result"];
  const problems = [];
  for (const r of results) {
    const cert = r?.verificationResult?.signature?.certificate ?? {};
    if (cert.sourceRepositoryDigest !== receipt.build)
      problems.push(`attested at ${cert.sourceRepositoryDigest ?? "an unknown commit"}, not ${receipt.build}`);
    if (!RECEIPT_REFS.some((re) => re.test(cert.sourceRepositoryRef ?? "")))
      problems.push(`attested from ${cert.sourceRepositoryRef ?? "an unknown ref"}, not main or a release line`);
    if (cert.runnerEnvironment !== "github-hosted")
      problems.push(`attested on a ${cert.runnerEnvironment ?? "unknown"} runner`);
    // The signer, checked here exactly rather than by gh's --signer-workflow alone: this
    // workflow file, at the ref the receipt was produced from, at the receipt's own commit,
    // so the signer that ran is the revision reviewed with the code it certified.
    const signer = `https://github.com/${RECEIPTS_WORKFLOW}@${cert.sourceRepositoryRef}`;
    if (cert.buildSignerURI !== signer)
      problems.push(`signed by ${cert.buildSignerURI ?? "an unknown workflow"}, not ${signer}`);
    if (cert.buildSignerDigest !== receipt.build)
      problems.push(`signer workflow at ${cert.buildSignerDigest ?? "an unknown revision"}, not ${receipt.build}`);
  }
  return problems;
}

/**
 * The oldest GitHub CLI whose `--signer-workflow` must match the whole workflow path: earlier
 * ones (2.51.0 to 2.101.0) took any workflow whose path began with it (GHSA-wjmr-j3rp-mh2g).
 */
export const MIN_GH_VERSION = [2, 102, 0];

function ghVersionProblem(run, cwd) {
  let out;
  try {
    out = run(["--version"], cwd);
  } catch (error) {
    return `gh cannot run: ${firstLine(error)}`;
  }
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(out ?? "");
  if (!m) return "gh printed no version";
  const have = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] > MIN_GH_VERSION[i]) return undefined;
    if (have[i] < MIN_GH_VERSION[i])
      return `gh ${have.join(".")} is older than ${MIN_GH_VERSION.join(".")}, which matches --signer-workflow exactly (GHSA-wjmr-j3rp-mh2g)`;
  }
  return undefined;
}

function runGh(args, cwd) {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

/**
 * Whether the code and requirements a receipt certified are still those at HEAD. A receipt pins
 * one exact build, but the release need not be that commit: the release gate (`--release`)
 * accepts a descendant of it whose certified inputs are unchanged, and refuses a promoted row,
 * or a scoped claim, whose build differs from HEAD in anything but:
 *
 * - documentation, changelog fragments and the receipts themselves (`EXEMPT`);
 * - a `package.json`'s `version` field, which a release commit bumps (every other field,
 *   scripts and dependencies included, must be unchanged);
 * - in the support matrix, a row's `tier`, `pin`, `receipts` and `scoped`: the promotion or the
 *   scoped claim and the pointer to its evidence, which can only be written after the build
 *   they pin. The claim itself is still checked against its receipts (`scopedProblems`). The
 *   routes, route paths and their eligibility (`knownFailOpen`, `recoveryUnverified`), cases,
 *   exclusions and requirements the receipts were judged against must be unchanged.
 *
 * Everything else, workflows and build and packaging configuration included, counts.
 */
export const EXEMPT = [/^docs\//, /\.md$/, /^changelog\.d\//, /^tools\/guard-qualification\/receipts\//];
const MATRIX = "tools/guard-qualification/support-matrix.json";

export function staleProblems(repoRoot, build, run = runGit) {
  try {
    run(["merge-base", "--is-ancestor", build, "HEAD"], repoRoot);
  } catch {
    return [`build ${build} is not an ancestor of HEAD`];
  }
  let changed;
  try {
    changed = run(["diff", "--name-only", "--no-renames", build, "HEAD"], repoRoot).split("\n").filter(Boolean);
  } catch (error) {
    return [`cannot compare build ${build} with HEAD: ${firstLine(error)}`];
  }
  const show = (rev, file) => {
    try {
      return JSON.parse(run(["show", `${rev}:${file}`], repoRoot));
    } catch {
      return undefined;
    }
  };
  const counted = changed.filter((file) => {
    if (EXEMPT.some((re) => re.test(file))) return false;
    if (file === "package.json" || file.endsWith("/package.json"))
      return !sameJson(withoutVersion(show(build, file)), withoutVersion(show("HEAD", file)));
    if (file === MATRIX) return !sameJson(requirements(show(build, file)), requirements(show("HEAD", file)));
    return true;
  });
  if (counted.length === 0) return [];
  const shown = counted.slice(0, 5).join(", ");
  return [
    `build ${build} is stale: ${counted.length} certified file(s) changed since (${shown}${counted.length > 5 ? ", …" : ""})`,
  ];
}

const withoutVersion = (pkg) => (pkg && typeof pkg === "object" ? { ...pkg, version: undefined } : pkg);
/** The matrix less what recording a certification may change: each row's tier, pin, receipts and scoped claim. */
const requirements = (m) =>
  m && Array.isArray(m.agents)
    ? {
        ...m,
        agents: m.agents.map((a) => ({
          ...a,
          tier: undefined,
          pin: undefined,
          receipts: undefined,
          scoped: undefined,
        })),
      }
    : m;
const sameJson = (a, b) => a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function firstLine(error) {
  const text = String(error?.stderr || error?.message || error).trim();
  return text.split("\n")[0].slice(0, 300);
}
