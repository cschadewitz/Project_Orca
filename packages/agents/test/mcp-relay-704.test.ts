/**
 * ORCA runs a hooked session's MCP servers itself and serves them to the agent over ACP
 * (#704). Here a real ACP agent over stdio is given a server, and a real stdio MCP server
 * stands behind it. The agent must learn the server's name and nothing else: not its command,
 * not its environment, not the secret in it. The server starts only for a request made after
 * the session is admitted, and never if admission is refused. Past admission, every request is
 * checked again when it is dispatched: a tool call only in the session's live turn and only as
 * ORCA's policy decides it then, each request within a deadline, and a server that never
 * finishes starting is stopped on its deadline or when the session closes.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, type Logger } from "@orca/core";
import {
  ENV_SECRET_DELIVERY,
  LocalHost,
  openAcpSession,
  type AgentHost,
  type AgentSecretDelivery,
  type AgentSession,
  type OpenSessionOptions,
} from "@orca/agents";

const SECRET = "relay-secret-7f3a9c";

/**
 * An ACP agent that offers MCP over ACP and writes the `session/new` params it was given to
 * `SEEN_LOG`. At `session/new` it lists every server (`LIST_LOG`), and with `OUTSIDE_CALL`
 * also calls a tool there, outside any turn. Each prompt's text is a JSON list of requests
 * (`[method, params]`) it sends every server during the turn; the outcomes go to
 * `RESULT_LOG`, and the turn ends once they are all answered.
 */
const agentScript = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let nextId = 1000;
let n = 0;
let servers = [];
const waiting = new Map();
const request = (method, params) => new Promise((resolve) => {
  const id = ++nextId;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "agent", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
const mcp = (serverId, method, params) => request("mcp/message", { serverId, requestId: "r" + ++n, method, params: { ...(params || {}), _meta: meta } });
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false, mcpCapabilities: { acp: process.env.NO_ACP ? false : true } }, agentInfo: { name: "relay-agent", version: "0" } } });
  else if (m.method === "session/new") {
    fs.writeFileSync(process.env.SEEN_LOG, JSON.stringify({ params: m.params, env: process.env }));
    servers = m.params.mcpServers;
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
    const out = [];
    if (process.env.NO_LIST) return;
    for (const s of servers) {
      out.push(await mcp(s.serverId, "server/discover"));
      out.push(await mcp(s.serverId, "tools/list"));
      if (process.env.OUTSIDE_CALL) out.push(await mcp(s.serverId, "tools/call", { name: "touch", arguments: {} }));
    }
    fs.writeFileSync(process.env.LIST_LOG, JSON.stringify(out));
  } else if (m.method === "session/prompt") {
    const ops = JSON.parse(m.params.prompt[0].text);
    if (ops[0] === "EXIT") process.exit(0);
    let out = [];
    if (ops[0] === "PARALLEL")
      out = await Promise.all(servers.flatMap((s) => ops.slice(1).map(([method, params]) => mcp(s.serverId, method, params))));
    // A parallel turn stays open a while after its answers, so what is still queued then is
    // judged by its own deadline, not by the turn having ended.
    if (ops[0] === "PARALLEL") await new Promise((r) => setTimeout(r, 1500));
    else for (const s of servers) for (const [method, params] of ops) out.push(await mcp(s.serverId, method, params));
    fs.writeFileSync(process.env.RESULT_LOG, JSON.stringify(out));
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    // An ACP error, or the MCP error or result the \`mcp/message\` answer carries.
    const r = m.error ? { error: m.error } : m.result;
    resolve(r && r.error ? { acpError: r.error } : r && "result" in r ? r.result : r);
  }
});
setInterval(() => {}, 1000);
`;

/**
 * A stdio MCP server of the 2025-06-18 era: `initialize` first (never answered with
 * `HANG_INIT`, answered after `SLOW_INIT` ms), then a tool `touch` that reports what it was
 * given, a tool `slow` that never answers, a tool `leak` that fails with the secret in its
 * error, and tools that answer in ways JSON-RPC does not allow.
 */
const serverScript = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
fs.appendFileSync(process.env.SERVER_LOG, "started " + process.pid + "\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(process.env.SERVER_LOG, (m.method || "response") + (m.params && m.params.name ? " " + m.params.name : "") + "\\n");
  if (m.method === "initialize") {
    const answer = () => {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "real-server", version: "3" } } });
    };
    if (process.env.HANG_INIT) {}
    else if (process.env.SLOW_INIT) setTimeout(answer, Number(process.env.SLOW_INIT));
    else answer();
    // An answer to a request id ORCA has not sent yet, as a server guessing ahead would.
    if (process.env.FORGE_ID)
      setTimeout(() => send({ jsonrpc: "2.0", id: Number(process.env.FORGE_ID), result: { content: [{ type: "text", text: "forged" }] } }), 300);
  } else if (m.method === "tools/list")
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call" && m.params.name === "slow") {}
  else if (m.method === "tools/call" && m.params.name === "bad-result")
    send({ jsonrpc: "2.0", id: m.id, result: "not an object" });
  else if (m.method === "tools/call" && m.params.name === "both")
    send({ jsonrpc: "2.0", id: m.id, result: {}, error: { code: 1, message: "and" } });
  else if (m.method === "tools/call" && m.params.name === "bad-error")
    send({ jsonrpc: "2.0", id: m.id, error: "not an object" });
  else if (m.method === "tools/call" && m.params.name === "wrong-id")
    send({ jsonrpc: "2.0", id: "r" + m.id, result: {} });
  else if (m.method === "tools/call" && m.params.name === "leak")
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32050, message: "token " + process.env.API_TOKEN + " rejected\\n" + "x".repeat(5000), data: { token: process.env.API_TOKEN, stack: "at server.cjs:1" } } });
  else if (m.method === "tools/call")
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "secret is " + (process.env.API_TOKEN === "${SECRET}" ? "here" : "missing") + (process.env.ORCA_TEST_WITHHELD ? "; withheld is present" : "") }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`;

const WITHHELD = "ORCA_TEST_WITHHELD";
const CALL = JSON.stringify([["tools/call", { name: "touch", arguments: {} }]]);

const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const logged: string[] = [];
const logger: Logger = {
  debug: (msg, ctx) => void logged.push(JSON.stringify([msg, ctx])),
  info: (msg, ctx) => void logged.push(JSON.stringify([msg, ctx])),
  warn: (msg, ctx) => void logged.push(JSON.stringify([msg, ctx])),
  error: (msg, ctx) => void logged.push(JSON.stringify([msg, ctx])),
  log: (level, msg, ctx) => void logged.push(JSON.stringify([level, msg, ctx])),
  child: () => logger,
};

async function setup(opts: {
  admission?: Promise<void>;
  noAcp?: boolean;
  agentToken?: boolean;
  delivery?: AgentSecretDelivery;
  outsideCall?: boolean;
  hangInit?: boolean;
  slowInitMs?: number;
  forgeId?: number;
  /** Wraps the host the session spawns through. */
  host?: (inner: AgentHost) => AgentHost;
  noList?: boolean;
  withheld?: boolean;
  permissionFiles?: string[];
  permissions?: { default: "allow" | "ask" | "deny"; rules: unknown[] };
  askPermission?: OpenSessionOptions["askPermission"];
  startTimeoutMs?: number;
  requestTimeoutMs?: number;
}) {
  const dir = await mkdtemp(join(tmpdir(), "orca-704-relay-"));
  dirs.push(dir);
  const agentFile = join(dir, "agent.cjs");
  const serverFile = join(dir, "server.cjs");
  await writeFile(agentFile, agentScript);
  await writeFile(serverFile, serverScript);
  const seenLog = join(dir, "seen.json");
  const resultLog = join(dir, "results.json");
  const listLog = join(dir, "list.json");
  const serverLog = join(dir, "server.log");
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, `${SECRET}\n`);
  const session = openAcpSession({
    host: (opts.host ?? ((h) => h))(new LocalHost({ id: "local", type: "local" })),
    agent: AgentSpecSchema.parse({
      id: "relay",
      command: process.execPath,
      args: [agentFile],
      env: {
        SEEN_LOG: seenLog,
        RESULT_LOG: resultLog,
        LIST_LOG: listLog,
        ...(opts.outsideCall ? { OUTSIDE_CALL: "1" } : {}),
        ...(opts.noList ? { NO_LIST: "1" } : {}),
        ...(opts.noAcp ? { NO_ACP: "1" } : {}),
        ...(opts.agentToken ? { AGENT_TOKEN: { secret: "token" } } : {}),
      },
      permissions: opts.permissions ?? { default: "allow", rules: [] },
      mcpServers: [
        {
          name: "tools",
          command: process.execPath,
          args: [serverFile],
          env: {
            API_TOKEN: { secret: "token" },
            SERVER_LOG: serverLog,
            ...(opts.hangInit ? { HANG_INIT: "1" } : {}),
            ...(opts.slowInitMs ? { SLOW_INIT: String(opts.slowInitMs) } : {}),
            ...(opts.forgeId ? { FORGE_ID: String(opts.forgeId) } : {}),
          },
        },
      ],
    }),
    cwd: dir,
    logger,
    secrets: {
      token: { host: "local", provider: "file", path: tokenFile },
      // A secret ORCA reads from its own environment: that variable is withheld from the
      // agent, and so from the servers ORCA runs for it.
      ...(opts.withheld ? { fromEnv: { host: "local", provider: "env", name: WITHHELD } } : {}),
    },
    ...(opts.permissionFiles ? { permissionFiles: opts.permissionFiles } : {}),
    authorizeSecretUse: async () => undefined,
    ...(opts.delivery ? { secretDelivery: opts.delivery } : {}),
    handshakeTimeoutMs: 10_000,
    relayMcpServers: true,
    ...(opts.admission ? { admission: opts.admission } : {}),
    ...(opts.askPermission ? { askPermission: opts.askPermission } : {}),
    ...(opts.startTimeoutMs !== undefined ? { mcpStartTimeoutMs: opts.startTimeoutMs } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { mcpRequestTimeoutMs: opts.requestTimeoutMs } : {}),
  });
  const read = async <T>(file: string): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text !== undefined) return JSON.parse(text) as T;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`nothing was written to ${file}`);
  };
  return {
    open: async () => {
      const s = await session;
      sessions.push(s);
      return s;
    },
    session,
    seen: () => read<{ params: { mcpServers: Record<string, unknown>[] }; env: Record<string, string> }>(seenLog),
    listed: () => read<Record<string, unknown>[]>(listLog),
    results: () => read<Record<string, unknown>[]>(resultLog),
    /** Run one turn whose requests are `ops`, and read what came back. */
    turn: async (s: AgentSession, ops: string = CALL) => {
      await s.prompt([{ type: "text", text: ops }]);
      return read<Record<string, unknown>[]>(resultLog);
    },
    serverLog: () => readFile(serverLog, "utf8").catch(() => ""),
  };
}

const refused = (message: RegExp | string) => ({
  acpError: expect.objectContaining({ message: expect.stringMatching(message) }),
});

describe("ORCA serves a hooked session's MCP servers over ACP (#704)", () => {
  it("tells the agent a name and an id, and runs the server itself with its secret", async () => {
    logged.length = 0;
    const t = await setup({});
    const s = await t.open();
    const seen = await t.seen();
    expect(seen.params.mcpServers).toEqual([{ type: "acp", name: "tools", serverId: expect.any(String) }]);
    const said = JSON.stringify(seen);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain("server.cjs");
    const [discover, list] = await t.listed();
    expect(discover).toEqual({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      serverInfo: { name: "real-server", version: "3" },
    });
    expect(list).toEqual({ tools: [{ name: "touch", inputSchema: { type: "object" } }] });
    const [call] = await t.turn(s);
    expect(call).toEqual({ content: [{ type: "text", text: "secret is here" }] });
    // The old-era server was opened the old way, and was never sent the new handshake.
    expect((await t.serverLog()).split("\n")).toEqual(
      expect.arrayContaining(["initialize", "notifications/initialized", "tools/list", "tools/call touch"]),
    );
    expect(await t.serverLog()).not.toContain("server/discover");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("starts nothing while admission is pending, and nothing at all once it is refused", async () => {
    let refuse!: (e: Error) => void;
    const admission = new Promise<void>((_, reject) => (refuse = reject));
    admission.catch(() => undefined);
    const t = await setup({ admission });
    await t.open();
    await t.seen();
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.serverLog()).toBe("");
    refuse(new Error("not the runtime ORCA verified"));
    const [discover] = await t.listed();
    expect(discover).toEqual(refused("the session was not admitted"));
    expect(await t.serverLog()).toBe("");
  });

  it("starts the server for the first request after the session is admitted", async () => {
    let admit!: () => void;
    const admission = new Promise<void>((resolve) => (admit = resolve));
    const t = await setup({ admission });
    const s = await t.open();
    await t.seen();
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.serverLog()).toBe("");
    admit();
    await t.listed();
    const [call] = await t.turn(s);
    expect(call).toEqual({ content: [{ type: "text", text: "secret is here" }] });
  });

  it("refuses a tool call outside a live turn, however admitted the session is", async () => {
    const t = await setup({ outsideCall: true });
    await t.open();
    const [, list, call] = await t.listed();
    expect(list).toEqual({ tools: [{ name: "touch", inputSchema: { type: "object" } }] });
    expect(call).toEqual(refused(/no live turn/));
    expect(await t.serverLog()).not.toContain("tools/call");
  });

  it("decides each tool call by ORCA's policy at dispatch, and a deny never reaches the server", async () => {
    const t = await setup({
      permissions: {
        default: "allow",
        rules: [{ match: { kind: "other", titlePattern: "^tools: touch$" }, decision: "deny" }],
      },
    });
    const s = await t.open();
    await t.listed();
    const [call] = await t.turn(s);
    expect(call).toEqual(refused(/policy says deny/));
    expect(await t.serverLog()).not.toContain("tools/call");
  });

  it("puts an ask to a person as a one-time allow for that exact call", async () => {
    const asked: unknown[] = [];
    let answer = "reject";
    const t = await setup({
      permissions: { default: "ask", rules: [] },
      askPermission: async (req) => {
        asked.push(req.toolCall);
        return answer;
      },
    });
    const s = await t.open();
    await t.listed();
    const [rejected] = await t.turn(s);
    expect(rejected).toEqual(refused(/not allowed/));
    expect(await t.serverLog()).not.toContain("tools/call");
    answer = "allow";
    const [allowed] = await t.turn(s);
    expect(allowed).toEqual({ content: [{ type: "text", text: "secret is here" }] });
    expect(asked).toEqual([
      expect.objectContaining({ title: "tools: touch", kind: "other", rawInput: {} }),
      expect.objectContaining({ title: "tools: touch", kind: "other", rawInput: {} }),
    ]);
  });

  it("refuses requests ORCA does not relay", async () => {
    const t = await setup({});
    const s = await t.open();
    await t.listed();
    const [read, init] = await t.turn(
      s,
      JSON.stringify([
        ["resources/read", { uri: "file:///etc/passwd" }],
        ["initialize", {}],
      ]),
    );
    expect(read).toEqual(refused(/resources\/read is not relayed/));
    expect(init).toEqual(refused(/initialize is not relayed/));
    expect(await t.serverLog()).not.toContain("resources/read");
  });

  it("ends a request at its deadline and tells the server it was cancelled", async () => {
    const t = await setup({ requestTimeoutMs: 300 });
    const s = await t.open();
    await t.listed();
    const [slow] = await t.turn(s, JSON.stringify([["tools/call", { name: "slow", arguments: {} }]]));
    expect(slow).toEqual({
      acpError: expect.objectContaining({ message: "the request's deadline passed", data: { reason: "deadline" } }),
    });
    for (let i = 0; i < 40 && !(await t.serverLog()).includes("notifications/cancelled"); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await t.serverLog()).toContain("notifications/cancelled");
  });

  it("stops a server that does not finish starting within its deadline", async () => {
    const t = await setup({ hangInit: true, startTimeoutMs: 300 });
    await t.open();
    const [discover] = await t.listed();
    expect(discover).toEqual({
      acpError: expect.objectContaining({
        message: expect.stringMatching(/did not start/),
        data: { reason: "start-timeout" },
      }),
    });
    await expectGone(await serverPid(t.serverLog));
  });

  it("stops a server that is still starting when the session closes", async () => {
    const t = await setup({ hangInit: true, startTimeoutMs: 60_000 });
    const s = await t.open();
    const pid = await serverPid(t.serverLog);
    await s.close();
    await expectGone(pid);
  });

  it("withholds from a server what the session withholds from its agent", async () => {
    process.env[WITHHELD] = "daemon-only-value";
    try {
      const t = await setup({ withheld: true });
      const s = await t.open();
      expect((await t.seen()).env[WITHHELD]).toBeUndefined();
      await t.listed();
      const [call] = await t.turn(s);
      expect(call).toEqual({ content: [{ type: "text", text: "secret is here" }] });
    } finally {
      delete process.env[WITHHELD];
    }
  });

  it("passes on a server's error as its code and a bounded, redacted message, and nothing else", async () => {
    logged.length = 0;
    const t = await setup({});
    const s = await t.open();
    await t.listed();
    const [leak] = await t.turn(s, JSON.stringify([["tools/call", { name: "leak", arguments: {} }]]));
    const error = (leak as { acpError: { code: number; message: string; data?: unknown } }).acpError;
    expect(error.code).toBe(-32050);
    expect(error.message).toMatch(/^token \[REDACTED\] rejected x+…$/);
    expect(error.message.length).toBeLessThanOrEqual(501);
    expect(error.data).toBeUndefined();
    expect(JSON.stringify(leak)).not.toContain(SECRET);
    expect(JSON.stringify(leak)).not.toContain("server.cjs");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("decides a call again once its server has started, at the write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-704-sidecar-"));
    dirs.push(dir);
    const sidecar = join(dir, "permissions.json");
    const t = await setup({ noList: true, slowInitMs: 800, permissionFiles: [sidecar] });
    const s = await t.open();
    await t.seen();
    const turn = t.turn(s);
    // The call was allowed when it arrived; while its server starts, a deny is recorded.
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.serverLog()).toContain("initialize");
    await writeFile(
      sidecar,
      JSON.stringify({
        version: 1,
        agents: { relay: { rules: [{ match: { kind: "other", titlePattern: "^tools: touch$" }, decision: "deny" }] } },
      }),
    );
    const [call] = await turn;
    expect(call).toEqual(refused(/denies it now/));
    expect(await t.serverLog()).not.toContain("tools/call");
  });

  it("stops a server whose input is stuck, without waiting on the write", async () => {
    let stuck = false;
    const t = await setup({
      noList: true,
      requestTimeoutMs: 60_000,
      host: (inner) => stallingServerInput(inner, () => (stuck = true)),
    });
    const s = await t.open();
    await t.seen();
    const turn = s.prompt([{ type: "text", text: CALL }]).catch(() => undefined);
    const pid = await serverPid(t.serverLog);
    for (let i = 0; i < 100 && !stuck; i++) await new Promise((r) => setTimeout(r, 20));
    expect(stuck).toBe(true);
    await s.close();
    await expectGone(pid);
    await turn;
  });

  it("drops a queued request whose authority ran out before the transport took it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const t = await setup({
      noList: true,
      requestTimeoutMs: 400,
      host: (inner) => holdingServerInput(inner, '"name":"hold"', held),
    });
    const s = await t.open();
    await t.seen();
    const turn = t.turn(
      s,
      JSON.stringify([
        "PARALLEL",
        ["tools/call", { name: "hold", arguments: {} }],
        ["tools/call", { name: "touch", arguments: {} }],
      ]),
    );
    // Both deadlines pass while the first write is still with the transport; the turn is live.
    await new Promise((r) => setTimeout(r, 800));
    release();
    const [hold, touch] = await turn;
    expect(hold).toEqual({ acpError: expect.objectContaining({ data: { reason: "deadline" } }) });
    expect(touch).toEqual({ acpError: expect.objectContaining({ data: { reason: "deadline" } }) });
    await new Promise((r) => setTimeout(r, 300));
    const log = await t.serverLog();
    expect(log).toContain("tools/call hold");
    expect(log).not.toContain("tools/call touch");
  });

  it("takes no answer for a request that has not been handed to the server yet", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // `initialize` is request 1, `hold` 2 and `touch` 3; the server answers 3 while it is queued.
    const t = await setup({
      noList: true,
      forgeId: 3,
      requestTimeoutMs: 60_000,
      host: (inner) => holdingServerInput(inner, '"name":"hold"', held),
    });
    const s = await t.open();
    await t.seen();
    const turn = t.turn(
      s,
      JSON.stringify([
        "PARALLEL",
        ["tools/call", { name: "hold", arguments: {} }],
        ["tools/call", { name: "touch", arguments: {} }],
      ]),
    );
    await new Promise((r) => setTimeout(r, 700));
    release();
    const [hold, touch] = await turn;
    expect(JSON.stringify([hold, touch])).not.toContain("forged");
    expect(touch).toEqual({ acpError: expect.objectContaining({ data: { reason: "invalid-response" } }) });
    expect(await t.serverLog()).not.toContain("tools/call touch");
  });

  it("decides a queued call on the policy as it is when the server is handed it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-704-sidecar-"));
    dirs.push(dir);
    const sidecar = join(dir, "permissions.json");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const t = await setup({
      noList: true,
      permissionFiles: [sidecar],
      requestTimeoutMs: 60_000,
      host: (inner) => holdingServerInput(inner, '"name":"hold"', held),
    });
    const s = await t.open();
    await t.seen();
    const turn = t.turn(
      s,
      JSON.stringify([
        "PARALLEL",
        ["tools/call", { name: "hold", arguments: {} }],
        ["tools/call", { name: "touch", arguments: {} }],
      ]),
    );
    // Both were allowed and the server has started; `touch` waits in line behind `hold`.
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(
      sidecar,
      JSON.stringify({
        version: 1,
        agents: { relay: { rules: [{ match: { kind: "other", titlePattern: "^tools: touch$" }, decision: "deny" }] } },
      }),
    );
    release();
    const [hold, touch] = await turn;
    expect(hold).toEqual({ content: [{ type: "text", text: "secret is here" }] });
    expect(touch).toEqual(refused(/denies it now/));
    expect(await t.serverLog()).not.toContain("tools/call touch");
  });

  it("starts no server for a request whose deadline passed while it was decided", async () => {
    const t = await setup({
      noList: true,
      permissions: { default: "ask", rules: [] },
      requestTimeoutMs: 200,
      askPermission: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return "allow";
      },
    });
    const s = await t.open();
    await t.seen();
    const [call] = await t.turn(s);
    expect(call).toEqual({ acpError: expect.objectContaining({ data: { reason: "deadline" } }) });
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.serverLog()).toBe("");
  });

  it("settles a request at its deadline while its server is still starting", async () => {
    const t = await setup({ noList: true, slowInitMs: 3_000, requestTimeoutMs: 300 });
    const s = await t.open();
    await t.seen();
    const started = Date.now();
    const [call] = await t.turn(s);
    expect(call).toEqual({ acpError: expect.objectContaining({ data: { reason: "deadline" } }) });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.each([
    ["a result that is not an object", "bad-result"],
    ["both a result and an error", "both"],
    ["an error that is not an object", "bad-error"],
  ])("settles a request answered with %s, at once and as a failure", async (_, tool) => {
    const t = await setup({ requestTimeoutMs: 60_000 });
    const s = await t.open();
    await t.listed();
    const started = Date.now();
    const [answer] = await t.turn(s, JSON.stringify([["tools/call", { name: tool, arguments: {} }]]));
    expect(answer).toEqual({ acpError: expect.objectContaining({ data: { reason: "invalid-response" } }) });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The server itself is still usable.
    const [call] = await t.turn(s);
    expect(call).toEqual({ content: [{ type: "text", text: "secret is here" }] });
  });

  it("fails everything pending and stops a server whose answer matches no request, then starts it again", async () => {
    const t = await setup({ requestTimeoutMs: 60_000 });
    const s = await t.open();
    await t.listed();
    const pid = await serverPid(t.serverLog);
    const started = Date.now();
    const [answer] = await t.turn(s, JSON.stringify([["tools/call", { name: "wrong-id", arguments: {} }]]));
    expect(answer).toEqual({ acpError: expect.objectContaining({ data: { reason: "invalid-response" } }) });
    expect(Date.now() - started).toBeLessThan(5_000);
    await expectGone(pid);
    const [call] = await t.turn(s);
    expect(call).toEqual({ content: [{ type: "text", text: "secret is here" }] });
  });

  it("stops its servers when the agent's transport is lost", async () => {
    const t = await setup({});
    const s = await t.open();
    await t.listed();
    const pid = await serverPid(t.serverLog);
    await s.prompt([{ type: "text", text: JSON.stringify(["EXIT"]) }]).catch(() => undefined);
    await expectGone(pid);
  });

  it("refuses to open when the agent cannot take MCP servers over ACP", async () => {
    const t = await setup({ noAcp: true });
    await expect(t.session).rejects.toThrow(/does not offer MCP over ACP/);
    expect(await t.serverLog()).toBe("");
  });

  it("stops the server when the session closes", async () => {
    const t = await setup({});
    const s = await t.open();
    await t.listed();
    const pid = await serverPid(t.serverLog);
    await s.close();
    await expectGone(pid);
  });

  it("hands the agent its own secret-backed env through one swappable delivery", async () => {
    // The default puts the value in the agent's environment, as ORCA always has.
    const viaEnv = await setup({ agentToken: true });
    await viaEnv.open();
    expect((await viaEnv.seen()).env["AGENT_TOKEN"]).toBe(SECRET);
    expect(ENV_SECRET_DELIVERY.kind).toBe("env");
    // Another strategy (a stand-in for a key store) keeps the value out of the agent process,
    // while the host still reads it for the MCP server ORCA runs.
    const withheld: AgentSecretDelivery = {
      kind: "test-store",
      spawnOptions: (plan) => ({
        secrets: plan.deliveries.map((d) => ({ ...d, env: [] })),
        withheldEnv: plan.withheldEnv,
      }),
    };
    const viaStore = await setup({ agentToken: true, delivery: withheld });
    const s = await viaStore.open();
    const seen = await viaStore.seen();
    expect(seen.env["AGENT_TOKEN"]).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    await viaStore.listed();
    const [call] = await viaStore.turn(s);
    expect(call).toEqual({ content: [{ type: "text", text: "secret is here" }] });
  });
});

/**
 * The host, except that once a relayed server is sent a tool call, the write to it never
 * finishes, and neither does closing its input: a server that has stopped reading.
 */
function stallingServerInput(inner: AgentHost, onStuck: () => void): AgentHost {
  const host = Object.create(inner) as AgentHost;
  host.spawnAgent = async (agent, options) => {
    const handle = await inner.spawnAgent(agent, options);
    if (!agent.id.startsWith("mcp-")) return handle;
    const writer = handle.stream.writable.getWriter();
    let stuck = false;
    const never = () => new Promise<void>(() => undefined);
    const writable = new WritableStream<unknown>({
      write: (message) => {
        if (stuck || JSON.stringify(message).includes('"tools/call"')) {
          stuck = true;
          onStuck();
          return never();
        }
        return writer.write(message as never);
      },
      close: never,
    });
    return Object.assign(Object.create(handle) as typeof handle, {
      stream: { readable: handle.stream.readable, writable },
    });
  };
  return host;
}

/** The host, except that a write to a relayed server matching `match` waits for `held`. */
function holdingServerInput(inner: AgentHost, match: string, held: Promise<void>): AgentHost {
  const host = Object.create(inner) as AgentHost;
  host.spawnAgent = async (agent, options) => {
    const handle = await inner.spawnAgent(agent, options);
    if (!agent.id.startsWith("mcp-")) return handle;
    const writer = handle.stream.writable.getWriter();
    const writable = new WritableStream<unknown>({
      write: async (message) => {
        if (JSON.stringify(message).includes(match)) await held;
        await writer.write(message as never);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
    return Object.assign(Object.create(handle) as typeof handle, {
      stream: { readable: handle.stream.readable, writable },
    });
  };
  return host;
}

async function serverPid(log: () => Promise<string>): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const pid = Number(/started (\d+)/.exec(await log())?.[1]);
    if (pid > 0) return pid;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the server never started");
}

async function expectGone(pid: number): Promise<void> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 60 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
  expect(alive()).toBe(false);
}
