// The one version-to-lane policy every release workflow uses (docs/RELEASING.md, "Release
// lines"). A new minor or major (`X.Y.0` and its candidates) is cut from `main`; a patch
// (`X.Y.Z`, Z > 0, and its candidates) only from its protected release line `release/X.Y`.
// Nothing else is eligible: a patch on `main`, or a `.0` release on a line, is refused.
//
// A line is trusted only while a ruleset protects it: pull requests only, no force pushes or
// deletion, and both the CI check and the release line check required. Prepare, publish and
// signing check that with the rules API before they build, sign or open anything from a line.
//
// Usage (tools only: no dependencies, runs from main's checkout against any repository):
//   node tools/release-lane.js lane <version>              -> main | release/X.Y
//   node tools/release-lane.js verify <sha> <version>      -> "<lane> <head sha>", from the cwd's
//                                                             git repository and `gh api`
//   node tools/release-lane.js release-pr <event.json>     -> checks a merged release pull
//                                                             request before it is published
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LINE_CHECKS = ["check (node 24)", "release line check"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The branch a version may be cut from. */
export function laneOf(version) {
  const m = SEMVER.exec(String(version ?? ""));
  if (!m) throw new Error(`not a semver version: ${version}`);
  return Number(m[3]) === 0 ? "main" : `release/${Number(m[1])}.${Number(m[2])}`;
}

/**
 * What a line's active rules (GET /repos/R/rules/branches/B) lack, empty when it is protected
 * enough to be a release source: a pull request for every change, no force push, no deletion,
 * and LINE_CHECKS required.
 */
export function protectionProblems(rules) {
  const types = new Set((rules ?? []).map((r) => r.type));
  const problems = [];
  if (!types.has("pull_request")) problems.push("changes must require a pull request");
  if (!types.has("non_fast_forward")) problems.push("force pushes must be blocked");
  if (!types.has("deletion")) problems.push("deletion must be restricted");
  const required = new Set(
    (rules ?? [])
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters?.required_status_checks ?? [])
      .map((c) => c.context),
  );
  for (const check of LINE_CHECKS) if (!required.has(check)) problems.push(`"${check}" must be a required check`);
  return problems;
}

/** The release-preparation shape of a release pull request's changes; problems, or empty. */
export function releaseDiffProblems({ version, files, basePackage, headPackage }) {
  const problems = [];
  const strip = (pkg) => {
    const copy = { ...pkg };
    delete copy.version;
    return JSON.stringify(copy);
  };
  if (headPackage?.version !== version)
    problems.push(`package.json at the head says ${headPackage?.version}, not ${version}`);
  if (basePackage?.version === version) problems.push(`the base already says ${version}`);
  if (strip(basePackage ?? {}) !== strip(headPackage ?? {}))
    problems.push("package.json changes more than its version");
  for (const f of files ?? []) {
    const ok =
      (f.filename === "package.json" && f.status === "modified") ||
      (f.filename === "CHANGELOG.md" && f.status === "modified") ||
      (/^changelog\.d\/[^/]+\.md$/.test(f.filename) &&
        f.filename !== "changelog.d/README.md" &&
        f.status === "removed");
    if (!ok) problems.push(`${f.filename} (${f.status}) is not part of a release preparation`);
  }
  if (!(files ?? []).some((f) => f.filename === "package.json")) problems.push("package.json is not bumped");
  if (!(files ?? []).some((f) => f.filename === "CHANGELOG.md")) problems.push("CHANGELOG.md has no new section");
  return problems;
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const isAncestor = (sha, ref) => {
  try {
    git("merge-base", "--is-ancestor", sha, ref);
    return true;
  } catch {
    return false;
  }
};
const ghJson = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
const repo = () => process.env.GITHUB_REPOSITORY ?? die("GITHUB_REPOSITORY is not set");
function die(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

/** The lane a commit of `version` may be released or signed from, and that lane's head. */
function verify(sha, version) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) die(`not a full commit sha: ${sha}`);
  let lane;
  try {
    lane = laneOf(version);
  } catch (error) {
    die(error.message);
  }
  let head;
  try {
    head = git("rev-parse", "--verify", `refs/remotes/origin/${lane}^{commit}`);
  } catch {
    die(`${lane}, the only branch v${version} may come from, does not exist`);
  }
  if (lane !== "main") {
    const problems = protectionProblems(ghJson(`repos/${repo()}/rules/branches/${lane}`));
    if (problems.length) die(`${lane} is not protected as a release line: ${problems.join("; ")}`);
  }
  if (!isAncestor(sha, head)) die(`${sha} (v${version}) is not on ${lane}, the only branch it may come from`);
  console.log(`${lane} ${head}`);
}

/**
 * A merged release pull request may start publication only if it is the release preparation
 * the guard passed: from this repository, `release/vV` into V's lane, the guard green on the
 * exact head that was reviewed, and the merge commit's tree equal to that head's tree.
 */
function releasePr(eventPath, sha) {
  const pr = JSON.parse(readFileSync(eventPath, "utf8")).pull_request;
  if (!pr?.merged) die("the pull request did not merge");
  const version = /^release\/v(.+)$/.exec(pr.head.ref)?.[1];
  if (!version) die(`${pr.head.ref} is not a release pull request head (release/vX.Y.Z)`);
  let lane;
  try {
    lane = laneOf(version);
  } catch (error) {
    die(error.message);
  }
  if (pr.head.repo?.full_name !== repo()) die("a release pull request must come from this repository");
  if (pr.base.ref !== lane) die(`v${version} is cut from ${lane}, but the pull request merged into ${pr.base.ref}`);
  if (lane !== "main") {
    const runs = ghJson(
      `repos/${repo()}/commits/${pr.head.sha}/check-runs?check_name=${encodeURIComponent("release line check")}`,
    ).check_runs;
    if (!runs.some((r) => r.conclusion === "success"))
      die(`the release line check did not pass on the reviewed head ${pr.head.sha}`);
    git("fetch", "-q", "origin", pr.head.sha);
    if (git("rev-parse", `${sha}^{tree}`) !== git("rev-parse", `${pr.head.sha}^{tree}`))
      die(`the merge commit ${sha} is not the reviewed head ${pr.head.sha}; update the branch and review again`);
  }
  console.log(`release pull request #${pr.number}: v${version} into ${lane}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "lane") {
    try {
      console.log(laneOf(args[0]));
    } catch (error) {
      die(error.message);
    }
  } else if (command === "verify") verify(args[0], args[1]);
  else if (command === "release-pr") releasePr(args[0], args[1]);
  else die("usage: node tools/release-lane.js lane <version> | verify <sha> <version> | release-pr <event.json> <sha>");
}
