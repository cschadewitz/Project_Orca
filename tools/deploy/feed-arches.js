#!/usr/bin/env node
/**
 * Windows arm64 release evidence (#889): which architectures a release may be published and
 * fed with, and the arm64 baseline its native acceptance upgrades from.
 *
 *   feed-arches.js baseline-run VERSION RELEASES_JSON
 *       print the acceptance run id of VERSION's upgrade baseline candidate (the newest
 *       published final older than VERSION, from ARM64_EVIDENCE_FROM on, not marked x64-only,
 *       with an arm64 installer),
 *       or nothing; the caller fetches that run, with its jobs under "jobs", for the commands
 *       below (BASELINE_RUN_JSON)
 *   feed-arches.js baseline VERSION REPO RELEASES_JSON BASELINE_RUN_JSON
 *       print "VERSION DIGEST ASSET_ID" of the verified baseline, nothing when there is no
 *       candidate, and exit 1 when the candidate has no verified acceptance
 *   feed-arches.js acceptance-run VERSION RELEASE_JSON
 *       print the run id named by the release's single arm64 acceptance record, or nothing
 *   feed-arches.js verify VERSION REPO RELEASE_JSON RELEASES_JSON BASELINE_RUN_JSON RUN_JSON EVIDENCE_JSON
 *       exit 0 only if the release's arm64 installer passed native acceptance (below)
 *   feed-arches.js serve VERSION REPO RELEASE_JSON RELEASES_JSON [BASELINE_RUN_JSON RUN_JSON EVIDENCE_JSON]
 *       print "x64" or "x64 arm64" for feed-publish.yml; exit 1 if arm64 is attached, not
 *       declined, and its acceptance cannot be verified (so nothing is fed x64-only by mistake)
 *
 * The release's notes only point at evidence. release-attach.sh records
 * `<!-- orca-signed-run-arm64: RUN sha256:HEX -->` when it attaches the signed installer and
 * Release (accept Windows arm64) `<!-- orca-arm64-accepted: RUN sha256:HEX -->` when it
 * passes; an operator's x64-only decision is `<!-- orca-x64-only -->`. Acceptance verifies
 * only when the named run is a successful run of release-accept-arm64.yml on main in this
 * repository, and the `arm64-acceptance-evidence` artifact that run uploaded names this
 * release id, version, source commit and installer digest, with a mode and prior
 * version/digest equal to the baseline computed here from the published releases. That
 * baseline must itself carry signing and acceptance records for its installer naming a
 * successful acceptance run on main whose receipt job names that release, commit and
 * digest; a candidate without them stops the check rather than passing as a fresh install
 * or falling back to an older release.
 *
 * Finals before ARM64_EVIDENCE_FROM are never candidates. No release before it could carry
 * that proof: the signing and acceptance records start with #889, and v0.6.0's arm64
 * installer is unsigned. Excluding them by version, a fixed fact about the release list
 * rather than anything a release's notes say, keeps the no-fallback rule intact, and the
 * first arm64 final is accepted as a fresh install.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const FINAL = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SIGNED_ARM64 = /<!-- orca-signed-run-arm64: ([0-9]+) (sha256:[0-9a-f]{64}) -->/g;
const ACCEPTED_ARM64 = /<!-- orca-arm64-accepted: ([0-9]+) (sha256:[0-9a-f]{64}) -->/g;
export const X64_ONLY = "<!-- orca-x64-only -->";
export const ACCEPT_WORKFLOW = ".github/workflows/release-accept-arm64.yml";
export const EVIDENCE_ARTIFACT = "arm64-acceptance-evidence";
/** The first final that can carry signed arm64 and acceptance records (#889). */
export const ARM64_EVIDENCE_FROM = "0.7.1";

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const arm64Name = (version) => `ORCA-${version}-win-arm64.exe`;
const records = (body, pattern) => [...(body ?? "").matchAll(pattern)].map((m) => ({ run: m[1], digest: m[2] }));

/** The release's single arm64 installer asset, or undefined. */
export function arm64Asset(version, release) {
  const assets = (release?.assets ?? []).filter((a) => a.name === arm64Name(version));
  return assets.length === 1 ? assets[0] : undefined;
}

export const declined = (release) => (release?.body ?? "").includes(X64_ONLY);

/**
 * The newest published, non-prerelease final older than VERSION, from ARM64_EVIDENCE_FROM on,
 * that is not marked x64-only and carries an arm64 installer: the release an arm64
 * acceptance upgrades from. It is
 * chosen before its proof is looked at, so a missing proof never falls back to an older one.
 */
export function baselineCandidate(version, releases) {
  let best = null;
  for (const release of releases ?? []) {
    const tag = /^v(.+)$/.exec(release?.tag_name ?? "")?.[1];
    if (!tag || !FINAL.test(tag) || release.draft !== false || release.prerelease || !release.published_at) continue;
    if (compare(tag, version) >= 0 || compare(tag, ARM64_EVIDENCE_FROM) < 0 || declined(release)) continue;
    if (!(release.assets ?? []).some((a) => a.name === arm64Name(tag))) continue;
    if (!best || compare(tag, best.version) > 0) best = { version: tag, release };
  }
  return best;
}

/** The candidate's acceptance run id, for the caller to fetch; undefined if there is none. */
export const baselineRun = (version, releases) => {
  const candidate = baselineCandidate(version, releases);
  return candidate ? acceptanceRun(candidate.release) : undefined;
};

/** undefined if the release's records name one signed, accepted arm64 installer, else why. */
function recordProblem(version, release) {
  if (declined(release)) return `v${version} is marked x64-only`;
  const asset = arm64Asset(version, release);
  if (!asset || !DIGEST.test(asset.digest ?? ""))
    return `v${version} has no single ${arm64Name(version)} with a digest`;
  const signed = records(release.body, SIGNED_ARM64);
  if (signed.length !== 1 || signed[0].digest !== asset.digest)
    return `v${version} has no single signing record for its ${arm64Name(version)} (${asset.digest})`;
  const accepted = records(release.body, ACCEPTED_ARM64);
  if (accepted.length !== 1 || accepted[0].digest !== asset.digest)
    return `v${version} has no single native acceptance record for its ${arm64Name(version)} (${asset.digest})`;
  return undefined;
}

/** undefined if RUN is the successful acceptance run ID on main of REPO, else why. */
function runProblem(run, id, repo) {
  if (!run || String(run.id) !== id) return `acceptance run ${id} could not be read`;
  const facts = [
    run.path,
    run.repository?.full_name,
    run.head_repository?.full_name,
    run.head_branch,
    run.status,
    run.conclusion,
  ];
  if (
    facts.join(" ") !== `${ACCEPT_WORKFLOW} ${repo} ${repo} main completed success` ||
    !["workflow_run", "workflow_dispatch"].includes(run.event)
  )
    return `run ${id} is not a successful ${ACCEPT_WORKFLOW} run on main of ${repo} (${facts.join(" ")} ${run.event})`;
  return undefined;
}

/**
 * The name the record job of release-accept-arm64.yml takes, binding that run's success to
 * one release, version, source commit and installer digest. A job's name is set by the
 * workflow file on main, not by anything a release's notes say, and it outlives the run's
 * artifacts: it is the baseline's durable receipt.
 */
export const receipt = ({ id, version, sha, digest }) =>
  `arm64 acceptance receipt: release ${id} v${version} ${sha} ${digest}`;

/** undefined if RUN's jobs include a successful receipt for RELEASE's arm64 installer. */
function receiptProblem(run, version, release) {
  if (!/^[0-9a-f]{40}$/.test(release.target_commitish ?? "")) return `v${version} does not target a commit`;
  const name = receipt({
    id: release.id,
    version,
    sha: release.target_commitish,
    digest: arm64Asset(version, release).digest,
  });
  if (!Array.isArray(run.jobs)) return `run ${run.id}'s jobs could not be read`;
  const found = run.jobs.some((job) => job.name === name && job.status === "completed" && job.conclusion === "success");
  return found ? undefined : `run ${run.id} has no successful job named "${name}"`;
}

/**
 * The verified upgrade baseline: { none: true } when no earlier release is a candidate,
 * { version, digest, asset } when the candidate's arm64 installer has one signing and one
 * acceptance record for its digest, that record names a successful acceptance run on main
 * (RUN, fetched by the caller with its jobs), and that run's receipt job names this release,
 * version, source commit and digest; { problem } when the candidate lacks any of it. The
 * run's evidence artifact expires, so the run and its receipt job are the durable proof.
 */
export function baseline(version, releases, { repo, run } = {}) {
  const candidate = baselineCandidate(version, releases);
  if (!candidate) return { none: true };
  const prefix = `upgrade baseline v${candidate.version} has no verified arm64 acceptance`;
  const problem =
    recordProblem(candidate.version, candidate.release) ??
    runProblem(run, acceptanceRun(candidate.release), repo) ??
    receiptProblem(run, candidate.version, candidate.release);
  if (problem) return { problem: `${prefix}: ${problem}` };
  const asset = arm64Asset(candidate.version, candidate.release);
  return { version: candidate.version, digest: asset.digest, asset: asset.id };
}

/** The run id named by the single acceptance record, or undefined. */
export function acceptanceRun(release) {
  const accepted = records(release?.body, ACCEPTED_ARM64);
  return accepted.length === 1 ? accepted[0].run : undefined;
}

/** undefined if the release's arm64 installer passed native acceptance, else the reason. */
export function acceptanceProblem({ version, repo, release, releases, baselineRun: base, run, evidence }) {
  if (!FINAL.test(version)) return `${version} is not a final version`;
  const recorded = recordProblem(version, release);
  if (recorded) return recorded;
  const digest = arm64Asset(version, release).digest;
  const id = acceptanceRun(release);
  const problem = runProblem(run, id, repo);
  if (problem) return problem;
  if (!evidence) return `run ${id} has no ${EVIDENCE_ARTIFACT} artifact`;
  const expected = baseline(version, releases, { repo, run: base });
  if (expected.problem) return expected.problem;
  const want = {
    format: 1,
    run_id: id,
    release_id: String(release.id),
    version,
    source_sha: release.target_commitish,
    digest,
    mode: expected.none ? "fresh" : "upgrade",
    previous: expected.none ? null : { version: expected.version, digest: expected.digest },
  };
  const got = {
    format: evidence.format,
    run_id: String(evidence.run_id),
    release_id: String(evidence.release_id),
    version: evidence.version,
    source_sha: evidence.source_sha,
    digest: evidence.digest,
    mode: evidence.mode,
    previous: evidence.previous ? { version: evidence.previous.version, digest: evidence.previous.digest } : null,
  };
  if (!/^[0-9a-f]{40}$/.test(want.source_sha ?? "")) return `v${version} does not target a commit`;
  for (const key of Object.keys(want))
    if (JSON.stringify(got[key]) !== JSON.stringify(want[key]))
      return `run ${id}'s evidence has ${key} ${JSON.stringify(got[key])}, not ${JSON.stringify(want[key])}`;
  return undefined;
}

/** { arches, reason?, error? } for feed-publish.yml. */
export function feedArches(input) {
  const { version, release } = input;
  // A prerelease's assets are its ordinary (unsigned) builds; only finals have arm64 acceptance.
  if (!FINAL.test(version)) return { arches: ["x64"], reason: `v${version} is a prerelease` };
  if (declined(release)) return { arches: ["x64"], reason: `v${version} is marked x64-only` };
  if ((release?.assets ?? []).every((a) => a.name !== arm64Name(version)))
    return { arches: ["x64"], reason: `v${version} has no ${arm64Name(version)}` };
  const problem = acceptanceProblem(input);
  return problem ? { arches: ["x64"], error: problem } : { arches: ["x64", "arm64"] };
}

const json = (file) => (file && file !== "-" ? JSON.parse(readFileSync(file, "utf8")) : undefined);
const optional = (file) => {
  try {
    return json(file);
  } catch {
    return undefined;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, version, ...rest] = process.argv.slice(2);
  const usage = () => {
    console.error("usage: feed-arches.js baseline-run|baseline|acceptance-run|verify|serve VERSION ...");
    process.exit(2);
  };
  if (!FINAL.test(version ?? "") && !/^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$/.test(version ?? "")) usage();
  if (command === "baseline-run" && rest.length === 1) {
    const run = baselineRun(version, json(rest[0]));
    if (run) console.log(run);
  } else if (command === "baseline" && rest.length === 3) {
    const [repo, releases, run] = rest;
    const found = baseline(version, json(releases), { repo, run: optional(run) });
    if (found.problem) {
      console.error(`::error::${found.problem}`);
      process.exit(1);
    }
    if (!found.none) console.log(`${found.version} ${found.digest} ${found.asset}`);
  } else if (command === "acceptance-run" && rest.length === 1) {
    const run = acceptanceRun(json(rest[0]));
    if (run) console.log(run);
  } else if (command === "verify" && rest.length === 6) {
    const [repo, release, releases, base, run, evidence] = rest;
    const problem = acceptanceProblem({
      version,
      repo,
      release: json(release),
      releases: json(releases),
      baselineRun: optional(base),
      run: optional(run),
      evidence: optional(evidence),
    });
    if (problem) {
      console.error(`arm64 acceptance not verified: ${problem}`);
      process.exit(1);
    }
  } else if (command === "serve" && (rest.length === 3 || rest.length === 6)) {
    const [repo, release, releases, base, run, evidence] = rest;
    const result = feedArches({
      version,
      repo,
      release: json(release),
      releases: json(releases),
      baselineRun: optional(base),
      run: optional(run),
      evidence: optional(evidence),
    });
    if (result.error) {
      console.error(
        `::error::v${version}'s arm64 installer is attached but its acceptance does not verify: ${result.error}`,
      );
      process.exit(1);
    }
    if (result.reason) console.error(`arm64 not served: ${result.reason}`);
    console.log(result.arches.join(" "));
  } else usage();
}
