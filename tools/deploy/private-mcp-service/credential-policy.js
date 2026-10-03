/** Fail-closed, reusable checks for a reviewed ORCA MCP service profile. */
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, constants } from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";

export const SCOPED_PERMISSIONS = Object.freeze([
  "runs.read",
  "artifacts.read",
  "workflows.read",
  "runs.start",
  "runs.control",
  "inputs.answer",
]);
export const PLAN_PERMISSIONS = Object.freeze([...SCOPED_PERMISSIONS, "plan.read", "plan.write"]);
const ID = /^[A-Za-z0-9_-]{12}$/;
const TOKEN = /^orca1\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHILD_SETTINGS = new Set(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]);

export class PolicyError extends Error {
  constructor(code) {
    super(`MCP service validation failed (${code})`);
    this.name = "PolicyError";
    this.code = code;
  }
}
function fail(code) {
  throw new PolicyError(code);
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value, required, optional = []) {
  if (
    !object(value) ||
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail("shape");
}
function exactSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((item) => actual.includes(item))
  );
}
function scopeEqual(a, b) {
  return (
    object(a) &&
    object(b) &&
    a.runs === b.runs &&
    (a.workflows === "*"
      ? b.workflows === "*"
      : Array.isArray(a.workflows) && Array.isArray(b.workflows) && exactSet(a.workflows, b.workflows))
  );
}
function date(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail("expiry");
  return time;
}
function localEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("endpoint");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "33871" ||
    url.pathname !== "/rpc" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    fail("endpoint");
}

/** The profile has no defaults: each identity, envelope and runtime path must be reviewed. */
export function validateProfile(profile, now = Date.now()) {
  keys(
    profile,
    [
      "version",
      "review",
      "policy",
      "principal",
      "credentialId",
      "permissions",
      "scope",
      "endpoint",
      "target",
      "runtime",
    ],
    ["childEnvironment"],
  );
  if (profile.version !== 1) fail("profile-version");
  keys(profile.review, ["approvedBy", "approvedAt", "reference"]);
  if (![profile.review.approvedBy, profile.review.reference].every((x) => typeof x === "string" && x.trim()))
    fail("review");
  if (date(profile.review.approvedAt) > now) fail("review");
  if (
    !ID.test(profile.credentialId) ||
    typeof profile.principal !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(profile.principal) ||
    profile.principal === "owner"
  )
    fail("principal");
  const expected =
    profile.policy === "scoped-six"
      ? SCOPED_PERMISSIONS
      : profile.policy === "workspace-plan-eight"
        ? PLAN_PERMISSIONS
        : undefined;
  if (!expected || !exactSet(profile.permissions, expected)) fail("permissions");
  keys(profile.scope, ["workflows", "runs"]);
  if (profile.policy === "scoped-six") {
    if (
      !Array.isArray(profile.scope.workflows) ||
      !profile.scope.workflows.length ||
      profile.scope.workflows.length > 100 ||
      new Set(profile.scope.workflows).size !== profile.scope.workflows.length ||
      profile.scope.workflows.some((x) => typeof x !== "string" || !x || x === "*") ||
      !["all", "owned"].includes(profile.scope.runs)
    )
      fail("scope");
  } else if (profile.scope.workflows !== "*" || profile.scope.runs !== "all") fail("scope");
  localEndpoint(profile.endpoint);
  keys(profile.target, ["workspaceId", "instanceId"]);
  if (!UUID.test(profile.target.workspaceId) || !UUID.test(profile.target.instanceId)) fail("target");
  keys(profile.runtime, ["node", "cliEntry", "workspaceDir", "orcaVersion", "commit"]);
  if (
    [profile.runtime.node, profile.runtime.cliEntry, profile.runtime.workspaceDir].some(
      (x) => typeof x !== "string" || !isAbsolute(x),
    ) ||
    profile.runtime.orcaVersion !== "0.6.0" ||
    profile.runtime.commit !== "3702da5b38dc449280c2837366615de741e9c45c"
  )
    fail("runtime");
  const env = profile.childEnvironment ?? {};
  if (
    !object(env) ||
    Object.entries(env).some(
      ([name, value]) => !CHILD_SETTINGS.has(name) || typeof value !== "string" || !value || /[\r\n\0]/.test(value),
    )
  )
    fail("child-environment");
  return profile;
}

/** Refuse symlink components and mutable directory ancestors; O_NOFOLLOW closes the final-link race. */
export function readPrivateFile(path, maxBytes = 64 * 1024) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("file-path");
  const resolved = resolve(path);
  if (resolved !== path) fail("file-path");
  try {
    let cursor = dirname(path);
    while (cursor !== parse(cursor).root) {
      const st = lstatSync(cursor);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022 && !(st.mode & 0o1000))) fail("file-directory");
      cursor = dirname(cursor);
    }
    const before = lstatSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid() ||
      before.mode & 0o077 ||
      before.size > maxBytes
    )
      fail("file-security");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const after = fstatSync(fd);
      if (
        !after.isFile() ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.nlink !== 1 ||
        after.uid !== process.getuid() ||
        after.mode & 0o077 ||
        after.size > maxBytes
      )
        fail("file-security");
      const buffer = Buffer.allocUnsafe(maxBytes + 1);
      let used = 0;
      while (used <= maxBytes) {
        const count = readSync(fd, buffer, used, maxBytes + 1 - used, null);
        if (count === 0) break;
        used += count;
      }
      if (used > maxBytes) fail("file-security");
      return buffer.subarray(0, used).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    fail("file-security");
  }
}

export function validateCredential(profile, tokenText, storeText, now = Date.now()) {
  const token = TOKEN.exec(tokenText.replace(/\n$/, ""));
  if (!token || token[1] !== profile.credentialId) fail("token");
  let store;
  try {
    store = JSON.parse(storeText);
  } catch {
    fail("credential-store");
  }
  if (!object(store) || store.version !== 1 || !Array.isArray(store.credentials)) fail("credential-store");
  const matches = store.credentials.filter((row) => object(row) && row.id === profile.credentialId);
  if (matches.length !== 1) fail("credential-record");
  const row = matches[0];
  if (
    row.bootstrap ||
    row.revokedAt ||
    row.principal !== profile.principal ||
    !exactSet(row.permissions, profile.permissions) ||
    !scopeEqual(row.scope, profile.scope) ||
    typeof row.secretSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.secretSha256)
  )
    fail("credential-policy");
  if (date(row.expiresAt) <= now) fail("expiry");
  const actual = createHash("sha256").update(token[2], "utf8").digest();
  if (!timingSafeEqual(actual, Buffer.from(row.secretSha256, "hex"))) fail("token");
  return tokenText.replace(/\n$/, "");
}

export function validateDiscovery(profile, discovery) {
  if (
    !object(discovery) ||
    discovery.authentication !== "credential" ||
    discovery.principalId !== profile.principal ||
    discovery.orcaVersion !== profile.runtime.orcaVersion ||
    !object(discovery.target) ||
    discovery.target.workspaceId !== profile.target.workspaceId ||
    discovery.target.instanceId !== profile.target.instanceId ||
    !object(discovery.scope) ||
    !exactSet(discovery.scope.permissions, profile.permissions) ||
    !scopeEqual(discovery.scope, profile.scope)
  )
    fail("live-identity");
  return discovery;
}
