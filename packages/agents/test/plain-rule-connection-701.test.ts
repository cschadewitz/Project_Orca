/**
 * #701 assembling a plain-rule judge from configuration: provider, HTTPS sender and the person's own key through the
 * #336 secret lease. A loopback HTTP server stands in for the provider (reached through an injected request
 * function); the key is generated per test in an env variable. No real key, model, network beyond loopback or paid
 * call is used, and nothing is wired into a live permission path.
 */
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostSpec } from "@orca/core";
import type { HttpsRequestFn } from "../src/review-judge/https-sender.js";
import {
  preparePlainRuleJudge,
  type PlainRuleDisclosureQuery,
  type PlainRuleDisclosureService,
} from "../src/review-judge/plain-rule-connection.js";
import { PLAIN_RULE_VERDICT_SCHEMA, type PlainRuleJudgeInput } from "../src/review-judge/plain-rule.js";
import { ANTHROPIC_API_VERSION } from "../src/review-judge/plain-rule-providers.js";
import { secretJudgeCredentials } from "../src/review-judge/secret-credentials.js";

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

let server: Server;
let destination: string;
let seen: Seen[];
let verdict: "covered" | "not-covered";
let envName: string;
let keyValue: string;

const loopback: HttpsRequestFn = (options) => httpRequest(options);
const signal = () => new AbortController().signal;

beforeEach(async () => {
  seen = [];
  verdict = "covered";
  envName = `ORCA_TEST_JUDGE_KEY_${randomUUID().replace(/-/g, "")}`;
  keyValue = `sk-test-${randomUUID()}`;
  process.env[envName] = keyValue;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      const messages = body.messages as { role: string; content: string }[] | undefined;
      const userText = messages?.find((m) => m.role === "user")?.content ?? "{}";
      const frame = JSON.parse(userText) as { requestId: string; rules: { id: string; revision: string }[] };
      const text = JSON.stringify({
        schema: PLAIN_RULE_VERDICT_SCHEMA,
        requestId: frame.requestId,
        verdicts: frame.rules.map((r) => ({
          ruleId: r.id,
          ruleRevision: r.revision,
          verdict,
          reasonCode: verdict === "covered" ? "matches-criterion" : "outside-criterion",
        })),
      });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.headers["x-api-key"] !== undefined) {
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: text, refusal: null } },
            ],
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  destination = `https://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
});

afterEach(async () => {
  delete process.env[envName];
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const input: PlainRuleJudgeInput = {
  rules: [{ ruleId: "pr_docs", ruleRevision: "r1", criterion: "Reading docs." }],
  restrictions: { deny: false, ask: false },
  action: { kind: "read", title: "Read docs/a.md", locations: ["docs/a.md"], inWorkspace: true, targetsVerified: true },
};

function credentials(over: { pinned?: string; authorizedNow?: () => boolean } = {}) {
  return secretJudgeCredentials({
    secrets: () => ({
      "judge-key": { host: "local", provider: "env", name: envName, destination: over.pinned ?? destination },
    }),
    host: { id: "local", spec: { type: "local" } as HostSpec },
    authorize: async () => undefined,
    authorizedNow: over.authorizedNow ?? (() => true),
    agentId: "agent-a",
  });
}

function disclosure(
  over: Partial<PlainRuleDisclosureService> & { revision?: () => string; revisionNow?: () => string } = {},
) {
  const queries: PlainRuleDisclosureQuery[] = [];
  let checks = 0;
  let nowChecks = 0;
  const service: PlainRuleDisclosureService = {
    find:
      over.find ??
      (async (query) => {
        queries.push(query);
        return { ...query, grantRef: "grant-1", revision: "g1", expiresAt: "2999-01-01T00:00:00Z" };
      }),
    current:
      over.current ??
      (async () => {
        checks++;
        return { revision: over.revision?.() ?? "g1", expiresAt: "2999-01-01T00:00:00Z" };
      }),
    currentNow:
      over.currentNow ??
      (() => {
        nowChecks++;
        return { revision: over.revisionNow?.() ?? over.revision?.() ?? "g1", expiresAt: "2999-01-01T00:00:00Z" };
      }),
  };
  return { service, queries, checks: () => checks, nowChecks: () => nowChecks };
}

const config = (over: Record<string, unknown> = {}) => ({
  provider: { kind: "anthropic" },
  destination,
  credential: "judge-key",
  ...over,
});

async function prepared(over: Record<string, unknown> = {}, services: Record<string, unknown> = {}) {
  const made = await preparePlainRuleJudge(
    config(over),
    { credentials: credentials(), disclosure: disclosure().service, request: loopback, ...services },
    signal(),
  );
  if (made.status !== "prepared") throw new Error(`unavailable: ${made.reason}`);
  return made;
}

describe("#701 plain-rule judge from config", () => {
  it("Anthropic: the key goes in x-api-key with the API version, only to the pinned destination, and the rule allows", async () => {
    const made = await prepared();
    expect(made.provider).toMatchObject({ kind: "anthropic", model: "claude-haiku-5-5" });
    const outcome = await made.judge(input, signal());
    expect(outcome).toMatchObject({ outcome: "allow", ruleId: "pr_docs", judgeConfigRef: made.judgeConfigRef });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe(keyValue);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["anthropic-version"]).toBe(ANTHROPIC_API_VERSION);
    expect(seen[0]!.body.model).toBe("claude-haiku-5-5");
    // The key never appears in the body or the config ref.
    expect(JSON.stringify(seen[0]!.body)).not.toContain(keyValue);
    expect(made.judgeConfigRef).not.toContain(keyValue);
  });

  it("OpenAI-compatible: the key goes in a bearer header and the configured model is used", async () => {
    const made = await prepared({ provider: { kind: "openai-compatible", model: "small-model" } });
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "allow" });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${keyValue}`);
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.body).toMatchObject({ model: "small-model", n: 1 });
  });

  it("a not-covered answer is no-match", async () => {
    verdict = "not-covered";
    const made = await prepared();
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "no-match" });
  });

  it("asks the disclosure grant for exactly this destination, provider and wire format, and rechecks it every send", async () => {
    const d = disclosure();
    const made = await prepared({}, { disclosure: d.service });
    expect(d.queries).toEqual([
      {
        purpose: "review-judge",
        destination,
        providerVersion: expect.stringMatching(/^plain-rule-provider\/v1:sha256:/) as unknown,
        requestSchema: "orca-plain-rule-request/v1",
      },
    ]);
    await made.judge(input, signal());
    await made.judge(input, signal());
    expect(d.checks()).toBe(2);
  });

  it("a grant revoked or changed after preparation stops the send", async () => {
    let revision = "g1";
    const d = disclosure({ revision: () => revision });
    const made = await prepared({}, { disclosure: d.service });
    revision = "g2";
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "no-match", verdict: "unavailable" });
    const gone = disclosure({ current: async () => null });
    const made2 = await prepared({}, { disclosure: gone.service });
    expect(await made2.judge(input, signal())).toMatchObject({ verdict: "unavailable" });
    expect(seen).toHaveLength(0);
  });

  it("rechecks the grant synchronously at the dispatch itself, after the awaited recheck", async () => {
    let now = "g1";
    const d = disclosure({ revisionNow: () => now });
    const made = await prepared({}, { disclosure: d.service });
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "allow" });
    expect(d.nowChecks()).toBe(1);
    // The awaited recheck still passes, but the grant changed by the time of the dispatch.
    now = "g2";
    expect(await made.judge(input, signal())).toMatchObject({ verdict: "unavailable" });
    // An expired grant at dispatch, and a dispatch check that throws.
    const expired = disclosure({ currentNow: () => ({ revision: "g1", expiresAt: "2000-01-01T00:00:00Z" }) });
    const made2 = await prepared({}, { disclosure: expired.service });
    expect(await made2.judge(input, signal())).toMatchObject({ verdict: "unavailable" });
    const throwing = disclosure({
      currentNow: () => {
        throw new Error("store");
      },
    });
    const made3 = await prepared({}, { disclosure: throwing.service });
    expect(await made3.judge(input, signal())).toMatchObject({ verdict: "unavailable" });
    expect(seen).toHaveLength(1);
  });

  it("a call cancelled during the awaited recheck is not sent", async () => {
    const controller = new AbortController();
    const d = disclosure({
      current: async () => {
        controller.abort();
        return { revision: "g1", expiresAt: "2999-01-01T00:00:00Z" };
      },
    });
    const made = await prepared({}, { disclosure: d.service });
    await made.judge(input, controller.signal);
    expect(seen).toHaveLength(0);
  });

  it("uses exactly the provider approved for disclosure: later changes to the config change nothing", async () => {
    const cfg = { provider: { kind: "anthropic", model: "claude-haiku-5-5" }, destination, credential: "judge-key" };
    const d = disclosure();
    const made = await preparePlainRuleJudge(
      cfg,
      { credentials: credentials(), disclosure: d.service, request: loopback },
      signal(),
    );
    if (made.status !== "prepared") throw new Error(made.reason);
    cfg.provider.kind = "openai-compatible";
    cfg.provider.model = "other-model";
    expect(Object.isFrozen(made.provider)).toBe(true);
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "allow" });
    expect(seen[0]!.headers["x-api-key"]).toBe(keyValue);
    expect(seen[0]!.body.model).toBe("claude-haiku-5-5");
    // A config read through a getter is read once.
    let reads = 0;
    const tricky = {
      get provider() {
        reads++;
        return reads === 1 ? { kind: "anthropic" } : { kind: "openai-compatible", model: "x" };
      },
      destination,
      credential: "judge-key",
    };
    const made2 = await preparePlainRuleJudge(
      tricky,
      { credentials: credentials(), disclosure: disclosure().service, request: loopback },
      signal(),
    );
    expect(made2).toMatchObject({ status: "prepared", provider: { kind: "anthropic" } });
    expect(reads).toBe(1);
  });

  it("a key use revoked at the hand-off stops the send", async () => {
    let allowed = true;
    const made = await prepared({}, { credentials: credentials({ authorizedNow: () => allowed }) });
    allowed = false;
    expect(await made.judge(input, signal())).toMatchObject({ verdict: "unavailable" });
    expect(seen).toHaveLength(0);
  });

  it("enforces the daily budget per UTC day, reserved per call and never refunded", async () => {
    let now = Date.parse("2026-11-23T10:00:00Z");
    const made = await prepared({ limits: { maxCallsPerDay: 2 } }, { now: () => now });
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "allow" });
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "allow" });
    expect(await made.judge(input, signal())).toMatchObject({ verdict: "unavailable" });
    expect(seen).toHaveLength(2);
    now = Date.parse("2026-11-24T00:00:01Z");
    expect(await made.judge(input, signal())).toMatchObject({ outcome: "allow" });
    expect(seen).toHaveLength(3);
  });

  it("defaults to 5 s per call and 200 calls per day; changing a limit changes the config ref", async () => {
    const a = await prepared();
    const b = await prepared({ limits: { timeoutMs: 5000, maxCallsPerDay: 200 } });
    const c = await prepared({ limits: { maxCallsPerDay: 10 } });
    const d = await prepared({ limits: { timeoutMs: 2000 } });
    expect(a.judgeConfigRef).toBe(b.judgeConfigRef);
    expect(new Set([a.judgeConfigRef, c.judgeConfigRef, d.judgeConfigRef]).size).toBe(3);
  });

  it("never asks the judge about what it could not allow, so no key is leased", async () => {
    const made = await prepared();
    expect(await made.judge({ ...input, action: { ...input.action, kind: "execute" } }, signal())).toMatchObject({
      verdict: "outside-envelope",
    });
    expect(await made.judge({ ...input, restrictions: { deny: true, ask: false } }, signal())).toMatchObject({
      verdict: "hard-boundary",
    });
    expect(seen).toHaveLength(0);
  });
});

describe("#701 plain-rule judge from config: fail-closed preparation", () => {
  const unavailable = async (cfg: unknown, services: Record<string, unknown> = {}, s = signal()) =>
    preparePlainRuleJudge(
      cfg,
      { credentials: credentials(), disclosure: disclosure().service, request: loopback, ...services },
      s,
    );

  it.each([
    ["no config", undefined],
    ["not an object", "judge"],
    ["no destination", { provider: { kind: "anthropic" }, credential: "judge-key" }],
    ["no credential", { provider: { kind: "anthropic" }, destination: "https://x.example/v1" }],
    ["odd credential id", { provider: { kind: "anthropic" }, destination: "https://x.example/v1", credential: "a b" }],
    [
      "unknown key",
      { provider: { kind: "anthropic" }, destination: "https://x.example/v1", credential: "k", extra: 1 },
    ],
    [
      "unknown limit",
      { provider: { kind: "anthropic" }, destination: "https://x.example/v1", credential: "k", limits: { cache: 1 } },
    ],
    [
      "zero budget",
      {
        provider: { kind: "anthropic" },
        destination: "https://x.example/v1",
        credential: "k",
        limits: { maxCallsPerDay: 0 },
      },
    ],
    [
      "huge timeout",
      {
        provider: { kind: "anthropic" },
        destination: "https://x.example/v1",
        credential: "k",
        limits: { timeoutMs: 600_000 },
      },
    ],
  ])("refuses %s", async (_name, cfg) => {
    expect(await unavailable(cfg)).toEqual({ status: "unavailable", reason: "incomplete-config" });
  });

  it("refuses a bad provider or destination", async () => {
    expect(await unavailable(config({ provider: { kind: "other" } }))).toMatchObject({ reason: "provider-invalid" });
    expect(await unavailable(config({ provider: { kind: "openai-compatible" } }))).toMatchObject({
      reason: "provider-invalid",
    });
    expect(await unavailable(config({ destination: "http://127.0.0.1/v1" }))).toMatchObject({
      reason: "destination-invalid",
    });
    expect(await unavailable(config({ destination: "https://user:pw@x.example/v1" }))).toMatchObject({
      reason: "destination-invalid",
    });
  });

  it("refuses a key that is missing, pinned elsewhere or unusable, without reading it", async () => {
    expect(await unavailable(config({ credential: "nope" }))).toMatchObject({ reason: "credential-binding-missing" });
    expect(
      await unavailable(config(), { credentials: credentials({ pinned: "https://other.example/v1/messages" }) }),
    ).toMatchObject({ reason: "credential-destination-mismatch" });
    const throwing = { describe: async () => Promise.reject(new Error("x")), withCredential: async () => "" };
    expect(await unavailable(config(), { credentials: throwing })).toMatchObject({ reason: "credential-unavailable" });
    expect(seen).toHaveLength(0);
  });

  it("refuses a missing, mismatched, expired or failing disclosure grant", async () => {
    const grant = (patch: Record<string, unknown>) =>
      disclosure({
        find: async (query) => ({
          ...query,
          grantRef: "grant-1",
          revision: "g1",
          expiresAt: "2999-01-01T00:00:00Z",
          ...patch,
        }),
      }).service;
    expect(await unavailable(config(), { disclosure: disclosure({ find: async () => null }).service })).toMatchObject({
      reason: "disclosure-grant-missing",
    });
    for (const patch of [
      { destination: "https://other.example/v1" },
      { providerVersion: "other" },
      { requestSchema: "other" },
      { purpose: "agent" },
      { grantRef: "" },
      { revision: "" },
    ]) {
      expect(await unavailable(config(), { disclosure: grant(patch) })).toMatchObject({
        reason: "disclosure-grant-mismatch",
      });
    }
    expect(await unavailable(config(), { disclosure: grant({ expiresAt: "2000-01-01T00:00:00Z" }) })).toMatchObject({
      reason: "disclosure-grant-expired",
    });
    expect(
      await unavailable(config(), {
        disclosure: disclosure({ find: async () => Promise.reject(new Error()) }).service,
      }),
    ).toMatchObject({ reason: "disclosure-unavailable" });
  });

  it("refuses missing services and a cancelled preparation", async () => {
    expect(await unavailable(config(), { credentials: undefined })).toMatchObject({ reason: "incomplete-config" });
    expect(await unavailable(config(), { disclosure: {} })).toMatchObject({ reason: "incomplete-config" });
    const { currentNow: _omitted, ...withoutDispatchCheck } = disclosure().service;
    expect(await unavailable(config(), { disclosure: withoutDispatchCheck })).toMatchObject({
      reason: "incomplete-config",
    });
    const c = new AbortController();
    c.abort();
    expect(await unavailable(config(), {}, c.signal)).toMatchObject({ reason: "cancelled" });
  });
});
