/**
 * The Codex app-server session driver (#1157) against a scripted app-server: what opens and
 * what is refused (reviewer, approval policy, working directory, login, version, host, policy
 * given), how a turn's items become ACP updates and its end a stop reason, cancel, asks
 * declined until #1159, config options, close, and the host handle's one-reader rule.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, silentLogger, type OrcaError } from "@orca/core";
import {
  codexItemUpdate,
  codexPlanUpdate,
  codexStopReason,
  LocalHost,
  openCodexAppServerSession,
  stripShellPrefix,
  wrapAgentProcess,
  type AgentHost,
  type AgentProcessHandle,
  type SessionUpdateEvent,
} from "../src/index.js";

const CWD = process.cwd();
const INIT = {
  userAgent: "orca/0.171.0 (test)",
  codexHome: "/h/.codex",
  platformFamily: "unix",
  platformOs: "linux",
};
const MODELS = {
  data: [
    {
      model: "gpt-5.5",
      displayName: "GPT-5.5",
      description: "d",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "high", description: "" },
      ],
    },
    { model: "gpt-5", displayName: "GPT-5", description: "", hidden: false, supportedReasoningEfforts: [] },
    { model: "secret", displayName: "S", description: "", hidden: true, supportedReasoningEfforts: [] },
  ],
  nextCursor: null,
};

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown };
type Responder = (msg: Msg, peer: Peer) => unknown;

interface Peer {
  received: Msg[];
  say(message: unknown): void;
  notify(method: string, params: Record<string, unknown>): void;
}

/** A host whose one agent is a scripted app-server answering by method. */
function scriptedHost(answers: Record<string, Responder>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: Msg[] = [];
  const peer: Peer = {
    received,
    say: (m) => stdout.write(JSON.stringify(m) + "\n"),
    notify: (method, params) => peer.say({ method, params }),
  };
  let buffer = "";
  stdin.on("data", (d: Buffer) => {
    buffer += d.toString();
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const msg = JSON.parse(buffer.slice(0, nl)) as Msg;
      buffer = buffer.slice(nl + 1);
      received.push(msg);
      if (msg.method && msg.id !== undefined) {
        const answer = answers[msg.method];
        if (!answer) peer.say({ id: msg.id, error: { code: -32600, message: `unknown variant \`${msg.method}\`` } });
        else {
          const result = answer(msg, peer);
          if (result !== NO_ANSWER) peer.say({ id: msg.id, result });
        }
      }
    }
  });
  let exit!: (e: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => (exit = r));
  const kill = vi.fn(() => exit({ code: null, signal: "SIGTERM" }));
  const handle: AgentProcessHandle = {
    get stream(): never {
      throw new Error("no ACP stream");
    },
    stdio: () => ({ stdin, stdout }),
    pid: 4242,
    exited,
    stderrTail: () => "",
    kill,
  };
  const spawnAgent = vi.fn(async (_spec: unknown) => handle);
  const host = new LocalHost({ id: "local", type: "local" }) as AgentHost;
  host.spawnAgent = spawnAgent;
  return { host, peer, spawnAgent, kill };
}

const NO_ANSWER = Symbol("no answer");

const THREAD = (over: Record<string, unknown> = {}) => ({
  thread: { id: "thr_1" },
  model: "gpt-5.5",
  modelProvider: "openai",
  serviceTier: null,
  disabledPluginIds: [],
  cwd: CWD,
  instructionSources: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite" },
  reasoningEffort: "low",
  ...over,
});

const BASE: Record<string, Responder> = {
  initialize: () => INIT,
  "account/read": () => ({ account: { type: "apiKey" }, userId: null, requiresOpenaiAuth: true }),
  "thread/start": () => THREAD(),
  "model/list": () => MODELS,
  "thread/unsubscribe": () => ({ status: "unsubscribed" }),
};

const agent = (more: Record<string, unknown> = {}) =>
  AgentSpecSchema.parse({ id: "codex", command: process.execPath, driver: "codex-app-server", ...more });

const open = (host: AgentHost, more: Partial<Parameters<typeof openCodexAppServerSession>[0]> = {}) =>
  openCodexAppServerSession({
    host,
    agent: agent(),
    cwd: CWD,
    thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    logger: silentLogger,
    ...more,
  });

describe("opening a session", () => {
  it("handshakes, checks the login, and starts the thread with reviewer user and the given policy", async () => {
    const s = scriptedHost(BASE);
    const session = await open(s.host);
    expect(session.acpSessionId).toBe("thr_1");
    const methods = s.peer.received.map((m) => m.method);
    expect(methods.slice(0, 5)).toEqual(["initialize", "initialized", "account/read", "thread/start", "model/list"]);
    expect(s.peer.received.find((m) => m.method === "account/read")?.params).toEqual({});
    expect(s.peer.received.find((m) => m.method === "thread/start")?.params).toEqual({
      cwd: CWD,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    // the launch is the agent's command with app-server after its arguments
    expect(s.spawnAgent.mock.calls[0]![0]).toMatchObject({ command: process.execPath, args: ["app-server"] });
    await session.close();
    expect(s.peer.received.at(-1)).toMatchObject({ method: "thread/unsubscribe", params: { threadId: "thr_1" } });
    expect(s.kill).toHaveBeenCalled();
  });

  it("passes the agent's default model to the thread", async () => {
    const s = scriptedHost(BASE);
    const session = await open(s.host, { agent: agent({ defaultModel: "gpt-5" }) });
    expect(s.peer.received.find((m) => m.method === "thread/start")?.params).toMatchObject({ model: "gpt-5" });
    await session.close();
  });

  const refusedWith = async (answers: Record<string, Responder>, pattern: RegExp, code = "NOT_SUPPORTED") => {
    const s = scriptedHost({ ...BASE, ...answers });
    const error = (await open(s.host).catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe(code);
    expect(error.message).toMatch(pattern);
    expect(s.kill).toHaveBeenCalled();
    return s;
  };

  it("refuses a thread whose reviewer is not user", async () => {
    for (const reviewer of ["auto_review", "guardian_subagent", undefined])
      await refusedWith(
        { "thread/start": () => THREAD({ approvalsReviewer: reviewer }) },
        /Codex started the thread with approvals reviewer .*, not what ORCA asked for\. ORCA refuses the session\./,
      );
  });

  it("refuses a thread with another approval policy or working directory", async () => {
    await refusedWith({ "thread/start": () => THREAD({ approvalPolicy: "never" }) }, /approval policy "never"/);
    await refusedWith(
      { "thread/start": () => THREAD({ cwd: "/somewhere/else" }) },
      /working directory "\/somewhere\/else"/,
    );
    await refusedWith({ "thread/start": () => THREAD({ thread: {} }) }, /without a thread id/, "AGENT_PROTOCOL");
  });

  it("refuses a Codex with no login, and starts no thread", async () => {
    const s = await refusedWith(
      { "account/read": () => ({ account: null, userId: null, requiresOpenaiAuth: true }) },
      /Run `codex login`/,
    );
    expect(s.peer.received.some((m) => m.method === "thread/start")).toBe(false);
  });

  it("refuses an unpinned Codex before anything else", async () => {
    const s = await refusedWith(
      { initialize: () => ({ ...INIT, userAgent: "orca/0.170.0" }) },
      /only with Codex 0\.171\.0/,
    );
    expect(s.peer.received.map((m) => m.method)).toEqual(["initialize"]);
  });

  it("refuses without a policy, with full access or never, on another host, and for an ACP agent", async () => {
    const s = scriptedHost(BASE);
    for (const thread of [
      undefined,
      { approvalPolicy: "never", sandbox: "workspace-write" },
      { approvalPolicy: "on-request", sandbox: "danger-full-access" },
    ])
      await expect(open(s.host, { thread: thread as never })).rejects.toThrow(/needs an approval policy/);
    const ssh = scriptedHost(BASE).host;
    Object.defineProperty(ssh, "spec", { value: { id: "box", type: "ssh" } });
    await expect(open(ssh)).rejects.toThrow(/runs on ssh host box/);
    await expect(open(s.host, { agent: AgentSpecSchema.parse({ id: "codex", command: "codex-acp" }) })).rejects.toThrow(
      /does not ask for driver: codex-app-server/,
    );
    expect(s.spawnAgent).not.toHaveBeenCalled();
  });
});

describe("a turn", () => {
  /** A Codex that plays `items` for each turn and ends it with `status`. */
  function turnPlaying(play: (peer: Peer, turnId: string) => void, status = "completed"): Record<string, Responder> {
    let n = 0;
    return {
      ...BASE,
      "turn/start": (_msg, peer) => {
        const turnId = `turn_${++n}`;
        setImmediate(() => {
          play(peer, turnId);
          if (status !== "none")
            peer.notify("turn/completed", {
              threadId: "thr_1",
              turn: { id: turnId, status, error: status === "failed" ? { message: "model refused" } : null },
            });
        });
        return { turn: { id: turnId, status: "inProgress" } };
      },
      "turn/interrupt": (msg, peer) => {
        setImmediate(() =>
          peer.notify("turn/completed", {
            threadId: "thr_1",
            turn: { id: msg.params!["turnId"], status: "interrupted", error: null },
          }),
        );
        return {};
      },
    };
  }

  const item = (peer: Peer, method: "item/started" | "item/completed", it: Record<string, unknown>) =>
    peer.notify(method, { threadId: "thr_1", turnId: "t", item: it });

  it("reports a message, a command and a patch as ACP updates, then end_turn", async () => {
    const cmd = {
      type: "commandExecution",
      id: "c1",
      command: "/bin/bash -lc 'echo hi > a.txt'",
      cwd: CWD,
      commandActions: [{ type: "unknown", command: "echo hi > a.txt" }],
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null,
    };
    const change = {
      type: "fileChange",
      id: "p1",
      changes: [{ path: "/w/b.txt", kind: { type: "add" }, diff: "hi\n" }],
      status: "inProgress",
    };
    const s = scriptedHost(
      turnPlaying((peer) => {
        peer.notify("item/reasoning/summaryTextDelta", { threadId: "thr_1", itemId: "r", delta: "thinking" });
        peer.notify("turn/plan/updated", { threadId: "thr_1", plan: [{ step: "write", status: "inProgress" }] });
        item(peer, "item/started", cmd);
        item(peer, "item/completed", { ...cmd, status: "completed", aggregatedOutput: "", exitCode: 0 });
        item(peer, "item/started", change);
        item(peer, "item/completed", { ...change, status: "completed" });
        peer.notify("item/agentMessage/delta", { threadId: "thr_1", itemId: "m1", delta: "do" });
        peer.notify("item/agentMessage/delta", { threadId: "thr_1", itemId: "m1", delta: "ne" });
        item(peer, "item/completed", { type: "agentMessage", id: "m1", text: "done" });
        // another thread's events are not this session's
        peer.notify("item/agentMessage/delta", { threadId: "thr_other", itemId: "x", delta: "nope" });
      }),
    );
    const session = await open(s.host);
    const events: SessionUpdateEvent[] = [];
    session.onUpdate((e) => events.push(e));
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.peer.received.find((m) => m.method === "turn/start")?.params).toMatchObject({
      threadId: "thr_1",
      input: [{ type: "text", text: "go", text_elements: [] }],
      model: "gpt-5.5",
      effort: "low",
    });
    expect(
      events.map((e) => [e.summary.kind, e.summary.toolKind, e.summary.status, e.summary.title, e.summary.text]),
    ).toEqual([
      ["agent_thought_chunk", undefined, undefined, undefined, "thinking"],
      ["plan", undefined, undefined, undefined, undefined],
      ["tool_call", "execute", "in_progress", "echo hi > a.txt", undefined],
      ["tool_call_update", undefined, "completed", undefined, undefined],
      ["tool_call", "edit", "in_progress", "Editing files", undefined],
      ["tool_call_update", undefined, "completed", undefined, undefined],
      ["agent_message_chunk", undefined, undefined, undefined, "do"],
      ["agent_message_chunk", undefined, undefined, undefined, "ne"],
    ]);
    expect(events.every((e) => e.sessionId === "thr_1")).toBe(true);
    await session.close();
  });

  it("reports a whole message once when Codex sends it without deltas", async () => {
    const s = scriptedHost(
      turnPlaying((peer) => item(peer, "item/completed", { type: "agentMessage", id: "m", text: "whole" })),
    );
    const session = await open(s.host);
    const texts: (string | undefined)[] = [];
    session.onUpdate((e) => texts.push(e.summary.text));
    await session.prompt("go");
    expect(texts).toEqual(["whole"]);
    await session.close();
  });

  it("throws Codex's message for a failed turn, and takes no non-text prompt", async () => {
    const s = scriptedHost(turnPlaying(() => undefined, "failed"));
    const session = await open(s.host);
    await expect(session.prompt("go")).rejects.toMatchObject({
      code: "AGENT_PROTOCOL",
      message: "agent codex: Codex failed the turn: model refused",
    });
    await expect(session.prompt([{ type: "image", data: "x", mimeType: "image/png" }])).rejects.toThrow(
      /takes text prompts only, not image/,
    );
    await session.close();
  });

  it("handles a turn that ends before turn/start answers", async () => {
    let peerRef!: Peer;
    const s = scriptedHost({
      ...BASE,
      "turn/start": (msg, peer) => {
        peerRef = peer;
        peer.notify("turn/completed", { threadId: "thr_1", turn: { id: "early", status: "completed", error: null } });
        peer.say({ id: msg.id, result: { turn: { id: "early", status: "completed" } } });
        return NO_ANSWER;
      },
    });
    const session = await open(s.host);
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(peerRef).toBeDefined();
    await session.close();
  });

  it("cancel interrupts the running turn, which ends cancelled", async () => {
    const s = scriptedHost(turnPlaying(() => undefined, "none"));
    const session = await open(s.host);
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(true));
    await new Promise((r) => setImmediate(r));
    await session.cancel();
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(s.peer.received.find((m) => m.method === "turn/interrupt")?.params).toEqual({
      threadId: "thr_1",
      turnId: "turn_1",
    });
    await session.close();
  });

  it("an abort before turn/start answers still interrupts the turn once it has an id", async () => {
    let answer!: () => void;
    const s = scriptedHost({
      ...turnPlaying(() => undefined, "none"),
      "turn/start": (msg, peer) => {
        answer = () => peer.say({ id: msg.id, result: { turn: { id: "late", status: "inProgress" } } });
        return NO_ANSWER;
      },
    });
    const session = await open(s.host);
    const abort = new AbortController();
    const turn = session.prompt("go", { signal: abort.signal });
    await vi.waitFor(() => expect(answer).toBeDefined());
    abort.abort("stop");
    answer();
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(s.peer.received.filter((m) => m.method === "turn/interrupt")).toHaveLength(1);
    await session.close();
  });

  it("kills a Codex that does not end its turn within the cancel grace", async () => {
    const s = scriptedHost({ ...turnPlaying(() => undefined, "none"), "turn/interrupt": () => ({}) });
    const session = await open(s.host, { cancelGraceMs: 50 });
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(true));
    await new Promise((r) => setImmediate(r));
    await session.cancel();
    await expect(turn).rejects.toThrow(/did not end its turn within 50ms of turn\/interrupt/);
    expect(s.kill).toHaveBeenCalled();
    // stopped without asking Codex anything more, and takes no further prompt
    expect(s.peer.received.some((m) => m.method === "thread/unsubscribe")).toBe(false);
    await expect(session.prompt("again")).rejects.toThrow(/did not end its turn/);
  });

  it("settles a cancel past the grace while turn/start is still unanswered, and stops at once", async () => {
    const s = scriptedHost({ ...turnPlaying(() => undefined, "none"), "turn/start": () => NO_ANSWER });
    const session = await open(s.host, { cancelGraceMs: 50, requestTimeoutMs: 60_000 });
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(true));
    const cancelled = Date.now();
    await session.cancel();
    await expect(turn).rejects.toThrow(/did not end its turn within 50ms/);
    expect(Date.now() - cancelled).toBeLessThan(5_000);
    // no turn id, so no interrupt could be sent; the process is stopped without waiting on Codex
    expect(s.peer.received.some((m) => m.method === "turn/interrupt")).toBe(false);
    await vi.waitFor(() => expect(s.kill).toHaveBeenCalled());
    await session.close();
    expect(s.peer.received.some((m) => m.method === "thread/unsubscribe")).toBe(false);
  });

  it("ends the session when turn/start's outcome is unknown: no answer in time", async () => {
    const s = scriptedHost({ ...turnPlaying(() => undefined, "none"), "turn/start": () => NO_ANSWER });
    const session = await open(s.host, { requestTimeoutMs: 100 });
    await expect(session.prompt("go")).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      message: expect.stringMatching(/turn\/start got no usable answer .*whether Codex is running the turn is unknown/),
    });
    await vi.waitFor(() => expect(s.kill).toHaveBeenCalled());
    await expect(session.prompt("again")).rejects.toThrow(/whether Codex is running the turn is unknown/);
    expect(s.peer.received.filter((m) => m.method === "turn/start")).toHaveLength(1);
    await session.close();
  });

  it("ends the session when turn/start answers without a turn id", async () => {
    const s = scriptedHost({ ...turnPlaying(() => undefined, "none"), "turn/start": () => ({ turn: {} }) });
    const session = await open(s.host);
    await expect(session.prompt("go")).rejects.toThrow(/turn\/start got an answer without a turn id/);
    await vi.waitFor(() => expect(s.kill).toHaveBeenCalled());
    await expect(session.prompt("again")).rejects.toThrow(/without a turn id/);
    await session.close();
  });

  it.each([
    ["a string code", "-32602"],
    ["a fractional code", -32602.5],
  ])("ends the session when turn/start answers with %s, a malformed error and no refusal", async (_name, code) => {
    const s = scriptedHost({
      ...turnPlaying(() => undefined, "none"),
      "turn/start": (msg, peer) => {
        peer.say({ id: msg.id, error: { code, message: "bad input" } });
        return NO_ANSWER;
      },
    });
    const session = await open(s.host);
    await expect(session.prompt("go")).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      message: expect.stringMatching(/turn\/start got no usable answer \(.*malformed error\).*is unknown/),
    });
    await vi.waitFor(() => expect(s.kill).toHaveBeenCalled());
    await expect(session.prompt("again")).rejects.toThrow(/whether Codex is running the turn is unknown/);
    expect(s.peer.received.filter((m) => m.method === "turn/start")).toHaveLength(1);
    await session.close();
  });

  it("keeps the session when Codex refuses turn/start with an error", async () => {
    let refuse = true;
    const play = turnPlaying(() => undefined);
    const s = scriptedHost({
      ...play,
      "turn/start": (msg, peer) => {
        if (!refuse) return play["turn/start"]!(msg, peer);
        refuse = false;
        peer.say({ id: msg.id, error: { code: -32602, message: "bad input" } });
        return NO_ANSWER;
      },
    });
    const session = await open(s.host);
    await expect(session.prompt("go")).rejects.toMatchObject({
      code: "AGENT_PROTOCOL",
      message: "agent codex: Codex refused turn/start: bad input",
    });
    await expect(session.prompt("again")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.kill).not.toHaveBeenCalled();
    await session.close();
  });

  it("takes a completion early only for the pending start, and keeps none across turns", async () => {
    let n = 0;
    const finish = (id: string) =>
      s.peer.notify("turn/completed", { threadId: "thr_1", turn: { id, status: "completed" } });
    const s = scriptedHost({
      ...BASE,
      "turn/start": (msg, peer) => {
        const turnId = `turn_${++n}`;
        // while turn 2 starts, Codex reports turn 3 finished: held for turn 2's start only
        if (n === 2) finish("turn_3");
        peer.say({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
        return NO_ANSWER;
      },
    });
    const session = await open(s.host);
    const pending = async (turn: Promise<unknown>) => {
      let settled = false;
      void turn.finally(() => (settled = true)).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 30));
      return !settled;
    };
    // between turns, a stray completion is dropped, so turn 1 does not end on it
    finish("turn_1");
    await new Promise((r) => setImmediate(r));
    const one = session.prompt("one");
    expect(await pending(one)).toBe(true);
    finish("turn_1");
    await expect(one).resolves.toMatchObject({ stopReason: "end_turn" });
    const two = session.prompt("two");
    expect(await pending(two)).toBe(true);
    finish("turn_2");
    await expect(two).resolves.toMatchObject({ stopReason: "end_turn" });
    // turn 3's early completion went with turn 2's start
    const three = session.prompt("three");
    expect(await pending(three)).toBe(true);
    finish("turn_3");
    await expect(three).resolves.toMatchObject({ stopReason: "end_turn" });
    await session.close();
  });

  it("refuses a second prompt while one is running", async () => {
    const s = scriptedHost(turnPlaying(() => undefined, "none"));
    const session = await open(s.host);
    const first = session.prompt("one");
    await expect(session.prompt("two")).rejects.toMatchObject({ code: "RUN_STATE" });
    await session.cancel();
    await first;
    await session.close();
  });
});

describe("malformed notifications", () => {
  const cases: [string, string, Record<string, unknown>, RegExp][] = [
    [
      "an item without actions",
      "item/started",
      { item: { type: "commandExecution", id: "c", command: "ls", cwd: "/", status: "inProgress" } },
      /commandExecution item without/,
    ],
    [
      "a read action without a path",
      "item/started",
      {
        item: {
          type: "commandExecution",
          id: "c",
          command: "cat",
          cwd: "/",
          status: "inProgress",
          commandActions: [{ type: "read" }],
        },
      },
      /read command action without its path/,
    ],
    [
      "a file change without a kind",
      "item/started",
      { item: { type: "fileChange", id: "p", status: "inProgress", changes: [{ path: "a", diff: "" }] } },
      /file change without/,
    ],
    [
      "an item without an id",
      "item/completed",
      { item: { type: "agentMessage", text: "x" } },
      /item without an id and a type/,
    ],
    [
      "a message without text",
      "item/completed",
      { item: { type: "agentMessage", id: "m" } },
      /agentMessage item without its text/,
    ],
    [
      "an MCP call without its tool",
      "item/started",
      { item: { type: "mcpToolCall", id: "m", server: "s", status: "inProgress" } },
      /mcpToolCall item without/,
    ],
    [
      "a plan step with an unknown status",
      "turn/plan/updated",
      { plan: [{ step: "a", status: "doing" }] },
      /plan step without/,
    ],
    [
      "token usage without counts",
      "thread/tokenUsage/updated",
      { tokenUsage: { total: {}, last: {} } },
      /token usage without/,
    ],
    ["a delta without text", "item/agentMessage/delta", { itemId: "m", delta: 3 }, /delta without/],
    [
      "a completed turn without a status",
      "turn/completed",
      { turn: { id: "turn_1" } },
      /turn without its id and status/,
    ],
  ];
  it.each(cases)("%s fails the turn as a protocol error and stops the process", async (_name, method, params, why) => {
    const s = scriptedHost({
      ...BASE,
      "turn/start": (_msg, peer) => {
        setImmediate(() => peer.notify(method, { threadId: "thr_1", turnId: "turn_1", ...params }));
        return { turn: { id: "turn_1", status: "inProgress" } };
      },
    });
    const session = await open(s.host);
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("AGENT_PROTOCOL");
    expect(error.message).toMatch(why);
    expect(error.message).toContain(`a ${method} notification with`);
    await vi.waitFor(() => expect(s.kill).toHaveBeenCalled());
    await expect(session.prompt("again")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    await session.close();
  });

  it("ignores params it does not read, and notifications it does not handle", async () => {
    const s = scriptedHost({
      ...BASE,
      "turn/start": (_msg, peer) => {
        setImmediate(() => {
          peer.notify("thread/status/changed", { threadId: "thr_1", status: 7 });
          peer.say({ method: "some/new/notification", params: "anything" });
          peer.notify("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } });
        });
        return { turn: { id: "turn_1", status: "inProgress" } };
      },
    });
    const session = await open(s.host);
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.kill).not.toHaveBeenCalled();
    await session.close();
  });
});

describe("asks before ORCA's ask bridge (#1159)", () => {
  it("declines every approval and refuses any other ask", async () => {
    const s = scriptedHost(BASE);
    const session = await open(s.host);
    const answers: unknown[] = [];
    const before = s.peer.received.length;
    s.peer.say({ id: "a1", method: "item/commandExecution/requestApproval", params: { threadId: "thr_1" } });
    s.peer.say({ id: "a2", method: "item/fileChange/requestApproval", params: { threadId: "thr_1" } });
    s.peer.say({ id: "a3", method: "item/tool/requestUserInput", params: { threadId: "thr_1" } });
    await vi.waitFor(() => expect(s.peer.received.length).toBe(before + 3));
    answers.push(...s.peer.received.slice(before));
    expect(answers).toEqual([
      { id: "a1", result: { decision: "decline" } },
      { id: "a2", result: { decision: "decline" } },
      { id: "a3", error: { code: -32601, message: "ORCA does not answer item/tool/requestUserInput yet" } },
    ]);
    await session.close();
  });
});

describe("config options", () => {
  it("offers Codex's visible models and the current model's efforts, and applies a change to the next turn", async () => {
    const s = scriptedHost({
      ...BASE,
      "turn/start": (_m, peer) => {
        setImmediate(() =>
          peer.notify("turn/completed", { threadId: "thr_1", turn: { id: "t1", status: "completed" } }),
        );
        return { turn: { id: "t1" } };
      },
    });
    const session = await open(s.host);
    expect(session.configOptions).toEqual([
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.5",
        options: [
          { value: "gpt-5.5", name: "GPT-5.5", description: "d" },
          { value: "gpt-5", name: "GPT-5" },
        ],
      },
      {
        type: "select",
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "low" },
          { value: "high", name: "high" },
        ],
      },
    ]);
    await session.setConfigOption("reasoning_effort", "high");
    await expect(session.setConfigOption("model", "secret")).rejects.toThrow(/does not offer secret for model/);
    await expect(session.setConfigOption("mode", "x")).rejects.toThrow(/has no option mode/);
    await session.prompt("go");
    expect(s.peer.received.find((m) => m.method === "turn/start")?.params).toMatchObject({ effort: "high" });
    await session.setConfigOption("model", "gpt-5");
    expect(session.configOptions.map((o) => o.id)).toEqual(["model"]);
    await session.close();
  });

  it("keeps the current model alone when Codex cannot list its models", async () => {
    const s = scriptedHost({ ...BASE, "model/list": undefined as never });
    const session = await open(s.host);
    expect(session.configOptions).toEqual([
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5.5",
        options: [{ value: "gpt-5.5", name: "gpt-5.5" }],
      },
    ]);
    await session.close();
  });
});

describe("mappings", () => {
  it("titles commands as the ACP route does", () => {
    expect(stripShellPrefix("/bin/bash -lc 'echo hi'")).toBe("echo hi");
    expect(stripShellPrefix('bash -lc "echo \\"q\\" \\$x"')).toBe('echo "q" $x');
    expect(stripShellPrefix("zsh -c ls")).toBe("ls");
    expect(stripShellPrefix("bash --norc")).toBe("bash --norc");
    expect(stripShellPrefix("git status")).toBe("git status");
    const cmd = (actions: unknown[]) =>
      codexItemUpdate(
        {
          type: "commandExecution",
          id: "c",
          command: "/bin/bash -lc 'cat a'",
          cwd: "/w",
          commandActions: actions,
        } as never,
        "started",
      );
    expect(cmd([{ type: "read", command: "cat a", name: "a", path: "/w/a" }])).toMatchObject({
      kind: "read",
      title: "Read file '/w/a'",
      locations: [{ path: "/w/a" }],
    });
    expect(cmd([{ type: "search", command: "rg x", query: "x", path: "src" }])).toMatchObject({
      kind: "search",
      title: "Search for 'x' in src",
    });
    expect(cmd([{ type: "listFiles", command: "ls", path: null }])).toMatchObject({
      kind: "read",
      title: "List files",
    });
    expect(cmd([{ type: "read" }, { type: "read" }])).toMatchObject({ kind: "execute", title: "cat a" });
  });

  it("maps statuses, a declined command, MCP calls, web search and unknown items", () => {
    const done = (it: Record<string, unknown>) => codexItemUpdate(it as never, "completed");
    expect(
      done({ type: "commandExecution", id: "c", status: "declined", aggregatedOutput: null, exitCode: null }),
    ).toMatchObject({
      status: "failed",
      rawOutput: { declined: true },
    });
    expect(
      codexItemUpdate(
        { type: "mcpToolCall", id: "m", server: "gh", tool: "issues", arguments: { q: 1 } } as never,
        "started",
      ),
    ).toMatchObject({ title: "mcp__gh__issues", kind: "other", rawInput: { q: 1 } });
    expect(
      done({ type: "mcpToolCall", id: "m", status: "failed", error: { message: "x" }, result: null }),
    ).toMatchObject({
      status: "failed",
      rawOutput: { error: { message: "x" } },
    });
    expect(codexItemUpdate({ type: "webSearch", id: "w" } as never, "started")).toMatchObject({ kind: "fetch" });
    expect(codexItemUpdate({ type: "somethingNew", id: "n" } as never, "started")).toMatchObject({
      sessionUpdate: "tool_call",
      title: "somethingNew",
      kind: "other",
    });
    for (const type of ["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction", "hookPrompt"])
      expect(codexItemUpdate({ type, id: "x" } as never, "started")).toBeUndefined();
    expect(
      codexItemUpdate(
        {
          type: "fileChange",
          id: "f",
          status: "inProgress",
          changes: [{ path: "/a", kind: { type: "update", move_path: null }, diff: "@@" }],
        } as never,
        "started",
      ),
    ).toMatchObject({ content: [{ type: "content", content: { type: "text", text: "@@" } }] });
  });

  it("maps plans and stop reasons", () => {
    expect(
      codexPlanUpdate([
        { step: "a", status: "inProgress" },
        { step: "b", status: "pending" },
      ]),
    ).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "a", status: "in_progress", priority: "medium" },
        { content: "b", status: "pending", priority: "medium" },
      ],
    });
    expect(codexStopReason("c", { status: "completed" })).toBe("end_turn");
    expect(codexStopReason("c", { status: "interrupted" })).toBe("cancelled");
    expect(() => codexStopReason("c", { status: "inProgress" })).toThrow(/ended the turn with status "inProgress"/);
    expect(() => codexStopReason("c", null)).toThrow(/with status undefined/);
  });
});

describe("the host handle's stdio", () => {
  it("gives one reader: raw stdio or the ACP stream, never both", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: ["pipe", "pipe", "pipe"] });
    const handle = await wrapAgentProcess(child, { onSpawnError: (e) => e });
    try {
      expect(handle.stdio?.()).toMatchObject({ stdin: child.stdin, stdout: child.stdout });
      expect(() => handle.stream).toThrow(/already in use as raw stdio/);
    } finally {
      handle.kill("SIGKILL");
    }
    const other = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: ["pipe", "pipe", "pipe"] });
    const acpHandle = await wrapAgentProcess(other, { onSpawnError: (e) => e });
    try {
      expect(acpHandle.stream).toBe(acpHandle.stream);
      expect(() => acpHandle.stdio?.()).toThrow(/already in use as an ACP stream/);
    } finally {
      acpHandle.kill("SIGKILL");
    }
  });

  it("lets a wrapper made with Object.create replace the stream, as a plain property would", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: ["pipe", "pipe", "pipe"] });
    const handle = await wrapAgentProcess(child, { onSpawnError: (e) => e });
    try {
      const replacement = { readable: new ReadableStream(), writable: new WritableStream() };
      const wrapped = Object.assign(Object.create(handle) as AgentProcessHandle, { stream: replacement });
      expect(wrapped.stream).toBe(replacement);
      // the wrapper's own stream leaves the handle's stdio free
      expect(handle.stdio?.()).toMatchObject({ stdin: child.stdin, stdout: child.stdout });
    } finally {
      handle.kill("SIGKILL");
    }
  });
});
