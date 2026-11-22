// The patch-content gate for release line branches (docs/RELEASING.md, "Release lines").
//
// A pull request into `release/X.Y` may only carry work for a patch of that line: it must
// name at least one issue (`Fixes #N`, `Refs #N`, `Backport of #N`, ...), and every issue it
// names must be in a milestone of that line (`X.Y.Z`, Z > 0) and carry no `release:minor` or
// `release:major` label. The release pull request `release-prepare.yml` opens for the line is
// checked instead as what it must be: label `release`, head `release/vX.Y.Z` in this
// repository, a version whose lane (tools/release-lane.js) is this line, and a diff that is
// exactly a release preparation (the version bump, the CHANGELOG section, deleted fragments).
// A label or a branch name alone exempts nothing.
//
// Usage (in .github/workflows/release-line-guard.yml): node tools/release-line-guard.js
// reads the pull_request event from GITHUB_EVENT_PATH and each named issue through `gh api`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIPT_TITLE, laneOf, receiptMessage, releaseDiffProblems } from "./release-lane.js";

const BUMPS = new Set(["release:minor", "release:major"]);
const REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|part of|backport of)\s*:?\s+#(\d+)\b/gi;

/** The line a base branch names, or undefined: `release/0.7` -> { major: 0, minor: 7 }. */
export function lineOf(base) {
  const m = /^release\/(\d+)\.(\d+)$/.exec(base ?? "");
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined;
}

/** Issue numbers a pull request body names with a linking keyword, in order, once each. */
export function referencedIssues(body) {
  const found = [];
  for (const m of String(body ?? "").matchAll(REFERENCE)) {
    const n = Number(m[1]);
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

/** Whether a milestone title names a patch of the line (`0.7.1`, `v0.7.2`, `0.7.1-rc.1`). */
export function inLine(title, line) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(title ?? "").trim());
  return Boolean(m) && Number(m[1]) === line.major && Number(m[2]) === line.minor && Number(m[3]) > 0;
}

/**
 * Problems with a pull request into a line branch; empty means it may merge.
 * `pr`: { base, head, labels: [name], milestone: title | null, body, sameRepository,
 *   release: { files: [{ filename, status }], basePackage, headPackage } }.
 * `issues`: { [number]: { labels: [name], milestone: title | null, isPullRequest } }.
 */
export function checkLinePullRequest(pr, issues) {
  const line = lineOf(pr.base);
  if (!line) return [`${pr.base} is not a release line branch (release/X.Y)`];
  const name = `${line.major}.${line.minor}`;
  const problems = [];
  const bump = (pr.labels ?? []).find((l) => BUMPS.has(l));
  if (bump) problems.push(`the pull request is labelled ${bump}; minor and major work never goes into release/${name}`);
  if (pr.milestone && !inLine(pr.milestone, line))
    problems.push(`the pull request's milestone "${pr.milestone}" is not a ${name}.x patch milestone`);

  // Release-shaped by label or by head: then it must be the release preparation, nothing else.
  const release = /^release\/v(.+)$/.exec(pr.head ?? "");
  if ((pr.labels ?? []).includes("release") || release) {
    if (!(pr.labels ?? []).includes("release"))
      problems.push("a release/vX.Y.Z pull request must carry the release label");
    if (!release) return [...problems, `a release pull request's head must be release/vX.Y.Z, not ${pr.head}`];
    const version = release[1];
    let lane;
    try {
      lane = laneOf(version);
    } catch (error) {
      return [...problems, error.message];
    }
    if (lane !== pr.base) problems.push(`v${version} is cut from ${lane}, not ${pr.base}`);
    if (!pr.sameRepository) problems.push("a release pull request must come from this repository");
    problems.push(...releaseDiffProblems({ version, ...pr.release }));
    return problems;
  }

  const numbers = referencedIssues(pr.body);
  if (!numbers.length)
    problems.push(`name the ${name}.x issue this fixes in the description (Fixes #N, Refs #N or Backport of #N)`);
  for (const n of numbers) {
    const issue = issues[n];
    if (!issue) {
      problems.push(`#${n} could not be read`);
      continue;
    }
    if (issue.isPullRequest) continue; // a backport names its source pull request too
    const label = (issue.labels ?? []).find((l) => BUMPS.has(l));
    if (label) problems.push(`#${n} is labelled ${label}; it belongs to the next minor, not release/${name}`);
    if (!inLine(issue.milestone, line))
      problems.push(`#${n} is in milestone "${issue.milestone ?? "none"}", not a ${name}.x patch milestone`);
  }
  if (numbers.length && numbers.every((n) => issues[n]?.isPullRequest))
    problems.push(`name at least one ${name}.x issue, not only pull requests`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const p = event.pull_request;
  // First, whatever the verdict: which pull request, line and head this run judged. The check
  // run's conclusion is the verdict; this receipt is what ties it to the pull request
  // (tools/release-lane.js, RECEIPT_TITLE).
  console.log(
    `::notice title=${RECEIPT_TITLE}::${receiptMessage({ number: p.number, base: p.base.ref, head: p.head.sha })}`,
  );
  const api = (path, ...flags) =>
    execFileSync("gh", ["api", ...flags, `repos/${process.env.GITHUB_REPOSITORY}/${path}`], { encoding: "utf8" });
  const pkg = (sha) =>
    JSON.parse(Buffer.from(JSON.parse(api(`contents/package.json?ref=${sha}`)).content, "base64").toString("utf8"));
  const pr = {
    base: p.base.ref,
    head: p.head.ref,
    labels: p.labels.map((l) => l.name),
    milestone: p.milestone?.title ?? null,
    body: p.body ?? "",
    sameRepository: p.head.repo?.full_name === process.env.GITHUB_REPOSITORY,
  };
  if (pr.labels.includes("release") || /^release\/v/.test(pr.head)) {
    // Read through the API: nothing from the pull request is checked out or run.
    const files = api(`pulls/${p.number}/files?per_page=100`, "--paginate", "--jq", ".[] | {filename, status}")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    pr.release = { files, basePackage: pkg(p.base.sha), headPackage: pkg(p.head.sha) };
  }
  const issues = {};
  for (const n of referencedIssues(pr.body)) {
    try {
      const issue = JSON.parse(api(`issues/${n}`));
      issues[n] = {
        labels: issue.labels.map((l) => l.name),
        milestone: issue.milestone?.title ?? null,
        isPullRequest: Boolean(issue.pull_request),
      };
    } catch {
      // Reported as "could not be read" below.
    }
  }
  const problems = checkLinePullRequest(pr, issues);
  if (problems.length) {
    for (const problem of problems) console.log(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`release line check passed for ${pr.head} -> ${pr.base}`);
}
