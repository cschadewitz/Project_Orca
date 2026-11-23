/**
 * A session with ORCA's pre-tool hook is held away from ORCA's host services until its
 * runtime is admitted (#704). `openAcpSession`'s `admission` is that hold: here a real ACP
 * agent over stdio asks ORCA to read a file, write one and ask a person the moment its
 * session exists, before anybody has given it work, and again in its first turn; the effects
 * are read from disk, not from what the session reports.
 *
 * Outside a turn ORCA already answers no file request and no ask (#703). The hold is ahead
 * of that rule and does not depend on it: nothing is served to a session that has not been
 * admitted, however the turn bookkeeping changes.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import { LocalHost, openAcpSession, type AgentSession } from "@orca/agents";

/**
 * An ACP agent that, as soon as it has answered `session/new`, makes each request in `OPS` of
 * ORCA and writes what came back for each to `RESULT_LOG`; and in each turn does the same
 * again, into `RESULT_LOG.turn`.
 */
const eagerAgent = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let nextId = 1000;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const perform = (op) => {
  if (op.write !== undefined) return request("fs/write_text_file", { sessionId: "s1", path: op.write, content: "agent" });
  if (op.read !== undefined) return request("fs/read_text_file", { sessionId: "s1", path: op.read });
  return request("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "t", title: "rm -rf work", kind: "execute" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  });
};
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "eager", version: "0" } } });
  else if (m.method === "session/new") {
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
    const results = await Promise.all(JSON.parse(process.env.OPS).map(perform));
    require("node:fs").writeFileSync(process.env.RESULT_LOG, JSON.stringify(results));
  } else if (m.method === "session/prompt") {
    const results = [];
    for (const op of JSON.parse(process.env.OPS)) results.push(await perform(op));
    require("node:fs").writeFileSync(process.env.RESULT_LOG + ".turn", JSON.stringify(results));
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve(m.error ? { error: m.error.data } : { result: m.result });
  }
});
setInterval(() => {}, 1000);
`;

const dirs: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(admission: Promise<void> | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "orca-704-admission-"));
  dirs.push(dir);
  const agentFile = join(dir, "agent.cjs");
  await writeFile(agentFile, eagerAgent);
  const secret = join(dir, "notes.txt");
  await writeFile(secret, "private");
  const written = join(dir, "written.txt");
  const log = join(dir, "results.json");
  const asked: string[] = [];
  const session = await openAcpSession({
    host: new LocalHost({ id: "local", type: "local" }),
    agent: AgentSpecSchema.parse({
      id: "eager",
      command: process.execPath,
      args: [agentFile],
      env: { OPS: JSON.stringify([{ read: secret }, { write: written }, { ask: true }]), RESULT_LOG: log },
      permissions: { default: "allow", rules: [] },
    }),
    cwd: dir,
    askPermission: async (req) => {
      asked.push(req.toolCall.title ?? "");
      return "allow";
    },
    handshakeTimeoutMs: 10_000,
    ...(admission ? { admission } : {}),
  });
  sessions.push(session);
  const results = async (file = log) => {
    for (let i = 0; i < 100; i++) {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text !== undefined) return JSON.parse(text) as { result?: unknown; error?: { reason?: string } }[];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the agent never logged its results");
  };
  return { session, written, asked, results, log };
}

/** Whether a file exists yet; the agent's requests run concurrently with the test. */
const exists = (path: string) =>
  readFile(path, "utf8").then(
    () => true,
    () => false,
  );

describe("holding a session away from ORCA's host services until it is admitted (#704)", () => {
  it("answers nothing while admission is pending, and refuses everything once it is refused", async () => {
    let refuse!: (e: Error) => void;
    const admission = new Promise<void>((_, reject) => (refuse = reject));
    const t = await setup(admission);
    // The agent has asked; nothing has been answered, read or written.
    await new Promise((r) => setTimeout(r, 300));
    expect(await exists(t.log)).toBe(false);
    expect(await exists(t.written)).toBe(false);
    refuse(new Error("the runtime is not the one ORCA verified"));
    const [read, write, ask] = await t.results();
    expect(read).toEqual({ error: expect.objectContaining({ reason: "the session was not admitted" }) });
    expect(write).toEqual({ error: expect.objectContaining({ reason: "the session was not admitted" }) });
    expect(ask).toEqual({ result: { outcome: { outcome: "cancelled" } } });
    expect(await exists(t.written)).toBe(false);
    expect(t.asked).toEqual([]);
  });

  it("passes the held requests on to ORCA's usual rules once the session is admitted", async () => {
    let admit!: () => void;
    const admission = new Promise<void>((resolve) => (admit = resolve));
    const t = await setup(admission);
    await new Promise((r) => setTimeout(r, 300));
    expect(await exists(t.log)).toBe(false);
    admit();
    // Admitted, but still outside a turn: the next rule answers, and it answers no.
    const [read, write, ask] = await t.results();
    expect(read).toEqual({ error: expect.objectContaining({ reason: expect.stringContaining("no live turn") }) });
    expect(write).toEqual({ error: expect.objectContaining({ reason: expect.stringContaining("no live turn") }) });
    expect(ask).toEqual({ result: { outcome: { outcome: "cancelled" } } });
    // In a turn, the admitted session is served as any other.
    await t.session.prompt([{ type: "text", text: "go" }]);
    const [turnRead, turnWrite, turnAsk] = await t.results(`${t.log}.turn`);
    expect(turnRead).toEqual({ result: { content: "private" } });
    expect(turnWrite).toEqual({ result: {} });
    expect(await readFile(t.written, "utf8")).toBe("agent");
    // The policy (`default: allow`) answers the ask itself; it is decided, not cancelled.
    expect(turnAsk).toEqual({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
  });

  it("refuses in a turn too, if a session's admission was refused", async () => {
    const admission = Promise.reject(new Error("refused"));
    // Already settled before the session observes it; that is not an unhandled refusal.
    admission.catch(() => undefined);
    const t = await setup(admission);
    await t.session.prompt([{ type: "text", text: "go" }]);
    const [read, write, ask] = await t.results(`${t.log}.turn`);
    expect(read).toEqual({ error: expect.objectContaining({ reason: "the session was not admitted" }) });
    expect(write).toEqual({ error: expect.objectContaining({ reason: "the session was not admitted" }) });
    expect(ask).toEqual({ result: { outcome: { outcome: "cancelled" } } });
    expect(await exists(t.written)).toBe(false);
    expect(t.asked).toEqual([]);
  });

  it("waits for nothing when there is no admission to wait for", async () => {
    const t = await setup(undefined);
    await t.session.prompt([{ type: "text", text: "go" }]);
    const [read] = await t.results(`${t.log}.turn`);
    expect(read).toEqual({ result: { content: "private" } });
  });
});
