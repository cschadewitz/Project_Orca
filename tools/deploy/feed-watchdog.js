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
 * - the channel file is one this feed publishes: exactly one `files[]` entry (what the
 *   installed updater reads) naming that architecture's installer, with the legacy `path` and
 *   `sha512` agreeing with it;
 * - the installer the feed serves has that entry's size and sha512, and its SHA-256 equals
 *   the published GitHub release asset's digest, so the feed serves the released bytes.
 *
 * It cannot read rings.json (that needs the bucket credential, which stays in the protected
 * desktop-feed environment), so it checks what a ring is offered, not what it should be offered.
 * The canary tokens live in the `feed-canary` environment, which only main can deploy to.
 * Tokens are only ever sent as Authorization headers; nothing here prints them. It does print
 * the canary map's digest (the SHA-256 of `{ sha256(token): { ring } }` with hashes sorted, the
 * form the Worker's FEED_TOKENS uses), so whoever runs the Worker can tie its token registry to
 * the canaries this run proved against the live feed. The digest reveals no token.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RINGS } from "./feed-worker/rings.js";
import * as worker from "./feed-worker/worker.js";

const ARCHES = ["x64", "arm64"];
const VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/;

const TOP_KEYS = new Set(["version", "files", "path", "sha512", "releaseDate"]);
const ENTRY_KEYS = new Set(["url", "sha512", "size", "blockMapSize", "isAdminRightsRequired"]);

function scalar(value) {
  let v = value.trim();
  if (v.length >= 2 && ((v[0] === "'" && v.at(-1) === "'") || (v[0] === '"' && v.at(-1) === '"'))) v = v.slice(1, -1);
  if (!v || /[\n#{}[\]&*!|>]/.test(v) || v.startsWith("- ")) throw new Error("unexpected value");
  return v;
}

function field(line, allowed, target) {
  const at = line.indexOf(": ");
  const key = at < 0 ? line : line.slice(0, at);
  if (at < 0 || !allowed.has(key) || Object.hasOwn(target, key)) throw new Error(`unexpected key ${key}`);
  target[key] = scalar(line.slice(at + 2));
}

/**
 * An electron-builder channel file, parsed as strictly as release-assets.py parses it before
 * publication: top-level fields plus the `files[]` entries electron-updater actually reads.
 * Throws on any other layout.
 */
export function parseChannel(text) {
  const top = {};
  let entry;
  let inFiles = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (raw.startsWith("  - ") && inFiles) {
      entry = {};
      top.files.push(entry);
      field(raw.slice(4), ENTRY_KEYS, entry);
    } else if (raw.startsWith("    ") && !raw.startsWith("     ") && entry) {
      field(raw.slice(4), ENTRY_KEYS, entry);
    } else if (!raw.startsWith(" ")) {
      entry = undefined;
      inFiles = false;
      if (raw === "files:") {
        if (top.files) throw new Error("unexpected key files");
        top.files = [];
        inFiles = true;
      } else field(raw, new Set([...TOP_KEYS].filter((k) => k !== "files")), top);
    } else throw new Error("unexpected layout");
  }
  return top;
}

/**
 * Problems with one ring's channel file, as messages; empty when it is acceptable. The
 * installer the updater fetches is `files[0]`; the legacy top-level `path` and `sha512` must
 * agree with it, as release-assets.py requires before anything is published.
 */
export function channelProblems(ring, arch, channel) {
  const where = `${ring} latest-${arch}.yml`;
  const problems = [];
  if (!channel.version || !VERSION.test(channel.version))
    problems.push(`${where}: unexpected version ${channel.version}`);
  else if (ring === "stable" && channel.version.includes("-"))
    problems.push(`${where}: stable offers the prerelease ${channel.version}`);
  const name = `ORCA-${channel.version}-win-${arch}.exe`;
  const files = channel.files ?? [];
  if (files.length !== 1) {
    problems.push(`${where}: names ${files.length} installers in files[], not exactly one`);
    return problems;
  }
  const [entry] = files;
  if (entry.url !== name)
    problems.push(`${where}: files[0] ${entry.url} is not ${arch}'s installer for ${channel.version}`);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512 ?? "")) problems.push(`${where}: files[0] has no valid sha512`);
  if (!/^\d+$/.test(entry.size ?? "")) problems.push(`${where}: files[0] has no valid size`);
  if ((entry.isAdminRightsRequired ?? "false") !== "false")
    problems.push(`${where}: files[0] requires admin rights; ORCA's installer is per-user`);
  if (channel.path !== entry.url || channel.sha512 !== entry.sha512)
    problems.push(`${where}: legacy path/sha512 disagree with files[0]`);
  return problems;
}

/** The SHA-256 (hex) of the canonical canary map: sorted token hashes to exactly { ring }. */
export function canaryMapDigest(tokens) {
  const entries = Object.entries(tokens).map(([ring, token]) => [
    createHash("sha256").update(token).digest("hex"),
    ring,
  ]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const map = {};
  for (const [hash, ring] of entries) map[hash] = { ring };
  return createHash("sha256").update(JSON.stringify(map)).digest("hex");
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
  const feed = (name, token, method = "GET") =>
    fetch(new URL(name, base), {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: "manual",
    });
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
      let channel;
      try {
        channel = parseChannel(await response.text());
      } catch (error) {
        problems.push(`${ring} latest-${arch}.yml: not a channel file this feed publishes (${error.message})`);
        continue;
      }
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
      // What the installed updater downloads and verifies: files[0], not the legacy fields.
      const [entry] = channel.files;
      const asset = release.assets?.find((a) => a.name === entry.url);
      if (!/^sha256:[0-9a-f]{64}$/.test(asset?.digest ?? "")) {
        problems.push(`${ring} ${arch}: release v${channel.version} has no ${entry.url} digest`);
        continue;
      }

      if (installers.has(entry.url)) {
        // Already downloaded for another ring: one full download per installer, but this
        // ring's token must still reach the same bytes.
        const head = await feed(entry.url, tokens[ring], "HEAD");
        if (head.status !== 200 || head.headers.get("content-length") !== entry.size) {
          problems.push(
            `${ring} ${arch}: HEAD ${entry.url} got ${head.status}, length ${head.headers.get("content-length")}`,
          );
          continue;
        }
      } else {
        const download = await feed(entry.url, tokens[ring]);
        if (download.status !== 200) installers.set(entry.url, { status: download.status });
        else {
          const bytes = Buffer.from(await download.arrayBuffer());
          installers.set(entry.url, {
            size: bytes.length,
            sha512: createHash("sha512").update(bytes).digest("base64"),
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          });
        }
      }
      const installer = installers.get(entry.url);
      if (installer.status) problems.push(`${ring} ${arch}: ${entry.url} got ${installer.status}`);
      else if (installer.size !== Number(entry.size) || installer.sha512 !== entry.sha512)
        problems.push(`${ring} ${arch}: ${entry.url} does not match the channel file's files[0] size and sha512`);
      else if (installer.sha256 !== asset.digest)
        problems.push(`${ring} ${arch}: ${entry.url} differs from the published release asset`);
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
  if (problems.length === 0) console.log(`canary map sha256: ${canaryMapDigest(tokens)}`);
  process.exit(problems.length ? 1 : 0);
}
