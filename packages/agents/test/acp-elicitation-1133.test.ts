/**
 * An agent's question over ACP (#1133, #1169): `elicitation/create` from the agent reaches the
 * session's `askElicitation`, and only that.
 *
 * The agent here is a few lines of JSON-RPC over stdio: it records what `initialize` offered,
 * and during the prompt asks the form from its environment, then reports both back in a
 * message chunk. The forms are the shapes the real adapters send: claude-agent-acp's
 * `AskUserQuestion` (a titled `oneOf` plus a free-text companion) and codex-acp's
 * `request_user_input` (required fields, and a secret one).
 */
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, type ElicitationAnswer, type ElicitationForm } from "@orca/core";
import {
  LocalHost,
  openAcpSession,
  withProviderGuards,
  type AgentSession,
  type OpenSessionOptions,
  type PermissionInvocation,
} from "@orca/agents";

const askingAgent = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let caps; let promptId;
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    caps = m.params.clientCapabilities;
    send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: {}, agentInfo: { name: "asker", version: "0" } } });
  } else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    promptId = m.id;
    send({ id: 900, method: "elicitation/create", params: { sessionId: process.env.ASK_SESSION || "s1", toolCallId: "tc-1", ...JSON.parse(process.env.ASK) } });
  } else if (m.id === 900) {
    const text = JSON.stringify({ caps, result: m.result, error: m.error && m.error.code });
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    setTimeout(() => send({ id: promptId, result: { stopReason: "end_turn" } }), 20);
  }
});
setInterval(() => {}, 1000);
`;

const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

interface Asked {
  form: ElicitationForm;
  invocation: PermissionInvocation;
  about: { toolCallId?: string };
}

async function ask(
  request: Record<string, unknown>,
  answer?: (asked: Asked) => Promise<ElicitationAnswer | undefined>,
  env: Record<string, string> = {},
) {
  const asked: Asked[] = [];
  const session = await openAcpSession({
    host: new LocalHost({ id: "local", type: "local" }),
    agent: AgentSpecSchema.parse({
      id: "asker",
      command: process.execPath,
      args: ["-e", askingAgent],
      env: { ASK: JSON.stringify(request), ...env },
    }),
    cwd: process.cwd(),
    ...(answer
      ? {
          askElicitation: async (form: ElicitationForm, invocation: PermissionInvocation, about: Asked["about"]) => {
            const entry = { form, invocation, about };
            asked.push(entry);
            return answer(entry);
          },
        }
      : {}),
  });
  sessions.push(session);
  let said = "";
  session.onUpdate((e) => {
    if (e.raw.sessionUpdate === "agent_message_chunk" && e.raw.content.type === "text") said += e.raw.content.text;
  });
  await session.prompt("go");
  return {
    asked,
    reply: JSON.parse(said) as { caps: Record<string, unknown>; result?: Record<string, unknown>; error?: number },
  };
}

/** What claude-agent-acp 0.109.1 sends for one `AskUserQuestion` question. */
const askUserQuestion = {
  mode: "form",
  message: "Which database should the service use?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Database",
        oneOf: [
          { const: "Postgres", title: "Postgres", description: "Relational, already in the stack." },
          { const: "SQLite", title: "SQLite" },
        ],
      },
      question_0_custom: {
        type: "string",
        title: "Other",
        description: "Type your own answer, or add a note to the option you chose above (optional).",
      },
    },
  },
};

/** What codex-acp 2.9.0 sends for `request_user_input`. */
const codexQuestion = (secret = false) => ({
  mode: "form",
  message: "Codex needs your input to continue.",
  requestedSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        title: "Which environment?",
        oneOf: [
          { const: "staging", title: "staging" },
          { const: "None of the above", title: "None of the above" },
        ],
        _meta: { codex: { isOther: true, isSecret: secret } },
      },
      target__note: { type: "string", title: "Additional answer or note" },
    },
    required: ["target"],
  },
  _meta: { codex: { autoResolutionMs: null } },
});

describe("agent questions over ACP (#1133, #1169)", () => {
  it("advertises form elicitation, never URL, and only with somebody to ask", async () => {
    const withAsker = await ask(askUserQuestion, async () => ({ action: "decline" }));
    expect(withAsker.reply.caps.elicitation).toEqual({ form: {} });
    const without = await ask(askUserQuestion);
    expect(without.reply.caps.elicitation).toBeUndefined();
    // As before #1133: a session that cannot ask refuses the method outright.
    expect(without.reply.error).toBe(-32601);
  });

  it("puts Claude's AskUserQuestion to the asker and delivers the answer", async () => {
    const { asked, reply } = await ask(askUserQuestion, async () => ({
      action: "accept",
      content: { question_0: "Postgres", question_0_custom: "with pgvector" },
    }));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.about).toEqual({ toolCallId: "tc-1" });
    expect(asked[0]!.form).toEqual({
      message: "Which database should the service use?",
      fields: [
        {
          key: "question_0",
          kind: "choice",
          title: "Database",
          required: false,
          options: [
            { value: "Postgres", label: "Postgres", description: "Relational, already in the stack." },
            { value: "SQLite", label: "SQLite" },
          ],
        },
        {
          key: "question_0_custom",
          kind: "text",
          title: "Other",
          description: "Type your own answer, or add a note to the option you chose above (optional).",
          required: false,
        },
      ],
    });
    expect(reply.result).toEqual({
      action: "accept",
      content: { question_0: "Postgres", question_0_custom: "with pgvector" },
    });
  });

  it("puts Codex's question to the asker, required fields and all", async () => {
    const { asked, reply } = await ask(codexQuestion(), async () => ({
      action: "accept",
      content: { target: "staging" },
    }));
    expect(asked[0]!.form.fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["target", "choice", true],
      ["target__note", "text", false],
    ]);
    expect(reply.result).toEqual({ action: "accept", content: { target: "staging" } });
  });

  it("returns decline when the person declines", async () => {
    const { reply } = await ask(askUserQuestion, async () => ({ action: "decline" }));
    expect(reply.result).toEqual({ action: "decline" });
  });

  it("returns cancel when nobody answered", async () => {
    const { asked, reply } = await ask(askUserQuestion, async () => undefined);
    expect(asked).toHaveLength(1);
    expect(reply.result).toEqual({ action: "cancel" });
  });

  it.each([
    ["a secret field", codexQuestion(true)],
    [
      "a form with no fields (a confirmation)",
      { mode: "form", message: "Proceed?", requestedSchema: { type: "object", properties: {} } },
    ],
    [
      "a URL elicitation",
      { mode: "url", message: "Sign in", url: "https://example.invalid/login", elicitationId: "e1" },
    ],
    [
      "a field type ORCA cannot show",
      { mode: "form", message: "Shape?", requestedSchema: { type: "object", properties: { o: { type: "object" } } } },
    ],
  ])("declines %s without asking anybody", async (_, request) => {
    const { asked, reply } = await ask(request, async () => ({ action: "accept", content: {} }));
    expect(asked).toHaveLength(0);
    expect(reply.result).toEqual({ action: "decline" });
  });

  it("cancels a question for another session without asking", async () => {
    const { asked, reply } = await ask(askUserQuestion, async () => ({ action: "decline" }), { ASK_SESSION: "other" });
    expect(asked).toHaveLength(0);
    expect(reply.result).toEqual({ action: "cancel" });
  });

  it("binds the ask to the live turn", async () => {
    const { asked } = await ask(askUserQuestion, async () => ({ action: "decline" }));
    const { invocation } = asked[0]!;
    expect(invocation.turnId).toBeTruthy();
    expect(invocation.invocationId).toBeTruthy();
    // The turn has ended by now, and the ask's signal with it.
    expect(invocation.signal.aborted).toBe(true);
  });
});

describe("agents a provider guard vouches for (#1133)", () => {
  it("are not offered questions: their pinned behaviour did not include them", async () => {
    const seen: OpenSessionOptions[] = [];
    const guarded = withProviderGuards(
      async (options: OpenSessionOptions) => {
        seen.push(options);
        return {} as AgentSession;
      },
      [{ id: "pinned", matches: () => true, prepare: async (o) => o, guard: (s) => s }],
    );
    await guarded({
      host: new LocalHost({ id: "local", type: "local" }),
      agent: AgentSpecSchema.parse({ id: "pinned", command: "x" }),
      cwd: process.cwd(),
      askElicitation: async () => undefined,
    });
    expect(seen).toHaveLength(1);
    expect("askElicitation" in seen[0]!).toBe(false);
  });
});
