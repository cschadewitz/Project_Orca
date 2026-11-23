/**
 * #701 HTTPS judge sender. A local plain-HTTP server stands in for the provider, reached through an injected request
 * function, so the sender's own request, response bounds, cancellation and failure codes run for real. The key is
 * generated per test; no network beyond loopback, real key, model or paid call is used.
 */
import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovedJudgePayloadV1, HostSpec, JudgeRequestV1 } from "@orca/core";
import { LOCAL_ADVICE_SCHEMA, LOCAL_EVIDENCE_SCHEMA } from "../src/review-judge/adapter.js";
import {
  ENDPOINT_FRAME_FIELDS,
  prepareJudgeConnection,
  REQUIRED_SENDER_CAPABILITIES,
  type JudgeDisclosureQuery,
} from "../src/review-judge/connection.js";
import { createEndpointReviewJudge, ENDPOINT_RESPONSE_SCHEMA } from "../src/review-judge/endpoint.js";
import {
  createHttpsJudgeSender,
  HTTPS_JUDGE_SENDER_VERSION,
  JudgeSenderFailed,
  type HttpsJudgeSenderOptions,
  type HttpsRequestFn,
} from "../src/review-judge/https-sender.js";
import {
  JUDGE_SECRET_CREDENTIAL_KIND,
  judgeSecretRef,
  secretJudgeCredentials,
} from "../src/review-judge/secret-credentials.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let destination: string;
let seen: Seen[];
let closed: number;
let handler: (req: IncomingMessage, res: ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  closed = 0;
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
    res.on("close", () => closed++);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  destination = `https://127.0.0.1:${(server.address() as AddressInfo).port}/v1/judge`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Plain HTTP to the loopback fake: the sender's options are passed through unchanged. */
const loopback: HttpsRequestFn = (options) => httpRequest(options);

const key = () => `sk-test-${randomUUID()}`;
const lease = (value: string, pinned = destination) => ({
  kind: JUDGE_SECRET_CREDENTIAL_KIND,
  destination: pinned,
  reveal: () => value,
});

function sender(over: Partial<HttpsJudgeSenderOptions> = {}) {
  const made = createHttpsJudgeSender({
    destination,
    auth: { scheme: "bearer" },
    headers: { "provider-version": "2026-01-01" },
    request: loopback,
    ...over,
  });
  if (made.status !== "ready") throw new Error(`sender invalid: ${made.reason}`);
  return made.sender;
}

const signal = () => new AbortController().signal;

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JudgeSenderFailed);
    return (error as JudgeSenderFailed).code;
  }
  throw new Error("expected a failure");
}

describe("#701 HTTPS judge sender: one bounded POST", () => {
  it("posts the frame once to the fixed path with the key only in the auth header", async () => {
    const value = key();
    const s = sender();
    const frame = JSON.stringify({ schema: "x", requestId: "r1" });
    expect(await s.send({ frame, credential: lease(value), signal: signal(), maxResponseBytes: 1024 })).toBe(
      '{"ok":true}',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/judge", body: frame });
    expect(seen[0]!.headers).toMatchObject({
      authorization: `Bearer ${value}`,
      "content-type": "application/json",
      "accept-encoding": "identity",
      "provider-version": "2026-01-01",
      "content-length": String(Buffer.byteLength(frame)),
    });
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(s.capabilities).toEqual(expect.arrayContaining([...REQUIRED_SENDER_CAPABILITIES]));
    expect(s.destination).toBe(destination);
    expect(s.version.startsWith(`${HTTPS_JUDGE_SENDER_VERSION}:sha256:`)).toBe(true);
    expect(s.version).not.toContain(value);
  });

  it("places the key in x-api-key when configured, and the version follows the placement and path", async () => {
    const value = key();
    const s = sender({ auth: { header: "x-api-key" } });
    await s.send({ frame: "{}", credential: lease(value), signal: signal(), maxResponseBytes: 1024 });
    expect(seen[0]!.headers["x-api-key"]).toBe(value);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(s.version).not.toBe(sender().version);
    expect(sender({ destination: destination.replace("/v1/", "/v2/") }).version).not.toBe(sender().version);
  });
});

describe("#701 HTTPS judge sender: no redirects, no retries, bounded replies", () => {
  const respond =
    (status: number, headers: Record<string, string>, body: string | Buffer = '{"ok":true}') =>
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(status, headers);
      res.end(body);
    };

  it.each([
    [
      "a redirect",
      respond(302, { location: "https://elsewhere.invalid/", "content-type": "application/json" }),
      "http-status",
    ],
    ["a server error", respond(500, { "content-type": "application/json" }), "http-status"],
    ["an auth error", respond(401, { "content-type": "application/json" }), "http-status"],
    ["html", respond(200, { "content-type": "text/html" }), "content-type"],
    ["no content type", respond(200, {}), "content-type"],
    ["gzip", respond(200, { "content-type": "application/json", "content-encoding": "gzip" }), "content-encoding"],
    [
      "invalid UTF-8",
      respond(200, { "content-type": "application/json" }, Buffer.from([0x7b, 0xff, 0x7d])),
      "malformed-utf8",
    ],
    [
      "a declared oversize body",
      respond(200, { "content-type": "application/json", "content-length": "5000" }, "x".repeat(5000)),
      "response-too-large",
    ],
  ])("refuses %s with a fixed code after exactly one request", async (_name, h, code) => {
    handler = h;
    expect(
      await failure(sender().send({ frame: "{}", credential: lease(key()), signal: signal(), maxResponseBytes: 1024 })),
    ).toBe(code);
    expect(seen).toHaveLength(1);
  });

  it("cuts off a streamed body past the bound", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const tick = setInterval(() => res.write("x".repeat(512)), 1);
      res.on("close", () => clearInterval(tick));
    };
    expect(
      await failure(sender().send({ frame: "{}", credential: lease(key()), signal: signal(), maxResponseBytes: 2048 })),
    ).toBe("response-too-large");
  });

  it("never carries the provider's body, headers or the key into the failure", async () => {
    const value = key();
    handler = (req, res) => {
      res.writeHead(401, { "content-type": "application/json", "x-echo": String(req.headers.authorization) });
      res.end(JSON.stringify({ error: `bad key ${String(req.headers.authorization)}` }));
    };
    try {
      await sender().send({ frame: "{}", credential: lease(value), signal: signal(), maxResponseBytes: 1024 });
      throw new Error("expected a failure");
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
      expect(text).not.toContain(value);
      expect(text).not.toContain("bad key");
    }
  });
});

describe("#701 HTTPS judge sender: cancellation", () => {
  it("settles at once on abort and destroys the request, even when the server never answers", async () => {
    handler = () => undefined; // hang
    const controller = new AbortController();
    const pending = sender().send({
      frame: "{}",
      credential: lease(key()),
      signal: controller.signal,
      maxResponseBytes: 1024,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
    controller.abort();
    expect(await failure(pending)).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(1);
  });

  it("sends nothing when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await failure(
        sender().send({ frame: "{}", credential: lease(key()), signal: controller.signal, maxResponseBytes: 1024 }),
      ),
    ).toBe("cancelled");
    expect(seen).toHaveLength(0);
  });

  it("is a network failure when the server closes mid-body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
      res.write('{"partial":');
      setTimeout(() => res.destroy(), 5);
    };
    expect(
      await failure(sender().send({ frame: "{}", credential: lease(key()), signal: signal(), maxResponseBytes: 1024 })),
    ).toBe("network");
  });
});

describe("#701 HTTPS judge sender: the credential", () => {
  it.each([
    ["another destination", () => lease(key(), "https://other.example"), "credential-mismatch"],
    ["another kind", () => ({ ...lease(key()), kind: "other/v1" }), "credential-mismatch"],
    ["no reveal", () => ({ kind: JUDGE_SECRET_CREDENTIAL_KIND, destination }), "credential-mismatch"],
    ["null", () => null, "credential-mismatch"],
    [
      "an ended lease",
      () => ({
        ...lease(""),
        reveal: () => {
          throw new Error("ended");
        },
      }),
      "credential-invalid",
    ],
    ["an empty value", () => lease(""), "credential-invalid"],
    ["a value with a line break", () => lease("sk-a\r\nx-injected: 1"), "credential-invalid"],
    ["a value with a space", () => lease("sk a"), "credential-invalid"],
    ["a non-ASCII value", () => lease("sk-é"), "credential-invalid"],
  ])("refuses %s without sending anything", async (_name, make, code) => {
    expect(
      await failure(
        sender().send({ frame: "{}", credential: make() as object, signal: signal(), maxResponseBytes: 1024 }),
      ),
    ).toBe(code);
    expect(seen).toHaveLength(0);
  });
});

describe("#701 HTTPS judge sender: configuration is checked before any key is touched", () => {
  it.each([
    ["plain http", { destination: "http://judge.example/v1" }, "destination"],
    ["userinfo", { destination: "https://u:p@judge.example/v1" }, "destination"],
    ["a query", { destination: "https://judge.example/v1?x=1" }, "destination"],
    ["an empty query", { destination: "https://judge.example/v1?" }, "destination"],
    ["a fragment", { destination: "https://judge.example/v1#x" }, "destination"],
    ["a dot-dot path", { destination: "https://judge.example/v1/../admin" }, "destination"],
    ["an encoded path", { destination: "https://judge.example/v1/%2e%2e/admin" }, "destination"],
    ["a non-canonical host", { destination: "https://JUDGE.example/v1" }, "destination"],
    ["an explicit default port", { destination: "https://judge.example:443/v1" }, "destination"],
    ["not a URL", { destination: "judge.example" }, "destination"],
    ["an unknown auth", { auth: { scheme: "basic" } as never }, "auth"],
    ["two auth placements", { auth: { scheme: "bearer", header: "x-api-key" } as never }, "auth"],
    ["an auth header as an extra", { headers: { authorization: "Bearer x" } }, "headers"],
    ["a framing header as an extra", { headers: { "content-length": "1" } }, "headers"],
    ["a header value with a line break", { headers: { "provider-version": "1\r\nx: y" } }, "headers"],
    ["an upper-case header name", { headers: { "Provider-Version": "1" } }, "headers"],
  ])("refuses %s", (_name, over, reason) => {
    expect(
      createHttpsJudgeSender({
        destination: "https://judge.example/v1/judge",
        auth: { scheme: "bearer" },
        ...over,
      }),
    ).toEqual({ status: "invalid", reason });
  });

  it.each([
    "https://judge.example",
    "https://judge.example/",
    "https://judge.example/v1/messages",
    "https://judge.example:8443/v1",
  ])("accepts %s", (destination) => {
    expect(createHttpsJudgeSender({ destination, auth: { scheme: "bearer" } }).status).toBe("ready");
  });
});

describe("#701 HTTPS judge sender: end to end with a pinned #336 secret", () => {
  it("judges through the connection with the key read at use and sent only in the auth header", async () => {
    const name = `ORCA_TEST_JUDGE_KEY_${randomUUID().replace(/-/g, "_").toUpperCase()}`;
    const value = key();
    process.env[name] = value;
    try {
      handler = (req, res) => {
        const sent = JSON.parse(seen.at(-1)!.body) as Record<string, string>;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            schema: ENDPOINT_RESPONSE_SCHEMA,
            requestId: sent.requestId,
            model: sent.model,
            adviceSchema: LOCAL_ADVICE_SCHEMA,
            recommendation: req.headers.authorization === `Bearer ${value}` ? "allow" : "deny",
            rationaleCode: "fixture-match",
            uncertainty: false,
          }),
        );
      };
      const credentials = secretJudgeCredentials({
        secrets: () => ({ "judge-key": { host: "local", provider: "env", name, destination } }),
        host: { id: "local", spec: { type: "local" } as HostSpec },
        authorize: async () => undefined,
        authorizedNow: () => true,
        agentId: "agent-a",
      });
      const connection = await prepareJudgeConnection(
        {
          methodVersion: "fake-endpoint-method/v1",
          modelVersion: "fake-model/v1",
          promptVersion: "fake-prompt/v1",
          configVersion: "fake-config/v1",
          destination,
          destinationPolicyRef: "disclosure:fake/v1",
          projectionPolicyRevision: "projection/v1",
          credentialRef: judgeSecretRef("judge-key"),
          limits: {
            maxPending: 1,
            maxCalls: 5,
            maxRequestBytes: 2048,
            maxResponseBytes: 1024,
            maxTimeoutMs: 2000,
            maxCostUnitsPerCall: 1,
            maxTotalCostUnits: 5,
          },
        },
        {
          grants: {
            find: async (query: JudgeDisclosureQuery) => ({
              ...query,
              grantRef: "grant:1",
              revision: "r1",
              fields: [...ENDPOINT_FRAME_FIELDS],
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
            current: async () => ({ revision: "r1", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
          },
          credentials,
          sender: sender(),
        },
        new AbortController().signal,
      );
      if (connection.status !== "prepared") throw new Error(connection.reason);
      const judge = createEndpointReviewJudge({
        manifest: connection.manifest,
        transport: connection.transport,
        limits: connection.limits,
      });
      const req: JudgeRequestV1 = {
        version: 1,
        reviewId: "review:1",
        actionBindingRef: "action:1",
        authority: {
          capturedGeneration: "g1",
          currentPolicyRevision: "p1",
          authorityRevision: "a1",
          revocationEpoch: "r1",
          leaseEpoch: "l1",
        },
        coverageId: "coverage:1",
        delegation: { ruleId: "rule:1", ruleRevision: "rr1" },
        requirement: "required",
        projectionPolicyRevision: "projection/v1",
        destinationPolicyRef: "disclosure:fake/v1",
        judgeConfigRef: connection.configRef,
        deadlineAt: new Date(Date.now() + 5000).toISOString(),
        approvedProjection: {
          kind: "parsed-json",
          codecVersion: LOCAL_EVIDENCE_SCHEMA,
          privateRef: "protected:x",
          bindingRef: "projection:1",
        },
      };
      const payload: ApprovedJudgePayloadV1 = {
        version: 1,
        bindingRef: "projection:1",
        schemaVersion: LOCAL_EVIDENCE_SCHEMA,
        content: JSON.stringify({
          schema: LOCAL_EVIDENCE_SCHEMA,
          applicability: "matches",
          context: "complete",
          injection: "absent",
        }),
      };
      const result = await judge.assess(req, payload, new AbortController().signal);
      expect(result).toMatchObject({ execution: "evaluated", result: "fit" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).not.toContain(value);
      expect(JSON.stringify([result, connection.refusals()])).not.toContain(value);
    } finally {
      delete process.env[name];
    }
  });
});
