#!/usr/bin/env node
/**
 * Windows arm64 release evidence (#889): which architectures a release may be published and
 * fed with, and the arm64 baseline its native acceptance upgrades from.
 *
 *   feed-arches.js baseline VERSION RELEASES_JSON
 *       print "VERSION DIGEST ASSET_ID" of the newest published final older than VERSION that
 *       carries an arm64 installer, or nothing if none does
 *   feed-arches.js acceptance-run VERSION RELEASE_JSON
 *       print the run id named by the release's single arm64 acceptance record, or nothing
 *   feed-arches.js verify VERSION REPO RELEASE_JSON RELEASES_JSON RUN_JSON EVIDENCE_JSON
 *       exit 0 only if the release's arm64 installer passed native acceptance (below)
 *   feed-arches.js serve VERSION REPO RELEASE_JSON RELEASES_JSON [RUN_JSON EVIDENCE_JSON]
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
 * version/digest equal to the baseline computed here from the published releases.
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
 * The newest published, non-prerelease final older than VERSION with one arm64 installer
 * (a valid digest), as { version, digest, asset }; null when there is none.
 */
export function baseline(version, releases) {
  let best = null;
  for (const release of releases ?? []) {
    const tag = /^v(.+)$/.exec(release?.tag_name ?? "")?.[1];
    if (!tag || !FINAL.test(tag) || release.draft !== false || release.prerelease || !release.published_at) continue;
    if (compare(tag, version) >= 0) continue;
    const asset = arm64Asset(tag, release);
    if (!asset || !DIGEST.test(asset.digest ?? "")) continue;
    if (!best || compare(tag, best.version) > 0) best = { version: tag, digest: asset.digest, asset: asset.id };
  }
  return best;
}

/** The run id named by the single acceptance record, or undefined. */
export function acceptanceRun(release) {
  const accepted = records(release?.body, ACCEPTED_ARM64);
  return accepted.length === 1 ? accepted[0].run : undefined;
}

/** undefined if the release's arm64 installer passed native acceptance, else the reason. */
export function acceptanceProblem({ version, repo, release, releases, run, evidence }) {
  if (!FINAL.test(version)) return `${version} is not a final version`;
  if (declined(release)) return `v${version} is marked x64-only`;
  const asset = arm64Asset(version, release);
  if (!asset || !DIGEST.test(asset.digest ?? ""))
    return `v${version} has no single ${arm64Name(version)} with a digest`;
  const digest = asset.digest;
  const signed = records(release.body, SIGNED_ARM64);
  if (signed.length !== 1 || signed[0].digest !== digest)
    return `v${version} has no single signing record for its ${arm64Name(version)} (${digest})`;
  const accepted = records(release.body, ACCEPTED_ARM64);
  if (accepted.length !== 1 || accepted[0].digest !== digest)
    return `v${version} has no single native acceptance record for its ${arm64Name(version)} (${digest})`;
  const id = accepted[0].run;
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
  if (!evidence) return `run ${id} has no ${EVIDENCE_ARTIFACT} artifact`;
  const expected = baseline(version, releases);
  const want = {
    format: 1,
    run_id: id,
    release_id: String(release.id),
    version,
    source_sha: release.target_commitish,
    digest,
    mode: expected ? "upgrade" : "fresh",
    previous: expected ? { version: expected.version, digest: expected.digest } : null,
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
    console.error("usage: feed-arches.js baseline|acceptance-run|verify|serve VERSION ...");
    process.exit(2);
  };
  if (!FINAL.test(version ?? "") && !/^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$/.test(version ?? "")) usage();
  if (command === "baseline" && rest.length === 1) {
    const found = baseline(version, json(rest[0]));
    if (found) console.log(`${found.version} ${found.digest} ${found.asset}`);
  } else if (command === "acceptance-run" && rest.length === 1) {
    const run = acceptanceRun(json(rest[0]));
    if (run) console.log(run);
  } else if (command === "verify" && rest.length === 5) {
    const [repo, release, releases, run, evidence] = rest;
    const problem = acceptanceProblem({
      version,
      repo,
      release: json(release),
      releases: json(releases),
      run: optional(run),
      evidence: optional(evidence),
    });
    if (problem) {
      console.error(`arm64 acceptance not verified: ${problem}`);
      process.exit(1);
    }
  } else if (command === "serve" && (rest.length === 3 || rest.length === 5)) {
    const [repo, release, releases, run, evidence] = rest;
    const result = feedArches({
      version,
      repo,
      release: json(release),
      releases: json(releases),
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
