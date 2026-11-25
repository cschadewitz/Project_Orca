/**
 * The demo seed's boundaries (tools/demo-seed/seed.mjs): it changes only the workspace it was
 * pointed at, through that workspace's own loopback daemon, and only the plans it made itself.
 * A fake daemon records every request, so each case can show what the seed never sent.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const SEED = fileURLToPath(new URL("../demo-seed/seed.mjs", import.meta.url));
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
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (respond?.(req, res)) return;
      const message = JSON.parse(body);
      calls.push({ method: message.method, params: message.params, auth: req.headers.authorization });
      const handler = handlers[message.method];
      const result = typeof handler === "function" ? handler(message.params, calls) : (handler ?? {});
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "response", id: message.id, ok: true, result }));
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

it("changes only the plans this run made, not an older plan with a fixture's key", async () => {
  const selected = workspace();
  const older = { id: "plan-older-billing", key: "billing", requestIds: ["req-from-before"] };
  // A plan that appears during the run with a fixture's key but someone else's request.
  const foreign = { id: "plan-foreign-mobile", key: "mobile", requestIds: ["req-someone-else"] };
  let n = 0;
  const requestFor = new Map();
  let plansListed = 0;
  const daemon = await fakeDaemon({
    "config.get": { config: { path: join(selected, "orca.config.yaml") } },
    "requests.submit": (params) => {
      const requestId = `req-${++n}`;
      requestFor.set(params.title, requestId);
      return { state: "accepted", admissionId: `adm-${n}`, requestId, runId: `run-${n}` };
    },
    "plans.list": () => {
      plansListed++;
      if (plansListed === 1) return { plans: [older] };
      // Ours: the search program's own request, so the seed may update it (the control case).
      const search = {
        id: "plan-new-search",
        key: "search",
        requestIds: [requestFor.get("Search that understands typos")],
      };
      return { plans: [older, foreign, search] };
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
  const planWrites = daemon.calls.filter((call) => ["decisions.decide", "risks.update"].includes(call.method));
  expect(planWrites.map((call) => call.params.planId)).toEqual(["plan-new-search"]);
  expect(planWrites.map((call) => call.params.key)).toEqual(["hosted-cost"]);
  for (const call of daemon.calls) expect(call.auth).toBe(`Bearer ${TOKEN}`);
}, 30_000);
