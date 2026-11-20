/**
 * The desktop feed's rings: which version each ring (internal, preview, stable) is offered,
 * optional partial rollouts, and the only transitions publication and promotion may make.
 * Shared by the Cloudflare Worker that serves the feed and the CLI the release jobs run.
 */

export const RINGS = ["internal", "preview", "stable"];
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

/** Fail closed on anything but the exact shape this file writes. */
export function validateRings(value) {
  if (!value || typeof value !== "object" || value.format !== 1 || !value.rings || typeof value.rings !== "object")
    throw new Error("rings.json is not format 1");
  for (const [name, ring] of Object.entries(value.rings)) {
    if (!RINGS.includes(name)) throw new Error(`Unknown ring: ${name}`);
    if (!ring || typeof ring !== "object") throw new Error(`Invalid ring: ${name}`);
    if (ring.version !== undefined && !isVersion(ring.version)) throw new Error(`Invalid version in ${name}`);
    if (name === "stable" && ring.version && isPrerelease(ring.version))
      throw new Error("stable cannot hold a prerelease");
    if (ring.rollout !== undefined) {
      const { version, percent } = ring.rollout ?? {};
      if (!isVersion(version) || !Number.isInteger(percent) || percent < 1 || percent > 99)
        throw new Error(`Invalid rollout in ${name}`);
      if (name === "stable" && isPrerelease(version)) throw new Error("stable cannot roll out a prerelease");
      if (ring.version && compareVersions(version, ring.version) <= 0)
        throw new Error(`Rollout in ${name} must be newer than its version`);
    }
  }
  return value;
}

function clone(rings) {
  return validateRings(JSON.parse(JSON.stringify(rings)));
}

/**
 * A newly published release lands in `internal` only. An older version than internal already
 * offers (a hotfix behind a newer rc) is stored but not offered; promote it explicitly.
 */
export function publish(rings, version) {
  if (!isVersion(version)) throw new Error(`Invalid version: ${version}`);
  const next = clone(rings);
  const current = next.rings.internal?.version;
  if (current && compareVersions(version, current) <= 0)
    return { rings: next, changed: false, message: `internal stays on ${current}; ${version} stored only` };
  next.rings.internal = { version };
  return { rings: validateRings(next), changed: true, message: `internal now offers ${version}` };
}

/**
 * Offer `version` to `percent`% of a ring (1-99), to all of it (100), or halt its rollout (0).
 * Rings never move backwards: the client refuses downgrades, so a pointer moved back would
 * only strand the people already updated. Halting leaves the ring's full version untouched.
 */
export function promote(rings, ring, version, percent) {
  if (!RINGS.includes(ring)) throw new Error(`Unknown ring: ${ring}`);
  if (!isVersion(version)) throw new Error(`Invalid version: ${version}`);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("percent must be 0-100");
  const next = clone(rings);
  const entry = next.rings[ring] ?? {};
  if (percent === 0) {
    if (entry.rollout?.version !== version) throw new Error(`${ring} is not rolling out ${version}`);
    delete entry.rollout;
    next.rings[ring] = entry;
    return { rings: validateRings(next), message: `${ring} rollout of ${version} halted` };
  }
  if (ring === "stable" && isPrerelease(version)) throw new Error("stable cannot take a prerelease");
  if (entry.version && compareVersions(version, entry.version) <= 0)
    throw new Error(`${ring} already offers ${entry.version}; rings never move backwards`);
  if (percent === 100) {
    next.rings[ring] = { version };
    return { rings: validateRings(next), message: `${ring} now offers ${version} to everyone` };
  }
  entry.rollout = { version, percent };
  next.rings[ring] = entry;
  return { rings: validateRings(next), message: `${ring} offers ${version} to ${percent}%` };
}

/** 0-99, stable for one token and one rollout version, so raising the percent only adds people. */
export async function rolloutBucket(tokenHash, version) {
  const data = new TextEncoder().encode(`${tokenHash}:${version}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return value % 100;
}

/** The version a token's ring offers it, or undefined when the ring offers nothing yet. */
export async function versionFor(rings, ring, tokenHash) {
  const entry = rings.rings[ring];
  if (!entry) return undefined;
  if (entry.rollout && (await rolloutBucket(tokenHash, entry.rollout.version)) < entry.rollout.percent)
    return entry.rollout.version;
  return entry.version;
}
