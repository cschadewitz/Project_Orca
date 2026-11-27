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
 * The server bundle channel (#877) is checked the same way with the same canaries:
 * `server/latest-linux-x64.yml` must parse strictly (feed-server.js), name a published release
 * the ring may hold, and its three files must be served with the listed sizes and SHA-256
 * digests, equal to that release's recorded assets. A broken server channel fails the run.
 * While rings.json sets the servers' stop switch (#878), every server channel must answer 503
 * with `X-Orca-Feed-Stop: servers`, and nothing else may.
 *
 * What each ring should be offered comes from the feed's live rings.json, which a separate job
 * of feed-watchdog.yml reads with a read-only bucket key (in the feed-reader environment, main
 * only, never in the canary job) and hands over as FEED_RINGS. Against it, an x64 or server
 * channel answering 404 for a ring that rings.json gives an offer is a failure, as is an offer
 * of anything but that ring's full or rollout version, or an offer to a ring with none. When
 * the feed is switched on (FEED_COMMISSIONED, from the ORCA_FEED_BUCKET variable) and no ring
 * state was handed over (the read failed, or rings.json is missing), the run fails: an empty
 * ring could not be told from a broken one. An empty ring state that exists is valid.
 * Independently, a ring whose x64 desktops are offered a version from the server bundle's line
 * must offer its servers that version or newer (servers first, rings.js). These are checks of
 * what the feed offers, never of what any host has installed or is running.
 *
 * This process never holds the bucket credential and cannot read rings.json (that needs the bucket credential, which stays in the protected
 * desktop-feed environment), so it checks what a ring is offered, not what it should be offered.
 * The canary tokens live in the `feed-canary` environment, which only main can deploy to.
 * Tokens are only ever sent as Authorization headers; nothing here prints them. When the
 * configuration holds exactly one well-formed, distinct canary per ring and the run is clean,
 * it also prints a digest of those configured canaries, the canaries this run saw the feed
 * accept (SHA-256 of `{ sha256(token): { ring } }`, hashes sorted). It is not a read-back of the
 * Worker's token registry, nor proof of each token's ring (two rings with identical offers,
 * empty ones included, look alike from outside). It reveals no token.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseServerChannel } from "./feed-server.js";
import { RINGS, compareVersions, hasServer, validateRings } from "./feed-worker/rings.js";
import * as worker from "./feed-worker/worker.js";

const INSTALLER_PREFIX = "ORCA";
const STOP_HEADER = "x-orca-feed-stop";
// The Orrery rename bridge (v0.8.1): a ring may offer a release from either side of the rename,
// so its installer carries either name, and the stop header either spelling, for one release.
// rename-keep-start: both names on purpose
const INSTALLER_PREFIXES = [...new Set([INSTALLER_PREFIX, "ORCA", "Orrery"])];
const STOP_HEADERS = [...new Set([STOP_HEADER, "x-orca-feed-stop", "x-orrery-feed-stop"])];
// rename-keep-end

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
  const names = INSTALLER_PREFIXES.map((prefix) => `${prefix}-${channel.version}-win-${arch}.exe`);
  const files = channel.files ?? [];
  if (files.length !== 1) {
    problems.push(`${where}: names ${files.length} installers in files[], not exactly one`);
    return problems;
  }
  const [entry] = files;
  if (!names.includes(entry.url))
    problems.push(`${where}: files[0] ${entry.url} is not ${arch}'s installer for ${channel.version}`);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512 ?? "")) problems.push(`${where}: files[0] has no valid sha512`);
  if (!/^\d+$/.test(entry.size ?? "")) problems.push(`${where}: files[0] has no valid size`);
  if ((entry.isAdminRightsRequired ?? "false") !== "false")
    problems.push(`${where}: files[0] requires admin rights; ORCA's installer is per-user`);
  if (channel.path !== entry.url || channel.sha512 !== entry.sha512)
    problems.push(`${where}: legacy path/sha512 disagree with files[0]`);
  return problems;
}

/**
 * The digest of the configured canaries, or undefined unless there is exactly one well-formed,
 * distinct token per ring: SHA-256 (hex) of `{ sha256(token): { ring } }` with hashes sorted.
 * A partial or duplicated configuration still runs the ordinary checks but gets no digest.
 */
export function canaryMapDigest(tokens) {
  const rings = Object.keys(tokens ?? {});
  if (rings.length !== RINGS.length || !RINGS.every((ring) => Object.hasOwn(tokens, ring))) return undefined;
  const values = RINGS.map((ring) => tokens[ring]);
  if (!values.every((t) => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t))) return undefined;
  if (new Set(values).size !== values.length) return undefined;
  const entries = RINGS.map((ring) => [createHash("sha256").update(tokens[ring]).digest("hex"), ring]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const map = {};
  for (const [hash, ring] of entries) map[hash] = { ring };
  return createHash("sha256").update(JSON.stringify(map)).digest("hex");
}

/**
 * Run every check. `fetch` and the served architectures are injectable for tests. Resolves
 * to { problems, report }: report lines are safe to print, problems fail the run.
 */
/** The versions RING may be offered on CHANNEL by rings.json: full, rollout or none. */
export function recordedOffers(record, ring, channel) {
  const entry = (channel === "server" ? record.server : record.rings)?.[ring];
  return [entry?.version, entry?.rollout?.version].filter(Boolean);
}

/**
 * Hold one channel's answer for a ring against what rings.json offers it: null when it agrees,
 * otherwise the problem. STATUS is the HTTP status, VERSION the offered version on a 200.
 */
export function offerProblem(where, record, offers, status, version) {
  if (!record) return null;
  if (status === 404) return offers.length ? `${where}: got 404, but rings.json offers ${offers.join(" or ")}` : null;
  if (!offers.length) return `${where}: offers ${version}, but rings.json offers nothing`;
  if (!offers.includes(version)) return `${where}: offers ${version}, but rings.json offers ${offers.join(" or ")}`;
  return null;
}

/**
 * The ring state the workflow hands over: FEED_RINGS is the `rings` job's output, which is
 * empty when that job failed or was skipped (never an empty ring state, which is `{...}`).
 */
export function ringState(env) {
  const commissioned = env.FEED_COMMISSIONED === "true";
  if (!env.FEED_RINGS) return { record: undefined, commissioned };
  try {
    return { record: validateRings(JSON.parse(env.FEED_RINGS)), commissioned };
  } catch (error) {
    throw new Error(`the feed's ring state is unreadable: ${error.message}`, { cause: error });
  }
}

export async function watch({
  url,
  tokens,
  repo,
  githubToken,
  fetch = globalThis.fetch,
  served,
  record,
  commissioned = false,
}) {
  const arches = served ?? worker.SERVED_ARCHES ?? ARCHES;
  const base = url.endsWith("/") ? url : `${url}/`;
  const problems = [];
  const report = [];
  if (record) validateRings(record);
  else if (commissioned)
    problems.push("the feed is switched on (ORCA_FEED_BUCKET) but its ring state (rings.json) was not available");
  else
    report.push(
      "no ring state (the feed is off): a 404 cannot be told from an empty ring; only servers-first is checked",
    );
  const desktopOffers = new Map();
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
      // Only x64 is held against rings.json: a snapshot may leave arm64 out (#889).
      const offers = arch === "x64" && record ? recordedOffers(record, ring, "desktop") : [];
      if (response.status === 404) {
        const problem = arch === "x64" ? offerProblem(`${ring} latest-x64.yml`, record, offers, 404) : null;
        if (problem) problems.push(problem);
        else
          report.push(`${ring} ${arch}: nothing offered${record && arch === "x64" ? " (none in rings.json)" : " yet"}`);
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
      if (arch === "x64") {
        desktopOffers.set(ring, channel.version);
        const problem = offerProblem(`${ring} latest-x64.yml`, record, offers, 200, channel.version);
        if (problem) {
          problems.push(problem);
          continue;
        }
      }

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
  await watchServers({ tokens, rings, feed, github, releases, problems, report, record, desktopOffers });
  return { problems, report };
}

/** The server bundle channel of every ring with a canary (#877). Adds to problems and report. */
async function watchServers({ tokens, rings, feed, github, releases, problems, report, record, desktopOffers }) {
  const anonymous = await feed("server/latest-linux-x64.yml");
  if (anonymous.status !== 401)
    problems.push(`a server channel request without a token got ${anonymous.status}, not 401`);
  const served = new Map();
  for (const ring of rings) {
    const where = `${ring} server/latest-linux-x64.yml`;
    const response = await feed("server/latest-linux-x64.yml", tokens[ring]);
    const offers = record ? recordedOffers(record, ring, "server") : [];
    // Servers first: desktops offered a server-era version imply servers on it or newer.
    const desktop = desktopOffers.get(ring);
    const needed = desktop && hasServer(desktop) ? desktop : undefined;
    // The servers' stop switch (#878): every server channel answers 503 with the stop header
    // while rings.json sets it, and never otherwise.
    const stopped =
      response.status === 503 && STOP_HEADERS.some((header) => response.headers.get(header) === "servers");
    if (record?.serverStop === true || stopped) {
      if (record?.serverStop !== true)
        problems.push(`${where}: answers the servers' stop, but rings.json does not set it`);
      else if (!stopped) problems.push(`${where}: rings.json stops servers, but the feed answered ${response.status}`);
      else report.push(`${ring} server: stopped (serverStop); no server activates anything`);
      continue;
    }
    if (response.status === 404) {
      const problem = offerProblem(where, record, offers, 404);
      if (problem) problems.push(problem);
      else if (needed) problems.push(`${where}: got 404, but ${ring}'s desktops are offered ${needed} (servers first)`);
      else report.push(`${ring} server: nothing offered${record ? " (none in rings.json)" : " yet"}`);
      continue;
    }
    if (response.status !== 200) {
      problems.push(`${where}: got ${response.status}`);
      continue;
    }
    let channel;
    try {
      channel = parseServerChannel(await response.text());
    } catch (error) {
      problems.push(`${where}: not a server channel file this feed publishes (${error.message})`);
      continue;
    }
    if (ring === "stable" && channel.version.includes("-")) {
      problems.push(`${where}: stable offers the prerelease ${channel.version}`);
      continue;
    }
    const mismatch = offerProblem(where, record, offers, 200, channel.version);
    if (mismatch) {
      problems.push(mismatch);
      continue;
    }
    if (needed && compareVersions(channel.version, needed) < 0) {
      problems.push(
        `${where}: offers ${channel.version}, older than the ${needed} ${ring}'s desktops are offered (servers first)`,
      );
      continue;
    }
    if (!releases.has(channel.version))
      releases.set(channel.version, await github(`releases/tags/v${channel.version}`));
    const release = releases.get(channel.version);
    if (!release || release.draft !== false || !release.published_at) {
      problems.push(`${ring} server: ${channel.version} has no published GitHub release`);
      continue;
    }
    let ok = true;
    for (const kind of ["archive", "manifest", "signature"]) {
      const name = channel[kind];
      const digest = `sha256:${channel[`${kind}Sha256`]}`;
      const asset = release.assets?.find((a) => a.name === name);
      if (asset?.digest !== digest) {
        problems.push(
          `${ring} server: ${name} is not release v${channel.version}'s asset (${asset?.digest ?? "missing"})`,
        );
        ok = false;
        continue;
      }
      const path = `server/${name}`;
      if (served.has(path)) {
        // Downloaded for another ring: this ring's token must still reach the same bytes.
        const head = await feed(path, tokens[ring], "HEAD");
        if (head.status !== 200 || head.headers.get("content-length") !== String(channel[`${kind}Size`])) {
          problems.push(
            `${ring} server: HEAD ${path} got ${head.status}, length ${head.headers.get("content-length")}`,
          );
          ok = false;
        }
        continue;
      }
      const download = await feed(path, tokens[ring]);
      if (download.status !== 200) {
        served.set(path, true);
        problems.push(`${ring} server: ${path} got ${download.status}`);
        ok = false;
        continue;
      }
      const bytes = Buffer.from(await download.arrayBuffer());
      served.set(path, true);
      if (
        bytes.length !== channel[`${kind}Size`] ||
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest
      ) {
        problems.push(`${ring} server: ${path} does not match the channel file's size and sha256`);
        ok = false;
      }
    }
    if (ok) report.push(`${ring} server: ${channel.version}, served bytes match the published release`);
  }
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
  let state;
  try {
    state = ringState(process.env);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
  const { problems, report } = await watch({
    url,
    tokens,
    repo: process.env.GITHUB_REPOSITORY,
    githubToken: process.env.GITHUB_TOKEN,
    ...state,
  });
  for (const line of report) console.log(line);
  for (const problem of problems) console.error(`::error::${problem}`);
  const digest = problems.length === 0 ? canaryMapDigest(tokens) : undefined;
  if (digest) console.log(`canary map sha256: ${digest} (the configured canaries, all accepted by the feed)`);
  process.exit(problems.length ? 1 : 0);
}
