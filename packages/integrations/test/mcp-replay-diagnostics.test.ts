/** Inject transport and owner failures to verify bounded redaction and unchanged failure propagation. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { lockMetadata, ReplayDiagnostics, transportObserverSource } from "./mcp-replay-diagnostics.js";
import { ProductionFixture } from "./mcp-operator-production-fixture.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const temporary = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-replay-diagnostics-"));
  dirs.push(dir);
  return dir;
};

it("observes allowlisted transport causes and HTTP status without inspecting sensitive request fields", async () => {
  const dir = await temporary();
  const log = join(dir, "diagnostics");
  const source = `
    import assert from 'node:assert/strict';
    import {channel} from 'node:diagnostics_channel';
    import {writeFileSync} from 'node:fs';
    let captured = '';
    process.stderr.write = (chunk) => { captured += chunk; return true; };
    const request = {get origin() {throw Error('SECRET_URL');}, get headers() {throw Error('SECRET_TOKEN');}, get body() {throw Error('SECRET_BODY');}};
    const cause = Object.assign(new Error('SECRET_PATH'), {code: 'ECONNRESET', host: 'SECRET_HOST'});
    const error = Object.assign(new TypeError('SECRET_TOKEN'), {cause});
    cause.cause = error;
    channel('undici:request:create').publish({request});
    channel('undici:request:error').publish({request, error});
    assert.equal(error.cause, cause);
    assert.equal(cause.cause, error);
    const denied = {};
    channel('undici:request:create').publish({request: denied});
    channel('undici:request:headers').publish({request: denied, response: {statusCode: 503}});
    const timeout = {};
    channel('undici:request:create').publish({request: timeout});
    channel('undici:request:error').publish({request: timeout, error: new DOMException('SECRET_TIMEOUT', 'TimeoutError')});
    const unknown = {};
    channel('undici:request:create').publish({request: unknown});
    channel('undici:request:error').publish({request: unknown, error: {name: 'SECRET_NAME', code: 'SECRET_CODE', message: 'SECRET_MESSAGE'}});
    for (let i = 0; i < 100; i++) channel('undici:request:create').publish({request: {}});
    writeFileSync(${JSON.stringify(log)}, captured);
  `;
  execFileSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(transportObserverSource)}`,
      "--input-type=module",
      "-e",
      source,
    ],
    {
      env: { PATH: process.env.PATH ?? "" },
      stdio: "pipe",
    },
  );
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(log, "utf8");
  expect(text).not.toContain("SECRET");
  const records = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line.slice("ORCA_TEST_TRANSPORT ".length)));
  expect(records[1]).toMatchObject({
    outcome: "error",
    causes: [
      { name: "TypeError", code: "OTHER" },
      { name: "Error", code: "ECONNRESET" },
    ],
  });
  expect(records[3]).toMatchObject({ outcome: "headers", status: 503 });
  expect(records[5]).toMatchObject({ outcome: "error", causes: [{ name: "TimeoutError", code: "OTHER" }] });
  expect(records[7]).toMatchObject({ outcome: "error", causes: [{ name: "OTHER", code: "OTHER" }] });
  expect(records).toHaveLength(68); // At most 64 starts, plus the four completed requests.
  expect(records.every((record) => record.elapsedMs >= 0)).toBe(true);
});

it("drops raw, malformed, oversized and forged child stderr; retains only the last 16 safe observations", async () => {
  const diagnostics = new ReplayDiagnostics();
  const emit = (record: unknown) => diagnostics.capture(Buffer.from(`ORCA_TEST_TRANSPORT ${JSON.stringify(record)}\n`));
  diagnostics.capture(Buffer.from("SECRET_TOKEN\nORCA_TEST_TRANSPORT not-json\n"));
  diagnostics.capture(Buffer.from("X".repeat(3000) + "ORCA_TEST_TRANSPORT {}\n"));
  emit({ request: 1, outcome: "error", elapsedMs: 1, causes: [{ name: "Error", code: "SECRET_CODE" }] });
  emit({ request: 1, outcome: "headers", elapsedMs: 1, status: 503, secret: "SECRET_PATH" });
  for (let request = 1; request <= 20; request++) {
    const line = `ORCA_TEST_TRANSPORT ${JSON.stringify({ request, outcome: "started", elapsedMs: 0 })}\n`;
    diagnostics.capture(Buffer.from(line.slice(0, 10)));
    diagnostics.capture(Buffer.from(line.slice(10)));
  }
  const fixture = new ProductionFixture();
  fixture.dir = await temporary();
  fixture.daemon = { exitCode: null, signalCode: null, pid: process.pid } as ProductionFixture["daemon"];
  const previous = { exitCode: null, signalCode: "SIGKILL", pid: process.pid } as ProductionFixture["daemon"];
  const failure = new Error("SECRET_FAILURE");
  await expect(
    diagnostics.measure("replay", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  const evidence = await diagnostics.evidence(fixture, previous, "retry_synthetic", "run_synthetic");
  expect(evidence.transport).toHaveLength(16);
  expect(evidence.transport[0]?.request).toBe(5);
  expect(evidence.previousDaemon).toEqual({ exitCode: null, signal: "SIGKILL" });
  expect(evidence.currentDaemon).toEqual({ exitCode: null, signal: null });
  expect(evidence.stages).toMatchObject([{ stage: "replay" }]);
  expect(JSON.stringify(evidence)).not.toMatch(/SECRET|retry_synthetic|run_synthetic|orca-replay-diagnostics/);
});

it("observes real fetch socket and abort failures and non-auth HTTP status without replacing fetch", () => {
  const source = `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:http';
    const server = createServer((request, response) => {
      if (request.url === '/socket') response.destroy();
      else if (request.url === '/status') { response.writeHead(503); response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const original = fetch;
    try {
      await assert.rejects(fetch(endpoint + '/socket', {headers: {authorization: 'Bearer SECRET_TOKEN'}}), TypeError);
      await assert.rejects(fetch(endpoint + '/timeout', {signal: AbortSignal.timeout(25)}), {name: 'TimeoutError'});
      const response = await fetch(endpoint + '/status');
      assert.equal(response.status, 503);
      await response.body.cancel();
      assert.equal(fetch, original);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  `;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(transportObserverSource)}`,
      "--input-type=module",
      "-e",
      source,
    ],
    {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("");
  expect(child.stderr).not.toMatch(/SECRET|127\.0\.0\.1|Bearer/);
  const observations = child.stderr
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line.slice("ORCA_TEST_TRANSPORT ".length)));
  expect(observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        outcome: "error",
        causes: expect.arrayContaining([expect.objectContaining({ code: "UND_ERR_SOCKET" })]),
      }),
      expect.objectContaining({
        outcome: "error",
        causes: expect.arrayContaining([expect.objectContaining({ name: "TimeoutError" })]),
      }),
      expect.objectContaining({ outcome: "headers", status: 503 }),
    ]),
  );
});

it("reports live owner relationships and age without emitting pid, hostname, owner filename or extra fields", async () => {
  const dir = await temporary();
  const lock = join(dir, "lock");
  await mkdir(lock);
  await writeFile(
    join(lock, "owner.123.aabb.json"),
    JSON.stringify({ pid: process.pid, at: Date.now() - 1000, host: hostname(), token: "SECRET_TOKEN" }),
  );
  const evidence = await lockMetadata(lock, process.pid, process.pid + 1);
  expect(evidence).toMatchObject({
    state: "directory",
    entries: 1,
    owner: { sameHost: true, alive: true, previousDaemon: true, currentDaemon: false },
  });
  expect(evidence.owner).toHaveProperty("ageMs", expect.any(Number));
  expect(JSON.stringify(evidence)).not.toMatch(/SECRET|owner\.123|"pid"|"host"/);
});

it("fails closed for foreign, malformed, oversized, multiple and symlink owners", async () => {
  const dir = await temporary();
  const lock = join(dir, "lock");
  const owner = join(lock, "owner.123.aabb.json");
  await mkdir(lock);
  expect(await lockMetadata(lock)).toMatchObject({ state: "directory", entries: 0, owner: "unavailable" });
  await writeFile(owner, JSON.stringify({ pid: process.pid, at: Date.now(), host: "SECRET_FOREIGN_HOST" }));
  expect(await lockMetadata(lock)).toMatchObject({ owner: { sameHost: false, alive: "unknown" } });
  await writeFile(owner, "malformed SECRET_TOKEN");
  expect(await lockMetadata(lock)).toMatchObject({ state: "unavailable" });
  await writeFile(owner, "X".repeat(2049));
  expect(await lockMetadata(lock)).toMatchObject({ owner: "unavailable" });
  await writeFile(join(lock, "SECRET_OTHER_FILE"), "SECRET_TOKEN");
  expect(await lockMetadata(lock)).toMatchObject({ entries: 2, owner: "unavailable" });
  await rm(lock, { recursive: true });
  await mkdir(lock);
  const outside = join(dir, "SECRET_PROTECTED_RECORD");
  await writeFile(outside, "SECRET_TOKEN");
  await symlink(outside, owner);
  expect(await lockMetadata(lock)).toMatchObject({ state: "unavailable" });
  await rm(lock, { recursive: true });
  await symlink(dir, lock);
  expect(await lockMetadata(lock)).toEqual({ state: "symlink" });
  expect(await lockMetadata(join(dir, "absent"))).toEqual({ state: "absent" });
});

it.skipIf(process.platform === "win32")("rejects four FIFO owners without starving subsequent cleanup", async () => {
  const dir = await temporary();
  const source = `
    import assert from 'node:assert/strict';
    import {execFileSync} from 'node:child_process';
    import {access, mkdir, rm} from 'node:fs/promises';
    import {join} from 'node:path';
    import {ReplayDiagnostics} from ${JSON.stringify(new URL("./mcp-replay-diagnostics.ts", import.meta.url).href)};
    const dir = ${JSON.stringify(dir)};
    const operationId = 'retry_synthetic';
    const runId = 'run_synthetic';
    try {
      const paths = [
        join(dir, 'state/admission-retries/catalog.lock'),
        join(dir, 'state/admission-retries', operationId + '.lock'),
        join(dir, 'state/runs', runId + '.jsonl.lock'),
        join(dir, 'state/leases', encodeURIComponent('run:' + runId) + '.json.mutation.lock'),
      ];
      for (const path of paths) {
        await mkdir(path, {recursive: true});
        execFileSync('mkfifo', [join(path, 'owner.123.aabb.json')], {stdio: 'pipe'});
      }
      const daemon = {exitCode: null, signalCode: null, pid: process.pid};
      const evidence = await new ReplayDiagnostics().evidence({dir, daemon}, daemon, operationId, runId);
      assert.ok(Array.isArray(evidence.locks));
      assert.equal(evidence.locks.length, 4);
      for (const lock of evidence.locks) assert.equal(lock.owner, 'unavailable');
    } finally {
      // Same asynchronous recursive removal used by ProductionFixture.close().
      await rm(dir, {recursive: true, force: true});
    }
    await assert.rejects(access(dir), {code: 'ENOENT'});
    process.stdout.write('cleanup-completed');
  `;
  // Four blocking opens exhaust this isolated child's pool. The external watchdog
  // can stop a regression even when evidence's own deadline cannot cancel I/O.
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    env: { PATH: process.env.PATH ?? "", UV_THREADPOOL_SIZE: "4" },
    encoding: "utf8",
    timeout: 3000,
    killSignal: "SIGKILL",
  });
  expect(child.status).toBe(0);
  expect(child.signal).toBeNull();
  expect(child.stdout).toBe("cleanup-completed");
  expect(child.stderr).toBe("");
});
