// The one version-to-lane policy every release workflow uses (docs/RELEASING.md, "Release
// lines"). Every release of `X.Y`, its `.0` and that `.0`'s candidates included, is cut from its
// protected release line `release/X.Y`. The line of a new minor or major is created from `main`
// when its first candidate (or its `.0`, without candidates) is prepared, so `main` keeps taking
// the next minor's work while `X.Y.0` stabilizes; the line of an older minor is created from its
// newest final tag. Nothing else is eligible: a release commit that is not on its line is refused.
//
// A line is trusted only while a ruleset protects it: pull requests only, no force pushes or
// deletion, and both the CI check and the release line check required. Prepare, publish,
// signing and the server bundle check that with the rules API before they build, sign or open
// anything from a line.
//
// Usage (tools only: no dependencies, runs from main's checkout against any repository):
//   node tools/release-lane.js lane <version>              -> release/X.Y
//   node tools/release-lane.js verify <sha> <version>      -> "<lane> <head sha>", from the cwd's
//                                                             git repository and `gh api`
//   node tools/release-lane.js on-lane <sha> <version>     -> "<lane>", from `gh api` alone (no
//                                                             checkout): the commit is on its
//                                                             protected lane
//   node tools/release-lane.js rehearse <sha> <version>    -> what `verify` would say, for a dry
//                                                             run; reports, never refuses
//   node tools/release-lane.js release-pr <event.json>     -> checks a merged release pull
//                                                             request before it is published
//   node tools/release-lane.js guard-evidence <pr> <base> <head>
//                                                          -> the guard's newest trusted pass for
//                                                             that pull request (publishes nothing)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LINE_CHECKS = ["check (node 24)", "release line check"];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The branch a version may be cut from: its line, `release/X.Y`, for every version of X.Y. */
export function laneOf(version) {
  const m = SEMVER.exec(String(version ?? ""));
  if (!m) throw new Error(`not a semver version: ${version}`);
  return `release/${Number(m[1])}.${Number(m[2])}`;
}

/** Whether a version is a new minor or major (`X.Y.0` or one of its candidates). */
export function isNewLine(version) {
  const m = SEMVER.exec(String(version ?? ""));
  if (!m) throw new Error(`not a semver version: ${version}`);
  return Number(m[3]) === 0;
}

// GitHub Actions' app id: a required check pinned to it can only be satisfied by a workflow.
export const ACTIONS_APP_ID = 15368;

/**
 * What a line's active rules (GET /repos/R/rules/branches/B) lack, empty when it is protected
 * enough to be a release source: a pull request for every change, no force push, no deletion,
 * and LINE_CHECKS required from GitHub Actions with branches kept up to date.
 */
export function protectionProblems(rules) {
  const types = new Set((rules ?? []).map((r) => r.type));
  const problems = [];
  if (!types.has("pull_request")) problems.push("changes must require a pull request");
  if (!types.has("non_fast_forward")) problems.push("force pushes must be blocked");
  if (!types.has("deletion")) problems.push("deletion must be restricted");
  const statusRules = (rules ?? []).filter((r) => r.type === "required_status_checks");
  const required = statusRules.flatMap((r) => r.parameters?.required_status_checks ?? []);
  for (const check of LINE_CHECKS) {
    const entries = required.filter((c) => c.context === check);
    if (!entries.length) problems.push(`"${check}" must be a required check`);
    else if (!entries.some((c) => c.integration_id === ACTIONS_APP_ID))
      problems.push(`"${check}" must be required from GitHub Actions, not any source`);
  }
  if (!statusRules.some((r) => r.parameters?.strict_required_status_checks_policy === true))
    problems.push("branches must be up to date before merging");
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
  const problems = protectionProblems(ghJson(`repos/${repo()}/rules/branches/${lane}`));
  if (problems.length) die(`${lane} is not protected as a release line: ${problems.join("; ")}`);
  if (!isAncestor(sha, head)) die(`${sha} (v${version}) is not on ${lane}, the only branch it may come from`);
  console.log(`${lane} ${head}`);
}

/**
 * `verify` without a checkout: the commit is on its version's protected lane, read through the
 * compare and rules APIs only. For jobs that check out nothing but main's tooling (the server
 * bundle's resolve job).
 */
function onLane(sha, version) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) die(`not a full commit sha: ${sha}`);
  let lane;
  try {
    lane = laneOf(version);
  } catch (error) {
    die(error.message);
  }
  const problems = protectionProblems(ghJson(`repos/${repo()}/rules/branches/${lane}`));
  if (problems.length) die(`${lane} is not protected as a release line: ${problems.join("; ")}`);
  let status;
  try {
    status = ghJson(`repos/${repo()}/compare/${sha}...${lane}`).status;
  } catch {
    die(`${lane}, the only branch v${version} may come from, does not exist or cannot be compared with ${sha}`);
  }
  if (status !== "ahead" && status !== "identical")
    die(`${sha} (v${version}) is not on ${lane} (${status}), the only branch it may come from`);
  console.log(lane);
}

/**
 * A dry run's look at the lane gate, which a dry run otherwise skips: what `verify` would say
 * about this commit as a release of `version`, without refusing anything. A commit already on its
 * protected line passes as it stands. For a release pull request head that is up to date with its
 * line (the line's head is an ancestor) it reports only that ancestry and protection preflight:
 * the merged pull request, the exact-head line check and the same-tree requirement that
 * publication enforces are not checked here. Prints one line and exits 0, so a rehearsal
 * reports the gate without depending on it.
 */
function rehearse(sha, version) {
  let lane;
  try {
    lane = laneOf(version);
  } catch (error) {
    return console.log(`lane gate would refuse: ${error.message}`);
  }
  let head;
  try {
    head = git("rev-parse", "--verify", `refs/remotes/origin/${lane}^{commit}`);
  } catch {
    return console.log(
      isNewLine(version)
        ? `lane gate: ${lane} does not exist yet; preparing v${version} cuts it from main, and the gate then requires the release commit on it`
        : `lane gate would refuse: ${lane}, the only branch v${version} may come from, does not exist`,
    );
  }
  let problems;
  try {
    problems = protectionProblems(ghJson(`repos/${repo()}/rules/branches/${lane}`));
  } catch {
    problems = ["its rules could not be read"];
  }
  if (problems.length) return console.log(`lane gate would refuse: ${lane} is not protected: ${problems.join("; ")}`);
  if (isAncestor(sha, head)) return console.log(`lane gate would accept: ${sha} (v${version}) is on ${lane}`);
  if (isAncestor(head, sha))
    return console.log(
      `lane gate preflight passed (ancestry and protection only): ${sha} (v${version}) is up to date with protected ${lane} at ${head}; ` +
        "publication still requires the merged release pull request, its exact-head line check and the same tree",
    );
  console.log(`lane gate would refuse: ${sha} (v${version}) is neither on ${lane} nor up to date with it (${head})`);
}

export const GUARD_WORKFLOW = ".github/workflows/release-line-guard.yml";

/**
 * The receipt main's guard writes when it passes a pull request: a notice annotation on its own
 * check run, `::notice title=RECEIPT_TITLE::{"pr":N,"base":"release/X.Y","head":"<sha>"}`.
 * GitHub leaves `pull_requests` empty on pull_request_target runs, and a run's display title is
 * the pull request's own title unless the workflow sets one, so neither binds a result to its
 * pull request. The receipt does: only the guard script writes annotations on that check run
 * (it runs none of the pull request's code), runs from before this receipt existed carry none,
 * and annotations stay with the check run after the pull request closes.
 */
export const RECEIPT_TITLE = "release line receipt v1";
export const receiptMessage = ({ number, base, head }) => JSON.stringify({ pr: number, base, head });

/**
 * Whether a check run is the release line guard as main runs it: by GitHub Actions, from
 * main's release-line-guard.yml on a pull_request_target event, attached to exactly `headSha`,
 * and linked to this pull request (`pr.number`) into this line (`pr.base`) by its receipt.
 * The check run binds the commit: a pull_request_target run itself runs main's revision. A
 * check name alone is not provenance: anything with checks: write could post one.
 */
export function guardRunProblems(checkRun, workflowRun, annotations, headSha, pr = {}) {
  const problems = [];
  if (checkRun?.conclusion !== "success") problems.push("it did not succeed");
  problems.push(...guardSourceProblems(checkRun, workflowRun, headSha));
  // For this pull request into this line, at this head: a pass for another pull request that
  // shares the commit, or for the same commit aimed at another branch, is not this one's.
  if (guardBinding(checkRun, annotations, headSha, pr) !== "this")
    problems.push(`it is not linked to #${pr.number} into ${pr.base} at ${headSha}`);
  return problems;
}

/** Whether a check run is main's guard, run by GitHub Actions on `headSha`; empty when it is. */
export function guardSourceProblems(checkRun, workflowRun, headSha) {
  const problems = [];
  if (checkRun?.head_sha !== headSha) problems.push(`it ran on ${checkRun?.head_sha}, not ${headSha}`);
  if (checkRun?.app?.slug !== "github-actions")
    problems.push(`it was posted by ${checkRun?.app?.slug ?? "an unknown app"}`);
  if (workflowRun?.path !== GUARD_WORKFLOW) problems.push(`it came from ${workflowRun?.path ?? "no workflow"}`);
  if (workflowRun?.event !== "pull_request_target") problems.push(`it ran on ${workflowRun?.event ?? "no"} event`);
  return problems;
}

/**
 * Which pull request a trusted guard attempt is shown to belong to: "this" (its receipt or
 * GitHub's link names this pull request, line and head, and nothing names anything else),
 * "other" (every piece of evidence is well formed and names another pull request, line or
 * head), or "unbound": no evidence (it failed or was cancelled before writing its receipt and
 * GitHub left no link), malformed evidence, or evidence that names both. An unbound attempt
 * could be this pull request's, so it is never skipped over.
 */
export function guardBinding(checkRun, annotations, headSha, pr = {}) {
  const named = [];
  for (const a of annotations ?? []) {
    if (a?.annotation_level !== "notice" || a?.title !== RECEIPT_TITLE) continue;
    let receipt;
    try {
      receipt = JSON.parse(a.message);
    } catch {
      return "unbound";
    }
    const keys = Object.keys(receipt ?? {})
      .sort()
      .join(",");
    if (
      keys !== "base,head,pr" ||
      !Number.isInteger(receipt.pr) ||
      typeof receipt.base !== "string" ||
      !/^[0-9a-f]{40}$/.test(receipt.head ?? "")
    )
      return "unbound";
    named.push({ number: receipt.pr, base: receipt.base, head: receipt.head });
  }
  for (const link of checkRun?.pull_requests ?? []) {
    const head = link?.head?.sha ?? headSha;
    if (!Number.isInteger(link?.number) || typeof link?.base?.ref !== "string" || typeof head !== "string")
      return "unbound";
    named.push({ number: link.number, base: link.base.ref, head });
  }
  const isThis = (n) => n.number === pr.number && n.base === pr.base && n.head === headSha;
  if (!named.length) return "unbound";
  if (named.every(isThis)) return "this";
  if (named.some(isThis)) return "unbound";
  return "other";
}

const versionAt = (sha) => {
  try {
    return JSON.parse(git("show", `${sha}:package.json`)).version;
  } catch {
    return undefined;
  }
};

/**
 * The newest release line check recorded for pull request `number` into `base` at `head`, which
 * must be a trusted pass; dies otherwise. Only that pull request's results count, and an older
 * pass does not outlive a later failure (a relabel, a milestone change, an edited body). It
 * publishes nothing, so it can be run against any pull request, open or closed.
 */
function guardEvidence({ number, base, head }) {
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) die(`not a full commit sha: ${head}`);
  const runs = ghJson(
    `repos/${repo()}/commits/${head}/check-runs?check_name=${encodeURIComponent("release line check")}&filter=all`,
  ).check_runs;
  const target = { number, base };
  // Every attempt by main's guard on this head, newest first, except those shown to be another
  // pull request's or another line's. The newest of them is the current verdict.
  const attempts = (runs ?? [])
    .map((run) => ({
      run,
      workflow: run.check_suite?.id
        ? ghJson(`repos/${repo()}/actions/runs?check_suite_id=${run.check_suite.id}`).workflow_runs?.[0]
        : undefined,
    }))
    .filter(({ run, workflow }) => !guardSourceProblems(run, workflow, head).length)
    .map((attempt) => {
      const annotations = ghJson(`repos/${repo()}/check-runs/${attempt.run.id}/annotations`);
      return { ...attempt, annotations, binding: guardBinding(attempt.run, annotations, head, target) };
    })
    .filter(({ binding }) => binding !== "other")
    .sort((a, b) => Number(b.run.id) - Number(a.run.id));
  if (!attempts.length)
    die(`no release line check, as main runs it, for #${number} into ${base} ran on the reviewed head ${head}`);
  const { run: newest, workflow, annotations, binding } = attempts[0];
  if (binding === "unbound")
    die(
      `the newest release line check on ${head} (check run ${newest.id}, ${newest.conclusion ?? newest.status}) ` +
        `left no receipt, so whether #${number} into ${base} passed is inconclusive; rerun the guard`,
    );
  const problems = guardRunProblems(newest, workflow, annotations, head, target);
  if (problems.length)
    die(
      `the release line check, as main runs it, did not pass on the reviewed head ${head} ` +
        `(its newest result for #${number}, check run ${newest.id}: ${problems.join(", ")})`,
    );
  console.log(`release line check run ${newest.id} passed #${number} into ${base} at ${head}`);
}

/**
 * A merged release pull request may start publication only if it is the release preparation
 * that was reviewed: from this repository, `release/vV` into V's line, package.json saying V
 * at both the reviewed head and the merge commit, the merge commit's tree equal to that head's
 * tree, and the release line guard as main runs it passed on that exact head.
 */
function releasePr(eventPath, sha) {
  const pr = JSON.parse(readFileSync(eventPath, "utf8")).pull_request;
  if (!pr?.merged) die("the pull request did not merge");
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) die(`not a full commit sha: ${sha}`);
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
  if (!/^[0-9a-f]{40}$/.test(pr.head.sha ?? "")) die(`not a full commit sha: ${pr.head.sha}`);
  try {
    git("fetch", "-q", "origin", pr.head.sha);
  } catch {
    die(`the reviewed head ${pr.head.sha} could not be fetched`);
  }
  for (const [what, at] of [
    ["the reviewed head", pr.head.sha],
    ["the merge commit", sha],
  ]) {
    const found = versionAt(at);
    if (found !== version) die(`package.json at ${what} ${at} says ${found}, not ${version}`);
  }
  if (git("rev-parse", `${sha}^{tree}`) !== git("rev-parse", `${pr.head.sha}^{tree}`))
    die(`the merge commit ${sha} is not the reviewed head ${pr.head.sha}; update the branch and review again`);
  guardEvidence({ number: pr.number, base: lane, head: pr.head.sha });
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
  else if (command === "on-lane") onLane(args[0], args[1]);
  else if (command === "rehearse") rehearse(args[0], args[1]);
  else if (command === "release-pr") releasePr(args[0], args[1]);
  else if (command === "guard-evidence") guardEvidence({ number: Number(args[0]), base: args[1], head: args[2] });
  else
    die(
      "usage: node tools/release-lane.js lane <version> | verify <sha> <version> | on-lane <sha> <version> | rehearse <sha> <version> | release-pr <event.json> <sha> | guard-evidence <pr> <base> <head>",
    );
}
