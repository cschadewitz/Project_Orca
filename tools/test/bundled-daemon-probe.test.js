/** Synthetic child fixtures exercise authentication, bounded failures and owned cleanup. */
import { mkdtemp, writeFile, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CLIENT_PROTOCOL, PROTOCOL_VERSION, isCompatible } from "@orca/protocol";
import { DaemonClient } from "../../packages/app/src/client/daemon-client.js";
import { LocalDaemonToken } from "../../packages/app/src/client/auth.js";
import { probeBundledDaemon } from "../probe-bundled-daemon.js";

const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const contract = { DaemonClient, LocalDaemonToken, PROTOCOL_VERSION, isCompatible, version };
const fixtures = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of fixtures.splice(0)) await rm(dir, { recursive: true, force: true });
});

// A child that answers or exits does so in well under 300 ms, so 1500 ms is slack for a slow
// host. A child that never answers can only be proven wrong by the bound running out, so those
// cases wait for a shorter one: still twice the slowest real answer.
const ANSWER_TIMEOUT_MS = 1500;
const UNANSWERED_TIMEOUT_MS = 600;

async function fixture(mode = "success", timeoutMs = ANSWER_TIMEOUT_MS) {
  const dir = await mkdtemp(join(tmpdir(), "orca-synthetic-probe-test-"));
  fixtures.push(dir);
  const bundlePath = join(dir, "fixture.mjs");
  // This child implements only a synthetic HTTP fixture. All requests stay on loopback.
  await writeFile(
    bundlePath,
    `
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = ${JSON.stringify(mode)};
const protocol = ${JSON.stringify(PROTOCOL_VERSION)};
// The app's client offers the oldest current-major daemon it works with (#880); the daemon answers in its own.
const offer = ${JSON.stringify(CLIENT_PROTOCOL)};
const version = ${JSON.stringify(version)};
const cwd = process.cwd();
const args = process.argv.slice(2);
const option = (key) => args[args.indexOf(key) + 1];
if (args[0] !== 'serve' || option('--host') !== '127.0.0.1' || option('--port') !== '0' ||
    option('--cwd') !== cwd || !readFileSync(option('--config'), 'utf8').includes('workflows: []') ||
    args.includes('--unauthenticated-loopback')) process.exit(91);
if (Object.keys(process.env).some((key) => /^(ORCA_|NODE_OPTIONS|NODE_PATH|KEPLER_|.*_PROXY$)/i.test(key)) ||
    process.env.HOME !== cwd || process.env.USERPROFILE !== cwd || process.env.TMPDIR !== cwd) process.exit(92);
if (mode === 'early-exit') { console.error('synthetic-private-output'); process.exit(17); }
if (mode === 'silent') setInterval(() => {}, 1000);
else if (mode === 'flood') process.stdout.write('synthetic-private-output'.repeat(10000));
else {
  const tokenFile = join(cwd, 'auth', 'local-client.token');
  mkdirSync(join(cwd, 'auth'), { recursive: true });
  if (mode !== 'missing-token') writeFileSync(tokenFile, mode === 'wrong-token' ? 'synthetic-wrong-token' : 'synthetic-owned-token');
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (req.url !== '/rpc' || req.method !== 'POST') process.exit(93);
    if (req.headers.authorization !== 'Bearer synthetic-owned-token') {
      res.writeHead(401);
      res.end(JSON.stringify({kind: 'response', id: 0, ok: false, error: {code: 'AUTH_INVALID', message: 'synthetic-private-output'}}));
      return;
    }
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      const request = JSON.parse(body);
      if (request.method !== 'hello' || JSON.stringify(request.params.protocol) !== JSON.stringify(offer) ||
          calls !== 1) process.exit(94);
      if (mode === 'hung-hello') return;
      if (mode === 'malformed') { res.end('synthetic-private-output'); return; }
      if (mode === 'oversized-response') { res.end('x'.repeat(100000)); return; }
      if (mode === 'redirect') { res.writeHead(302, { location: 'https://invalid.example/synthetic-private-output' }); res.end(); return; }
      const result = { protocol, orcaVersion: version, processId: process.pid, storeDir: join(cwd, '.orca'),
        capabilities: ['runs.control'], methods: ['hello'] };
      if (mode === 'incompatible') result.protocol = { ...protocol, major: protocol.major + 1 };
      if (mode === 'stale-release') result.orcaVersion = 'synthetic-stale-release';
      if (mode === 'other-child') result.processId++;
      if (mode === 'other-store') result.storeDir = join(cwd, 'other-store');
      if (mode === 'bad-shape') result.capabilities = 'synthetic-private-output';
      if (mode === 'no-controls') result.capabilities = [];
      res.end(JSON.stringify({ kind: 'response', id: request.id, ok: true, result }));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const url = mode === 'remote-readiness' ? 'http://invalid.example:1234' : 'http://127.0.0.1:' + server.address().port;
    const authPath = mode === 'other-token-path' ? join(cwd, 'unowned.token') : tokenFile;
    // Deliberately split readiness chunks and use CRLF, as on Windows.
    process.stdout.write('orca dae');
    setTimeout(() => {
      process.stdout.write('mon fixture listening on ' + url + ' (protocol fixture)\\r\\n');
      process.stdout.write('authentication: token; local token file: ' + authPath + '\\r\\n');
    }, 10);
  });
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  else process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
`,
  );
  return { bundlePath, tempParent: dir, contract, timeoutMs, stopTimeoutMs: 100 };
}

async function expectClean(options) {
  expect(await readdir(options.tempParent)).toEqual(["fixture.mjs"]);
}

it("authenticates the owned child with current hello and cleans only its workspace", async () => {
  const options = await fixture();
  const inheritedFetch = vi.fn(() => {
    throw new Error("synthetic proxy must not be used");
  });
  vi.stubGlobal("fetch", inheritedFetch);
  for (const name of [
    "ORCA_DAEMON_URL",
    "ORCA_DAEMON_TOKEN",
    "ORCA_DAEMON_TOKEN_FILE",
    "ORCA_RELEASE",
    "ORCA_WORKSPACE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "HTTPS_PROXY",
    "KEPLER_TASK_DIR",
  ]) {
    vi.stubEnv(name, "synthetic-override-must-not-reach-child");
  }
  // An unrelated sibling remains intact after recursive cleanup of the probe-owned directory.
  await writeFile(join(options.tempParent, "keep.txt"), "synthetic sibling");
  expect(await probeBundledDaemon(options)).toEqual({
    authenticated: true,
    orcaVersion: version,
    protocol: PROTOCOL_VERSION,
  });
  expect((await readdir(options.tempParent)).sort()).toEqual(["fixture.mjs", "keep.txt"]);
  expect(inheritedFetch).not.toHaveBeenCalled();
});

it.each([
  ["early-exit", "EARLY_EXIT"],
  ["silent", "TIMEOUT", UNANSWERED_TIMEOUT_MS],
  ["flood", "OUTPUT_LIMIT"],
  ["missing-token", "AUTH_REQUIRED"],
  ["wrong-token", "AUTH_INVALID"],
  ["malformed", "PROTOCOL_MESSAGE"],
  ["bad-shape", "HELLO_RESPONSE"],
  ["incompatible", "PROTOCOL_VERSION"],
  ["stale-release", "RELEASE_VERSION"],
  ["other-child", "CHILD_IDENTITY"],
  ["other-store", "CHILD_IDENTITY"],
  ["no-controls", "HELLO_CONTRACT"],
  ["remote-readiness", "READINESS"],
  ["other-token-path", "AUTH_METADATA"],
  ["hung-hello", "TIMEOUT", UNANSWERED_TIMEOUT_MS],
  ["oversized-response", "RESPONSE_LIMIT"],
  ["redirect", "HTTP_RESPONSE"],
])("fails safely for %s and removes the owned temporary files", async (mode, code, timeoutMs) => {
  const options = await fixture(mode, timeoutMs);
  await expect(probeBundledDaemon(options)).rejects.toThrow(`Bundled daemon probe failed [${code}]`);
  await expectClean(options);
});

it("bounds shutdown even when the owned child ignores SIGTERM", async () => {
  const options = await fixture("ignore-term");
  expect((await probeBundledDaemon(options)).authenticated).toBe(true);
  await expectClean(options);
});

it("fails a missing entry without exposing raw child output or leaving files", async () => {
  const options = await fixture();
  await expect(probeBundledDaemon({ ...options, bundlePath: join(options.tempParent, "missing.mjs") })).rejects.toThrow(
    "Bundled daemon probe failed [EARLY_EXIT]",
  );
  await expectClean(options);
});

it.each([0, -1, Infinity, 60_001])("rejects invalid wait bound %s before creating files", async (timeoutMs) => {
  const options = await fixture();
  await expect(probeBundledDaemon({ ...options, timeoutMs })).rejects.toThrow("[INVALID_TIMEOUT]");
  await expectClean(options);
});
