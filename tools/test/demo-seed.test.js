/**
 * The demo seed's boundaries (tools/demo-seed/seed.mjs): it changes only the workspace it was
 * pointed at, through that workspace's own loopback daemon, and only the plans it made itself.
 * A fake daemon records every request, so each case can show what the seed never sent.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const SEED = fileURLToPath(new URL("../demo-seed/seed.mjs", import.meta.url));
const BUILD = fileURLToPath(new URL("../demo-seed/build.mjs", import.meta.url));

// Prepare copies the bundled scripted agent into the workspace, so the bundle must exist.
beforeAll(() => {
  execFileSync(process.execPath, [BUILD], { stdio: "ignore" });
}, 120_000);
const TOKEN = "demo-seed-test-token";
const cleanup = [];
afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
});

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "demo-seed-ws-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "auth"));
  writeFileSync(join(dir, "auth", "local-client.token"), `${TOKEN}\n`);
  writeFileSync(join(dir, "orca.config.yaml"), "{}\n");
  return dir;
}

/** A daemon that answers from `handlers` (method -> result or function) and records each call. */
async function fakeDaemon(handlers, respond) {
  const calls = [];
  // A Map, so a method name from the request can only find a handler the test gave it.
  const table = new Map(Object.entries(handlers));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (respond?.(req, res)) return;
      const message = JSON.parse(body);
      calls.push({ method: message.method, params: message.params, auth: req.headers.authorization });
      const handler = table.get(message.method);
      const result = typeof handler === "function" ? handler(message.params, calls) : (handler ?? {});
      res.setHeader("content-type", "application/json");
      // A handler that returns `{ refuse: { code, message } }` answers as the daemon refuses a request.
      const answer = result?.refuse
        ? { kind: "response", id: message.id, ok: false, error: result.refuse }
        : { kind: "response", id: message.id, ok: true, result };
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise((done) => server.close(done)));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

function seed(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SEED, ...args], { env: { PATH: process.env.PATH } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => done({ code, output }));
  });
}

const MUTATIONS = [
  "config.set",
  "config.apply",
  "requests.submit",
  "inputs.answer",
  "runs.cancel",
  "decisions.decide",
  "risks.update",
];

for (const phase of ["prepare", "populate"]) {
  it(`refuses the ${phase} phase when the daemon serves a different workspace`, async () => {
    const selected = workspace();
    const other = workspace();
    const daemon = await fakeDaemon({ "config.get": { config: { path: join(other, "orca.config.yaml") } } });
    const { code, output } = await seed(["--workspace", selected, "--url", daemon.url, "--phase", phase]);
    expect(code).not.toBe(0);
    expect(output).toMatch(/refusing: the daemon serves/);
    expect(daemon.calls.map((call) => call.method)).toEqual(["config.get"]);
    expect(daemon.calls.filter((call) => MUTATIONS.includes(call.method))).toEqual([]);
    for (const dir of [selected, other]) expect(existsSync(join(dir, "demo-seed"))).toBe(false);
  });
}

it("refuses a daemon that is not on loopback, before sending the token anywhere", async () => {
  const selected = workspace();
  const { code, output } = await seed([
    "--workspace",
    selected,
    "--url",
    "http://192.0.2.10:6722",
    "--phase",
    "prepare",
  ]);
  expect(code).not.toBe(0);
  expect(output).toMatch(/only talks to a daemon on http:\/\/127\.0\.0\.1/);
  expect(existsSync(join(selected, "demo-seed"))).toBe(false);
});

it("does not follow a redirect with the token", async () => {
  const selected = workspace();
  const elsewhere = await fakeDaemon({ "config.get": { config: { path: join(selected, "orca.config.yaml") } } });
  const redirecting = await fakeDaemon({}, (req, res) => {
    res.statusCode = 307;
    res.setHeader("location", `${elsewhere.url}/rpc`);
    res.end();
    return true;
  });
  const { code } = await seed(["--workspace", selected, "--url", redirecting.url, "--phase", "prepare"]);
  expect(code).not.toBe(0);
  expect(elsewhere.calls).toEqual([]);
  expect(existsSync(join(selected, "demo-seed"))).toBe(false);
});

it("never submits a program into an existing plan, and writes only to plans it made", async () => {
  const selected = workspace();
  // Every fixture key, already taken by older plans: the seed must neither join nor change them.
  const older = ["billing", "search", "mobile", "platform"].map((key) => ({
    id: `plan-older-${key}`,
    key,
    requestIds: [`req-before-${key}`],
  }));
  let n = 0;
  const programs = new Map(); // title -> { requestId, planKey }
  let plansListed = 0;
  const daemon = await fakeDaemon({
    "config.get": { config: { path: join(selected, "orca.config.yaml") } },
    "requests.submit": (params) => {
      const requestId = `req-${++n}`;
      if (params.vars?.plan) programs.set(params.title, { requestId, planKey: params.vars.plan });
      return { state: "accepted", admissionId: `adm-${n}`, requestId, runId: `run-${n}` };
    },
    "plans.list": () => {
      plansListed++;
      if (plansListed === 1) return { plans: older };
      // Ours: the search program's own plan (the control the seed may update). Mobile's new
      // plan was joined by another request, so it is not the seed's alone.
      const search = programs.get("Search that understands typos");
      const mobile = programs.get("Offline mode for the mobile app");
      return {
        plans: [
          ...older,
          { id: "plan-new-search", key: search.planKey, requestIds: [search.requestId] },
          { id: "plan-joined-mobile", key: mobile.planKey, requestIds: [mobile.requestId, "req-someone-else"] },
        ],
      };
    },
    "decisions.list": () => ({ decisions: [{ key: "engine" }] }),
    "inputs.list": { inputs: [] },
    "runs.list": { runs: [] },
    "runs.cancel": {},
  });
  const { code, output } = await seed([
    "--workspace",
    selected,
    "--url",
    daemon.url,
    "--phase",
    "populate",
    "--settle",
    "11",
  ]);
  expect(code, output).toBe(0);

  // The submissions themselves: four programs, each into a new key of its own, none existing.
  const keys = daemon.calls.filter((call) => call.method === "requests.submit" && call.params.vars?.plan);
  expect(keys).toHaveLength(4);
  const existing = new Set(older.map((plan) => plan.key));
  for (const call of keys) {
    expect(existing.has(call.params.vars.plan)).toBe(false);
    expect(call.params.vars.plan).toMatch(/^(billing|search|mobile|platform)-[a-z0-9]+$/);
  }
  expect(new Set(keys.map((call) => call.params.vars.plan)).size).toBe(4);

  // The later writes: only the plan this run made and alone fed.
  const planWrites = daemon.calls.filter((call) => ["decisions.decide", "risks.update"].includes(call.method));
  expect(planWrites.map((call) => call.params.planId)).toEqual(["plan-new-search"]);
  expect(planWrites.map((call) => call.params.key)).toEqual(["hosted-cost"]);
  for (const call of daemon.calls) expect(call.auth).toBe(`Bearer ${TOKEN}`);
}, 30_000);

it("sends a submission the store refused under contention again, with the same key, and nothing else (#1284)", async () => {
  const selected = workspace();
  let refusals = 2;
  let n = 0;
  const handlers = {
    "config.get": { config: { path: join(selected, "orca.config.yaml") } },
    "requests.submit": () => {
      if (refusals-- > 0)
        return { refuse: { code: "STORE_LOCK_TIMEOUT", message: "lock catalog.lock still held after 100ms" } };
      n++;
      return { state: "accepted", admissionId: `adm-${n}`, requestId: `req-${n}`, runId: `run-${n}` };
    },
    "plans.list": { plans: [] },
    "decisions.list": { decisions: [] },
    "inputs.list": { inputs: [] },
    "runs.list": { runs: [] },
    "runs.cancel": {},
  };
  const daemon = await fakeDaemon(handlers);
  const args = ["--workspace", selected, "--url", daemon.url, "--phase", "populate", "--settle", "11"];
  const { code, output } = await seed(args);
  expect(code, output).toBe(0);
  const keys = daemon.calls.filter((call) => call.method === "requests.submit").map((c) => c.params.idempotencyKey);
  // The first item went three times under one key; every later item once.
  expect(keys[0]).toBe(keys[1]);
  expect(keys[1]).toBe(keys[2]);
  expect(new Set(keys).size).toBe(keys.length - 2);

  // Any other refusal is not retried.
  const other = workspace();
  const refusing = await fakeDaemon({
    ...handlers,
    "config.get": { config: { path: join(other, "orca.config.yaml") } },
    "requests.submit": () => ({ refuse: { code: "RUN_STATE", message: "no" } }),
  });
  const failed = await seed(["--workspace", other, "--url", refusing.url, "--phase", "populate", "--settle", "11"]);
  expect(failed.code).not.toBe(0);
  expect(refusing.calls.filter((call) => call.method === "requests.submit")).toHaveLength(1);
}, 30_000);

it("with --config-out, prepare writes the config to the file and saves nothing through the daemon", async () => {
  const selected = workspace();
  const out = join(selected, "seeded-config.json");
  const daemon = await fakeDaemon({
    "config.get": {
      config: {
        path: join(selected, "orca.config.yaml"),
        revision: "r1",
        parsed: { agents: [], workflows: ["first-run/workflow.yaml"], templates: [] },
      },
    },
    "agents.list": { agents: [] },
  });
  const { code, output } = await seed([
    "--workspace",
    selected,
    "--url",
    daemon.url,
    "--phase",
    "prepare",
    "--config-out",
    out,
  ]);
  expect(code, output).not.toBe(1);
  expect(daemon.calls.filter((call) => MUTATIONS.includes(call.method))).toEqual([]);
  const written = JSON.parse(readFileSync(out, "utf8"));
  expect(written.agents.map((agent) => agent.id)).toContain("atlas");
  expect(written.workflows).toContain("first-run/workflow.yaml");
}, 30_000);

it("--config-out creates a new private file and refuses an existing file or link", async () => {
  const selected = workspace();
  const config = { path: join(selected, "orca.config.yaml"), revision: "r1", parsed: { agents: [] } };
  const daemon = await fakeDaemon({ "config.get": { config }, "agents.list": { agents: [] } });
  const run = (out) => seed(["--workspace", selected, "--url", daemon.url, "--phase", "prepare", "--config-out", out]);

  const fresh = join(selected, "fresh.json");
  expect((await run(fresh)).code).not.toBe(1);
  expect(statSync(fresh).mode & 0o777).toBe(0o600);

  const existing = join(selected, "existing.json");
  writeFileSync(existing, "keep me\n");
  const refused = await run(existing);
  expect(refused.code).toBe(1);
  expect(refused.output).toMatch(/already exists/);
  expect(readFileSync(existing, "utf8")).toBe("keep me\n");

  const target = join(selected, "target.json");
  writeFileSync(target, "keep me too\n");
  const link = join(selected, "link.json");
  symlinkSync(target, link);
  expect((await run(link)).code).toBe(1);
  expect(readFileSync(target, "utf8")).toBe("keep me too\n");
  expect(daemon.calls.filter((call) => MUTATIONS.includes(call.method))).toEqual([]);
}, 60_000);

/**
 * A stand-in for the desktop app's bundled daemon: a process whose command line has the shape
 * the app spawns (`orca-daemon.mjs --cwd <ws> --config <config> serve --host <h> --port <p>`),
 * an HTTP listener on --port and a second listener that is not HTTP, as the real daemon holds.
 * Every connection and request is appended to `log`, with the authorization it carried.
 */
const FAKE_DAEMON = `
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as tcp } from "node:net";
const argv = process.argv.slice(2);
const value = (flag) => argv[argv.indexOf(flag) + 1];
const log = process.env.FAKE_LOG;
const host = value("--host").replace(/^\\[|\\]$/g, "");
createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const message = JSON.parse(body);
    appendFileSync(log, JSON.stringify({ method: message.method, auth: req.headers.authorization ?? null }) + "\\n");
    const result = message.method === "config.get"
      ? { config: { path: value("--config"), revision: "r1", parsed: { agents: [] } } }
      : { agents: [] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ kind: "response", id: message.id, ok: true, result }));
  });
}).listen(Number(value("--port")), host, () => {
  tcp((socket) => { appendFileSync(log, JSON.stringify({ raw: true }) + "\\n"); socket.destroy(); })
    .listen(0, host, () => process.stdout.write("ready\\n"));
});
`;

/** A free port on `host`. */
async function freePort(host) {
  const server = createServer();
  await new Promise((done) => server.listen(0, host, done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

/** Starts the stand-in daemon for `config` on `host` and returns what it was sent. */
async function bundledDaemon({ cwd, config, host = "127.0.0.1", port: wanted }) {
  const dir = mkdtempSync(join(tmpdir(), "demo-seed-daemon-"));
  const log = join(dir, "requests.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "orca-daemon.mjs"), FAKE_DAEMON);
  const port = wanted ?? (await freePort(host));
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const child = spawn(
    process.execPath,
    [join(dir, "orca-daemon.mjs"), "--cwd", cwd, "--config", config, "serve", "--host", host, "--port", String(port)],
    { env: { PATH: process.env.PATH, FAKE_LOG: log }, stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanup.push(async () => {
    child.kill();
    await new Promise((done) => (child.exitCode === null ? child.on("exit", done) : done()));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((done, failed) => {
    child.stdout.on("data", (chunk) => String(chunk).includes("ready") && done());
    child.on("exit", (code) => failed(new Error(`stand-in daemon exited ${code}`)));
  });
  const sent = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { url: `http://${urlHost}:${port}`, port, sent };
}

/** Whether this machine has IPv6 loopback (some containers do not). */
const IPV6 = await new Promise((done) => {
  const probe = createServer();
  probe.once("error", () => done(false));
  probe.listen(0, "::1", () => probe.close(() => done(true)));
});

describe.skipIf(process.platform !== "linux")("finding the daemon without --url (Linux /proc)", () => {
  const prepare = (selected) =>
    seed(["--workspace", selected, "--phase", "prepare", "--config-out", join(selected, `out-${Date.now()}.json`)]);

  it("talks only to the --port listener of the daemon that names this workspace's config", async () => {
    const selected = workspace();
    const daemon = await bundledDaemon({ cwd: selected, config: join(selected, "orca.config.yaml") });
    const { code, output } = await prepare(selected);
    expect(code, output).toBe(0);
    expect(output).toContain(`daemon ${daemon.url}`);
    expect(daemon.sent().some((entry) => entry.raw)).toBe(false);
    expect(daemon.sent().every((entry) => entry.auth === `Bearer ${TOKEN}`)).toBe(true);
  }, 30_000);

  it.skipIf(!IPV6)(
    "keeps the listener's address family: an IPv6 daemon's port on 127.0.0.1 gets no bearer",
    async () => {
      const selected = workspace();
      const decoyAuth = [];
      // Something else on the same port number over IPv4: the old discovery rewrote to 127.0.0.1.
      // The IPv4 side is bound first, on a port the kernel picks, so it cannot collide (#1245);
      // only the daemon's [::1] side can be taken, and then the pair is chosen again.
      let daemon;
      for (let attempt = 0; attempt < 10 && !daemon; attempt++) {
        const decoy = createServer((req, res) => {
          decoyAuth.push(req.headers.authorization ?? null);
          res.end();
        });
        await new Promise((done, failed) => {
          decoy.once("error", failed);
          decoy.listen(0, "127.0.0.1", done);
        });
        cleanup.push(() => new Promise((done) => decoy.close(done)));
        const { port } = decoy.address();
        daemon = await bundledDaemon({
          cwd: selected,
          config: join(selected, "orca.config.yaml"),
          host: "::1",
          port,
        }).catch(() => undefined);
      }
      expect(daemon, "no port was free on both 127.0.0.1 and [::1] in ten tries").toBeDefined();
      const { code, output } = await prepare(selected);
      expect(code, output).toBe(0);
      expect(output).toContain(`daemon ${daemon.url}`);
      expect(decoyAuth).toEqual([]);
    },
    30_000,
  );

  it("sends no bearer to a daemon whose path only starts with this workspace's", async () => {
    const selected = workspace();
    const sibling = `${selected}-other`;
    mkdirSync(sibling);
    cleanup.push(() => rmSync(sibling, { recursive: true, force: true }));
    writeFileSync(join(sibling, "orca.config.yaml"), "{}\n");
    const daemon = await bundledDaemon({ cwd: sibling, config: join(sibling, "orca.config.yaml") });
    const { code, output } = await prepare(selected);
    expect(code).not.toBe(0);
    expect(output).toMatch(/could not find the daemon for this workspace/);
    expect(daemon.sent()).toEqual([]);
  }, 30_000);

  it("refuses two daemons for one workspace and sends neither a bearer", async () => {
    const selected = workspace();
    const config = join(selected, "orca.config.yaml");
    const first = await bundledDaemon({ cwd: selected, config });
    const second = await bundledDaemon({ cwd: selected, config });
    const { code, output } = await prepare(selected);
    expect(code).not.toBe(0);
    expect(output).toMatch(/more than one daemon serves this workspace/);
    expect([...first.sent(), ...second.sent()]).toEqual([]);
  }, 30_000);
});
