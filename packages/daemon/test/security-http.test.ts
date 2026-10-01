import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/auth/index.js";
/**
 * #328 over `/rpc`: authentication refusals, the permission matrix at work, resource isolation
 * between principals, gate decisions and the audit trail - against a real orchestrator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanService } from "@orca/engine";
import { RequestSchema } from "@orca/core";
import { PROTOCOL_VERSION } from "@orca/protocol";
import { harness, putArtifact, recordJsonArtifact, raw, type Harness } from "./security-harness.js";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const INVALID = { kind: "response", id: 0, ok: false, error: { code: "AUTH_INVALID", message: "invalid credentials" } };

describe("authentication on /rpc", () => {
  it("asks for a credential when none is sent, before reading the body", async () => {
    const r = await h.rpc(undefined, "runs.list");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="orca"');
    expect(r.body).toEqual({
      kind: "response",
      id: 0,
      ok: false,
      error: { code: "AUTH_REQUIRED", message: "authentication required" },
    });
  });

  it("answers malformed, unknown, wrong, expired and revoked credentials identically", async () => {
    const [, id, secret] = h.tokens.alice.split(".");
    const expired = (await h.credentials.issue({ principal: "late", preset: "viewer", ttlMs: -1 })).token;
    const revoked = await h.credentials.issue({ principal: "gone", preset: "viewer" });
    await h.credentials.revoke(revoked.credential.id);
    const presented = [
      "not-a-token",
      `orca1.${"A".repeat(12)}.${secret}`,
      `orca1.${id}.${"B".repeat(43)}`,
      expired,
      revoked.token,
    ];
    for (const token of presented) {
      const r = await h.rpc(token, "runs.list");
      expect(r.status).toBe(401);
      expect(r.body).toEqual(INVALID);
    }
    const basic = await h.rpc(undefined, "runs.list", {}, { authorization: `Basic ${h.tokens.alice}` });
    expect(basic.body).toEqual(INVALID);
    // The reasons differ in the audit log, and only there.
    const reasons = h.audit.records.filter((r) => r.event === "authn.denied").map((r) => r.reason);
    expect(reasons).toEqual(["malformed", "unknown", "mismatch", "expired", "revoked", "malformed"]);
  });

  it("has no side effects for a refused call", async () => {
    const revoked = await h.credentials.issue({ principal: "alice", preset: "client" });
    await h.credentials.revoke(revoked.credential.id);
    const r = await h.rpc(revoked.token, "runs.cancel", { runId: h.runs.alice });
    expect(r.body).toEqual(INVALID);
    expect((await h.orchestrator.getState(h.runs.alice)).run.status).toBe("paused");
  });

  it.each(["revoked", "expired", "reduced-grants"])("refreshes %s authority after a pending body", async (change) => {
    await h.close();
    const dir = await mkdtemp(join(tmpdir(), "orca-http-auth-"));
    const file = join(dir, "credentials.json");
    let now = Date.now();
    const credentials = new CredentialStore({ file, now: () => new Date(now) });
    h = await harness({ credentials });
    const issued = await credentials.issue({ principal: "alice", preset: "client", ttlMs: 60_000 });
    let admitted!: () => void;
    const headersRead = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const authenticate = credentials.authenticate.bind(credentials);
    const spy = vi.spyOn(credentials, "authenticate").mockImplementation((token) => {
      const result = authenticate(token);
      admitted();
      return result;
    });
    const payload = JSON.stringify({ kind: "request", id: 9, method: "runs.cancel", params: { runId: h.runs.alice } });
    const req = httpRequest(`${h.daemon.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-length": Buffer.byteLength(payload) },
    });
    const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      req.on("error", reject);
      req.on("response", (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      });
    });
    try {
      req.write(payload.slice(0, 10));
      await headersRead;
      if (change === "revoked") await credentials.revoke(issued.credential.id);
      else if (change === "expired") now += 120_000;
      else {
        const stored = JSON.parse(await readFile(file, "utf8")) as {
          credentials: { id: string; permissions: string[] }[];
        };
        stored.credentials.find((c) => c.id === issued.credential.id)!.permissions = ["runs.read"];
        await writeFile(file, JSON.stringify(stored));
      }
      req.end(payload.slice(10));
      const r = await response;
      if (change === "reduced-grants")
        expect(r).toMatchObject({ status: 200, body: { id: 9, error: { code: "AUTH_FORBIDDEN" } } });
      else expect(r).toEqual({ status: 401, body: INVALID });
      expect((await h.orchestrator.getState(h.runs.alice)).run.status).toBe("paused");
    } finally {
      req.destroy();
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a credential in the URL and never records it", async () => {
    const res = await fetch(`${h.daemon.url}/rpc?access_token=${h.tokens.alice}`, {
      method: "POST",
      body: JSON.stringify({ kind: "request", id: 1, method: "runs.list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(INVALID);
    const secret = h.tokens.alice.split(".")[2]!;
    expect(JSON.stringify(h.audit.records)).not.toContain(secret);
  });

  it("refuses a browser origin and a non-loopback Host", async () => {
    const origin = await h.rpc(h.tokens.owner, "runs.list", {}, { origin: "https://evil.example" });
    expect(origin.status).toBe(403);
    expect(origin.body.error).toEqual({ code: "AUTH_FORBIDDEN", message: "not permitted" });
    const rebound = await raw(h.daemon.url, {
      headers: { host: "evil.example", authorization: `Bearer ${h.tokens.owner}` },
    });
    expect(rebound.status).toBe(403);
  });

  it("leaves /health open, and it says nothing", async () => {
    const res = await fetch(`${h.daemon.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("operation authorization", () => {
  it("refuses an operation before validating its params", async () => {
    const r = await h.rpc(h.tokens.viewer, "runs.cancel", { runId: 42 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 7, ok: false, error: { code: "AUTH_FORBIDDEN", message: "not permitted" } });
    expect(r.body.error?.details).toBeUndefined();
  });

  it("keeps workspace operations from a restricted principal", async () => {
    for (const method of ["config.get", "agents.list", "maintenance"])
      expect((await h.rpc(h.tokens.alice, method)).body.error?.code).toBe("AUTH_FORBIDDEN");
    expect((await h.rpc(h.tokens.owner, "config.get")).body.ok).toBe(true);
  });

  it("tells hello only what the principal may use", async () => {
    const hello = { client: "t/1", protocol: PROTOCOL_VERSION };
    const alice = (await h.rpc(h.tokens.alice, "hello", hello)).body.result as Record<string, unknown>;
    expect(alice.methods).toContain("runs.start");
    expect(alice.methods).not.toContain("config.get");
    expect(alice.capabilities).toEqual(["runs.read", "runs.subscribe", "runs.control"]);
    expect(alice.storeDir).toBeUndefined();
    const viewer = (await h.rpc(h.tokens.viewer, "hello", hello)).body.result as Record<string, unknown>;
    expect(viewer.capabilities).toEqual(["runs.read", "runs.subscribe"]);
    expect(viewer.methods).not.toContain("runs.cancel");
    const owner = (await h.rpc(h.tokens.owner, "hello", hello)).body.result as Record<string, unknown>;
    expect(owner.storeDir).toBe("/srv/store");
  });
});

describe("resource isolation", () => {
  const ids = (r: { body: { result?: unknown } }) =>
    (r.body.result as { runs: { id: string }[] }).runs.map((run) => run.id).sort();

  it("filters lists and recounts them", async () => {
    const alice = await h.rpc(h.tokens.alice, "runs.list");
    expect(ids(alice)).toEqual([h.runs.alice]);
    expect((alice.body.result as { total: number }).total).toBe(1);
    expect(ids(await h.rpc(h.tokens.bob, "runs.list"))).toEqual([h.runs.bob]);
    expect(ids(await h.rpc(h.tokens.owner, "runs.list"))).toEqual([h.runs.alice, h.runs.bob, h.runs.legacy].sort());
    // Paging applies to what the caller can see, not to the store.
    const page = await h.rpc(h.tokens.alice, "runs.list", { offset: 1 });
    expect((page.body.result as { runs: unknown[]; total: number }).runs).toEqual([]);
    expect((page.body.result as { total: number }).total).toBe(1);
  });

  it("answers another principal's run exactly as it answers a run that does not exist", async () => {
    for (const method of ["runs.get", "runs.events", "runs.resume", "runs.cancel"]) {
      const theirs = await h.rpc(h.tokens.alice, method, { runId: h.runs.bob });
      const nobody = await h.rpc(h.tokens.alice, method, { runId: "run-guessed" });
      expect(theirs.body.ok).toBe(false);
      expect(JSON.stringify(theirs.body.error).replaceAll(h.runs.bob, "ID")).toBe(
        JSON.stringify(nobody.body.error).replaceAll("run-guessed", "ID"),
      );
    }
    expect((await h.orchestrator.getState(h.runs.bob)).run.status).toBe("paused");
    // The unowned run is the owner's to see, and nobody restricted can reach it.
    expect((await h.rpc(h.tokens.alice, "runs.get", { runId: h.runs.legacy })).body.ok).toBe(false);
    expect((await h.rpc(h.tokens.owner, "runs.get", { runId: h.runs.legacy })).body.ok).toBe(true);
  });

  it("refuses linked documents before admission, disclosure or plan settlement", async () => {
    const request = RequestSchema.parse({
      id: "protected-request",
      title: "confidential request",
      body: "confidential body",
      createdAt: h.clock.isoNow(),
      updatedAt: h.clock.isoNow(),
    });
    await h.stores.requests.put(request);
    const plan = new PlanService({ stores: h.stores, clock: h.clock });
    const origin = { kind: "human" as const, actor: "owner" };
    const p = await plan.ensurePlan({ key: "protected", requestId: request.id }, origin);
    const registered = await plan.registerWorkItems(
      p.id,
      {
        requestId: request.id,
        items: [{ slug: "secret-item", title: "confidential item" }],
      },
      origin,
    );
    const item = registered.items[0]!;
    expect(item.runId).toBeUndefined();
    const before = await h.stores.workItems.get(item.id);
    const runsBefore = (await h.rpc(h.tokens.owner, "runs.list")).body.result;
    for (const links of [
      { requestId: request.id },
      { requestId: "guessed-request" },
      { workItemId: item.id },
      { workItemId: "guessed-item" },
      { requestId: request.id, workItemId: item.id },
    ]) {
      const r = await h.rpc(h.tokens.alice, "runs.start", { workflowId: "gated", ...links });
      expect(r.body.error).toEqual({ code: "AUTH_FORBIDDEN", message: "not permitted" });
      expect(JSON.stringify(r.body)).not.toContain("confidential");
    }
    expect((await h.rpc(h.tokens.owner, "runs.list")).body.result).toEqual(runsBefore);
    expect(await h.stores.workItems.get(item.id)).toEqual(before);
    // Positive control: the same unassigned item really is settled by an authorized run.
    const started = await h.rpc(h.tokens.owner, "runs.start", {
      workflowId: "gated",
      requestId: request.id,
      workItemId: item.id,
    });
    expect(started.body.ok).toBe(true);
    const { runId } = started.body.result as { runId: string };
    const gate = (await h.orchestrator.pendingInputs(runId))[0]!;
    expect((await h.rpc(h.tokens.owner, "inputs.answer", { requestId: gate.id, optionId: "ship" })).body.ok).toBe(true);
    expect(await h.stores.workItems.get(item.id)).toMatchObject({ runId, status: "done" });
  });

  it("lets a child run inherit its root's access", async () => {
    await h.append({
      type: "run.created",
      runId: "child-of-alice",
      payload: {
        workflowId: "other",
        workflowVersion: "1",
        parentRunId: h.runs.alice,
        workspace: { hostId: "local", cwd: "/tmp" },
        vars: {},
      },
    });
    expect((await h.rpc(h.tokens.alice, "runs.get", { runId: "child-of-alice" })).body.ok).toBe(true);
    expect((await h.rpc(h.tokens.bob, "runs.get", { runId: "child-of-alice" })).body.ok).toBe(false);
    expect(ids(await h.rpc(h.tokens.alice, "runs.list", { parentRunId: h.runs.alice }))).toEqual(["child-of-alice"]);
    expect(ids(await h.rpc(h.tokens.bob, "runs.list", { parentRunId: h.runs.alice }))).toEqual([]);
  });

  it("isolates artifact metadata and content", async () => {
    await putArtifact(h.stores, "art-alice", h.runs.alice, "alice's plan\n");
    const list = (token: string, params = {}) =>
      h
        .rpc(token, "artifacts.list", params)
        .then((r) => r.body.result as { artifacts: { id: string }[]; total: number });
    expect((await list(h.tokens.alice)).artifacts.map((a) => a.id)).toEqual(["art-alice"]);
    expect(await list(h.tokens.bob)).toMatchObject({ artifacts: [], total: 0 });
    expect(await list(h.tokens.bob, { runId: h.runs.alice })).toMatchObject({ artifacts: [], total: 0 });

    const mine = await h.rpc(h.tokens.alice, "artifacts.get", { artifactId: "art-alice" });
    expect((mine.body.result as { text: string }).text).toBe("alice's plan\n");
    const theirs = await h.rpc(h.tokens.bob, "artifacts.get", { artifactId: "art-alice" });
    const nobody = await h.rpc(h.tokens.bob, "artifacts.get", { artifactId: "art-nope" });
    expect(JSON.stringify(theirs.body.error).replaceAll("art-alice", "ID")).toBe(
      JSON.stringify(nobody.body.error).replaceAll("art-nope", "ID"),
    );
    const byAddress = await h.rpc(h.tokens.bob, "artifacts.get", { runId: h.runs.alice, name: "spec" });
    expect(byAddress.body.error?.code).toBe("ARTIFACT_MISSING");
    expect(JSON.stringify(byAddress.body)).not.toContain("alice's plan");
  });

  it("withholds artifact projections from runs.read-only credentials without losing page cursors", async () => {
    const seq = await recordJsonArtifact(h, "json-secret");
    for (const method of ["artifacts.get", "artifacts.list"])
      expect((await h.rpc(h.tokens.runsOnly, method, { artifactId: "json-secret" })).body.error?.code).toBe(
        "AUTH_FORBIDDEN",
      );
    const get = await h.rpc(h.tokens.runsOnly, "runs.get", { runId: h.runs.alice });
    expect(get.body.result).toMatchObject({ artifacts: [] });
    const events = await h.rpc(h.tokens.runsOnly, "runs.events", { runId: h.runs.alice, after: seq - 1, limit: 1 });
    expect(events.body.result).toMatchObject({ events: [], nextCursor: seq, prevCursor: seq });
    expect(JSON.stringify([get.body, events.body])).not.toContain("json-secret");
    expect(JSON.stringify([get.body, events.body])).not.toContain("private-json-value");
    const owner = await h.rpc(h.tokens.owner, "runs.events", { runId: h.runs.alice, after: seq - 1 });
    expect(JSON.stringify(owner.body.result)).toContain("private-json-value");
  });

  it("filters open inputs and claims to visible runs", async () => {
    const inputs = (token: string, params = {}) =>
      h.rpc(token, "inputs.list", params).then((r) => r.body.result as { inputs: { id: string }[]; waiting: number });
    expect((await inputs(h.tokens.alice)).inputs.map((i) => i.id)).toEqual([h.gates.alice]);
    expect((await inputs(h.tokens.alice)).waiting).toBe(1);
    expect(await inputs(h.tokens.alice, { runId: h.runs.bob })).toMatchObject({ inputs: [], waiting: 0 });
    expect((await inputs(h.tokens.owner)).waiting).toBe(3);
  });

  it("bounds workflows by the principal's workflow scope, without naming the rest", async () => {
    const list = await h.rpc(h.tokens.narrow, "workflows.list");
    expect((list.body.result as { workflows: { id: string }[] }).workflows.map((w) => w.id)).toEqual(["gated"]);
    const hidden = await h.rpc(h.tokens.narrow, "workflows.get", { id: "secret" });
    const absent = await h.rpc(h.tokens.narrow, "workflows.get", { id: "nope" });
    expect(JSON.stringify(hidden.body.error).replaceAll("secret", "ID")).toBe(
      JSON.stringify(absent.body.error).replaceAll("nope", "ID"),
    );
    expect(hidden.body.error?.details).toBeUndefined();
    const start = await h.rpc(h.tokens.narrow, "runs.start", { workflowId: "secret" });
    const startAbsent = await h.rpc(h.tokens.narrow, "runs.start", { workflowId: "nope" });
    expect(JSON.stringify(start.body.error).replaceAll("secret", "ID")).toBe(
      JSON.stringify(startAbsent.body.error).replaceAll("nope", "ID"),
    );
    expect(ids(await h.rpc(h.tokens.owner, "runs.list"))).toHaveLength(3);
  });
});

describe("gate decisions", () => {
  it("refuses an answer to a gate the caller cannot see, with no effect", async () => {
    const theirs = await h.rpc(h.tokens.bob, "inputs.answer", { requestId: h.gates.alice, optionId: "ship" });
    const nobody = await h.rpc(h.tokens.bob, "inputs.answer", { requestId: "hi-guessed", optionId: "ship" });
    expect(JSON.stringify(theirs.body.error).replaceAll(h.gates.alice, "ID")).toBe(
      JSON.stringify(nobody.body.error).replaceAll("hi-guessed", "ID"),
    );
    expect((await h.orchestrator.getState(h.runs.alice)).run.status).toBe("paused");
  });

  it("refuses a gate named under the wrong run", async () => {
    const r = await h.rpc(h.tokens.owner, "inputs.answer", {
      requestId: h.gates.alice,
      runId: h.runs.bob,
      optionId: "ship",
      resume: false,
    });
    expect(r.body.ok).toBe(false);
    const restricted = await h.rpc(h.tokens.alice, "inputs.answer", {
      requestId: h.gates.alice,
      runId: h.runs.bob,
      optionId: "ship",
    });
    expect(restricted.body.error?.code).toBe("RUN_STATE");
    expect((await h.orchestrator.getState(h.runs.alice)).run.status).toBe("paused");
  });

  it("needs a separate grant for a standing permission", async () => {
    const r = await h.rpc(h.tokens.alice, "inputs.answer", {
      requestId: h.gates.alice,
      optionId: "ship",
      always: { decision: "allow" },
    });
    expect(r.body.error).toEqual({ code: "AUTH_FORBIDDEN", message: "not permitted" });
    expect((await h.orchestrator.getState(h.runs.alice)).run.status).toBe("paused");
  });

  it("attributes a permitted answer, and refuses the stale second one", async () => {
    const ok = await h.rpc(h.tokens.alice, "inputs.answer", { requestId: h.gates.alice, optionId: "ship" });
    expect(ok.body.ok).toBe(true);
    const record = h.audit.records.find((r) => r.event === "operation" && r.operation === "inputs.answer");
    expect(record).toMatchObject({
      actor: { principal: "alice", kind: "credential", credential: h.ids.alice },
      outcome: "succeeded",
      target: { requestId: h.gates.alice },
      transport: "http",
    });
    expect(JSON.stringify(record)).not.toContain("ship");
    const again = await h.rpc(h.tokens.alice, "inputs.answer", {
      requestId: h.gates.alice,
      runId: h.runs.alice,
      optionId: "hold",
    });
    expect(again.body.ok).toBe(false);
    expect(["INPUT_ANSWERED", "RUN_NOT_WAITING"]).toContain(again.body.error?.code);
  });
});

describe("audit", () => {
  it("records mutations with their actor and outcome, and denials with an internal reason", async () => {
    await h.rpc(h.tokens.alice, "runs.cancel", { runId: h.runs.bob });
    await h.rpc(h.tokens.viewer, "runs.cancel", { runId: h.runs.bob });
    await h.rpc(h.tokens.bob, "runs.cancel", { runId: h.runs.bob, reason: "a private reason" });
    const denied = h.audit.records.filter((r) => r.event === "authz.denied");
    expect(denied.map((r) => [r.actor?.principal, r.reason])).toEqual([
      ["alice", "run-not-visible"],
      ["viewer", "missing-permission:runs.control"],
    ]);
    const cancelled = h.audit.records.find((r) => r.operation === "runs.cancel" && r.event === "operation");
    expect(cancelled).toMatchObject({
      actor: { principal: "bob" },
      outcome: "succeeded",
      target: { runId: h.runs.bob },
    });
    expect(JSON.stringify(h.audit.records)).not.toContain("a private reason");
    for (const token of Object.values(h.tokens)) expect(JSON.stringify(h.audit.records)).not.toContain(token);
  });
});
