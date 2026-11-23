/**
 * #701 plain-rule provider adapters (Anthropic Messages, OpenAI-compatible chat completions). Fake providers answer
 * from the request they receive; one run goes through the real HTTPS sender to a loopback fake. No real key, model,
 * network beyond loopback or paid call.
 */
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createHttpsJudgeSender } from "../src/review-judge/https-sender.js";
import {
  createPlainRuleJudge,
  PLAIN_RULE_VERDICT_SCHEMA,
  type PlainRuleJudgeInput,
} from "../src/review-judge/plain-rule.js";
import {
  ANTHROPIC_API_VERSION,
  createPlainRuleProviderTransport,
  DEFAULT_ANTHROPIC_PLAIN_RULE_MODEL,
  PLAIN_RULE_OUTPUT_SCHEMA,
  PLAIN_RULE_SYSTEM_PROMPT,
  PlainRuleProviderFailed,
  plainRuleProviderSenderOptions,
  plainRuleVerdictText,
  plainRuleProviderVersion,
  resolvePlainRuleProvider,
} from "../src/review-judge/plain-rule-providers.js";
import { JUDGE_SECRET_CREDENTIAL_KIND } from "../src/review-judge/secret-credentials.js";

interface Frame {
  requestId: string;
  rules: { id: string; revision: string }[];
}
type Verdict = "covered" | "not-covered" | "unsure";
const CODE: Record<Verdict, string> = {
  covered: "matches-criterion",
  "not-covered": "outside-criterion",
  unsure: "action-ambiguous",
};

const input: PlainRuleJudgeInput = {
  rules: [
    { ruleId: "pr_docs", ruleRevision: "r1", criterion: "Reading docs." },
    { ruleId: "pr_src", ruleRevision: "r2", criterion: "Reading source files." },
  ],
  restrictions: { deny: false, ask: false },
  action: { kind: "read", title: "Read src/a.ts", locations: ["src/a.ts"], inWorkspace: true, targetsVerified: true },
};

/** The model's answer for a frame: the given verdicts, in canonical compact JSON. */
const answerFor = (frame: Frame, verdicts: Verdict[]) =>
  JSON.stringify({
    schema: PLAIN_RULE_VERDICT_SCHEMA,
    requestId: frame.requestId,
    verdicts: frame.rules.map((r, i) => ({
      ruleId: r.id,
      ruleRevision: r.revision,
      verdict: verdicts[i] ?? "not-covered",
      reasonCode: CODE[verdicts[i] ?? "not-covered"],
    })),
  });

const anthropicReply = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  });

const openAiReply = (content: unknown, extra: Record<string, unknown> = {}, message: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "c1",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, refusal: null, ...message } }],
    ...extra,
  });

function judgeWith(config: unknown, reply: (body: Record<string, unknown>, frame: Frame) => string) {
  const bodies: Record<string, unknown>[] = [];
  const made = createPlainRuleProviderTransport({
    config,
    post: async (body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      bodies.push(parsed);
      const messages = parsed.messages as { role: string; content: string }[];
      const frame = JSON.parse(messages.at(-1)!.content) as Frame;
      return reply(parsed, frame);
    },
  });
  if (made.status !== "ready") throw new Error("invalid");
  return { judge: createPlainRuleJudge({ transport: made.transport }), bodies, made };
}

const signal = () => new AbortController().signal;

describe("#701 plain-rule provider: Anthropic", () => {
  it("sends the frame as data under a fixed system prompt with structured output, and allows on covered", async () => {
    const { judge, bodies } = judgeWith({ kind: "anthropic" }, (_b, f) =>
      anthropicReply(answerFor(f, ["not-covered", "covered"])),
    );
    expect(await judge(input, signal())).toMatchObject({ outcome: "allow", ruleId: "pr_src" });
    const body = bodies[0]!;
    expect(body).toMatchObject({
      model: DEFAULT_ANTHROPIC_PLAIN_RULE_MODEL,
      max_tokens: 1024,
      system: PLAIN_RULE_SYSTEM_PROMPT,
      output_config: { effort: "low", format: { type: "json_schema", schema: PLAIN_RULE_OUTPUT_SCHEMA } },
    });
    expect(body.messages).toHaveLength(1);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "output_config", "system"]);
  });

  it("accepts a pretty-printed answer, since only whitespace outside strings is dropped", async () => {
    const { judge } = judgeWith({ kind: "anthropic", model: "claude-haiku-5-5", effort: "medium" }, (_b, f) =>
      anthropicReply(JSON.stringify(JSON.parse(answerFor(f, ["covered"])), null, 2)),
    );
    expect(await judge(input, signal())).toMatchObject({ outcome: "allow", ruleId: "pr_docs" });
  });

  it.each([
    ["a refusal", (f: Frame) => anthropicReply(answerFor(f, ["covered"]), { stop_reason: "refusal" })],
    ["a cut-off", (f: Frame) => anthropicReply(answerFor(f, ["covered"]), { stop_reason: "max_tokens" })],
    ["a tool call", (f: Frame) => anthropicReply(answerFor(f, ["covered"]), { stop_reason: "tool_use" })],
    [
      "two text blocks",
      (f: Frame) =>
        anthropicReply("", {
          content: [
            { type: "text", text: answerFor(f, ["covered"]) },
            { type: "text", text: "also" },
          ],
        }),
    ],
    ["an error body", () => JSON.stringify({ type: "error", error: { type: "overloaded_error" } })],
    ["no role", (f: Frame) => anthropicReply(answerFor(f, ["covered"]), { role: undefined })],
    ["a user role", (f: Frame) => anthropicReply(answerFor(f, ["covered"]), { role: "user" })],
    [
      "a tool_use block beside the text",
      (f: Frame) =>
        anthropicReply("", {
          content: [
            { type: "text", text: answerFor(f, ["covered"]) },
            { type: "tool_use", id: "t", name: "x", input: {} },
          ],
        }),
    ],
    [
      "a server tool block beside the text",
      (f: Frame) =>
        anthropicReply("", {
          content: [
            { type: "server_tool_use", id: "s", name: "web_search", input: {} },
            { type: "text", text: answerFor(f, ["covered"]) },
          ],
        }),
    ],
    [
      "an unknown block type",
      (f: Frame) =>
        anthropicReply("", { content: [{ type: "text", text: answerFor(f, ["covered"]) }, { type: "future" }] }),
    ],
    ["a non-object block", (f: Frame) => anthropicReply("", { content: [answerFor(f, ["covered"])] })],
    ["not JSON at all", () => "<html>"],
    ["prose around the JSON", (f: Frame) => anthropicReply(`Sure! ${answerFor(f, ["covered"])}`)],
    [
      "a duplicate key",
      (f: Frame) => anthropicReply(answerFor(f, ["covered"]).replace(/^\{/, `{"requestId":"other",`)),
    ],
    [
      "an escaped look-alike",
      (f: Frame) => anthropicReply(answerFor(f, ["covered"]).replace("covered", "c\\u006fvered")),
    ],
  ])("never allows on %s", async (_name, make) => {
    const { judge } = judgeWith({ kind: "anthropic" }, (_b, f) => make(f));
    expect(await judge(input, signal())).toMatchObject({ outcome: "no-match" });
  });
});

describe("#701 plain-rule provider: OpenAI-compatible", () => {
  it("sends system and user messages with a strict JSON schema, and allows on covered", async () => {
    const { judge, bodies } = judgeWith({ kind: "openai-compatible", model: "gpt-small", maxTokens: 512 }, (_b, f) =>
      openAiReply(answerFor(f, ["covered"])),
    );
    expect(await judge(input, signal())).toMatchObject({ outcome: "allow", ruleId: "pr_docs" });
    expect(bodies[0]).toMatchObject({
      model: "gpt-small",
      max_completion_tokens: 512,
      n: 1,
      messages: [{ role: "system", content: PLAIN_RULE_SYSTEM_PROMPT }, { role: "user" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "orca_plain_rule_verdict", strict: true, schema: PLAIN_RULE_OUTPUT_SCHEMA },
      },
    });
  });

  it.each([
    ["a refusal", (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { refusal: "no" })],
    [
      "a cut-off",
      (f: Frame) =>
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { role: "assistant", content: answerFor(f, ["covered"]) } }],
        }),
    ],
    ["a tool call", (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { tool_calls: [{ id: "t" }] })],
    ["tool calls as an object", (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { tool_calls: { id: "t" } })],
    ["tool calls as a string", (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { tool_calls: "t" })],
    ["tool calls as false", (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { tool_calls: false })],
    [
      "a legacy function call",
      (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { function_call: { name: "x", arguments: "{}" } }),
    ],
    [
      "a function call as an empty object",
      (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { function_call: {} }),
    ],
    ["no role", (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { role: undefined })],
    ["a tool role", (f: Frame) => openAiReply(answerFor(f, ["covered"]), {}, { role: "tool" })],
    [
      "two choices",
      (f: Frame) =>
        JSON.stringify({
          choices: [0, 1].map(() => ({
            finish_reason: "stop",
            message: { role: "assistant", content: answerFor(f, ["covered"]) },
          })),
        }),
    ],
    ["no content", () => openAiReply(null)],
    ["an error body", () => JSON.stringify({ error: { message: "bad key sk-123" } })],
  ])("never allows on %s", async (_name, make) => {
    const { judge } = judgeWith({ kind: "openai-compatible", model: "gpt-small" }, (_b, f) => make(f));
    expect(await judge(input, signal())).toMatchObject({ outcome: "no-match" });
  });
});

describe("#701 plain-rule provider: wire shapes", () => {
  const frameOf = (body: Record<string, unknown>) =>
    JSON.parse((body.messages as { content: string }[]).at(-1)!.content) as Frame;

  it("sends the exact Anthropic Messages body", async () => {
    const { judge, bodies } = judgeWith({ kind: "anthropic", maxTokens: 256, effort: "medium" }, (_b, f) =>
      anthropicReply(answerFor(f, ["covered"])),
    );
    await judge(input, signal());
    const body = bodies[0]!;
    expect(body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 256,
      system: PLAIN_RULE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(frameOf(body)) }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: PLAIN_RULE_OUTPUT_SCHEMA } },
    });
  });

  it.each([
    [{}, "max_completion_tokens"],
    [{ tokenParam: "max_completion_tokens" }, "max_completion_tokens"],
    [{ tokenParam: "max_tokens" }, "max_tokens"],
  ])("sends the exact chat-completions body with %j", async (extra, field) => {
    const { judge, bodies } = judgeWith(
      { kind: "openai-compatible", model: "gpt-small", maxTokens: 300, ...extra },
      (_b, f) => openAiReply(answerFor(f, ["covered"])),
    );
    await judge(input, signal());
    const body = bodies[0]!;
    expect(body).toEqual({
      model: "gpt-small",
      [field]: 300,
      n: 1,
      messages: [
        { role: "system", content: PLAIN_RULE_SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(frameOf(body)) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "orca_plain_rule_verdict", strict: true, schema: PLAIN_RULE_OUTPUT_SCHEMA },
      },
    });
    expect(Object.keys(body)).not.toContain(field === "max_tokens" ? "max_completion_tokens" : "max_tokens");
  });
});

describe("#701 plain-rule provider: the answer must already be valid JSON", () => {
  it.each([
    ["a literal split by whitespace", '{"a":tr ue}'],
    ["a number split by whitespace", '{"a":1 0}'],
    ["a literal split by a newline", '{"a":nu\nll}'],
    ["a trailing comma", '{"a":1,}'],
    ["two values", '{"a":1} {"b":2}'],
  ])("refuses %s rather than repairing it", (_name, text) => {
    expect(() => plainRuleVerdictText(text)).toThrow(PlainRuleProviderFailed);
    try {
      plainRuleVerdictText(text);
    } catch (error) {
      expect((error as PlainRuleProviderFailed).code).toBe("provider-not-json");
    }
  });

  it("refuses valid JSON that is not canonical, and keeps strings byte for byte", () => {
    expect(() => plainRuleVerdictText('{"a":1,"a":2}')).toThrow(PlainRuleProviderFailed);
    expect(() => plainRuleVerdictText('{"a":"\\u0041"}')).toThrow(PlainRuleProviderFailed);
    expect(plainRuleVerdictText('{ "a" : "x  y" ,\n "b": [1, 2] }')).toBe('{"a":"x  y","b":[1,2]}');
  });

  it("refuses a malformed answer end to end", async () => {
    const { judge } = judgeWith({ kind: "anthropic" }, (_b, f) =>
      anthropicReply(answerFor(f, ["covered"]).replace('"verdicts":[', '"verdicts" [')),
    );
    expect(await judge(input, signal())).toMatchObject({ outcome: "no-match" });
  });
});

describe("#701 plain-rule provider: metadata that means no call", () => {
  it.each([
    ["null tool calls", { tool_calls: null }],
    ["empty tool calls", { tool_calls: [] }],
    ["null function call", { function_call: null }],
  ])("still allows a normal completion with %s", async (_name, message) => {
    const { judge } = judgeWith({ kind: "openai-compatible", model: "gpt-small" }, (_b, f) =>
      openAiReply(answerFor(f, ["covered"]), {}, message),
    );
    expect(await judge(input, signal())).toMatchObject({ outcome: "allow" });
  });

  it("still allows an Anthropic answer with redacted thinking", async () => {
    const { judge } = judgeWith({ kind: "anthropic" }, (_b, f) =>
      anthropicReply("", {
        content: [
          { type: "redacted_thinking", data: "x" },
          { type: "text", text: answerFor(f, ["covered"]) },
        ],
      }),
    );
    expect(await judge(input, signal())).toMatchObject({ outcome: "allow" });
  });
});

describe("#701 plain-rule provider: configuration", () => {
  it.each([
    ["no config", undefined],
    ["an unknown kind", { kind: "gemini", model: "x" }],
    ["an extra field", { kind: "anthropic", baseUrl: "https://x" }],
    ["an OpenAI-compatible config without a model", { kind: "openai-compatible" }],
    ["a model with spaces", { kind: "anthropic", model: "claude haiku" }],
    ["too few tokens", { kind: "anthropic", maxTokens: 10 }],
    ["too many tokens", { kind: "anthropic", maxTokens: 100_000 }],
    ["an unknown effort", { kind: "anthropic", effort: "max" }],
    ["effort on OpenAI-compatible", { kind: "openai-compatible", model: "m", effort: "low" }],
    ["an unknown token field", { kind: "openai-compatible", model: "m", tokenParam: "max_output_tokens" }],
    ["a token field on Anthropic", { kind: "anthropic", tokenParam: "max_tokens" }],
  ])("refuses %s", (_name, config) => {
    expect(resolvePlainRuleProvider(config)).toBeNull();
    expect(createPlainRuleProviderTransport({ config, post: async () => "" }).status).toBe("invalid");
  });

  it("fills defaults, and the version follows every configured field", () => {
    const base = resolvePlainRuleProvider({ kind: "anthropic" })!;
    expect(base).toEqual({ kind: "anthropic", model: "claude-haiku-5-5", maxTokens: 1024, effort: "low" });
    const versions = new Set(
      [
        base,
        resolvePlainRuleProvider({ kind: "anthropic", model: "claude-sonnet-5-5" })!,
        resolvePlainRuleProvider({ kind: "anthropic", maxTokens: 2048 })!,
        resolvePlainRuleProvider({ kind: "anthropic", effort: "medium" })!,
        resolvePlainRuleProvider({ kind: "openai-compatible", model: "claude-haiku-5-5" })!,
        resolvePlainRuleProvider({ kind: "openai-compatible", model: "claude-haiku-5-5", tokenParam: "max_tokens" })!,
      ].map(plainRuleProviderVersion),
    );
    expect(versions.size).toBe(6);
  });

  it("names how each provider's key and headers are sent", () => {
    expect(plainRuleProviderSenderOptions("anthropic")).toEqual({
      auth: { header: "x-api-key" },
      headers: { "anthropic-version": ANTHROPIC_API_VERSION },
    });
    expect(plainRuleProviderSenderOptions("openai-compatible")).toEqual({ auth: { scheme: "bearer" }, headers: {} });
  });
});

describe("#701 plain-rule provider: through the HTTPS sender", () => {
  it("judges end to end with the provider's headers and the key only in its auth header", async () => {
    const value = `sk-test-${randomUUID()}`;
    const seen: { headers: Record<string, unknown>; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ headers: req.headers, body });
        const messages = (JSON.parse(body) as { messages: { content: string }[] }).messages;
        const frame = JSON.parse(messages.at(-1)!.content) as Frame;
        const ok = req.headers["x-api-key"] === value && req.headers["anthropic-version"] === ANTHROPIC_API_VERSION;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(anthropicReply(answerFor(frame, ok ? ["covered"] : ["not-covered"])));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const destination = `https://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
      const made = createHttpsJudgeSender({
        destination,
        ...plainRuleProviderSenderOptions("anthropic"),
        request: (options) => httpRequest(options),
      });
      if (made.status !== "ready") throw new Error(made.reason);
      const credential = { kind: JUDGE_SECRET_CREDENTIAL_KIND, destination, reveal: () => value };
      const provider = createPlainRuleProviderTransport({
        config: { kind: "anthropic" },
        post: (body, s) => made.sender.send({ frame: body, credential, signal: s, maxResponseBytes: 16_384 }),
      });
      if (provider.status !== "ready") throw new Error("invalid");
      const out = await createPlainRuleJudge({ transport: provider.transport })(input, signal());
      expect(out).toMatchObject({ outcome: "allow", ruleId: "pr_docs" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.body).not.toContain(value);
      expect(JSON.stringify(out)).not.toContain(value);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
