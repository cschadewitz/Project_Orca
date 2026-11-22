/**
 * The update feed's rings: which version each ring (internal, preview, stable) is offered,
 * optional partial rollouts, and the only transitions publication and promotion may make.
 * Shared by the Cloudflare Worker that serves the feed and the CLI the release jobs run.
 *
 * Two channels share one rings.json, so one conditional write moves both consistently:
 * `rings` is the Windows desktop channel, and `server` (#877) the headless server bundle
 * channel, with the same ring entries. Servers must never fall behind the desktops that talk
 * to them, so from the server bundle's first line (SERVER_FROM) a ring's desktops are offered
 * a version only once every server in that ring is offered it or newer: the server ring's
 * full version, since a server outside a rollout keeps the full version. This is a rule about
 * what the feed offers: it says nothing about what any host has installed or is running, which
 * is the server updater's to establish (#878, #879).
 *
 * `serverStop: true` is the servers' stop switch (#878): while it is set, the Worker answers
 * every server's channel file with 503 and `X-Orca-Feed-Stop: servers`, so no server activates
 * anything, not even a version it was offered and staged before. Publication and promotion
 * leave it as it is; only resumeServers clears it.
 */

export const RINGS = ["internal", "preview", "stable"];
export const CHANNELS = ["desktop", "server"];
/** The first release line with a server bundle (release-attach.sh SERVER_FROM, #876). */
export const SERVER_FROM = "0.8.0";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isVersion(value) {
  return typeof value === "string" && VERSION.test(value);
}

export function isPrerelease(version) {
  return VERSION.exec(version)?.[4] !== undefined;
}

/** Semantic-version order (build metadata is not accepted, so it never needs ignoring). */
export function compareVersions(a, b) {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return Math.sign(d);
  }
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) return Math.sign(Number(p[i]) - Number(q[i]));
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

export function emptyRings() {
  return { format: 1, rings: {} };
}

function validateRingMap(map, label) {
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`Invalid ${label} rings`);
  for (const [name, ring] of Object.entries(map)) {
    const where = label === "desktop" ? name : `${label} ${name}`;
    if (!RINGS.includes(name)) throw new Error(`Unknown ring: ${where}`);
    if (!ring || typeof ring !== "object") throw new Error(`Invalid ring: ${where}`);
    if (ring.version !== undefined && !isVersion(ring.version)) throw new Error(`Invalid version in ${where}`);
    if (name === "stable" && ring.version && isPrerelease(ring.version))
      throw new Error("stable cannot hold a prerelease");
    if (ring.rollout !== undefined) {
      const { version, percent } = ring.rollout ?? {};
      if (!isVersion(version) || !Number.isInteger(percent) || percent < 1 || percent > 99)
        throw new Error(`Invalid rollout in ${where}`);
      if (name === "stable" && isPrerelease(version)) throw new Error("stable cannot roll out a prerelease");
      if (ring.version && compareVersions(version, ring.version) <= 0)
        throw new Error(`Rollout in ${where} must be newer than its version`);
    }
  }
}

/**
 * Fail closed on anything but the exact shape this file writes. `server` is optional: a
 * rings.json written before the server channel has none, and a Worker from before it ignores
 * the key, so adding it never stops the desktop channel.
 */
export function validateRings(value) {
  if (!value || typeof value !== "object" || value.format !== 1 || !value.rings || typeof value.rings !== "object")
    throw new Error("rings.json is not format 1");
  validateRingMap(value.rings, "desktop");
  if (value.server !== undefined) validateRingMap(value.server, "server");
  if (value.serverStop !== undefined && value.serverStop !== true)
    throw new Error("rings.json serverStop must be true or absent");
  return value;
}

/** Stop every server from activating anything offered (always allowed: it only stops). */
export function stopServers(rings) {
  const next = validateRings(JSON.parse(JSON.stringify(rings)));
  next.serverStop = true;
  return { rings: next, message: "servers stopped: every server's channel answers 503 until resumed" };
}

/** Lift the servers' stop switch. */
export function resumeServers(rings) {
  const next = validateRings(JSON.parse(JSON.stringify(rings)));
  if (!next.serverStop) throw new Error("servers are not stopped");
  delete next.serverStop;
  return { rings: next, message: "servers resumed: each server ring offers its version again" };
}

/** The ring map of CHANNEL inside RINGS (created empty for the server channel on demand). */
function channelRings(rings, channel, create = false) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
  if (channel === "desktop") return rings.rings;
  if (!rings.server && create) rings.server = {};
  return rings.server ?? {};
}

/** Whether VERSION is on a line that ships a server bundle (its release candidates included). */
export function hasServer(version) {
  const base = VERSION.exec(version);
  if (!base) throw new Error(`Invalid version: ${version}`);
  return compareVersions(`${base[1]}.${base[2]}.${base[3]}`, SERVER_FROM) >= 0;
}

/**
 * Refuse to offer desktop VERSION in RING while any of that ring's servers could still be
 * offered something older: the server ring's full version must be VERSION or newer.
 */
function requireServers(rings, ring, version) {
  if (!hasServer(version)) return;
  const servers = rings.server?.[ring]?.version;
  if (!servers || compareVersions(servers, version) < 0)
    throw new Error(
      `${ring} servers are ${servers ? `on ${servers}` : "offered nothing"}; offer the server bundle ${version} to all of ${ring} first (servers never fall behind desktops)`,
    );
}

/** The newest version any token in the ring may already have been offered. */
function newest(entry) {
  if (!entry) return undefined;
  return entry.rollout?.version ?? entry.version;
}

function clone(rings) {
  return validateRings(JSON.parse(JSON.stringify(rings)));
}

/**
 * A newly published release lands in `internal` only. An older version than internal already
 * offers (a hotfix behind a newer rc) is stored but not offered; promote it explicitly. On the
 * desktop channel, a server-era version needs internal's servers on it first.
 */
export function publish(rings, version, channel = "desktop") {
  if (!isVersion(version)) throw new Error(`Invalid version: ${version}`);
  if (channel === "server" && !hasServer(version))
    throw new Error(`${version} predates the server bundle (${SERVER_FROM})`);
  const next = clone(rings);
  const map = channelRings(next, channel, true);
  const label = channel === "desktop" ? "internal" : "internal servers";
  const current = newest(map.internal);
  if (current && compareVersions(version, current) <= 0)
    return {
      rings: next,
      changed: false,
      message: `${label} stay${channel === "desktop" ? "s" : ""} on ${current}; ${version} stored only`,
    };
  if (channel === "desktop") requireServers(next, "internal", version);
  map.internal = { version };
  return {
    rings: validateRings(next),
    changed: true,
    message: `${label} now offer${channel === "desktop" ? "s" : ""} ${version}`,
  };
}

/**
 * Offer `version` to `percent`% of a ring (1-99), to all of it (100), or halt its rollout (0).
 * Rings never move backwards: the client refuses downgrades, so a pointer moved back would
 * only strand the people already updated. Halting leaves the ring's full version untouched.
 * Desktops are never offered a server-era version their ring's servers are not all on; a
 * halt is always allowed, and servers may run ahead of desktops.
 */
export function promote(rings, ring, version, percent, channel = "desktop") {
  if (!RINGS.includes(ring)) throw new Error(`Unknown ring: ${ring}`);
  if (!isVersion(version)) throw new Error(`Invalid version: ${version}`);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("percent must be 0-100");
  if (channel === "server" && !hasServer(version))
    throw new Error(`${version} predates the server bundle (${SERVER_FROM})`);
  const next = clone(rings);
  const map = channelRings(next, channel, true);
  const label = channel === "desktop" ? ring : `${ring} servers`;
  const entry = map[ring] ?? {};
  if (percent === 0) {
    if (entry.rollout?.version !== version)
      throw new Error(`${label} ${channel === "desktop" ? "is" : "are"} not rolling out ${version}`);
    delete entry.rollout;
    map[ring] = entry;
    return { rings: validateRings(next), message: `${label} rollout of ${version} halted` };
  }
  if (ring === "stable" && isPrerelease(version)) throw new Error("stable cannot take a prerelease");
  if (entry.version && compareVersions(version, entry.version) <= 0)
    throw new Error(
      `${label} already offer${channel === "desktop" ? "s" : ""} ${entry.version}; rings never move backwards`,
    );
  // Some of the ring may already run the active rollout's version; an older one would strand
  // them. Widening or completing the same version is fine, and halting is handled above.
  if (entry.rollout && compareVersions(version, entry.rollout.version) < 0)
    throw new Error(
      `${label} ${channel === "desktop" ? "is" : "are"} rolling out ${entry.rollout.version}; rings never move backwards`,
    );
  if (channel === "desktop") requireServers(next, ring, version);
  if (percent === 100) {
    map[ring] = { version };
    return {
      rings: validateRings(next),
      message: `${label} now offer${channel === "desktop" ? "s" : ""} ${version} to everyone`,
    };
  }
  entry.rollout = { version, percent };
  map[ring] = entry;
  return {
    rings: validateRings(next),
    message: `${label} offer${channel === "desktop" ? "s" : ""} ${version} to ${percent}%`,
  };
}

/** 0-99, stable for one token and one rollout version, so raising the percent only adds people. */
export async function rolloutBucket(tokenHash, version) {
  const data = new TextEncoder().encode(`${tokenHash}:${version}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return value % 100;
}

/**
 * The version a token's ring offers it on CHANNEL, or undefined when the ring offers nothing
 * yet. The rollout bucket is the same on both channels: it depends only on the token and the
 * rollout version.
 */
export async function versionFor(rings, ring, tokenHash, channel = "desktop") {
  const entry = channelRings(rings, channel)[ring];
  if (!entry) return undefined;
  if (entry.rollout && (await rolloutBucket(tokenHash, entry.rollout.version)) < entry.rollout.percent)
    return entry.rollout.version;
  return entry.version;
}
