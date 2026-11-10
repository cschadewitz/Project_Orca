/**
 * The #392 missing/invalid-credential probe, offline: against the real daemon's /rpc on an
 * ephemeral loopback port with in-memory credentials, and against stub servers for every way
 * a live run has to stop. Nothing here reaches a host other than this process's own loopback.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseToken } from "../../packages/daemon/src/auth/credentials.ts";
import { harness } from "../../packages/daemon/test/security-harness.ts";
import {
  FIXTURE_ID,
  FIXTURE_SECRET,
  PROBES,
  ProbeUsageError,
  classify,
  confirmationFor,
  correlate,
  describePlan,
  main,
  parseEndpoint,
  runProbes,
  sendOnce,
  validateRunArgs,
} from "../auth-negative-test/probe.js";

const APPROVAL = "https://github.com/cschadewitz/Project_Orca/issues/392#issuecomment-1";
const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
});

/** A loopback server that answers every request with `answer` and counts what it saw. */
async function stub(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      answer(req, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(r)));
  return { endpoint: parseEndpoint(`http://127.0.0.1:${server.address().port}/rpc`), seen };
}

const quiet = () => ({ out: () => {}, err: () => {} });

describe("fixtures", () => {
  it("can never authenticate: one fails the token shape, the other is a published id and secret", () => {
    expect(PROBES.map((p) => p.name)).toEqual(["missing", "malformed-fixture", "unknown-id-fixture"]);
    expect(PROBES[0].authorization).toBeUndefined();
    expect(parseToken(PROBES[1].authorization.slice("Bearer ".length))).toBeUndefined();
    expect(parseToken(PROBES[2].authorization.slice("Bearer ".length))).toEqual({
      id: FIXTURE_ID,
      secret: FIXTURE_SECRET,
    });
    expect(FIXTURE_SECRET).toHaveLength(43);
    expect(FIXTURE_SECRET).toContain("not_a_credential");
  });

  it("are the only bearer values the module can send", async () => {
    const source = await readFile(new URL("../auth-negative-test/probe.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/token-file|ORCA_MCP_TOKEN|local-client\.token|credentials\.json/);
  });
});

describe("target selection", () => {
  it("accepts only an explicit loopback IP literal, an explicit port and exactly /rpc", () => {
    expect(parseEndpoint("http://127.0.0.1:33871/rpc")).toMatchObject({ host: "127.0.0.1:33871", port: 33871 });
    expect(parseEndpoint("http://[::1]:33871/rpc")).toMatchObject({ hostname: "::1", host: "[::1]:33871" });
    for (const bad of [
      "https://127.0.0.1:33871/rpc",
      "http://localhost:33871/rpc",
      "http://10.0.0.5:33871/rpc",
      "http://agent-01:33871/rpc",
      "http://127.0.0.1/rpc",
      "http://127.0.0.1:33871/",
      "http://127.0.0.1:33871/rpc?token=x",
      "http://127.0.0.1:33871/rpc?",
      "http://127.0.0.1:33871/rpc#x",
      "http://u:p@127.0.0.1:33871/rpc",
      "http://127.0.0.1:33872/healthz",
      "",
    ])
      expect(() => parseEndpoint(bad), bad).toThrow(ProbeUsageError);
  });

  it("binds the confirmation phrase to the port and requires a permission link and a fresh directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-an392-"));
    const base = { endpoint: "http://127.0.0.1:33871/rpc", approvalRef: APPROVAL, evidenceDir: join(dir, "e") };
    expect(confirmationFor(parseEndpoint(base.endpoint))).toBe("auth-negative-392@127.0.0.1:33871");
    expect(() => validateRunArgs({ ...base, confirm: "auth-negative-392@127.0.0.1:33871" })).not.toThrow();
    expect(() => validateRunArgs({ ...base, confirm: "auth-negative-392@127.0.0.1:6722" })).toThrow(/--confirm/);
    expect(() =>
      validateRunArgs({ ...base, confirm: "auth-negative-392@127.0.0.1:33871", approvalRef: "approved" }),
    ).toThrow(/--approval-ref/);
    expect(() => validateRunArgs({ ...base, confirm: "auth-negative-392@127.0.0.1:33871", evidenceDir: dir })).toThrow(
      /must not exist/,
    );
  });

  it("plan describes three requests, no retries, and sends nothing", async () => {
    const { endpoint, seen } = await stub((_, res) => res.end());
    const out = [];
    expect(await main(["plan", "--endpoint", endpoint.url], { out: (s) => out.push(s), err: () => {} })).toBe(0);
    const plan = JSON.parse(out.join(""));
    expect(plan).toMatchObject({ retries: 0, method: "hello", confirmation: confirmationFor(endpoint) });
    expect(plan.requests.map((r) => r.expected.auditReason)).toEqual(["missing", "malformed", "unknown"]);
    expect(JSON.stringify(plan)).not.toContain(FIXTURE_SECRET);
    expect(seen).toHaveLength(0);
  });

  it("run refuses before any request without the exact confirmation, and rejects unknown flags", async () => {
    const { endpoint, seen } = await stub((_, res) => res.end());
    const dir = await mkdtemp(join(tmpdir(), "orca-an392-"));
    const args = ["run", "--endpoint", endpoint.url, "--approval-ref", APPROVAL, "--evidence-dir", join(dir, "e")];
    expect(await main([...args, "--confirm", "yes"], quiet())).toBe(64);
    expect(await main([...args, "--confirm", confirmationFor(endpoint), "--token", "x"], quiet())).toBe(64);
    expect(seen).toHaveLength(0);
  });
});

describe("against the real daemon /rpc (in-memory credentials)", () => {
  it("is refused three times at the credential step, with matching audit records and no other effect", async () => {
    const h = await harness();
    closers.push(() => h.close());
    const before = {
      runs: (await h.rpc(h.tokens.owner, "runs.list")).body.result,
      ownedByAlice: (await h.rpc(h.tokens.alice, "runs.list")).body.result,
    };
    const endpoint = parseEndpoint(`${h.daemon.url}/rpc`);
    const evidence = await runProbes(endpoint, { approvalRef: APPROVAL });

    expect(evidence).toMatchObject({ outcome: "all-rejected", exitCode: 0, requestsSent: 3, requestsPlanned: 3 });
    expect(evidence.requests.map((r) => [r.verdict, r.status, r.code, r.bodyId])).toEqual([
      ["rejected-at-credential-check", 401, "AUTH_REQUIRED", 0],
      ["rejected-at-credential-check", 401, "AUTH_INVALID", 0],
      ["rejected-at-credential-check", 401, "AUTH_INVALID", 0],
    ]);
    expect(evidence.requests.every((r) => r.connection === "close")).toBe(true);

    // The audit log as the daemon would have written it, with a real session's traffic around it.
    const jsonl = h.audit.records.map((r) => JSON.stringify(r)).join("\n");
    const result = correlate(evidence, jsonl);
    expect(result.verdict).toBe("daemon-credential-boundary-confirmed");
    expect(result.matches.map((m) => m.reason)).toEqual(["missing", "malformed", "unknown"]);
    expect(result.matches[2].fixtureCredentialId).toBe(FIXTURE_ID);
    // Valid sessions are untouched: the same credentials still work and see the same runs.
    expect((await h.rpc(h.tokens.owner, "runs.list")).body.result).toEqual(before.runs);
    expect((await h.rpc(h.tokens.alice, "runs.list")).body.result).toEqual(before.ownedByAlice);
    expect(h.audit.records.filter((r) => r.event === "authn.denied")).toHaveLength(3);
  });

  it("is refused at the transport gate, not the credential step, when the Host is not loopback", async () => {
    const h = await harness();
    closers.push(() => h.close());
    const endpoint = parseEndpoint(`${h.daemon.url}/rpc`);
    const evidence = await runProbes(endpoint, {
      approvalRef: APPROVAL,
      send: (e, p, id) => sendOnce({ ...e, host: "agent-01.example" }, p, id),
    });
    expect(evidence).toMatchObject({ outcome: "rejected-at-transport-gate", exitCode: 2, requestsSent: 1 });
    expect(h.audit.records.filter((r) => r.event === "authn.denied").map((r) => r.reason)).toEqual([
      "host-not-loopback",
    ]);
    expect(correlate(evidence, h.audit.records.map((r) => JSON.stringify(r)).join("\n")).verdict).toBe("not-confirmed");
  });
});

describe("stops", () => {
  it("stops at the first unexpected access and keeps none of the body", async () => {
    const canary = "run_canary-that-must-not-be-kept";
    const { endpoint, seen } = await stub((_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ kind: "response", id: 1, ok: true, result: { runId: canary } }));
    });
    const evidence = await runProbes(endpoint, { approvalRef: APPROVAL });
    expect(evidence).toMatchObject({ outcome: "unexpected-access", exitCode: 3, requestsSent: 1 });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toContain(canary);
    expect(evidence.requests[0].bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops at a refusal that is not the daemon's exact one", async () => {
    const { endpoint, seen } = await stub((_, res) => {
      res.writeHead(401, { "www-authenticate": "Basic" });
      res.end(JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "proxy says no" } }));
    });
    const evidence = await runProbes(endpoint, { approvalRef: APPROVAL });
    expect(evidence).toMatchObject({ outcome: "unexpected-response", exitCode: 2, requestsSent: 1 });
    expect(evidence.requests[0].code).toBe("AUTH_REQUIRED");
    expect(JSON.stringify(evidence)).not.toContain("proxy says no");
    expect(seen).toHaveLength(1);
  });

  it("treats a refusal for the wrong reason as a stop, even mid-run", async () => {
    // Answers AUTH_REQUIRED to everything: right for the first probe, wrong for the second.
    const { endpoint, seen } = await stub((_, res) => {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="orca"', "content-type": "application/json" });
      res.end(
        JSON.stringify({
          kind: "response",
          id: 0,
          ok: false,
          error: { code: "AUTH_REQUIRED", message: "authentication required" },
        }),
      );
    });
    const evidence = await runProbes(endpoint, { approvalRef: APPROVAL });
    expect(evidence.requests.map((r) => r.verdict)).toEqual(["rejected-at-credential-check", "unexpected-response"]);
    expect(seen).toHaveLength(2);
  });

  it("does not retry an unreachable daemon or a silent one", async () => {
    const closed = createServer();
    await new Promise((r) => closed.listen(0, "127.0.0.1", r));
    const port = closed.address().port;
    await new Promise((r) => closed.close(r));
    const refused = await runProbes(parseEndpoint(`http://127.0.0.1:${port}/rpc`), { approvalRef: APPROVAL });
    expect(refused).toMatchObject({ outcome: "unreachable", exitCode: 4, requestsSent: 1 });
    expect(refused.requests[0].error).toBe("ECONNREFUSED");

    const { endpoint, seen } = await stub(() => {});
    const silent = await runProbes(endpoint, {
      approvalRef: APPROVAL,
      send: (e, p, id) => sendOnce(e, p, id, 200),
    });
    expect(silent).toMatchObject({ outcome: "unreachable", requestsSent: 1 });
    expect(silent.requests[0].error).toBe("ETIMEDOUT");
    expect(seen).toHaveLength(1);
  });

  it("enforces an absolute deadline against a slow-drip listener", async () => {
    const timers = [];
    const { endpoint, seen } = await stub((_, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      const timer = setInterval(() => res.write(" "), 20);
      timers.push(timer);
      res.on("close", () => clearInterval(timer));
    });
    closers.push(() => timers.forEach(clearInterval));
    const started = Date.now();
    const result = await sendOnce(endpoint, PROBES[0], "x", 100);
    const elapsed = Date.now() - started;
    expect(result).toEqual({ transportError: "ETIMEDOUT" });
    expect(elapsed).toBeLessThan(300);
    expect(seen).toHaveLength(1);
  });

  it("stops reading an oversized body and claims no digest for it", async () => {
    const big = "x".repeat(4097);
    const { endpoint } = await stub((_, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(big);
    });
    const response = await sendOnce(endpoint, PROBES[0], "x");
    expect(response).toMatchObject({ status: 401, truncated: true, body: undefined });
    expect(response.size).toBeGreaterThan(4096);
    const record = classify(PROBES[0], response);
    expect(record).toMatchObject({ verdict: "unexpected-response", stop: true, bodyTruncated: true, bodySha256: null });
    expect(record.bodyBytesAtLeast).toBeGreaterThan(4096);
    expect(record).not.toHaveProperty("bodyBytes");

    // An endless body is cut off at the cap, well before the deadline.
    const { endpoint: endless } = await stub((_, res) => {
      res.writeHead(200);
      const timer = setInterval(() => res.write("y".repeat(1024)), 5);
      res.on("close", () => clearInterval(timer));
    });
    const cut = await sendOnce(endless, PROBES[0], "x", 2_000);
    expect(cut).toMatchObject({ status: 200, truncated: true });
    expect(classify(PROBES[0], cut)).toMatchObject({ verdict: "unexpected-access", bodySha256: null });
  });

  it("digests a body at exactly the cap", async () => {
    const exact = "z".repeat(4096);
    const { endpoint } = await stub((_, res) => {
      res.writeHead(500);
      res.end(exact);
    });
    const response = await sendOnce(endpoint, PROBES[0], "x");
    expect(response).toMatchObject({ status: 500, size: 4096, truncated: false });
    const record = classify(PROBES[0], response);
    expect(record).toMatchObject({ bodyBytes: 4096 });
    expect(record.bodySha256).toBe(createHash("sha256").update(exact).digest("hex"));
  });

  it("sends nothing that names a proxy, a redirect or a URL credential", async () => {
    const { endpoint, seen } = await stub((_, res) => res.end());
    await sendOnce(endpoint, PROBES[2], "x");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/rpc" });
    expect(seen[0].headers.host).toBe(endpoint.host);
    expect(seen[0].headers.origin).toBeUndefined();
    expect(JSON.parse(seen[0].body)).toEqual({ kind: "request", id: "x", method: "hello", params: {} });
  });
});

describe("evidence", () => {
  it("is written once, owner-only, and the correlation names nothing outside the probe", async () => {
    const h = await harness();
    closers.push(() => h.close());
    const dir = await mkdtemp(join(tmpdir(), "orca-an392-"));
    const endpoint = parseEndpoint(`${h.daemon.url}/rpc`);
    const evidenceDir = join(dir, "evidence");
    const args = ["--endpoint", endpoint.url, "--approval-ref", APPROVAL, "--evidence-dir", evidenceDir];
    expect(await main(["run", ...args, "--confirm", confirmationFor(endpoint)], quiet())).toBe(0);
    expect(await main(["run", ...args, "--confirm", confirmationFor(endpoint)], quiet())).toBe(64);

    const evidenceFile = join(evidenceDir, "evidence.json");
    const evidenceText = await readFile(evidenceFile, "utf8");
    expect(JSON.parse(evidenceText).helperSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceText).not.toContain(FIXTURE_SECRET);
    expect(evidenceText).not.toContain("orca-negative-fixture-392");
    for (const token of Object.values(h.tokens)) expect(evidenceText).not.toContain(token.split(".")[2]);
    if (process.platform !== "win32") {
      expect((await stat(evidenceFile)).mode & 0o777).toBe(0o600);
      expect((await stat(evidenceDir)).mode & 0o777).toBe(0o700);
    }

    // A live session's records around the probe: an operation by a real principal.
    const session = {
      at: new Date().toISOString(),
      event: "operation",
      transport: "socket",
      actor: { principal: "private-principal-name", kind: "credential", credential: "privatecred1" },
      operation: "runs.list",
      outcome: "succeeded",
    };
    const auditLog = join(dir, "audit.jsonl");
    const denials = h.audit.records.filter((r) => r.event === "authn.denied");
    const lines = [...denials.map((r) => JSON.stringify(r)), JSON.stringify(session), "{torn"];
    await import("node:fs/promises").then((fs) => fs.writeFile(auditLog, lines.join("\n")));
    const out = join(dir, "correlation.json");
    expect(await main(["correlate", "--evidence", evidenceFile, "--audit-log", auditLog, "--out", out], quiet())).toBe(
      0,
    );
    const correlation = await readFile(out, "utf8");
    expect(JSON.parse(correlation)).toMatchObject({
      verdict: "daemon-credential-boundary-confirmed",
      otherRecordsInWindow: { operation: 1 },
      unparseableLines: 1,
    });
    expect(correlation).not.toContain("private-principal-name");
    expect(correlation).not.toContain("privatecred1");
    expect(await main(["correlate", "--evidence", evidenceFile, "--audit-log", auditLog, "--out", out], quiet())).toBe(
      64,
    );
  });

  it("does not confirm without the daemon's own records", () => {
    const evidence = {
      outcome: "all-rejected",
      runId: "r",
      startedAt: "2026-10-27T00:00:00.000Z",
      finishedAt: "2026-10-27T00:00:01.000Z",
      requests: PROBES.map((p, i) => ({
        index: i + 1,
        probe: p.name,
        verdict: "rejected-at-credential-check",
        sentAt: "2026-10-27T00:00:00.100Z",
        receivedAt: "2026-10-27T00:00:00.200Z",
      })),
    };
    expect(correlate(evidence, "").verdict).toBe("not-confirmed");
    // Right reasons, but a record from another peer or outside the window does not count.
    const rec = (reason, extra = {}) =>
      JSON.stringify({
        at: "2026-10-27T00:00:00.150Z",
        event: "authn.denied",
        transport: "http",
        outcome: "denied",
        code: reason === "missing" ? "AUTH_REQUIRED" : "AUTH_INVALID",
        reason,
        remote: "127.0.0.1",
        ...extra,
      });
    const good = [rec("missing"), rec("malformed"), rec("unknown", { target: { credentialId: FIXTURE_ID } })];
    expect(correlate(evidence, good.join("\n")).verdict).toBe("daemon-credential-boundary-confirmed");
    const remote = [good[0], good[1], rec("unknown", { target: { credentialId: FIXTURE_ID }, remote: "203.0.113.9" })];
    expect(correlate(evidence, remote.join("\n")).verdict).toBe("not-confirmed");
    const late = [
      good[0],
      good[1],
      rec("unknown", { target: { credentialId: FIXTURE_ID }, at: "2026-10-27T01:00:00.000Z" }),
    ];
    expect(correlate(evidence, late.join("\n")).verdict).toBe("not-confirmed");
    const otherId = [good[0], good[1], rec("unknown", { target: { credentialId: "realcred0001" } })];
    expect(correlate(evidence, otherId.join("\n")).verdict).toBe("not-confirmed");
  });

  it("classifies only the daemon's exact refusal as the credential boundary", () => {
    const exact = (code) => ({
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="orca"' },
      body: Buffer.from(
        JSON.stringify({
          kind: "response",
          id: 0,
          ok: false,
          error: { code, message: code === "AUTH_REQUIRED" ? "authentication required" : "invalid credentials" },
        }),
      ),
      size: 1,
    });
    expect(classify(PROBES[0], exact("AUTH_REQUIRED")).verdict).toBe("rejected-at-credential-check");
    expect(classify(PROBES[1], exact("AUTH_REQUIRED")).verdict).toBe("unexpected-response");
    const echoed = {
      ...exact("AUTH_INVALID"),
      body: Buffer.from(
        JSON.stringify({
          kind: "response",
          id: "an392-1",
          ok: false,
          error: { code: "AUTH_INVALID", message: "invalid credentials" },
        }),
      ),
    };
    // An echoed id means the body was read: something past the header check answered.
    expect(classify(PROBES[1], echoed).verdict).toBe("unexpected-response");
    expect(describePlan(parseEndpoint("http://127.0.0.1:1/rpc")).requests).toHaveLength(3);
  });
});

describe("operator procedure", () => {
  it("names the helper's exact fixtures, expectations and confirmation phrase", async () => {
    const doc = await readFile(
      new URL("../../docs/preparation/private-mcp-access/auth-negative-test.md", import.meta.url),
      "utf8",
    );
    for (const probe of PROBES) {
      if (probe.authorization) expect(doc).toContain(`\`${probe.authorization}\``);
      expect(doc).toContain(`\`${probe.expect.auditReason}\``);
    }
    expect(doc).toContain(confirmationFor(parseEndpoint("http://127.0.0.1:33871/rpc")));
    expect(doc).toContain("http://127.0.0.1:33871/rpc");
    expect(doc).toContain("## Permission required before live execution");
  });
});
