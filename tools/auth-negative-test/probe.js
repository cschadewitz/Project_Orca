#!/usr/bin/env node
/**
 * The #392 missing/invalid-credential rejection probe: three fixed requests to one explicitly
 * selected loopback daemon `/rpc`, and a correlator that matches them to the daemon's own
 * `authn.denied` audit records. docs/preparation/private-mcp-access/auth-negative-test.md is
 * the operator procedure; nothing here is authority to run it.
 *
 * What it will not do, by construction:
 *
 * - Read, accept or send a real credential. The only bearer values it sends are the two
 *   published fixtures below; there is no flag, file or environment variable for another one.
 * - Reach anything but `http://127.0.0.1:<port>/rpc` or `http://[::1]:<port>/rpc`, named
 *   explicitly and confirmed with a phrase that repeats the port. No proxy, no redirect.
 * - Retry. Each request is sent once; the first result that is not the expected refusal
 *   stops the run, and an unreachable daemon is a stop, not a reason to try again.
 * - Keep a response body it did not expect. A complete unexpected body is reduced to its
 *   length and SHA-256; a body over the cap is terminated and marked truncated, with no digest.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const ISSUE = 392;
export const SCHEMA = "orca.auth-negative-probe.v1";

/**
 * A credential id in ORCA's shape (`[A-Za-z0-9_-]{12}`) that no daemon issues: issued ids are
 * nine random bytes in base64url, and this one is a published constant.
 */
export const FIXTURE_ID = "negfix392zzz";
/** 43 characters in the secret's alphabet, published here, so it can never be anyone's secret. */
export const FIXTURE_SECRET = "negative_fixture_392_not_a_credential______";

/**
 * The three requests, in order. `auditReason` is what the daemon writes to its audit log and
 * never sends: both invalid fixtures look identical on the wire (`AUTH_INVALID`), and only
 * the audit reason says whether the credential store was consulted (`unknown`) or the value
 * was refused on its shape (`malformed`).
 */
export const PROBES = Object.freeze([
  Object.freeze({
    name: "missing",
    authorization: undefined,
    expect: Object.freeze({ code: "AUTH_REQUIRED", auditReason: "missing" }),
  }),
  Object.freeze({
    name: "malformed-fixture",
    authorization: "Bearer orca-negative-fixture-392-not-a-credential", // rename-keep: the prepared packet in docs/preparation (not renamed) names this exact fixture
    expect: Object.freeze({ code: "AUTH_INVALID", auditReason: "malformed" }),
  }),
  Object.freeze({
    name: "unknown-id-fixture",
    authorization: `Bearer orca1.${FIXTURE_ID}.${FIXTURE_SECRET}`,
    expect: Object.freeze({ code: "AUTH_INVALID", auditReason: "unknown", auditCredentialId: FIXTURE_ID }),
  }),
]);

/** The daemon's generic refusal messages (packages/daemon/src/auth/errors.ts). */
export const MESSAGES = Object.freeze({
  AUTH_REQUIRED: "authentication required",
  AUTH_INVALID: "invalid credentials",
  AUTH_FORBIDDEN: "not permitted",
});
export const WWW_AUTHENTICATE = 'Bearer realm="orca"';

/** The body each request carries. `hello` is read-only; a refusal never reads it at all. */
const METHOD = "hello";
const TIMEOUT_MS = 5_000;
const MAX_BODY = 4096;

export class ProbeUsageError extends Error {
  name = "ProbeUsageError";
}

/** Accept only an explicit loopback IP literal, an explicit port and exactly `/rpc`. */
export function parseEndpoint(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ProbeUsageError("--endpoint is not a URL");
  }
  if (url.protocol !== "http:") throw new ProbeUsageError("--endpoint must be plain http on loopback");
  if (url.username || url.password) throw new ProbeUsageError("--endpoint must not carry userinfo");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")
    throw new ProbeUsageError("--endpoint host must be the literal 127.0.0.1 or [::1]");
  if (!url.port || !/^\d+$/.test(url.port)) throw new ProbeUsageError("--endpoint must name its port explicitly");
  if (url.pathname !== "/rpc" || url.search || url.hash || !text.endsWith("/rpc"))
    throw new ProbeUsageError("--endpoint path must be exactly /rpc, with no query or fragment");
  return { hostname: url.hostname.replace(/^\[|\]$/g, ""), host: url.host, port: Number(url.port), url: url.href };
}

/** The phrase the operator types, binding consent to this issue and this one port. */
export function confirmationFor(endpoint) {
  return `auth-negative-${ISSUE}@${endpoint.host}`;
}

const APPROVAL_REF = /^https:\/\/github\.com\/cschadewitz\/Project_Orca\/(issues|pull)\/\d+#issuecomment-\d+$/;

export function validateRunArgs({ endpoint, confirm, approvalRef, evidenceDir }) {
  const parsed = parseEndpoint(endpoint ?? "");
  if (confirm !== confirmationFor(parsed))
    throw new ProbeUsageError(`--confirm must be exactly '${confirmationFor(parsed)}'`);
  if (!APPROVAL_REF.test(approvalRef ?? ""))
    throw new ProbeUsageError("--approval-ref must link the GitHub comment that records the permission");
  if (!evidenceDir) throw new ProbeUsageError("--evidence-dir is required");
  if (existsSync(evidenceDir)) throw new ProbeUsageError("--evidence-dir must not exist yet; one run, one directory");
  return parsed;
}

/**
 * Send one request, once. Resolves with what came back or why nothing did; never rejects.
 *
 * `timeoutMs` is one absolute wall-clock deadline covering connection, headers and body, not
 * an inactivity timeout: a listener that drips bytes cannot keep the probe running past it.
 * Once a status line has arrived it is kept, whatever happens to the body afterwards, so a
 * 2xx whose body then stalls or breaks is still classified as access, not as unreachable.
 *
 * `bodyState` says what is known about the body:
 * - `complete`: the response ended within MAX_BODY bytes; `body` holds it and `size` is exact.
 * - `truncated`: the first chunk over MAX_BODY arrived; the connection was torn down instead
 *   of drained, nothing is kept, and `size` is only the bytes observed (a lower bound).
 * - `unavailable`: headers arrived but the body did not finish (deadline or transport error);
 *   `size` is again only what was observed.
 */
export function sendOnce(endpoint, probe, id, timeoutMs = TIMEOUT_MS) {
  const body = JSON.stringify({ kind: "request", id, method: METHOD, params: {} });
  const headers = {
    host: endpoint.host,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    ...(probe.authorization === undefined ? {} : { authorization: probe.authorization }),
  };
  return new Promise((resolve) => {
    let settled = false;
    let response;
    // What has been observed so far; a transport error or the deadline keeps it.
    let partial = {};
    // Armed before the request exists; it can only fire after `req` below is assigned.
    const deadline = setTimeout(() => fail("ETIMEDOUT"), timeoutMs);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      response?.destroy();
      req.destroy();
      resolve(value);
    };
    const fail = (code) => done({ ...partial, transportError: code });
    // agent:false - a fresh connection, no keep-alive pool and no proxy.
    const req = request(
      { hostname: endpoint.hostname, port: endpoint.port, path: "/rpc", method: "POST", headers, agent: false },
      (res) => {
        response = res;
        const chunks = [];
        const head = {
          status: res.statusCode,
          headers: {
            "www-authenticate": res.headers["www-authenticate"],
            connection: res.headers.connection,
            "content-type": res.headers["content-type"],
          },
        };
        partial = { ...head, bodyState: "unavailable", size: 0 };
        res.on("data", (chunk) => {
          if (settled) return;
          partial.size += chunk.length;
          if (partial.size > MAX_BODY) {
            chunks.length = 0;
            done({ ...head, bodyState: "truncated", size: partial.size });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => done({ ...head, bodyState: "complete", body: Buffer.concat(chunks), size: partial.size }));
        res.on("error", (e) => fail(e.code ?? "ERESPONSE"));
      },
    );
    req.on("error", (e) => fail(e.code ?? "EREQUEST"));
    req.end(body);
  });
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Which boundary refused the request, from the response alone.
 *
 * - `credential-check`: 401 with the daemon's exact generic refusal for this fixture and
 *   `id: 0` - the daemon answered before reading the body, so this is TransportGate's
 *   credential step, not a method or the MCP adapter.
 * - `transport-gate`: 403 `AUTH_FORBIDDEN` - a Host, Origin or proxy rule fired before any
 *   credential was looked at. A stop: the probe was not shaped for that.
 * - `unexpected-access`: anything 2xx or `ok: true`. A stop, and the most serious one.
 */
export function classify(probe, response) {
  const successfulStatus = response.status >= 200 && response.status < 300;
  // A received 2xx is unexpected access even if its body later stalls or breaks.
  if (response.transportError && !successfulStatus)
    return { verdict: "unreachable", stop: true, error: response.transportError };
  // An injected `send` may omit bodyState; a Buffer body is then taken as complete.
  const bodyState = response.bodyState ?? (Buffer.isBuffer(response.body) ? "complete" : "unavailable");
  const complete = bodyState === "complete" && Buffer.isBuffer(response.body);
  let parsed;
  try {
    parsed = complete ? JSON.parse(response.body.toString("utf8")) : undefined;
  } catch {
    parsed = undefined;
  }
  // Only a body read to its end is digested. Otherwise bodyBytes is the observed lower bound
  // and there is no digest, rather than the digest of an empty or partial buffer.
  const record = {
    status: response.status,
    bodyBytes: response.size ?? 0,
    bodyState: complete ? "complete" : bodyState === "truncated" ? "truncated" : "unavailable",
    bodyBytesExact: complete,
    bodySha256: complete ? digest(response.body) : null,
    ...(response.transportError ? { error: response.transportError } : {}),
  };
  if (successfulStatus || parsed?.ok === true) return { verdict: "unexpected-access", stop: true, ...record };
  const expected = {
    kind: "response",
    id: 0,
    ok: false,
    error: { code: probe.expect.code, message: MESSAGES[probe.expect.code] },
  };
  if (
    response.status === 401 &&
    response.headers["www-authenticate"] === WWW_AUTHENTICATE &&
    isDeepStrictEqual(parsed, expected)
  )
    return {
      verdict: "rejected-at-credential-check",
      stop: false,
      status: 401,
      code: probe.expect.code,
      message: expected.error.message,
      bodyId: 0,
      wwwAuthenticate: WWW_AUTHENTICATE,
      connection: response.headers.connection,
    };
  const forbidden = {
    kind: "response",
    id: 0,
    ok: false,
    error: { code: "AUTH_FORBIDDEN", message: MESSAGES.AUTH_FORBIDDEN },
  };
  if (response.status === 403 && isDeepStrictEqual(parsed, forbidden))
    return { verdict: "rejected-at-transport-gate", stop: true, status: 403, code: "AUTH_FORBIDDEN" };
  const code =
    typeof parsed?.error?.code === "string" && /^[A-Z_]{1,40}$/.test(parsed.error.code) ? parsed.error.code : undefined;
  return { verdict: "unexpected-response", stop: true, ...record, ...(code ? { code } : {}) };
}

const EXIT = {
  "all-rejected": 0,
  "unexpected-response": 2,
  "rejected-at-transport-gate": 2,
  "unexpected-access": 3,
  unreachable: 4,
};

/**
 * Send the three probes in order, at most once each, stopping at the first that is not the
 * expected credential refusal. `send` and `now` are injectable for the offline tests.
 */
export async function runProbes(endpoint, { approvalRef, send = sendOnce, now = () => new Date() } = {}) {
  const startedAt = now();
  const runId = `an${ISSUE}-${startedAt.toISOString().replace(/[-:.]/g, "")}`;
  const requests = [];
  let stopped;
  for (const [index, probe] of PROBES.entries()) {
    const sentAt = now().toISOString();
    const response = await send(endpoint, probe, `${runId}-${index + 1}`);
    const receivedAt = now().toISOString();
    const result = classify(probe, response);
    const { stop, ...kept } = result;
    requests.push({
      index: index + 1,
      probe: probe.name,
      expected: { status: 401, code: probe.expect.code, auditReason: probe.expect.auditReason },
      sentAt,
      receivedAt,
      ...kept,
    });
    if (stop) {
      stopped = result.verdict;
      break;
    }
  }
  const outcome = stopped ?? "all-rejected";
  return {
    schema: SCHEMA,
    issue: ISSUE,
    runId,
    approvalRef,
    endpoint: endpoint.host,
    method: METHOD,
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    requestsPlanned: PROBES.length,
    requestsSent: requests.length,
    outcome,
    exitCode: EXIT[outcome],
    requests,
  };
}

function writePrivate(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const SKEW_MS = 2_000;

/**
 * Match each refused request to the daemon's own audit record of it, and say nothing about
 * the rest of the log beyond how many other records fell in the window, by event.
 *
 * A request is matched by an `authn.denied` record on `http`, in its send/receive window
 * (widened by a small skew), with the expected code and reason - and, for the unknown-id
 * fixture, the fixture's public credential id as the record's target. That pairing is what
 * says the daemon's credential step was the boundary, rather than the tunnel, the MCP
 * adapter or something in front of the daemon.
 */
export function correlate(evidence, auditText) {
  const records = [];
  for (const line of auditText.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn or foreign line is not evidence either way; it is counted below as such.
      records.push({ unparseable: true });
    }
  }
  const from = Date.parse(evidence.startedAt) - SKEW_MS;
  const to = Date.parse(evidence.finishedAt) + SKEW_MS;
  const inWindow = records.filter((r) => !r.unparseable && Date.parse(r.at) >= from && Date.parse(r.at) <= to);
  const used = new Set();
  const matches = [];
  for (const req of evidence.requests) {
    const probe = PROBES.find((p) => p.name === req.probe);
    if (req.verdict !== "rejected-at-credential-check" || !probe) {
      matches.push({ index: req.index, probe: req.probe, matched: false, why: "request was not a credential refusal" });
      continue;
    }
    const lo = Date.parse(req.sentAt) - SKEW_MS;
    const hi = Date.parse(req.receivedAt) + SKEW_MS;
    const found = inWindow.findIndex(
      (r, i) =>
        !used.has(i) &&
        r.event === "authn.denied" &&
        r.transport === "http" &&
        r.outcome === "denied" &&
        r.code === probe.expect.code &&
        r.reason === probe.expect.auditReason &&
        r.actor === undefined &&
        (probe.expect.auditCredentialId
          ? r.target?.credentialId === probe.expect.auditCredentialId
          : r.target === undefined) &&
        Date.parse(r.at) >= lo &&
        Date.parse(r.at) <= hi,
    );
    if (found < 0) {
      matches.push({ index: req.index, probe: req.probe, matched: false, why: "no matching authn.denied record" });
      continue;
    }
    used.add(found);
    const r = inWindow[found];
    matches.push({
      index: req.index,
      probe: req.probe,
      matched: true,
      at: r.at,
      event: r.event,
      transport: r.transport,
      code: r.code,
      reason: r.reason,
      remoteLoopback: r.remote === "127.0.0.1" || r.remote === "::1",
      ...(probe.expect.auditCredentialId ? { fixtureCredentialId: r.target.credentialId } : {}),
    });
  }
  const others = {};
  inWindow.forEach((r, i) => {
    if (used.has(i)) return;
    const key = typeof r.event === "string" && /^[a-z.]{1,40}$/.test(r.event) ? r.event : "other";
    others[key] = (others[key] ?? 0) + 1;
  });
  const unparseable = records.filter((r) => r.unparseable).length;
  const confirmed =
    evidence.outcome === "all-rejected" &&
    matches.length === PROBES.length &&
    matches.every((m) => m.matched && m.remoteLoopback);
  return {
    schema: `${SCHEMA}.correlation`,
    runId: evidence.runId,
    verdict: confirmed ? "daemon-credential-boundary-confirmed" : "not-confirmed",
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    matches,
    otherRecordsInWindow: others,
    unparseableLines: unparseable,
  };
}

/** What `plan` prints: the requests that `run` would send, without sending anything. */
export function describePlan(endpoint) {
  return {
    schema: `${SCHEMA}.plan`,
    endpoint: endpoint.host,
    confirmation: confirmationFor(endpoint),
    method: METHOD,
    retries: 0,
    timeoutMsEach: TIMEOUT_MS,
    requests: PROBES.map((p, i) => ({
      index: i + 1,
      probe: p.name,
      bearer: p.authorization === undefined ? "none" : "published fixture",
      expected: { status: 401, code: p.expect.code, auditReason: p.expect.auditReason },
    })),
  };
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) throw new ProbeUsageError(`unexpected argument '${key}'`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

const USAGE = `usage:
  probe.js plan --endpoint http://127.0.0.1:<port>/rpc
  probe.js run --endpoint <url> --confirm auth-negative-392@127.0.0.1:<port> --approval-ref <comment url> --evidence-dir <new dir>
  probe.js correlate --evidence <evidence.json> --audit-log <audit.jsonl> --out <correlation.json>`;

const ALLOWED = {
  plan: ["endpoint"],
  run: ["endpoint", "confirm", "approval-ref", "evidence-dir"],
  correlate: ["evidence", "audit-log", "out"],
};

export async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [command, ...rest] = argv;
  try {
    if (!ALLOWED[command]) throw new ProbeUsageError("unknown command");
    const f = flags(rest);
    for (const key of Object.keys(f))
      if (!ALLOWED[command].includes(key)) throw new ProbeUsageError(`--${key} is not accepted by ${command}`);
    if (command === "plan") {
      io.out(`${JSON.stringify(describePlan(parseEndpoint(f.endpoint ?? "")), null, 2)}\n`);
      return 0;
    }
    if (command === "run") {
      const endpoint = validateRunArgs({
        endpoint: f.endpoint,
        confirm: f.confirm,
        approvalRef: f["approval-ref"],
        evidenceDir: f["evidence-dir"],
      });
      mkdirSync(f["evidence-dir"], { recursive: false, mode: 0o700 });
      const evidence = await runProbes(endpoint, { approvalRef: f["approval-ref"] });
      evidence.helperSha256 = digest(readFileSync(fileURLToPath(import.meta.url)));
      writePrivate(join(f["evidence-dir"], "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      io.out(`${JSON.stringify(evidence, null, 2)}\n`);
      if (evidence.outcome !== "all-rejected")
        io.err(
          `STOP: ${evidence.outcome} at request ${evidence.requestsSent}; do not re-run - follow the stop procedure\n`,
        );
      return evidence.exitCode;
    }
    if (!f.evidence || !f["audit-log"] || !f.out)
      throw new ProbeUsageError("correlate needs --evidence, --audit-log and --out");
    if (existsSync(f.out)) throw new ProbeUsageError("--out must not exist yet");
    const evidence = JSON.parse(readFileSync(f.evidence, "utf8"));
    if (evidence.schema !== SCHEMA) throw new ProbeUsageError("--evidence is not probe evidence");
    const result = correlate(evidence, readFileSync(f["audit-log"], "utf8"));
    writePrivate(f.out, `${JSON.stringify(result, null, 2)}\n`);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    return result.verdict === "daemon-credential-boundary-confirmed" ? 0 : 5;
  } catch (e) {
    if (!(e instanceof ProbeUsageError)) throw e;
    io.err(`${e.message}\n${USAGE}\n`);
    return 64;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await main(process.argv.slice(2));
