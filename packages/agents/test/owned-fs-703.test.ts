/**
 * ORCA's own file executor is held to the policy (#703).
 *
 * An agent that is given `fs/*` asks ORCA to read and write its files. Before this, those
 * requests checked the session roots and ORCA's own files and nothing else, so an agent that
 * never sent `session/request_permission` wrote whatever the policy would have refused. Here a
 * real ACP agent over stdio makes the calls, and each is decided by the policy just before
 * the I/O: a deny refuses, an ask needs a one-time allow, and that allow is good once.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSpecSchema, type PermissionRule } from "@orca/core";
import { LocalHost, OwnedFsGate, fsToolCall, openAcpSession } from "@orca/agents";

/**
 * An ACP agent that performs the operations in `OPS` during each turn — `fs/*` requests and
 * `session/request_permission` asks — and writes what came back for each to `RESULT_LOG`.
 */
const probingAgent = `
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
  if (op.write !== undefined) return request("fs/write_text_file", { sessionId: "s1", path: op.write, content: op.content });
  if (op.read !== undefined) return request("fs/read_text_file", { sessionId: "s1", path: op.read });
  return request("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "t", title: op.title, kind: op.ask, locations: (op.paths || []).map((path) => ({ path })) },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
};
rl.on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize")
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, agentCapabilities: { loadSession: false }, agentInfo: { name: "prober", version: "0" } } });
  else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    const results = [];
    for (const op of JSON.parse(process.env.OPS)) results.push(await perform(op));
    require("node:fs").writeFileSync(process.env.RESULT_LOG, JSON.stringify(results));
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  } else if (m.id !== undefined && waiting.has(m.id)) {
    const resolve = waiting.get(m.id);
    waiting.delete(m.id);
    resolve(m.error ? { error: m.error.data } : { result: m.result });
  }
});
setInterval(() => {}, 1000);
`;

type Op = { write: string; content: string } | { read: string } | { ask: string; title: string; paths?: string[] };
type Outcome = { result?: unknown; error?: { path?: string; reason?: string } };

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
async function workspace(): Promise<string> {
  const dir = await temp("orca-owned-fs-");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), "export {};\n", "utf8");
  return dir;
}

/**
 * One turn of the probing agent with `policy`. `answer` stands for the person: it gets each
 * ask ORCA puts through and returns an option id, or undefined for no answer channel at all.
 */
async function turn(
  dir: string,
  ops: Op[],
  policy: { default?: "allow" | "deny" | "ask"; rules?: PermissionRule[] },
  answer?: (request: acp.RequestPermissionRequest) => string | undefined,
): Promise<{ outcomes: Outcome[]; decisions: string[]; asked: acp.RequestPermissionRequest[] }> {
  const log = join(await temp("orca-owned-fs-log-"), "results.json");
  const agent = AgentSpecSchema.parse({
    id: "prober",
    command: process.execPath,
    args: ["-e", probingAgent],
    env: { OPS: JSON.stringify(ops), RESULT_LOG: log },
    permissions: { rules: [], ...policy },
  });
  const decisions: string[] = [];
  const asked: acp.RequestPermissionRequest[] = [];
  const session = await openAcpSession({
    host: new LocalHost({ id: "local", type: "local" }),
    agent,
    cwd: dir,
    onPermission: (info) => void decisions.push(info.decision),
    ...(answer
      ? {
          askPermission: async (request: acp.RequestPermissionRequest) => {
            asked.push(request);
            return answer(request);
          },
        }
      : {}),
  });
  try {
    await session.prompt("go");
  } finally {
    await session.close();
  }
  return { outcomes: JSON.parse(await readFile(log, "utf8")) as Outcome[], decisions, asked };
}

const refused = (o: Outcome | undefined) => o?.error?.reason;

describe("the policy decides ORCA's own file executor (#703)", () => {
  it("refuses a write the policy denies, though the agent never asked", async () => {
    const dir = await workspace();
    const secret = join(dir, "src", "a.ts");
    const { outcomes, decisions } = await turn(dir, [{ write: secret, content: "pwned" }], {
      rules: [{ match: { kind: "edit", path: "src/a.ts" }, decision: "deny" }],
    });
    expect(refused(outcomes[0])).toMatch(/not allowed: deny/);
    expect(decisions).toEqual(["fs:deny"]);
    expect(await readFile(secret, "utf8")).toBe("export {};\n");
  });

  it("refuses an ask nobody can answer, before any I/O", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const { outcomes, decisions } = await turn(dir, [{ write: file, content: "x" }, { read: file }], {
      default: "ask",
    });
    expect(refused(outcomes[0])).toMatch(/ask:no-answerer/);
    expect(refused(outcomes[1])).toMatch(/ask:no-answerer/);
    expect(decisions).toEqual(["fs:ask:no-answerer", "fs:ask:no-answerer"]);
    expect(await readFile(file, "utf8")).toBe("export {};\n");
  });

  it("asks on the agent's behalf when it did not, and a one-time allow covers that one call", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "b.ts");
    let answered = 0;
    const { outcomes, decisions, asked } = await turn(
      dir,
      [
        { write: file, content: "one" },
        { write: file, content: "two" },
      ],
      { default: "ask" },
      () => (answered++ === 0 ? "allow" : "reject"),
    );
    // The first is allowed once; the second is asked again and refused.
    expect(outcomes[0]).toEqual({ result: {} });
    expect(refused(outcomes[1])).toMatch(/ask:reject_once/);
    expect(asked.map((r) => [r.toolCall.kind, r.toolCall.title])).toEqual([
      ["edit", `Write ${file}`],
      ["edit", `Write ${file}`],
    ]);
    expect(asked.flatMap((r) => r.options.map((o) => o.kind))).not.toContain("allow_always");
    expect(decisions).toEqual(["fs:ask:allow_once", "fs:ask:reject_once"]);
    expect(await readFile(file, "utf8")).toBe("one");
  });

  it("lets an agent that asked first write once on that answer, without asking twice", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "c.ts");
    const { outcomes, decisions, asked } = await turn(
      dir,
      [
        { ask: "edit", title: "Edit c.ts", paths: [file] },
        { write: file, content: "first" },
        { write: file, content: "second" },
        { read: file },
      ],
      { default: "ask" },
      (request) => (request.toolCall.title === "Edit c.ts" ? "allow" : "reject"),
    );
    expect(outcomes[0]).toEqual({ result: { outcome: { outcome: "selected", optionId: "allow" } } });
    // The permit is spent by the first write: the second is put to a person and refused.
    expect(outcomes[1]).toEqual({ result: {} });
    expect(refused(outcomes[2])).toMatch(/ask:reject_once/);
    // A permit to write is not a permit to read.
    expect(refused(outcomes[3])).toMatch(/ask:reject_once/);
    expect(asked.map((r) => r.toolCall.title)).toEqual(["Edit c.ts", `Write ${file}`, `Read ${file}`]);
    expect(decisions).toEqual(["ask:allow_once", "fs:permit", "fs:ask:reject_once", "fs:ask:reject_once"]);
    expect(await readFile(file, "utf8")).toBe("first");
  });

  it("lets what the policy allows through without asking", async () => {
    const dir = await workspace();
    const file = join(dir, "src", "a.ts");
    const { outcomes, decisions, asked } = await turn(
      dir,
      [{ write: file, content: "ok" }, { read: file }],
      {
        default: "ask",
        rules: [
          { match: { kind: "edit", path: "src/a.ts" }, decision: "allow" },
          { match: { kind: "read", scope: "workspace" }, decision: "allow" },
        ],
      },
      () => "reject",
    );
    expect(outcomes[0]).toEqual({ result: {} });
    expect(outcomes[1]).toEqual({ result: { content: "ok" } });
    expect(asked).toEqual([]);
    expect(decisions).toEqual(["fs:allow", "fs:allow"]);
  });
});

describe("one-use permits", () => {
  const ask = (kind: acp.ToolKind, path: string): acp.ToolCallUpdate => ({
    toolCallId: "t",
    title: "x",
    kind,
    locations: [{ path }],
  });

  it("are minted only by a one-time allow, for the access the kind stands for", () => {
    const gate = new OwnedFsGate("/w");
    gate.mint("t1", ask("edit", "/w/a.ts"), "allow_always");
    gate.mint("t1", ask("edit", "/w/a.ts"), "reject_once");
    gate.mint("t1", ask("execute", "/w/a.ts"), "allow_once");
    expect(gate.outstanding).toBe(0);
    gate.mint("t1", ask("search", "/w/a.ts"), "allow_once");
    expect(gate.spend("t1", "/w/a.ts", "write")).toBe(false);
    expect(gate.spend("t1", "a.ts", "read")).toBe(true);
  });

  it("are spent once, stay in their turn, and die with it", () => {
    const gate = new OwnedFsGate("/w");
    gate.mint("t1", ask("edit", "/w/a.ts"), "allow_once");
    expect(gate.spend("t2", "/w/a.ts", "write")).toBe(false);
    expect(gate.spend("t1", "/w/b.ts", "write")).toBe(false);
    expect(gate.spend("t1", "/w/a.ts", "write")).toBe(true);
    expect(gate.spend("t1", "/w/a.ts", "write")).toBe(false);
    gate.mint("t1", ask("edit", "/w/a.ts"), "allow_once");
    gate.endTurn("t1");
    expect(gate.spend("t1", "/w/a.ts", "write")).toBe(false);
  });

  it("decide a file call as the kind an ask for it would carry", () => {
    expect(fsToolCall("/w/a.ts", "read")).toMatchObject({ kind: "read", title: "Read /w/a.ts" });
    expect(fsToolCall("/w/a.ts", "write")).toMatchObject({ kind: "edit", title: "Write /w/a.ts" });
  });
});
