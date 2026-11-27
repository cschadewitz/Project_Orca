/**
 * ORCA-run MCP servers on the Claude Agent SDK route (#1125): Claude is given an in-process SDK
 * server by name only, and every request it makes goes through ORCA's MCP relay with the ACP
 * route's checks, decided by the permission bridge. Here an MCP client stands in for Claude
 * (an in-memory transport to the in-process server), a real stdio MCP server stands behind the
 * relay, and the bridge's `canUseTool` plays the ask Claude makes before it calls a tool.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OrcaError, silentLogger, type PermissionPolicy } from "@orca/core";
import {
  LocalHost,
  checkClaudeSdkMcpServers,
  claudeSdkMcpServers,
  claudeSdkPermissionBridge,
  openClaudeSdkSession,
} from "../src/index.js";
import { createMcpRelay, type McpRelay } from "../src/mcp-relay.js";

const SECRET = "mcp-1125-secret-value";
const serverScript = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
fs.appendFileSync(process.env.SERVER_LOG, "started\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(process.env.SERVER_LOG, (m.method || "response") + (m.params && m.params.name ? " " + m.params.name : "") + (m.params && m.params._meta ? " meta=" + JSON.stringify(m.params._meta) : "") + "\\n");
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "real", version: "1" } } });
  else if (m.method === "tools/list")
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "touch", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call")
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "secret is " + (process.env.API_TOKEN === "${SECRET}" ? "here" : "missing") }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`;

let dir: string;
let serverLog: string;
let relay: McpRelay | undefined;
let client: Client | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-claude-sdk-mcp-"));
  serverLog = join(dir, "server.log");
  await writeFile(join(dir, "server.cjs"), serverScript);
});
afterEach(async () => {
  await client?.close().catch(() => undefined);
  await relay?.close();
  client = relay = undefined;
  await rm(dir, { recursive: true, force: true });
});

const allowAll: PermissionPolicy = { default: "allow", rules: [] };
const askTouch: PermissionPolicy = {
  default: "allow",
  rules: [{ match: { titlePattern: "^tools: touch$" }, decision: "ask" }],
};
const denyTouch: PermissionPolicy = {
  default: "allow",
  rules: [{ match: { titlePattern: "^tools: touch$" }, decision: "deny" }],
};

async function setup(opts: { policy: () => PermissionPolicy; answer?: string; turn?: boolean }) {
  const turnAbort = new AbortController();
  const session = new AbortController();
  const state = { turn: opts.turn ?? true };
  const asked: string[] = [];
  const bridge = claudeSdkPermissionBridge({
    agent: { id: "claude-sdk" },
    sessionId: "sess_x",
    cwd: dir,
    liveTurn: () => (state.turn ? { id: "turn-1", signal: turnAbort.signal } : undefined),
    parentOf: () => undefined,
    loadPolicy: () => Promise.resolve(opts.policy()),
    sessionSignal: session.signal,
    ...(opts.answer
      ? {
          askPermission: (request) => {
            asked.push(request.toolCall.title ?? "");
            return Promise.resolve(opts.answer);
          },
        }
      : {}),
    logger: silentLogger,
  });
  relay = createMcpRelay({
    host: new LocalHost({ id: "local", type: "local" }),
    cwd: dir,
    redact: (t) => t.replaceAll(SECRET, "[redacted]"),
    servers: [
      {
        name: "tools",
        command: process.execPath,
        args: [join(dir, "server.cjs")],
        env: { SERVER_LOG: serverLog, API_TOKEN: SECRET },
      },
    ],
    admitted: Promise.resolve(true),
    authorize: bridge.authorizeMcp,
    logger: silentLogger,
    clientInfo: { name: "orca", version: "0" },
    startTimeoutMs: 10_000,
  });
  const config = claudeSdkMcpServers(relay, [{ name: "tools" }]);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config["tools"]!.instance.connect(serverSide);
  client = new Client({ name: "claude-stand-in", version: "0" });
  await client.connect(clientSide);
  /** What Claude does before an MCP tool call: ask ORCA (`canUseTool`), for this tool use. */
  const claudeAsks = async (toolUseId: string, input: Record<string, unknown> = {}) => {
    // Claude's hook comes first: it settles where the call runs (#1123).
    await bridge.preToolUse(
      {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__tools__touch",
        tool_input: input,
        tool_use_id: toolUseId,
      } as never,
      toolUseId,
      { signal: new AbortController().signal },
    );
    return bridge.canUseTool("mcp__tools__touch", input, {
      signal: new AbortController().signal,
      toolUseID: toolUseId,
      mcpServer: { name: "tools", source: "sdk" },
    } as never);
  };
  const callTool = (toolUseId?: string, args: Record<string, unknown> = {}) =>
    client!.callTool({
      name: "touch",
      arguments: args,
      ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId } } : {}),
    });
  return { state, session, asked, config, claudeAsks, callTool };
}

const log = () => readFile(serverLog, "utf8").catch(() => "");
const text = (r: unknown) => JSON.stringify(r);

describe("ORCA-run MCP servers on the Claude Agent SDK route (#1125)", () => {
  it("gives Claude an in-process server by name, with no command or environment", async () => {
    const { config } = await setup({ policy: () => allowAll });
    expect(Object.keys(config)).toEqual(["tools"]);
    expect(config["tools"]).toMatchObject({ type: "sdk", name: "tools" });
    expect(JSON.stringify(Object.keys(config["tools"]!))).not.toMatch(/command|env|args/);
    expect(await log()).toBe(""); // nothing started for being declared
  });

  it("lists the server's tools in a live session, and runs a call the policy allows with its secret", async () => {
    const { callTool } = await setup({ policy: () => allowAll });
    const tools = await client!.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["touch"]);
    expect(text(await callTool("toolu_1"))).toContain("secret is here");
    // Claude's own key stays on ORCA's side.
    expect(await log()).not.toContain("claudecode/toolUseId");
  });

  it("refuses a tool call outside a live turn, and it never reaches the server", async () => {
    const { callTool } = await setup({ policy: () => allowAll, turn: false });
    await expect(callTool("toolu_1")).rejects.toThrow(/no live turn/);
    expect(await log()).not.toContain("tools/call");
  });

  it("serves a call the policy asks about once, after the person allowed that tool use", async () => {
    const { claudeAsks, callTool, asked } = await setup({ policy: () => askTouch, answer: "allow" });
    expect(await claudeAsks("toolu_1")).toMatchObject({ behavior: "allow" });
    expect(asked).toEqual(["tools: touch"]);
    expect(text(await callTool("toolu_1"))).toContain("secret is here");
    // The answer was for that one tool use: the same id again is not allowed, and nobody is asked twice.
    await expect(callTool("toolu_1")).rejects.toThrow(/nobody was asked/);
    expect(asked).toHaveLength(1);
    expect((await log()).match(/tools\/call/g)).toHaveLength(1);
  });

  it("never asks from the relay: a call the policy asks about with no answer for it is refused", async () => {
    const { callTool, asked } = await setup({ policy: () => askTouch, answer: "allow" });
    await expect(callTool("toolu_9")).rejects.toThrow(/nobody was asked/);
    await expect(callTool()).rejects.toThrow(/nobody was asked/);
    expect(asked).toEqual([]);
    expect(await log()).not.toContain("tools/call");
  });

  it("ties an answer to its tool use's arguments", async () => {
    const { claudeAsks, callTool } = await setup({ policy: () => askTouch, answer: "allow" });
    await claudeAsks("toolu_1", { path: "a" });
    await expect(callTool("toolu_1", { path: "b" })).rejects.toThrow(/nobody was asked/);
    expect(await log()).not.toContain("tools/call");
  });

  it("lets a deny since win over any answer, and an automatic allow only while the policy still allows", async () => {
    let policy = askTouch;
    const { claudeAsks, callTool } = await setup({ policy: () => policy, answer: "allow" });
    await claudeAsks("toolu_1");
    policy = denyTouch;
    await expect(callTool("toolu_1")).rejects.toThrow(/denies/);

    policy = allowAll;
    await claudeAsks("toolu_2"); // an automatic allow
    policy = askTouch;
    await expect(callTool("toolu_2")).rejects.toThrow(/nobody was asked/);
    expect(await log()).not.toContain("tools/call");
  });

  it("serves nothing once the session has ended", async () => {
    const { session } = await setup({ policy: () => allowAll });
    session.abort();
    await expect(client!.listTools()).rejects.toThrow(/session has ended/);
  });

  it("refuses server names Claude's tool names cannot carry unambiguously", () => {
    for (const name of ["a__b", "_a", "a_", "a b", "x".repeat(65), ""])
      expect(() => checkClaudeSdkMcpServers("claude-sdk", [{ name }])).toThrow(OrcaError);
    expect(() => checkClaudeSdkMcpServers("claude-sdk", [{ name: "a" }, { name: "a" }])).toThrow(/two MCP servers/);
    expect(() => checkClaudeSdkMcpServers("claude-sdk", [{ name: "git-hub_tools2" }])).not.toThrow();
  });
});

/** A whole session, with the SDK stand-in as Claude, which can list a server's tools on its own. */
describe.runIf(process.platform !== "win32")("the relay's lifetime on a Claude Agent SDK session (#1125)", () => {
  const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));
  const open = async (env: Record<string, string>, startupTimeoutMs = 10_000) => {
    const claude = join(dir, "claude");
    await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`);
    await chmod(claude, 0o755);
    return openClaudeSdkSession({
      agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
      hostId: "local",
      cwd: dir,
      host: new LocalHost({ id: "local", type: "local" }),
      mcpServers: [
        { name: "tools", command: process.execPath, args: [join(dir, "server.cjs")], env: { SERVER_LOG: serverLog } },
      ],
      preflight: {
        executable: claude,
        env: { PATH: process.env.PATH ?? "", STAND_IN_LOG: join(dir, "claude.log"), ...env },
      },
      startupTimeoutMs,
      exitGraceMs: 1_000,
      logger: silentLogger,
    });
  };
  const answers = async () =>
    (await readFile(join(dir, "claude.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { mcp?: unknown })
      .filter((l) => l.mcp)
      .map((l) => JSON.stringify(l.mcp));
  const until = async (check: () => Promise<boolean>) => {
    for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50)))
      if (await check()) return;
  };

  it("serves a listing Claude sends while starting, once the session is ready", async () => {
    const session = await open({ STAND_IN_MCP_EARLY: "tools" });
    try {
      await until(async () => (await answers()).length > 0);
      expect((await answers())[0]).toContain('"name":"touch"');
      expect(await log()).toContain("started");
    } finally {
      await session.close();
    }
  });

  it("starts no server for a session that never became ready", async () => {
    const failed = await open({ STAND_IN_MCP_EARLY: "tools", STAND_IN_STARTUP: "silent" }, 300).catch(
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(OrcaError);
    await until(async () => (await answers()).length > 0);
    expect((await answers())[0]).toMatch(/not admitted|session closed/);
    expect(await log()).toBe("");
  });

  it("starts no server once teardown has begun", async () => {
    const session = await open({ STAND_IN_MCP_ON_END: "tools", STAND_IN_STUBBORN: "1" });
    await session.close();
    expect(await log()).toBe("");
  });
});
