/**
 * Cloudflare Worker serving the private update feed from an R2 bucket: the Windows desktop
 * channel, and the headless server bundle channel under `server/` (#877).
 *
 * Every request needs `Authorization: Bearer <token>`. The Worker never sees plain tokens at
 * rest: the `FEED_TOKENS` secret maps each token's SHA-256 (hex) to the ring it belongs to,
 * `{"<sha256>": {"ring": "preview"}}`. A server's token may be limited to the server channel,
 * `{"ring": "preview", "channel": "server"}`; it then reads nothing of the desktop channel. The bucket holds immutable `<version>/` snapshots and
 * `rings.json` (see rings.js). Nothing of a snapshot is served until its `complete.json`
 * exists, which feed-r2.sh writes last. The channel file a client asks for (`latest-x64.yml`)
 * resolves per token: the ring's version, or its partial rollout when the token's stable
 * bucket falls under the percentage. Installers and blockmaps are addressed by the version
 * in their file name, which is how electron-updater finds the old blockmap for a
 * differential download.
 *
 * The server channel works the same way, from its own snapshots: `server/<version>/` holds the
 * bundle, its manifest and the manifest's Sigstore signature (as attached to the GitHub
 * release, #876) and `latest-linux-x64.yml`, and is served only once its own `complete.json`
 * exists. `server/latest-linux-x64.yml` resolves per token from rings.json's `server` rings;
 * `server/orca-server-<version>-linux-x64.*` (or `orrery-server-…`) is addressed by the version in its name. The
 * server verifies the signature itself (orca-release.py), so the feed is transport only.
 *
 * Responses are never cached and never redirect. Authorization is never logged.
 */
import { RINGS, isVersion, validateRings, versionFor } from "./rings.js";

const CHANNEL = /^latest-(x64|arm64)\.yml$/;
// The Orrery rename bridge: for one release a ring may still offer a version from before the
// rename, so installers and server bundles are served under either name, and the servers' stop
// is sent under both header names (old servers read the first, renamed ones the second).
// rename-keep-start: both names on purpose
const PAYLOAD = /^(?:ORCA|Orrery)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-(x64|arm64)\.exe(?:\.blockmap)?$/;
const SERVER_STOP = { "X-Orca-Feed-Stop": "servers", "X-Orrery-Feed-Stop": "servers" };
// rename-keep-end
/**
 * Architectures the feed can serve at all, matching `FEED_ARCHES` in feed-publish.yml;
 * anything else answers 404 even if the bucket holds it. Which of them one version serves is
 * that snapshot's own immutable record: `complete.json` lists the architectures feed-r2.sh
 * published (#889), and a record without the list (every snapshot written before it)
 * serves x64 only. That holds for channel files and for direct installer and blockmap reads.
 */
export const SERVED_ARCHES = Object.freeze(["x64", "arm64"]);
const LEGACY_ARCHES = Object.freeze(["x64"]);
const TOKEN = /^Bearer ([A-Za-z0-9_-]{32,256})$/;
const SERVER_CHANNEL = "server/latest-linux-x64.yml";
const SERVER_PAYLOAD =
  /^server\/((?:orca|orrery)-server-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-linux-x64\.(?:tar\.xz|manifest\.json|manifest\.json\.sigstore\.json))$/; // rename-keep: either name

function respond(status, extra = {}, body = null) {
  return new Response(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The caller's token hash, ring and whether it is limited to the server channel, or undefined
 * for anything short of a known token. An entry naming any other channel is refused outright.
 */
export async function authenticate(request, tokens) {
  const match = TOKEN.exec(request.headers.get("Authorization") ?? "");
  if (!match) return undefined;
  const hash = await sha256Hex(match[1]);
  const entry = Object.hasOwn(tokens, hash) ? tokens[hash] : undefined;
  if (!entry || !RINGS.includes(entry.ring)) return undefined;
  if (entry.channel !== undefined && entry.channel !== "server") return undefined;
  return { hash, ring: entry.ring, serverOnly: entry.channel === "server" };
}

/**
 * One `bytes=` range, as R2 takes it. Several ranges get `multiple`: R2 cannot answer them in
 * one read, and electron-updater falls back to a full download when a multi-range request fails.
 */
export function parseRange(header) {
  if (header == null) return undefined;
  const value = /^bytes=(.+)$/.exec(header.trim())?.[1];
  if (!value) return { invalid: true };
  if (value.includes(",")) return { multiple: true };
  const match = /^\s*(\d*)-(\d*)\s*$/.exec(value);
  if (!match || (match[1] === "" && match[2] === "")) return { invalid: true };
  if (match[1] === "") return { suffix: Number(match[2]) };
  const offset = Number(match[1]);
  if (match[2] === "") return { offset };
  const end = Number(match[2]);
  if (end < offset) return { invalid: true };
  return { offset, length: end - offset + 1 };
}

function contentType(name) {
  if (name.endsWith(".yml")) return "text/yaml; charset=utf-8";
  if (name.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/**
 * Whether server/VERSION/complete.json, which feed-r2.sh writes last, is exactly the record
 * it writes for that version. Nothing of a server snapshot is served before.
 */
export function serverSnapshotComplete(text, version) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 3 &&
    record.format === 1 &&
    record.version === version &&
    record.platform === "linux-x64"
  );
}

async function serverPublished(bucket, version) {
  const object = await bucket.get(`server/${version}/complete.json`);
  return object ? serverSnapshotComplete(await object.text(), version) : false;
}

/**
 * The architectures VERSION's snapshot was published with, from VERSION/complete.json, which
 * feed-r2.sh writes last: undefined (serve nothing) until it exists or if it is not a record
 * this feed writes. A record without `arches` predates #889 and serves x64 only.
 */
export function snapshotArches(text, version) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  if (record.version !== undefined && record.version !== version) return undefined;
  if (record.arches === undefined) return record.format === 2 ? undefined : LEGACY_ARCHES;
  const { arches } = record;
  if (
    record.format !== 2 ||
    !Array.isArray(arches) ||
    arches.length === 0 ||
    new Set(arches).size !== arches.length ||
    !arches.every((arch) => SERVED_ARCHES.includes(arch))
  )
    return undefined;
  return arches;
}

async function published(bucket, version) {
  const object = await bucket.get(`${version}/complete.json`);
  return object ? snapshotArches(await object.text(), version) : undefined;
}

async function readRings(bucket) {
  const object = await bucket.get("rings.json");
  if (!object) return undefined;
  return validateRings(JSON.parse(await object.text()));
}

/** Serve one object: whole, or one satisfiable range; HEAD gets headers only. */
async function serve(bucket, key, name, request) {
  const head = request.method === "HEAD";
  const range = parseRange(request.headers.get("Range"));
  const meta = await bucket.head(key);
  if (!meta) return respond(404);
  const base = { "Content-Type": contentType(name), "Accept-Ranges": "bytes", ETag: meta.httpEtag };
  if (!range) {
    const object = head ? null : await bucket.get(key);
    if (!head && !object) return respond(404);
    return respond(200, { ...base, "Content-Length": String(meta.size) }, head ? null : object.body);
  }
  const unsatisfiable = () => respond(416, { "Content-Range": `bytes */${meta.size}`, "Accept-Ranges": "bytes" });
  if (range.invalid || range.multiple) return unsatisfiable();
  let offset;
  let length;
  if (range.suffix !== undefined) {
    if (range.suffix === 0) return unsatisfiable();
    length = Math.min(range.suffix, meta.size);
    offset = meta.size - length;
  } else {
    offset = range.offset;
    if (offset >= meta.size) return unsatisfiable();
    length = Math.min(range.length ?? meta.size - offset, meta.size - offset);
  }
  const headers = {
    ...base,
    "Content-Length": String(length),
    "Content-Range": `bytes ${offset}-${offset + length - 1}/${meta.size}`,
  };
  if (head) return respond(206, headers);
  const object = await bucket.get(key, { range: { offset, length } });
  if (!object) return respond(404);
  return respond(206, headers, object.body);
}

export async function handle(request, env) {
  let tokens;
  try {
    tokens = JSON.parse(env.FEED_TOKENS ?? "{}");
  } catch {
    return respond(503);
  }
  const caller = await authenticate(request, tokens);
  if (!caller) return respond(401, { "WWW-Authenticate": 'Bearer realm="orca-feed"' });
  if (request.method !== "GET" && request.method !== "HEAD") return respond(405, { Allow: "GET, HEAD" });

  // The query is ignored: electron-updater appends a random one to channel requests.
  const name = new URL(request.url).pathname.replace(/^\/+/, "");

  // The server bundle channel (#877): any token, including one limited to it.
  if (name === SERVER_CHANNEL) {
    let rings;
    try {
      rings = await readRings(env.FEED);
    } catch {
      return respond(503);
    }
    // The servers' stop switch (#878): no server may activate anything, even a version it was
    // offered before; the updater only ever activates what a fresh channel file names.
    if (rings?.serverStop === true) return respond(503, { ...SERVER_STOP, "Retry-After": "3600" });
    const version = rings && (await versionFor(rings, caller.ring, caller.hash, "server"));
    if (!version || !(await serverPublished(env.FEED, version))) return respond(404);
    return serve(env.FEED, `server/${version}/latest-linux-x64.yml`, name, request);
  }
  const bundle = SERVER_PAYLOAD.exec(name);
  if (bundle) {
    if (!isVersion(bundle[2]) || !(await serverPublished(env.FEED, bundle[2]))) return respond(404);
    return serve(env.FEED, `server/${bundle[2]}/${bundle[1]}`, name, request);
  }

  // Everything else is the desktop channel, which a server-only token never reads.
  if (caller.serverOnly || name.includes("/")) return respond(404);

  const channel = CHANNEL.exec(name);
  if (channel) {
    if (!SERVED_ARCHES.includes(channel[1])) return respond(404);
    let rings;
    try {
      rings = await readRings(env.FEED);
    } catch {
      return respond(503);
    }
    const version = rings && (await versionFor(rings, caller.ring, caller.hash));
    if (!version || !(await published(env.FEED, version))?.includes(channel[1])) return respond(404);
    // An rc snapshot carries prerelease-ARCH.yml; the client always asks for latest-ARCH.yml.
    for (const file of [`latest-${channel[1]}.yml`, `prerelease-${channel[1]}.yml`]) {
      if (await env.FEED.head(`${version}/${file}`)) return serve(env.FEED, `${version}/${file}`, name, request);
    }
    return respond(404);
  }

  // Any completed snapshot, not only the ring's current one: a differential download needs
  // the blockmap of the version the client is upgrading from.
  const payload = PAYLOAD.exec(name);
  if (payload) {
    if (!SERVED_ARCHES.includes(payload[2])) return respond(404);
    if (!(await published(env.FEED, payload[1]))?.includes(payload[2])) return respond(404);
    return serve(env.FEED, `${payload[1]}/${name}`, name, request);
  }
  return respond(404);
}

export default { fetch: handle };
