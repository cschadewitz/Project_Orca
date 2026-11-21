/**
 * Cloudflare Worker serving the private Windows desktop update feed from an R2 bucket.
 *
 * Every request needs `Authorization: Bearer <token>`. The Worker never sees plain tokens at
 * rest: the `FEED_TOKENS` secret maps each token's SHA-256 (hex) to the ring it belongs to,
 * `{"<sha256>": {"ring": "preview"}}`. The bucket holds immutable `<version>/` snapshots and
 * `rings.json` (see rings.js). Nothing of a snapshot is served until its `complete.json`
 * exists, which feed-r2.sh writes last. The channel file a client asks for (`latest-x64.yml`)
 * resolves per token: the ring's version, or its partial rollout when the token's stable
 * bucket falls under the percentage. Installers and blockmaps are addressed by the version
 * in their file name, which is how electron-updater finds the old blockmap for a
 * differential download.
 *
 * Responses are never cached and never redirect. Authorization is never logged.
 */
import { RINGS, validateRings, versionFor } from "./rings.js";

const CHANNEL = /^latest-(x64|arm64)\.yml$/;
const PAYLOAD = /^ORCA-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-(?:x64|arm64)\.exe(?:\.blockmap)?$/;
const TOKEN = /^Bearer ([A-Za-z0-9_-]{32,256})$/;

function respond(status, extra = {}, body = null) {
  return new Response(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The caller's token hash and ring, or undefined for anything short of a known token. */
export async function authenticate(request, tokens) {
  const match = TOKEN.exec(request.headers.get("Authorization") ?? "");
  if (!match) return undefined;
  const hash = await sha256Hex(match[1]);
  const entry = Object.hasOwn(tokens, hash) ? tokens[hash] : undefined;
  if (!entry || !RINGS.includes(entry.ring)) return undefined;
  return { hash, ring: entry.ring };
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
  return "application/octet-stream";
}

/** feed-r2.sh writes VERSION/complete.json last; until then nothing of VERSION is served. */
async function complete(bucket, version) {
  return Boolean(await bucket.head(`${version}/complete.json`));
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
  if (name.includes("/")) return respond(404);

  const channel = CHANNEL.exec(name);
  if (channel) {
    let rings;
    try {
      rings = await readRings(env.FEED);
    } catch {
      return respond(503);
    }
    const version = rings && (await versionFor(rings, caller.ring, caller.hash));
    if (!version || !(await complete(env.FEED, version))) return respond(404);
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
    if (!(await complete(env.FEED, payload[1]))) return respond(404);
    return serve(env.FEED, `${payload[1]}/${name}`, name, request);
  }
  return respond(404);
}

export default { fetch: handle };
