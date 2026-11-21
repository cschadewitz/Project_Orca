#!/usr/bin/env node
/**
 * Decide whether feed-auto.yml should start feed-publish.yml, and with which inputs:
 *
 *   node tools/deploy/feed-auto.js EVENT_NAME EVENT_JSON
 *
 * Two events can complete the pair a feed run needs (a published release and a successful
 * signing run of its tagged commit), in either order:
 *
 *   release published         the version is the tag; the signing run is the one successful
 *                             windows-signed.yml run on main that still holds the artifact
 *                             named for the tag's commit
 *   workflow_run completed    the signing run is the event's run; the version is the tag at
 *                             the commit it signed, which must already be a published release
 *
 * It only chooses inputs. feed-publish.yml re-checks everything itself (feed-source.js, the
 * signatures, the update metadata and that each served installer equals the published
 * release's asset), so a wrong choice here fails there and feeds nothing. Prints one line:
 * `dispatch VERSION RUN_ID` or `skip REASON`. Reads the API through `gh`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;
const SIGNED = ".github/workflows/windows-signed.yml";
const ARTIFACT = /^windows-signed-([0-9a-f]{40})$/;

/** The tagged commit's live signed artifact, if the run holds one. */
export function signedArtifact(artifacts, sha) {
  return (artifacts ?? []).find((a) => a.name === `windows-signed-${sha}` && a.expired === false);
}

export function isSignedRun(run) {
  return (
    run?.path === SIGNED && run.head_branch === "main" && run.status === "completed" && run.conclusion === "success"
  );
}

/** A published release was created: find the one signing run that holds its commit's build. */
export function fromRelease({ release, sha, runs, artifactsByRun }) {
  const tag = release?.tag_name ?? "";
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  if (!VERSION.test(version)) return { skip: `tag ${tag || "(none)"} is not a version` };
  if (release.draft !== false || !release.published_at) return { skip: `${tag} is not published` };
  if (!SHA.test(sha ?? "")) return { skip: `${tag} does not resolve to a commit` };
  const holders = (runs ?? []).filter(isSignedRun).filter((run) => signedArtifact(artifactsByRun?.[run.id], sha));
  if (holders.length === 0) {
    return { skip: `no successful signing run of ${sha} holds its artifact yet; its completion will feed ${tag}` };
  }
  if (holders.length > 1) {
    const ids = holders.map((run) => run.id).join(", ");
    throw new Error(`several signing runs of ${sha} (${ids}); dispatch feed-publish.yml with the accepted one`);
  }
  return { version, runId: String(holders[0].id) };
}

/** A signing run finished: feed it if its commit's tag is already a published release. */
export function fromSignedRun({ run, artifacts, tagsAtSha, releases }) {
  if (!isSignedRun(run)) return { skip: "not a successful Windows signed run on main" };
  const shas = (artifacts ?? [])
    .filter((a) => a.expired === false)
    .map((a) => ARTIFACT.exec(a.name)?.[1])
    .filter(Boolean);
  if (shas.length !== 1) return { skip: `run ${run.id} holds no single signed artifact` };
  const sha = shas[0];
  const published = (tagsAtSha?.[sha] ?? [])
    .filter((tag) => VERSION.test(tag.replace(/^v/, "")) && tag.startsWith("v"))
    .filter((tag) => releases?.[tag]?.draft === false && releases[tag].published_at);
  if (published.length === 0) return { skip: `${sha} has no published release yet; publishing it will feed it` };
  if (published.length > 1) throw new Error(`${sha} has several published releases: ${published.join(", ")}`);
  return { version: published[0].slice(1), runId: String(run.id) };
}

function gh(repo, path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", `repos/${repo}/${path}`], { encoding: "utf8" }));
  } catch {
    return undefined;
  }
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function decide(eventName, event, repo) {
  if (eventName === "release") {
    const release = event.release;
    let sha;
    try {
      sha = git("rev-parse", "--verify", "-q", `refs/tags/${release?.tag_name}^{commit}`);
    } catch {
      sha = "";
    }
    const runs =
      gh(repo, "actions/workflows/windows-signed.yml/runs?branch=main&status=success&per_page=50")?.workflow_runs ?? [];
    const artifactsByRun = {};
    for (const run of runs.filter(isSignedRun)) {
      artifactsByRun[run.id] = gh(repo, `actions/runs/${run.id}/artifacts`)?.artifacts ?? [];
    }
    return fromRelease({ release, sha, runs, artifactsByRun });
  }
  if (eventName === "workflow_run") {
    const run = event.workflow_run;
    if (!isSignedRun(run)) return { skip: "not a successful Windows signed run on main" };
    const artifacts = gh(repo, `actions/runs/${run.id}/artifacts`)?.artifacts ?? [];
    const tagsAtSha = {};
    const releases = {};
    for (const a of artifacts) {
      const sha = ARTIFACT.exec(a.name)?.[1];
      if (!sha) continue;
      tagsAtSha[sha] = git("tag", "--points-at", sha, "--list", "v*").split("\n").filter(Boolean);
      for (const tag of tagsAtSha[sha]) releases[tag] = gh(repo, `releases/tags/${tag}`);
    }
    return fromSignedRun({ run, artifacts, tagsAtSha, releases });
  }
  return { skip: `unsupported event ${eventName}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [eventName, eventFile] = process.argv.slice(2);
  try {
    const event = JSON.parse(readFileSync(eventFile, "utf8"));
    const result = decide(eventName, event, process.env.REPO);
    console.log(result.skip ? `skip ${result.skip}` : `dispatch ${result.version} ${result.runId}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
