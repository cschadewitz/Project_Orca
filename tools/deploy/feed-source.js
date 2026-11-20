#!/usr/bin/env node
/**
 * Decide whether a signed Windows run may feed a version, for feed-publish.yml:
 *
 *   node tools/deploy/feed-source.js VERSION TAG_SHA RUN_JSON RELEASE_JSON
 *
 * RUN_JSON is the Actions API record of the signed run, RELEASE_JSON the GitHub release for
 * vVERSION (absent or unreadable when there is none). The version must be a published,
 * non-draft release whose tag is the commit the run signed, from a successful
 * windows-signed.yml run dispatched from main. Prints the artifact name to download.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function load(file) {
  if (!file || !existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function checkSource({ version, sha, run, release }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("invalid version");
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`tag v${version} does not resolve to a commit`);
  if (!release || release.tag_name !== `v${version}`) throw new Error(`v${version} has no GitHub release`);
  if (release.draft !== false || !release.published_at) throw new Error(`release v${version} is not published`);
  if (!run || run.path !== ".github/workflows/windows-signed.yml") throw new Error("run is not Windows signed");
  if (run.head_branch !== "main") throw new Error("signed run was not dispatched from main");
  if (run.status !== "completed" || run.conclusion !== "success") throw new Error("signed run did not succeed");
  return `windows-signed-${sha}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, sha, runFile, releaseFile] = process.argv.slice(2);
  try {
    console.log(checkSource({ version, sha, run: load(runFile), release: load(releaseFile) }));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
