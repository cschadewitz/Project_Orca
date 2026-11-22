/**
 * #328 on `/socket`: the upgrade is authenticated, every notification is authorized for the
 * principal it is about to reach, and a credential that is revoked or expires while a
 * connection is open ends that connection's authority.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { OrcaEventInput } from "@orca/core";
import { z } from "zod";
import { OrcaEventSchema } from "@orca/core";
import { PROTOCOL_VERSION, RunsEventsResultSchema, STEP_CHANGED } from "@orca/protocol";
import { CredentialStore } from "../src/auth/index.js";
import { harness, recordGateArtifact, recordJsonArtifact, type Harness } from "./security-harness.js";

type Frame = {
  kind: string;
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: Record<string, unknown>;
};

class Client {
  readonly frames: Frame[] = [];
  readonly closed: Promise<number>;
  private nextId = 1;
  private waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      this.frames.push(
        JSON.parse(
          (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString(
            "utf8",
          ),
        ) as Frame,
      );
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  static open(
    url: string,
    opts: { token?: string; via?: "header" | "protocol"; origin?: string } = {},
  ): Promise<Client> {
    const protocols = opts.token && opts.via === "protocol" ? ["orca.v1", `orca.bearer.${opts.token}`] : ["orca.v1"];
    const headers: Record<string, string> = {};
    if (opts.token && opts.via !== "protocol") headers.authorization = `Bearer ${opts.token}`;
    if (opts.origin) headers.origin = opts.origin;
    const ws = new WebSocket(url, protocols, { headers });
    return new Promise((resolve, reject) => {
      ws.on("open", () => resolve(new Client(ws)));
      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += String(c)));
        res.on("end", () =>
          reject(Object.assign(new Error("refused"), { status: res.statusCode, body: JSON.parse(body) })),
        );
      });
      ws.on("error", (e) => reject(e));
    });
  }

  async call(method: string, params: unknown = {}): Promise<Frame> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ kind: "request", id, method, params }));
    for (;;) {
      const found = this.frames.find((f) => f.kind === "response" && f.id === id);
      if (found) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  notifications(method?: string): Frame[] {
    return this.frames.filter((f) => f.kind === "notification" && (!method || f.method === method));
  }

  async waitFor(predicate: (f: Frame) => boolean): Promise<Frame> {
    for (;;) {
      const found = this.frames.find((f) => f.kind === "notification" && predicate(f));
      if (found) return found;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  close(): void {
    this.ws.close();
  }
}

let h: Harness;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await h.close();
});

async function connect(token: string, via: "header" | "protocol" = "header"): Promise<Client> {
  const c = await Client.open(h.daemon.socketUrl!, { token, via });
  clients.push(c);
  return c;
}

const scheduled = (runId: string, stepRunId: string): OrcaEventInput => ({
  type: "step.scheduled",
  runId,
  payload: { stepRunId, nodeId: "n", nodeType: "agent", attempt: 1 },
});

const refusal = (url: string, opts: Parameters<typeof Client.open>[1]) =>
  Client.open(url, opts).then(
    () => {
      throw new Error("expected the upgrade to be refused");
    },
    (e: { status: number; body: unknown }) => ({ status: e.status, body: e.body }),
  );

describe("socket authentication", () => {
  it("refuses an upgrade with no credential, or a bad one, with the /rpc envelope", async () => {
    h = await harness();
    const url = h.daemon.socketUrl!;
    expect(await refusal(url, {})).toEqual({
      status: 401,
      body: {
        kind: "response",
        id: 0,
        ok: false,
        error: { code: "AUTH_REQUIRED", message: "authentication required" },
      },
    });
    const revoked = await h.credentials.issue({ principal: "x", preset: "viewer" });
    await h.credentials.revoke(revoked.credential.id);
    const invalid = {
      kind: "response",
      id: 0,
      ok: false,
      error: { code: "AUTH_INVALID", message: "invalid credentials" },
    };
    expect(await refusal(url, { token: revoked.token })).toEqual({ status: 401, body: invalid });
    expect(await refusal(url, { token: "orca1.nope" })).toEqual({ status: 401, body: invalid });
    expect(await refusal(url, { token: revoked.token, via: "protocol" })).toEqual({ status: 401, body: invalid });
    expect((await refusal(url, { token: h.tokens.owner, origin: "https://evil.example" })).status).toBe(403);
  });

  it("accepts a bearer subprotocol from a header-less client, and never echoes it", async () => {
    h = await harness();
    const ws = new globalThis.WebSocket(h.daemon.socketUrl!, ["orca.v1", `orca.bearer.${h.tokens.alice}`]);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    expect(ws.protocol).toBe("orca.v1");
    ws.close();
    const viaHeader = await connect(h.tokens.alice);
    expect(viaHeader.ws.protocol).toBe("orca.v1");
    expect((await viaHeader.call("runs.list")).ok).toBe(true);
  });

  it("checks the operation on the socket too, before its params", async () => {
    h = await harness();
    const viewer = await connect(h.tokens.viewer);
    expect((await viewer.call("runs.cancel", { runId: 1 })).error).toEqual({
      code: "AUTH_FORBIDDEN",
      message: "not permitted",
    });
    const agentsOnly = await h.credentials.issue({
      principal: "agents-only",
      permissions: ["agents.read"],
      scope: { workflows: "*", runs: "all" },
    });
    const c = await connect(agentsOnly.token);
    expect((await c.call("subscribe", { runId: h.runs.alice })).error).toMatchObject({ code: "AUTH_FORBIDDEN" });
  });
});

describe("notification authorization", () => {
  it("delivers a store-wide subscription only the runs its principal can see", async () => {
    h = await harness();
    const alice = await connect(h.tokens.alice);
    const owner = await connect(h.tokens.owner);
    for (const c of [alice, owner]) expect((await c.call("subscribe", { methods: [STEP_CHANGED] })).ok).toBe(true);
    await h.append(scheduled(h.runs.bob, "sr-bob"));
    await h.append(scheduled(h.runs.alice, "sr-alice"));
    await alice.waitFor((f) => f.params?.stepRunId === "sr-alice");
    await owner.waitFor((f) => f.params?.stepRunId === "sr-alice");
    expect(alice.notifications().map((f) => f.params?.runId)).toEqual([h.runs.alice]);
    expect(owner.notifications().map((f) => f.params?.runId)).toEqual([h.runs.bob, h.runs.alice]);
  });

  it("answers a subscription to an invisible run as it answers one to no run, and replays nothing", async () => {
    h = await harness();
    const alice = await connect(h.tokens.alice);
    const theirs = await alice.call("subscribe", { runId: h.runs.bob, since: 0 });
    const nobody = await alice.call("subscribe", { runId: "run-guessed", since: 0 });
    expect((theirs.result as { replayed: number }).replayed).toBe(0);
    expect((nobody.result as { replayed: number }).replayed).toBe(0);
    expect(alice.notifications()).toEqual([]);
    // Live events on that run are withheld as well: a marker on alice's own run, on a
    // stream that sees it, proves the earlier event was considered and dropped.
    expect((await alice.call("subscribe", { runId: h.runs.alice })).ok).toBe(true);
    await h.append(scheduled(h.runs.bob, "sr-bob"));
    await h.append(scheduled(h.runs.alice, "sr-alice"));
    await alice.waitFor((f) => f.params?.stepRunId === "sr-alice");
    expect(alice.notifications().filter((f) => f.params?.runId === h.runs.bob)).toEqual([]);
    // The owner's replay of the same run is real.
    const owner = await connect(h.tokens.owner);
    expect(
      ((await owner.call("subscribe", { runId: h.runs.bob, since: 0 })).result as { replayed: number }).replayed,
    ).toBeGreaterThan(0);
  });

  it.each(["owned", "all"] as const)("withholds input artifact metadata with %s run scope", async (runs) => {
    h = await harness();
    await recordGateArtifact(h, "gate-secret");
    const reader = await h.credentials.issue({
      principal: "alice",
      permissions: ["runs.read"],
      scope: { workflows: "*", runs },
    });
    const restricted = await connect(reader.token);
    const allowed = await connect(runs === "owned" ? h.tokens.alice : h.tokens.owner);
    const positive = await allowed.call("inputs.list");
    const negative = await restricted.call("inputs.list");
    expect(positive.ok).toBe(true);
    const result = positive.result as { inputs: { id: string; artifacts: unknown[] }[]; waiting: number };
    expect(result.waiting).toBe(runs === "owned" ? 1 : 3);
    expect(result.inputs.find((input) => input.id === h.gates.alice)?.artifacts).toEqual([
      expect.objectContaining({
        id: "gate-secret",
        name: "report",
        path: "/tmp/gate-secret.json",
        mediaType: "application/json",
        size: 30,
      }),
    ]);
    expect(negative.ok).toBe(true);
    expect(negative.result).toEqual({
      ...result,
      inputs: result.inputs.map((input) => ({ ...input, artifacts: [] })),
    });
    expect(JSON.stringify(negative.result)).not.toContain("gate-secret");
  });

  it("withholds JSON artifacts from socket reads, replay and live events", async () => {
    h = await harness();
    const seq = await recordJsonArtifact(h, "json-replay");
    const reader = await connect(h.tokens.runsOnly);
    const owner = await connect(h.tokens.owner);
    expect((await reader.call("runs.get", { runId: h.runs.alice })).result).toMatchObject({ artifacts: [] });
    expect((await reader.call("runs.events", { runId: h.runs.alice, after: seq - 1 })).result).toMatchObject({
      events: [],
    });
    for (const c of [reader, owner])
      await c.call("subscribe", { runId: h.runs.alice, since: seq - 1, methods: ["event.appended"] });
    expect(reader.notifications()).toEqual([]);
    expect(JSON.stringify(owner.notifications())).toContain("json-replay");
    await recordJsonArtifact(h, "json-live");
    await h.append(scheduled(h.runs.alice, "after-artifact"));
    for (const c of [reader, owner]) await c.waitFor((f) => JSON.stringify(f).includes("after-artifact"));
    expect(JSON.stringify(reader.frames)).not.toContain("json-replay");
    expect(JSON.stringify(reader.frames)).not.toContain("json-live");
    expect(JSON.stringify(reader.frames)).not.toContain("private-json-value");
    expect(JSON.stringify(owner.notifications())).toContain("json-live");
  });

  it("scopes a subscription id to its connection", async () => {
    h = await harness();
    const first = await connect(h.tokens.alice);
    const second = await connect(h.tokens.alice);
    const bob = await connect(h.tokens.bob);
    const { subscriptionId } = (await first.call("subscribe", { runId: h.runs.alice })).result as {
      subscriptionId: string;
    };
    expect((await second.call("unsubscribe", { subscriptionId })).result).toEqual({ stopped: false });
    expect((await bob.call("unsubscribe", { subscriptionId })).result).toEqual({ stopped: false });
    await h.append(scheduled(h.runs.alice, "sr-still"));
    await first.waitFor((f) => f.params?.stepRunId === "sr-still");
  });
});

describe("recovery events (#357)", () => {
  it("withholds a checkpoint attempt's reused artifacts from a reader without artifacts.read", async () => {
    h = await harness();
    const attempt = "run_checkpoint_attempt";
    const at = h.clock.isoNow();
    h.ownership.record(attempt, "alice");
    const reader = await connect(h.tokens.runsOnly);
    const owner = await connect(h.tokens.owner);
    // Live from before the attempt exists, so its seed (seq 0) arrives as a frame.
    for (const c of [reader, owner]) await c.call("subscribe", { methods: ["event.appended"] });
    await h.append({
      type: "run.created",
      runId: attempt,
      payload: {
        actor: { principalId: "alice" },
        workflowId: "gated",
        workflowVersion: "1",
        workspace: { kind: "local", path: "/tmp" },
        vars: {},
        checkpoint: {
          runId: h.runs.alice,
          stepRunId: "source-step",
          steps: [
            {
              stepRunId: "reused-step",
              from: { runId: h.runs.alice, stepRunId: "source-step" },
              nodeId: "s",
              nodeType: "start",
              attempt: 1,
              result: { artifactIds: ["ckpt-secret-artifact"], data: {} },
              children: [],
              completedAt: at,
            },
          ],
          artifacts: [
            {
              id: "ckpt-secret-artifact",
              kind: "spec",
              name: "spec",
              path: "/tmp/ckpt.md",
              mediaType: "text/markdown",
              contentHash: "0".repeat(64),
              size: 1,
              version: 1,
              producedBy: { runId: h.runs.alice, stepRunId: "source-step" },
              parents: [],
              data: {},
              createdAt: at,
            },
          ],
          vars: {},
        },
      },
    });
    const page = await reader.call("runs.events", { runId: attempt });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    expect(JSON.stringify(page.result)).not.toContain("ckpt-secret-artifact");
    expect(JSON.stringify((await reader.call("runs.get", { runId: attempt })).result)).not.toContain(
      "ckpt-secret-artifact",
    );
    await h.append(scheduled(attempt, "after-seed"));
    for (const c of [reader, owner]) await c.waitFor((f) => JSON.stringify(f).includes("after-seed"));
    // The seed reached both; only the artifact reader sees what it reuses.
    expect(JSON.stringify(reader.frames)).toContain("reused-step");
    expect(JSON.stringify(reader.frames)).not.toContain("ckpt-secret-artifact");
    expect(JSON.stringify(owner.frames)).toContain("ckpt-secret-artifact");
  });

  it("sends a review event only to a client that reads protocol 2.5 events", async () => {
    h = await harness();
    // What a 2.0-2.4 client (the released v0.7.0 app) parses: the event union without the review.
    const legacyEvent = z.discriminatedUnion(
      "type",
      OrcaEventSchema.options.filter((o) => o.shape.type.value !== "step.effect.reviewed") as never,
    );
    const legacyPage = RunsEventsResultSchema.extend({ events: z.array(legacyEvent) });
    const review = await h.append({
      type: "step.effect.reviewed",
      runId: h.runs.alice,
      payload: { stepRunId: "made-up", decision: "run-again" },
    });
    const legacy = await connect(h.tokens.alice);
    const current = await connect(h.tokens.alice);

    // History: withheld by default, cursors intact; present when the client reads 2.5.
    const old = await legacy.call("runs.events", { runId: h.runs.alice, after: review - 1 });
    expect(legacyPage.parse(old.result).events).toEqual([]);
    expect(old.result).toMatchObject({ lastSeq: review });
    const now = RunsEventsResultSchema.parse(
      (await current.call("runs.events", { runId: h.runs.alice, after: review - 1, protocol: PROTOCOL_VERSION }))
        .result,
    );
    expect(now.events.map((e) => e.type)).toEqual(["step.effect.reviewed"]);

    // Frames: the legacy stream skips it and carries on; the current one receives it.
    await legacy.call("subscribe", { runId: h.runs.alice, since: review - 1, methods: ["event.appended"] });
    await current.call("subscribe", {
      runId: h.runs.alice,
      since: review - 1,
      methods: ["event.appended"],
      protocol: PROTOCOL_VERSION,
    });
    await h.append(scheduled(h.runs.alice, "after-review"));
    for (const c of [legacy, current]) await c.waitFor((f) => JSON.stringify(f).includes("after-review"));
    for (const f of legacy.notifications("event.appended")) legacyEvent.parse(f.params!.event);
    expect(JSON.stringify(legacy.frames)).not.toContain("step.effect.reviewed");
    expect(JSON.stringify(current.frames)).toContain("step.effect.reviewed");
  });
});

describe("credential lifetime on an open connection", () => {
  it("closes the connection on revocation, before delivering anything else", async () => {
    h = await harness();
    const alice = await connect(h.tokens.alice);
    expect((await alice.call("subscribe", { runId: h.runs.alice })).ok).toBe(true);
    await h.credentials.revoke(h.ids.alice);
    await h.append(scheduled(h.runs.alice, "sr-after"));
    expect(await alice.closed).toBe(4401);
    expect(alice.notifications()).toEqual([]);
    const closed = h.audit.records.find((r) => r.event === "connection.closed");
    expect(closed).toMatchObject({ actor: { principal: "alice" }, reason: "revoked" });
    // Reconnecting with the old token is refused; a rotated one re-establishes authority and
    // can resume from a cursor.
    expect((await refusal(h.daemon.socketUrl!, { token: h.tokens.alice })).status).toBe(401);
  });

  it("closes an idle connection when its credential expires", async () => {
    let now = Date.parse("2026-10-01T00:00:00Z");
    const credentials = new CredentialStore({ now: () => new Date(now) });
    h = await harness({ credentials, revalidateMs: 10 });
    const brief = await credentials.issue({ principal: "alice", preset: "client", ttlMs: 60_000 });
    const c = await connect(brief.token);
    expect((await c.call("runs.list")).ok).toBe(true);
    now += 120_000;
    expect(await c.closed).toBe(4401);
  });

  it("re-establishes current authority on reconnect, not the old connection's", async () => {
    h = await harness();
    const rotated = await h.credentials.rotate(h.ids.alice);
    expect((await refusal(h.daemon.socketUrl!, { token: h.tokens.alice })).status).toBe(401);
    const again = await connect(rotated.token);
    // Same principal, so the same runs: ownership belongs to the principal, not the credential.
    const subscribed = await again.call("subscribe", { runId: h.runs.alice, since: 0 });
    expect((subscribed.result as { replayed: number }).replayed).toBeGreaterThan(0);
    expect((await again.call("runs.get", { runId: h.runs.bob })).ok).toBe(false);
  });
});
