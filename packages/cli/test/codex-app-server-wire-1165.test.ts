/**
 * The #1165 evidence harness's own wire reading and correlation, on small fixtures: no Codex,
 * no process. These check that the harness reads missing or unreadable evidence as unverified,
 * and fails only on a known opposite answer.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AgentProcessHandle } from "@orca/agents";
import { correlate, newWire, tapStdio, wireReader, type Decision, type Wire } from "./codex-app-server-wire.js";

const SHELL = "item/commandExecution/requestApproval";
const MCP = "mcpServer/elicitation/request";

/** A wire that saw one shell ask for `itemId`, and the answer `result` (or none) going back. */
function shellWire(itemId: string, result?: Record<string, unknown>, error?: unknown): Wire {
  const wire = newWire();
  wire.attached = true;
  const read = wireReader(wire);
  read.fromCodex({ id: 7, method: SHELL, params: { itemId } });
  if (result !== undefined) read.toCodex({ id: 7, result });
  if (error !== undefined) read.toCodex({ id: 7, error });
  return wire;
}
const decision = (toolCallId: string, d: string): Decision => ({ toolCallId, title: "t", decision: d });

describe("correlate", () => {
  it("an allow with accept on the wire is carried out", () => {
    const r = correlate([shellWire("c1", { decision: "accept" })], [decision("c1", "allow")]);
    expect(r.rows.map((x) => x.verdict)).toEqual(["carried out"]);
    expect(r).toMatchObject({ failures: [], unverified: [], askCount: 1 });
  });

  it("an allow with decline on the wire fails", () => {
    const r = correlate([shellWire("c1", { decision: "decline" })], [decision("c1", "allow")]);
    expect(r.rows[0]!.verdict).toBe("contradicted");
    expect(r.failures).toHaveLength(1);
  });

  it("a deny with accept on the wire fails", () => {
    const r = correlate([shellWire("c1", { decision: "accept" })], [decision("c1", "deny")]);
    expect(r.rows[0]!.verdict).toBe("contradicted");
    expect(r.failures).toHaveLength(1);
  });

  it("a deny with decline on the wire is carried out", () => {
    const r = correlate([shellWire("c1", { decision: "decline" })], [decision("c1", "deny")]);
    expect(r.rows[0]!.verdict).toBe("carried out");
    expect(r.failures).toEqual([]);
  });

  it.each([
    ["no answer seen", shellWire("c1")],
    ["an error answer", shellWire("c1", undefined, { code: -1, message: "x" })],
    ["an unreadable answer", shellWire("c1", { something: "else" })],
  ])("a deny with %s is unverified, not carried out", (_, wire) => {
    const r = correlate([wire], [decision("c1", "deny")]);
    expect(r.rows[0]!.verdict).toBe("unverified");
    expect(r.failures).toEqual([]);
    expect(r.unverified).toHaveLength(1);
  });

  it("an ask with no ORCA decision is unverified", () => {
    const r = correlate([shellWire("c1", { decision: "decline" })], []);
    expect(r.rows[0]!.orcaDecision).toBe("unverified");
    expect(r.unverified).toHaveLength(1);
  });

  it("a decision with no ask on the wire is unverified", () => {
    const r = correlate([shellWire("c1", { decision: "accept" })], [decision("c1", "allow"), decision("c2", "deny")]);
    expect(r.unverified).toEqual([expect.stringContaining("c2")]);
  });

  it("codex-side decisions are not ORCA decisions", () => {
    const r = correlate(
      [shellWire("c1", { decision: "accept" })],
      [decision("c1", "allow"), decision("c1", "codex:x")],
    );
    expect(r.rows[0]!.verdict).toBe("carried out");
  });

  it("a wire whose tap was not attached makes the ask count unverified, not zero", () => {
    const wire = newWire();
    const r = correlate([wire], []);
    expect(r).toMatchObject({ observed: false, askCount: "unverified" });
    expect(r.unverified).toHaveLength(1);
  });

  it("an attached tap that read nothing from Codex is not an observed exchange", () => {
    const wire = newWire();
    wire.attached = true;
    expect(correlate([wire], [])).toMatchObject({ observed: false, askCount: "unverified" });
  });

  it("a process started with no wire makes the exchange unobserved", () => {
    const r = correlate([shellWire("c1", { decision: "accept" })], [decision("c1", "allow")], 2);
    expect(r).toMatchObject({ observed: false, askCount: "unverified" });
  });

  it("an observed exchange with no asks counts zero", () => {
    const wire = newWire();
    wire.attached = true;
    wireReader(wire).fromCodex({ method: "turn/started", params: {} });
    expect(correlate([wire], [])).toMatchObject({ observed: true, askCount: 0, unverified: [] });
  });
});

describe("wireReader", () => {
  const mcpItem = (method: "item/started" | "item/completed", id: string, file: string) => ({
    method,
    params: { item: { type: "mcpToolCall", id, server: "t", tool: "touch", arguments: { file } } },
  });
  const elicit = (file: string) => ({
    id: 9,
    method: MCP,
    params: {
      serverName: "t",
      _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "touch", tool_params: { file } },
    },
  });

  it("matches an MCP ask to the one live call with the same server, tool and arguments", () => {
    const wire = newWire();
    const read = wireReader(wire);
    read.fromCodex(mcpItem("item/started", "m1", "a"));
    read.fromCodex(mcpItem("item/started", "m2", "b"));
    read.fromCodex(elicit("a"));
    expect(wire.asks[0]).toMatchObject({ method: MCP, itemId: null, matchedItem: "m1" });
  });

  it("leaves an MCP ask unmatched when two live calls fit, or none does", () => {
    const wire = newWire();
    const read = wireReader(wire);
    read.fromCodex(mcpItem("item/started", "m1", "a"));
    read.fromCodex(mcpItem("item/started", "m2", "a"));
    read.fromCodex(elicit("a"));
    read.fromCodex(mcpItem("item/completed", "m1", "a"));
    read.fromCodex(mcpItem("item/completed", "m2", "a"));
    read.fromCodex({ ...elicit("a"), id: 10 });
    expect(wire.asks.map((a) => a.matchedItem)).toEqual([null, null]);
  });

  it("reads an MCP answer's action, and a thread request's answer", () => {
    const wire = newWire();
    const read = wireReader(wire);
    read.toCodex({ id: 1, method: "thread/start", params: {} });
    read.fromCodex({ id: 1, result: { thread: { id: "th" } } });
    read.toCodex({ id: 2, method: "thread/resume", params: {} });
    read.fromCodex({ id: 2, error: { code: -1, message: "x" } });
    read.fromCodex(elicit("a"));
    read.toCodex({ id: 9, result: { action: "decline", content: null } });
    expect(wire.threadRequests).toEqual([
      { method: "thread/start", answered: "thread" },
      { method: "thread/resume", answered: "error" },
    ]);
    expect(wire.asks[0]!.answer).toBe("decline");
    expect(wire.seen).toEqual({ fromCodex: 3, toCodex: 3 });
  });
});

describe("wireReader commands and turns", () => {
  it("records when each command item started and finished, and the turn's status", () => {
    const wire = newWire();
    const read = wireReader(wire);
    const cmd = (method: string, status: string) => ({
      method,
      params: { item: { type: "commandExecution", id: "c1", status } },
    });
    read.fromCodex(cmd("item/started", "inProgress"));
    read.fromCodex({ method: "turn/completed", params: { turn: { id: "t", status: "interrupted" } } });
    expect(wire.commands).toEqual([{ itemId: "c1", startedAt: expect.any(Number), completedAt: null, status: null }]);
    read.fromCodex(cmd("item/completed", "failed"));
    expect(wire.commands[0]).toMatchObject({ completedAt: expect.any(Number), status: "failed" });
    expect(wire.turns).toEqual([{ completedAt: expect.any(Number), status: "interrupted" }]);
  });
});

describe("tapStdio", () => {
  const handle = (stdio?: AgentProcessHandle["stdio"]) => ({ stdio }) as unknown as AgentProcessHandle;

  it("leaves the wire unattached on a handle with no stdio", () => {
    const wire = newWire();
    const h = handle();
    tapStdio(h, wire);
    expect("stdio" in h && h.stdio !== undefined).toBe(false);
    expect(wire.attached).toBe(false);
  });

  it("attaches only once the stdio is taken, and passes bytes through unchanged", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const wire = newWire();
    const h = handle(() => ({ stdin, stdout }));
    tapStdio(h, wire);
    expect(wire.attached).toBe(false);
    const io = h.stdio!();
    expect(wire.attached).toBe(true);
    const fromCodex = `${JSON.stringify({ id: 7, method: SHELL, params: { itemId: "c1" } })}\nnot json\n`;
    const toCodex = `${JSON.stringify({ id: 7, result: { decision: "decline" } })}\n`;
    const readAll = (s: NodeJS.ReadableStream) => new Promise<string>((done) => s.once("data", (d) => done(String(d))));
    const orcaGot = readAll(io.stdout);
    const codexGot = readAll(stdin);
    stdout.write(fromCodex);
    io.stdin.write(toCodex);
    expect(await orcaGot).toBe(fromCodex);
    expect(await codexGot).toBe(toCodex);
    expect(wire.asks).toEqual([
      { id: 7, method: SHELL, itemId: "c1", approvalId: null, approvalKind: null, answer: "decline" },
    ]);
  });
});
