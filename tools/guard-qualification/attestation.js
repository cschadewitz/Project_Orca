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
  }
  return problems;
}

function runGh(args, cwd) {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

/**
 * Whether the code a receipt certified is still the code at HEAD. A tier is certified for one
 * build; the release gate (`--release`) refuses a row whose build differs from HEAD in any
 * path that decides or carries enforcement. Changes only to docs, receipts, the matrix itself
 * and `package.json` files leave a certification current: a release commit bumps every
 * package's version, and a dependency change shows in the lockfile.
 */
export const CERTIFIED_PATHS = ["packages", "tools/guard-qualification", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
export const NOT_CERTIFIED = [
  ":(exclude)tools/guard-qualification/receipts",
  ":(exclude)tools/guard-qualification/support-matrix.json",
  ":(glob,exclude)**/*.md",
  ":(glob,exclude)**/package.json",
];

export function staleProblems(repoRoot, build, run = runGit) {
  try {
    run(["merge-base", "--is-ancestor", build, "HEAD"], repoRoot);
  } catch {
    return [`build ${build} is not an ancestor of HEAD`];
  }
  let changed;
  try {
    changed = run(["diff", "--name-only", build, "HEAD", "--", ...CERTIFIED_PATHS, ...NOT_CERTIFIED], repoRoot)
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    return [`cannot compare build ${build} with HEAD: ${firstLine(error)}`];
  }
  if (changed.length === 0) return [];
  const shown = changed.slice(0, 5).join(", ");
  return [
    `build ${build} is stale: ${changed.length} certified file(s) changed since (${shown}${changed.length > 5 ? ", …" : ""})`,
  ];
}

function runGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function firstLine(error) {
  const text = String(error?.stderr || error?.message || error).trim();
  return text.split("\n")[0].slice(0, 300);
}
