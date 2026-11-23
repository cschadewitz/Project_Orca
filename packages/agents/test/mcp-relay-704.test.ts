/**
 * ORCA runs a hooked session's MCP servers itself and serves them to the agent over ACP
 * (#704). Here a real ACP agent over stdio is given a server, and a real stdio MCP server
 * stands behind it. The agent must learn the server's name and nothing else: not its command,
 * not its environment, not the secret in it. The server starts only for a request made after
 * the session is admitted, and never if admission is refused.
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
  type AgentSecretDelivery,
  type AgentSession,
} from "@orca/agents";

const SECRET = "relay-secret-7f3a9c";

/**
 * An ACP agent that offers MCP over ACP, writes the `session/new` params it was given to
 * `SEEN_LOG`, and then asks every server it was given to discover, list and call a tool;
 * the outcomes go to `RESULT_LOG`.
 */
const agentScript = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let nextId = 1000;
const waiting = new Map();
const request = (method, params) => new Promise((resolve) => {
  const id = ++nextId;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
});
const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "agent", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };
const mcp = (serverId, n, method, params) => request("mcp/message", { serverId, requestId: "r" + n, method, params: { ...(params || {}), _meta: meta } });
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false, mcpCapabilities: { acp: process.env.NO_ACP ? false : true } }, agentInfo: { name: "relay-agent", version: "0" } } });
  else if (m.method === "session/new") {
    fs.writeFileSync(process.env.SEEN_LOG, JSON.stringify({ params: m.params, env: process.env }));
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
    const out = [];
    for (const s of m.params.mcpServers) {
      out.push(await mcp(s.serverId, 1, "server/discover"));
      out.push(await mcp(s.serverId, 2, "tools/list"));
      out.push(await mcp(s.serverId, 3, "tools/call", { name: "touch", arguments: {} }));
    }
    fs.writeFileSync(process.env.RESULT_LOG, JSON.stringify(out));
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve(m.error ? { acpError: m.error } : m.result);
  }
});
setInterval(() => {}, 1000);
`;

/** A stdio MCP server of the 2025-06-18 era: `initialize` first, then one tool. */
const serverScript = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
fs.appendFileSync(process.env.SERVER_LOG, "started " + process.pid + "\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(process.env.SERVER_LOG, (m.method || "response") + "\\n");
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "real-server", version: "3" } } });
  else if (m.method === "tools/list")
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call")
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "secret is " + (process.env.API_TOKEN === "${SECRET}" ? "here" : "missing") }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`;

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
  child: () => logger,
} as Logger;

async function setup(opts: {
  admission?: Promise<void>;
  noAcp?: boolean;
  agentToken?: boolean;
  delivery?: AgentSecretDelivery;
}) {
  const dir = await mkdtemp(join(tmpdir(), "orca-704-relay-"));
  dirs.push(dir);
  const agentFile = join(dir, "agent.cjs");
  const serverFile = join(dir, "server.cjs");
  await writeFile(agentFile, agentScript);
  await writeFile(serverFile, serverScript);
  const seenLog = join(dir, "seen.json");
  const resultLog = join(dir, "results.json");
  const serverLog = join(dir, "server.log");
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, `${SECRET}\n`);
  const session = openAcpSession({
    host: new LocalHost({ id: "local", type: "local" }),
    agent: AgentSpecSchema.parse({
      id: "relay",
      command: process.execPath,
      args: [agentFile],
      env: {
        SEEN_LOG: seenLog,
        RESULT_LOG: resultLog,
        ...(opts.noAcp ? { NO_ACP: "1" } : {}),
        ...(opts.agentToken ? { AGENT_TOKEN: { secret: "token" } } : {}),
      },
      permissions: { default: "allow", rules: [] },
      mcpServers: [
        {
          name: "tools",
          command: process.execPath,
          args: [serverFile],
          env: { API_TOKEN: { secret: "token" }, SERVER_LOG: serverLog },
        },
      ],
    }),
    cwd: dir,
    logger,
    secrets: { token: { host: "local", provider: "file", path: tokenFile } },
    authorizeSecretUse: async () => undefined,
    ...(opts.delivery ? { secretDelivery: opts.delivery } : {}),
    handshakeTimeoutMs: 10_000,
    relayMcpServers: true,
    ...(opts.admission ? { admission: opts.admission } : {}),
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
    results: () => read<Record<string, unknown>[]>(resultLog),
    serverLog: () => readFile(serverLog, "utf8").catch(() => ""),
  };
}

describe("ORCA serves a hooked session's MCP servers over ACP (#704)", () => {
  it("tells the agent a name and an id, and runs the server itself with its secret", async () => {
    logged.length = 0;
    const t = await setup({});
    await t.open();
    const seen = await t.seen();
    expect(seen.params.mcpServers).toEqual([{ type: "acp", name: "tools", serverId: expect.any(String) }]);
    const said = JSON.stringify(seen);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain("server.cjs");
    const [discover, list, call] = await t.results();
    expect(discover).toEqual({
      result: expect.objectContaining({
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        serverInfo: { name: "real-server", version: "3" },
      }),
    });
    expect(list).toEqual({ result: { tools: [{ name: "touch", inputSchema: { type: "object" } }] } });
    expect(call).toEqual({ result: { content: [{ type: "text", text: "secret is here" }] } });
    // The old-era server was opened the old way, and was never sent the new handshake.
    expect((await t.serverLog()).split("\n")).toEqual(
      expect.arrayContaining(["initialize", "notifications/initialized", "tools/list", "tools/call"]),
    );
    expect(await t.serverLog()).not.toContain("server/discover");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("starts nothing while admission is pending, and nothing at all once it is refused", async () => {
    let refuse!: (e: Error) => void;
    const admission = new Promise<void>((_, reject) => (refuse = reject));
    const t = await setup({ admission });
    await t.open();
    await t.seen();
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.serverLog()).toBe("");
    refuse(new Error("not the runtime ORCA verified"));
    const [discover] = await t.results();
    expect(discover).toEqual({ error: expect.objectContaining({ message: "the session was not admitted" }) });
    expect(await t.serverLog()).toBe("");
  });

  it("starts the server for the first request after the session is admitted", async () => {
    let admit!: () => void;
    const admission = new Promise<void>((resolve) => (admit = resolve));
    const t = await setup({ admission });
    await t.open();
    await t.seen();
    await new Promise((r) => setTimeout(r, 300));
    expect(await t.serverLog()).toBe("");
    admit();
    const [, , call] = await t.results();
    expect(call).toEqual({ result: { content: [{ type: "text", text: "secret is here" }] } });
  });

  it("refuses to open when the agent cannot take MCP servers over ACP", async () => {
    const t = await setup({ noAcp: true });
    await expect(t.session).rejects.toThrow(/does not offer MCP over ACP/);
    expect(await t.serverLog()).toBe("");
  });

  it("stops the server when the session closes", async () => {
    const t = await setup({});
    const s = await t.open();
    await t.results();
    const pid = Number(/started (\d+)/.exec(await t.serverLog())?.[1]);
    expect(pid).toBeGreaterThan(0);
    await s.close();
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
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
    await viaStore.open();
    const seen = await viaStore.seen();
    expect(seen.env["AGENT_TOKEN"]).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    const [, , call] = await viaStore.results();
    expect(call).toEqual({ result: { content: [{ type: "text", text: "secret is here" }] } });
  });
});
