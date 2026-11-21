#!/usr/bin/env node
/**
 * Check the live desktop feed from outside, as a client sees it, for feed-watchdog.yml:
 *
 *   FEED_URL=https://... FEED_CANARY_TOKENS='{"internal":"…","stable":"…"}' \
 *     GITHUB_REPOSITORY=owner/repo [GITHUB_TOKEN=…] node tools/deploy/feed-watchdog.js
 *
 * Adopted from T3 Code's scheduled feed check (#863, item 6). For every ring that has a canary
 * token (minted with feed-token.js like any tester's) and every served architecture:
 *
 * - a request without a token gets 401, and an architecture the Worker does not serve gets 404;
 * - the channel file names a version the ring may hold: a published, non-draft GitHub release,
 *   never a prerelease in `stable`, and only `-rc.N` prereleases anywhere;
 * - the installer the feed serves hashes to the channel file's sha512, and its SHA-256 equals
 *   the published GitHub release asset's digest, so the feed serves the released bytes.
 *
 * It cannot read rings.json (that needs the bucket credential, which stays in the protected
 * desktop-feed environment), so it checks what a ring is offered, not what it should be offered.
 * Tokens are only ever sent as Authorization headers; nothing here prints them.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RINGS } from "./feed-worker/rings.js";
import * as worker from "./feed-worker/worker.js";

const ARCHES = ["x64", "arm64"];
const VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

/** The top-level `version`, `path` and `sha512` of an electron-builder channel file. */
export function parseChannel(text) {
  const field = (key) => new RegExp(`^${key}: *['"]?([^'"\\n]+?)['"]? *$`, "m").exec(text)?.[1];
  return { version: field("version"), path: field("path"), sha512: field("sha512") };
}

/** Problems with one ring's channel file, as messages; empty when it is acceptable. */
export function channelProblems(ring, arch, channel) {
  const where = `${ring} latest-${arch}.yml`;
  const problems = [];
  if (!channel.version || !VERSION.test(channel.version))
    problems.push(`${where}: unexpected version ${channel.version}`);
  else if (ring === "stable" && channel.version.includes("-"))
    problems.push(`${where}: stable offers the prerelease ${channel.version}`);
  if (channel.path !== `ORCA-${channel.version}-win-${arch}.exe`)
    problems.push(`${where}: path ${channel.path} is not ${arch}'s installer for ${channel.version}`);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(channel.sha512 ?? "")) problems.push(`${where}: missing or malformed sha512`);
  return problems;
}

/**
 * Run every check. `fetch` and the served architectures are injectable for tests. Resolves
 * to { problems, report }: report lines are safe to print, problems fail the run.
 */
export async function watch({ url, tokens, repo, githubToken, fetch = globalThis.fetch, served }) {
  const arches = served ?? worker.SERVED_ARCHES ?? ARCHES;
  const base = url.endsWith("/") ? url : `${url}/`;
  const problems = [];
  const report = [];
  const feed = (name, token) =>
    fetch(new URL(name, base), { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: "manual" });
  const github = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
      },
    });
    return response.status === 200 ? response.json() : undefined;
  };

  const anonymous = await feed("latest-x64.yml");
  if (anonymous.status !== 401) problems.push(`a request without a token got ${anonymous.status}, not 401`);

  const rings = RINGS.filter((ring) => tokens[ring]);
  if (rings.length === 0) problems.push("no canary tokens: set FEED_CANARY_TOKENS for at least one ring");
  for (const extra of Object.keys(tokens).filter((ring) => !RINGS.includes(ring)))
    problems.push(`canary token for unknown ring ${extra}`);

  const releases = new Map();
  const installers = new Map();
  for (const ring of rings) {
    for (const arch of ARCHES) {
      const response = await feed(`latest-${arch}.yml`, tokens[ring]);
      if (!arches.includes(arch)) {
        if (response.status !== 404)
          problems.push(`${ring} latest-${arch}.yml: ${arch} is not served but got ${response.status}`);
        continue;
      }
      if (response.status === 404) {
        report.push(`${ring} ${arch}: nothing offered yet`);
        continue;
      }
      if (response.status !== 200) {
        problems.push(`${ring} latest-${arch}.yml: got ${response.status}`);
        continue;
      }
      const channel = parseChannel(await response.text());
      const found = channelProblems(ring, arch, channel);
      problems.push(...found);
      if (found.length) continue;

      if (!releases.has(channel.version))
        releases.set(channel.version, await github(`releases/tags/v${channel.version}`));
      const release = releases.get(channel.version);
      if (!release || release.draft !== false || !release.published_at) {
        problems.push(`${ring} ${arch}: ${channel.version} has no published GitHub release`);
        continue;
      }
      const asset = release.assets?.find((a) => a.name === channel.path);
      if (!/^sha256:[0-9a-f]{64}$/.test(asset?.digest ?? "")) {
        problems.push(`${ring} ${arch}: release v${channel.version} has no ${channel.path} digest`);
        continue;
      }

      if (!installers.has(channel.path)) {
        const download = await feed(channel.path, tokens[ring]);
        if (download.status !== 200) installers.set(channel.path, { status: download.status });
        else {
          const bytes = Buffer.from(await download.arrayBuffer());
          installers.set(channel.path, {
            sha512: createHash("sha512").update(bytes).digest("base64"),
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          });
        }
      }
      const installer = installers.get(channel.path);
      if (installer.status) problems.push(`${ring} ${arch}: ${channel.path} got ${installer.status}`);
      else if (installer.sha512 !== channel.sha512)
        problems.push(`${ring} ${arch}: ${channel.path} does not match the channel file's sha512`);
      else if (installer.sha256 !== asset.digest)
        problems.push(`${ring} ${arch}: ${channel.path} differs from the published release asset`);
      else report.push(`${ring} ${arch}: ${channel.version}, served bytes match the published release`);
    }
  }
  return { problems, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let tokens;
  try {
    tokens = JSON.parse(process.env.FEED_CANARY_TOKENS ?? "");
  } catch {
    console.error("::error::FEED_CANARY_TOKENS is not a JSON object of ring to token");
    process.exit(1);
  }
  const url = process.env.FEED_URL ?? "";
  if (!/^https:\/\/[^/?#@]+\/?$/.test(url)) {
    console.error("::error::FEED_URL must be the feed's https origin");
    process.exit(1);
  }
  const { problems, report } = await watch({
    url,
    tokens,
    repo: process.env.GITHUB_REPOSITORY,
    githubToken: process.env.GITHUB_TOKEN,
  });
  for (const line of report) console.log(line);
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(problems.length ? 1 : 0);
}
