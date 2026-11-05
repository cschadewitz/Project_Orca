/**
 * SDK 2 stable-profile wire boundaries. Both peers use real NDJSON/SDK dispatch;
 * the host never launches a process or accesses files. These synthetic payloads
 * document ORCA's supported profile, not any installed provider's behavior.
 */
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionUpdate as UnstableSessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { AgentSpecSchema } from "@orca/core";
import {
  openAcpSession,
  stdioAcpStream,
  type AgentHost,
  type OpenSessionOptions,
  type SessionUpdateEvent,
} from "@orca/agents";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const cwd = "/synthetic/acp-stable";
const sessionId = "stable-session";
const meta = { "orca/idempotencyKey": "synthetic-key", custom: { retained: true } };
const text = { type: "text" as const, text: "supported content" };
const systemPrompt = { mode: "append", content: [text] };
const usage = { totalTokens: 3, inputTokens: 2, outputTokens: 1 };

function agent() {
  return acp
    .agent({ name: "synthetic-stable-peer" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId }));
}

function wire(app: acp.AgentApp) {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const connection = app.connect(stdioAcpStream(toAgent, toClient));
  cleanup.push(async () => {
    connection.close();
    await connection.closed;
    toAgent.destroy();
    toClient.destroy();
  });
  return {
    stream: stdioAcpStream(toClient, toAgent),
    pid: undefined,
    exited: connection.closed.then(() => ({ code: 0, signal: null })),
    stderrTail: () => "",
    kill: () => connection.close(),
  };
}

async function open(app: acp.AgentApp, options: Pick<OpenSessionOptions, "additionalDirectories"> = {}) {
  const peer = wire(app);
  const forbiddenIO = vi.fn(async () => {
    throw new Error("stable-boundary fixture forbids host I/O");
  });
  const host: AgentHost = {
    id: "synthetic",
    spec: { id: "synthetic", type: "local" },
    fs: {
      readFile: forbiddenIO,
      writeFile: forbiddenIO,
      exists: forbiddenIO,
      existsMany: forbiddenIO,
      mkdirp: forbiddenIO,
    },
    exec: forbiddenIO,
    joinPath: (...parts) => parts.join("/"),
    spawnAgent: async () => peer,
  };
  const session = await openAcpSession({
    host,
    agent: AgentSpecSchema.parse({ id: "stable-boundary", command: "never-spawned" }),
    cwd,
    ...options,
  });
  cleanup.push(async () => {
    await session.close();
    expect(forbiddenIO).not.toHaveBeenCalled();
  });
  return session;
}

// Type-check against the installed unstable profile so these are actual SDK variants,
// not invented unknown messages. Production and all runtime handlers remain stable.
const unstableUpdates = [
  { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "p", content: "plan" } },
  { sessionUpdate: "plan_removed", planId: "p" },
  { sessionUpdate: "subagent_update", sessionId: "child", state: { state: "idle" } },
  { sessionUpdate: "session_message", messageId: "m" },
  { sessionUpdate: "session_message_chunk", messageId: "m", content: text },
] satisfies UnstableSessionUpdate[];

it.each(unstableUpdates)(
  "does not deliver unadvertised $sessionUpdate, but preserves stable updates and completion",
  async (update) => {
    const session = await open(
      agent().onRequest(acp.methods.agent.session.prompt, async (ctx) => {
        // The sender deliberately supplies an extra-profile payload. The receiver's
        // registered session/update parser, rather than a direct schema call, rejects it.
        await ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "usage_update", used: 2, size: 10, _meta: meta },
        });
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: text },
        });
        return { stopReason: "end_turn" };
      }),
    );
    const seen: SessionUpdateEvent[] = [];
    session.onUpdate((event) => seen.push(event));
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    await vi.waitFor(() =>
      expect(seen.map((event) => event.raw)).toEqual([
        { sessionUpdate: "usage_update", used: 2, size: 10, _meta: meta },
        { sessionUpdate: "agent_message_chunk", content: text },
      ]),
    );
  },
);

it("parses supported request fields and metadata without advertising or honoring unstable instructions", async () => {
  const initialize = vi.fn<(params: acp.InitializeRequest) => acp.InitializeResponse>(() => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }));
  const create = vi.fn<(params: acp.NewSessionRequest) => acp.NewSessionResponse>(() => ({ sessionId }));
  const app = acp
    .agent({ name: "stable-request-observer" })
    .onRequest(acp.methods.agent.initialize, (ctx) => initialize(ctx.params))
    .onRequest(acp.methods.agent.session.new, (ctx) => create(ctx.params));
  const peer = wire(app);
  await acp.client({ name: "synthetic-client" }).connectWith(peer.stream, async (ctx) => {
    const init = {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        session: { configOptions: { boolean: {} } },
        plan: {},
        subagents: {},
      },
      _meta: meta,
    };
    const response = await ctx.request(acp.methods.agent.initialize, init);
    expect(response).toEqual({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } });
    // Stable peers do not advertise systemPrompt. Sending it anyway must not be
    // confused with support: SDK parsing discards it before the session handler.
    const request = { cwd, additionalDirectories: ["/synthetic/extra"], mcpServers: [], systemPrompt, _meta: meta };
    await ctx.request(acp.methods.agent.session.new, request);
  });
  expect(initialize).toHaveBeenCalledExactlyOnceWith({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
      session: { configOptions: { boolean: {} } },
      auth: { terminal: false },
    },
    _meta: meta,
  });
  expect(create).toHaveBeenCalledExactlyOnceWith({
    cwd,
    additionalDirectories: ["/synthetic/extra"],
    mcpServers: [],
    _meta: meta,
  });
});

it("preserves ORCA's additional directories and embedded resource through the receiving SDK handlers", async () => {
  const created: acp.NewSessionRequest[] = [];
  const prompted: acp.PromptRequest[] = [];
  const app = acp
    .agent({ name: "stable-content-observer" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { additionalDirectories: {} },
      },
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      created.push(ctx.params);
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, (ctx) => {
      prompted.push(ctx.params);
      return { stopReason: "end_turn" };
    });
  const session = await open(app, { additionalDirectories: ["/synthetic/extra"] });
  const resource: acp.ContentBlock = {
    type: "resource",
    resource: { uri: "file:///synthetic/context.txt", mimeType: "text/plain", text: "embedded context", _meta: meta },
    _meta: meta,
  };
  await session.prompt([text, resource]);
  expect(created).toEqual([{ cwd, additionalDirectories: ["/synthetic/extra"], mcpServers: [] }]);
  expect(prompted).toEqual([{ sessionId, prompt: [text, resource] }]);
});

it("receives raw response extras but exposes only ORCA's stable turn result, not experimental usage", async () => {
  const app = () => agent().onRequest(acp.methods.agent.session.prompt, () => ({ stopReason: "end_turn", usage }));
  const peer = wire(app());
  // Direct SDK request responses are not run through zPromptResponse. Assert this
  // over the wire so an ignored field is not mistakenly described as SDK stripping.
  await acp.client({ name: "raw-response-observer" }).connectWith(peer.stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
    await ctx.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [text] });
    expect(result).toEqual({ stopReason: "end_turn", usage });
  });
  const session = await open(app());
  expect(await session.prompt("go")).toEqual({ stopReason: "end_turn", durationMs: expect.any(Number) });
});
