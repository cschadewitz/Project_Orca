/**
 * The session reads the permission sidecar *per ask* (#271).
 *
 * ADR 0009 decided that "allow always" writes a rule to `orca.permissions.json` and that the
 * sidecar is read as a layer after the agent's configured rules. Until #271 only the writing
 * half ran: `openAcpSession` evaluated `agent.permissions` once, at `session/new`, so a rule
 * recorded while a run was in flight — which is when it is recorded, because somebody was
 * answering that run's prompt — never decided anything.
 *
 * So the agent here asks twice in one turn, and the grant is written between the two asks,
 * through `recordAlwaysDecision` (the writer the daemon's `inputs.answer` calls). The second
 * ask must be decided `allow` by the policy alone, without the `ask` callback being reached.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { AgentSpecSchema, type LogLevel, type Logger } from "@orca/core";
import {
  LocalHost,
  openAcpSession,
  permissionPolicyPath,
  recordAlwaysDecision,
  type AgentSession,
} from "@orca/agents";

/**
 * A minimal ACP agent that raises two `session/request_permission` requests for the same
 * tool call, one after the other, and ends the turn. Sequential on purpose: the point is
 * that the *second* ask is evaluated against the file as it stands by then.
 */
const askingAgent = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const ask = (n) =>
  request("session/request_permission", {
    sessionId: "s1",
    toolCall: {
      toolCallId: "t" + n,
      title: "Write " + process.env.TOOL_PATH,
      kind: "edit",
      locations: [{ path: process.env.TOOL_PATH }],
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    reply(m.id, { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "asker", version: "0" } });
  else if (m.method === "session/new") reply(m.id, { sessionId: "s1" });
  else if (m.method === "session/prompt") {
    await ask(1);
    await ask(2);
    reply(m.id, { stopReason: "end_turn" });
  } else if (m.id !== undefined && m.result !== undefined) {
    const resolve = waiting.get(m.id);
    if (resolve) {
      waiting.delete(m.id);
      resolve(m.result);
    }
  }
});
setInterval(() => {}, 1000);
`;

interface Logged {
  level: LogLevel;
  msg: string;
  fields: Record<string, unknown>;
}

function capturingLogger(out: Logged[]): Logger {
  const logger: Logger = {
    log: (level, msg, fields) => void out.push({ level, msg, fields: fields ?? {} }),
    debug: (msg, fields) => logger.log("debug", msg, fields),
    info: (msg, fields) => logger.log("info", msg, fields),
    warn: (msg, fields) => logger.log("warn", msg, fields),
    error: (msg, fields) => logger.log("error", msg, fields),
    child: () => logger,
  };
  return logger;
}

/**
 * One session over the asking agent, with `default: ask` so every tool call reaches the
 * policy, and `onAsk` standing in for the human-input port the engine wires.
 */
async function run(opts: {
  dir: string;
  permissionFiles: readonly string[];
  onAsk: (request: acp.RequestPermissionRequest) => Promise<string | undefined>;
  logger?: Logger;
}): Promise<{ session: AgentSession; decisions: string[] }> {
  const host = new LocalHost({ id: "local", type: "local" });
  const agent = AgentSpecSchema.parse({
    id: "asker",
    command: process.execPath,
    args: ["-e", askingAgent],
    env: { TOOL_PATH: join(opts.dir, "note.md") },
    permissions: { default: "ask" },
  });
  const decisions: string[] = [];
  const session = await openAcpSession({
    host,
    agent,
    cwd: opts.dir,
    permissionFiles: opts.permissionFiles,
    askPermission: opts.onAsk,
    onPermission: (info) => void decisions.push(info.decision),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  await session.prompt("go");
  return { session, decisions };
}

describe("the sidecar decides the next ask, not the next session", () => {
  it("answers the second ask from a rule written after the first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-perm-"));
    const file = permissionPolicyPath(dir);
    const asked: string[] = [];

    const { session, decisions } = await run({
      dir,
      permissionFiles: [file],
      onAsk: async (request) => {
        asked.push(request.toolCall.toolCallId ?? "");
        // Exactly what `inputs.answer` with `always` does in the daemon, while the session
        // that raised the ask is still open.
        await recordAlwaysDecision({ file, agentId: "asker", request, decision: "allow", workspaceCwd: dir });
        return "allow";
      },
    });
    await session.close();

    // One ask reached a person; the second never did.
    expect(asked).toEqual(["t1"]);
    expect(decisions).toEqual(["ask:allow_once", "allow"]);
    // And the rule that decided it is workspace-relative, so it survives the next worktree.
    const written = JSON.parse(await readFile(file, "utf8")) as {
      agents: Record<string, { rules: { match: { path?: string } }[] }>;
    };
    expect(written.agents["asker"]?.rules[0]?.match.path).toBe("note.md");
  });

  it("falls back to the configured rules when the sidecar is corrupt, and says so once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-perm-"));
    const file = permissionPolicyPath(dir);
    await writeFile(file, "{ this is not json", "utf8");
    const logged: Logged[] = [];
    const asked: string[] = [];

    const { session, decisions } = await run({
      dir,
      permissionFiles: [file],
      logger: capturingLogger(logged),
      onAsk: async (request) => {
        asked.push(request.toolCall.toolCallId ?? "");
        return "allow";
      },
    });
    await session.close();

    // An unreadable sidecar must not block the agent: both asks were evaluated, against the
    // configured `ask` default, and both reached the answerer.
    expect(asked).toEqual(["t1", "t2"]);
    expect(decisions).toEqual(["ask:allow_once", "ask:allow_once"]);
    // Logged at warn, and once - two asks are two reads of the same broken file.
    const warnings = logged.filter((l) => l.level === "warn" && l.msg.includes("sidecar"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({ file });
  });
});
