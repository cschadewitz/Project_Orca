/**
 * The Codex app-server session driver (#1157) against a scripted app-server: what opens and
 * what is refused (reviewer, approval policy, working directory, login, version, host, policy
 * given), how a turn's items become ACP updates and its end a stop reason, cancel, asks
 * declined until #1159, config options, close, and the host handle's one-reader rule.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
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
import { CONFIG_ANSWERS, configRead, NO_HOOKS, WRITE_SANDBOX } from "./codex-config-fixture.js";

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
  return { host, peer, spawnAgent, kill, exit, stdout };
}

const NO_ANSWER = Symbol("no answer");
const settle = () => new Promise((r) => setTimeout(r, 20));

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
  sandbox: WRITE_SANDBOX,
  reasoningEffort: "low",
  ...over,
});

const BASE: Record<string, Responder> = {
  initialize: () => INIT,
  ...CONFIG_ANSWERS,
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

describe("account and usage limits (#1164)", () => {
  const CHATGPT = (userId = "user-1") => ({
    account: { type: "chatgpt", email: "someone@example.com", planType: "pro", workspaceName: null },
    userId,
    requiresOpenaiAuth: true,
  });
  const SNAPSHOT = {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_795_000_000 },
    secondary: null,
    credits: null,
    planType: "pro",
    rateLimitReachedType: null,
  };
  /** A Codex whose turns end as `end`, after playing `play`. */
  const turns = (end: (peer: Peer, turnId: string) => void, more: Record<string, Responder> = {}) => {
    let n = 0;
    return {
      ...BASE,
      ...more,
      "turn/start": (_msg: Msg, peer: Peer) => {
        const turnId = `turn_${++n}`;
        setImmediate(() => end(peer, turnId));
        return { turn: { id: turnId, status: "inProgress" } };
      },
    };
  };
  const completed = (peer: Peer, turnId: string) =>
    peer.notify("turn/completed", { threadId: "thr_1", turn: { id: turnId, status: "completed", error: null } });

  it("reports the account at open, and reads a ChatGPT login's usage limits in the background", async () => {
    const accounts: unknown[] = [];
    const limits: unknown[] = [];
    const s = scriptedHost({
      ...BASE,
      "account/read": () => CHATGPT(),
      "account/rateLimits/read": () => ({ rateLimits: SNAPSHOT, rateLimitsByLimitId: null }),
    });
    const session = await open(s.host, { onAccount: (a) => accounts.push(a), onRateLimits: (l) => limits.push(l) });
    expect(accounts).toEqual([{ kind: "chatgpt", planType: "pro" }]);
    await vi.waitFor(() => expect(limits).toHaveLength(1));
    expect(limits[0]).toEqual({
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_795_000_000 },
      secondary: null,
      planType: "pro",
      rateLimitReachedType: null,
    });
    expect(s.peer.received.find((m) => m.method === "account/rateLimits/read")?.params).toEqual({
      excludeResetCreditDetails: true,
    });
    await session.close();
    // an API-key login has no usage limits to read
    const k = scriptedHost(BASE);
    await (await open(k.host)).close();
    expect(k.peer.received.some((m) => m.method === "account/rateLimits/read")).toBe(false);
  });

  it("names the window and its reset time when a turn ends on the usage limit", async () => {
    const limits: unknown[] = [];
    const s = scriptedHost(
      turns((peer, turnId) => {
        peer.notify("account/rateLimits/updated", {
          rateLimits: { ...SNAPSHOT, primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_795_000_000 } },
        });
        peer.notify("turn/completed", {
          threadId: "thr_1",
          turn: {
            id: turnId,
            status: "failed",
            error: {
              message: "You've hit your usage limit.",
              codexErrorInfo: "usageLimitExceeded",
              additionalDetails: null,
            },
          },
        });
      }),
    );
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.message).toContain(
      `the usage limit of its login is reached: the 5-hour window is 100% used and resets at ${new Date(1_795_000_000_000).toISOString()}`,
    );
    expect(error.details).toMatchObject({ reason: "codex-usage-limit" });
    expect(limits).toHaveLength(1);
    // the session goes on: the next turn runs once the limit allows
    await session.close();
  });

  it("refuses new turns while Codex reports the user signed out, and takes them again once signed in", async () => {
    let account: unknown = { account: { type: "apiKey" }, userId: null, requiresOpenaiAuth: true };
    const accounts: unknown[] = [];
    const s = scriptedHost(turns(completed, { "account/read": () => account }));
    const session = await open(s.host, { onAccount: (a) => accounts.push(a) });
    account = { account: null, userId: null, requiresOpenaiAuth: true };
    s.peer.notify("account/updated", { authMode: null, planType: null, reason: null });
    await vi.waitFor(() => expect(accounts).toHaveLength(2));
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain("Codex is no longer signed in. Run `codex login`");
    expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(false);
    account = { account: { type: "apiKey" }, userId: null, requiresOpenaiAuth: true };
    s.peer.notify("account/updated", { authMode: "apikey", planType: null, reason: null });
    await vi.waitFor(() => expect(accounts).toHaveLength(3));
    await expect(session.prompt("again")).resolves.toMatchObject({ stopReason: "end_turn" });
    await session.close();
  });

  it("refuses new turns once Codex reports another account than the session started on", async () => {
    let account: unknown = CHATGPT("user-1");
    const accounts: unknown[] = [];
    const s = scriptedHost(
      turns(completed, {
        "account/read": () => account,
        "account/rateLimits/read": () => ({ rateLimits: SNAPSHOT }),
      }),
    );
    const session = await open(s.host, { onAccount: (a) => accounts.push(a) });
    account = CHATGPT("user-2");
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await vi.waitFor(() => expect(accounts).toHaveLength(2));
    await expect(session.prompt("go")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      details: { reason: "codex-account-switched" },
    });
    await session.close();
  });

  it("ends the session on a malformed usage-limit update or account update", async () => {
    for (const [method, params] of [
      ["account/rateLimits/updated", { rateLimits: { primary: { usedPercent: "full" } } }],
      ["account/updated", { authMode: 1, planType: null, reason: null }],
    ] as const) {
      const s = scriptedHost(BASE);
      const session = await open(s.host);
      s.peer.notify(method, params);
      await vi.waitFor(() => expect(s.kill).toHaveBeenCalled());
      await expect(session.prompt("go")).rejects.toMatchObject({ code: "AGENT_PROTOCOL" });
    }
  });

  const failedOnLimit = (peer: Peer, turnId: string) =>
    peer.notify("turn/completed", {
      threadId: "thr_1",
      turn: {
        id: turnId,
        status: "failed",
        error: { message: "limit", codexErrorInfo: "usageLimitExceeded", additionalDetails: null },
      },
    });
  const window = (usedPercent: number, windowDurationMins = 300) => ({
    usedPercent,
    windowDurationMins,
    resetsAt: 1_795_000_000,
  });

  it("keeps each limit bucket apart, and names no window when two buckets are at their limit", async () => {
    const limits: ({ limitId: string | null } | null)[] = [];
    let both = false;
    const s = scriptedHost(
      turns(
        (peer, turnId) => {
          peer.notify("account/rateLimits/updated", {
            rateLimits: { ...SNAPSHOT, limitId: "codex", primary: window(100) },
          });
          if (both)
            peer.notify("account/rateLimits/updated", {
              rateLimits: { ...SNAPSHOT, limitId: "codex_other", primary: window(100, 60) },
            });
          failedOnLimit(peer, turnId);
        },
        {
          "account/read": () => CHATGPT(),
          "account/rateLimits/read": () => ({
            rateLimits: SNAPSHOT,
            rateLimitsByLimitId: {
              codex: SNAPSHOT,
              codex_other: { ...SNAPSHOT, limitId: "codex_other", primary: window(7, 60) },
            },
          }),
        },
      ),
    );
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    await vi.waitFor(() => expect(limits.map((l) => l?.limitId)).toEqual(["codex", "codex_other"]));
    // one bucket at its limit during the turn names its window
    const one = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(one.message).toContain("the 5-hour window is 100% used");
    // the other bucket's update does not overwrite the first: the evidence now names two windows
    both = true;
    const two = (await session.prompt("again").catch((e: unknown) => e)) as OrcaError;
    expect(two.message).toContain("Codex reported no single window at its limit for this turn");
    expect(two.details).toMatchObject({ reason: "codex-usage-limit", window: null });
    expect(limits.filter((l) => l?.limitId === "codex_other").at(-1)).toMatchObject({ primary: window(100, 60) });
    await session.close();
  });

  it("names no window from before the turn", async () => {
    const limits: unknown[] = [];
    const s = scriptedHost(
      turns(failedOnLimit, {
        "account/read": () => CHATGPT(),
        "account/rateLimits/read": () => ({ rateLimits: { ...SNAPSHOT, primary: window(100) } }),
      }),
    );
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    await vi.waitFor(() => expect(limits).toHaveLength(1));
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(error.message).toContain("Codex reported no single window at its limit for this turn");
    await session.close();
  });

  it("never lets a usage-limit read overwrite an update Codex sent after it began", async () => {
    const limits: ({ primary: unknown } | null)[] = [];
    let readId: unknown;
    const s = scriptedHost({
      ...BASE,
      "account/read": () => CHATGPT(),
      "account/rateLimits/read": (msg) => ((readId = msg.id), NO_ANSWER),
    });
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    await vi.waitFor(() => expect(readId).toBeDefined());
    s.peer.notify("account/rateLimits/updated", { rateLimits: { ...SNAPSHOT, primary: window(90) } });
    await vi.waitFor(() => expect(limits).toHaveLength(1));
    // the read answers late, with what Codex knew before its update
    s.peer.say({ id: readId as number, result: { rateLimits: { ...SNAPSHOT, primary: window(10) } } });
    await settle();
    expect(limits).toEqual([expect.objectContaining({ primary: window(90) })]);
    await session.close();
  });

  it("holds new turns while the account is read again, and runs them once it is the same", async () => {
    let held: Msg | undefined;
    let reads = 0;
    const s = scriptedHost(
      turns(completed, {
        "account/read": (msg) => (++reads === 1 ? CHATGPT() : ((held = msg), NO_ANSWER)),
      }),
    );
    const session = await open(s.host);
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await vi.waitFor(() => expect(held).toBeDefined());
    const turn = session.prompt("go");
    await settle();
    expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(false);
    s.peer.say({ id: held!.id as number, result: CHATGPT() });
    await expect(turn).resolves.toMatchObject({ stopReason: "end_turn" });
    await session.close();
  });

  it("ends a turn held on an account re-read when it is cancelled or its deadline passes, sending no turn/start", async () => {
    const held: Msg[] = [];
    let reads = 0;
    const s = scriptedHost(
      turns(completed, {
        "account/read": (msg) => (++reads === 1 ? CHATGPT() : (held.push(msg), NO_ANSWER)),
      }),
    );
    const session = await open(s.host, { cancelGraceMs: 20 });
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const abort = new AbortController();
    const cancelled = session.prompt("go", { signal: abort.signal });
    await settle();
    abort.abort("stop");
    await expect(cancelled).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(session.prompt("late", { timeoutMs: 30 })).resolves.toMatchObject({ stopReason: "cancelled" });
    // past the cancel grace: the session was not stopped, and the held re-read still decides
    await new Promise((r) => setTimeout(r, 60));
    expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(false);
    expect(s.kill).not.toHaveBeenCalled();
    s.peer.say({ id: held[0]!.id as number, result: CHATGPT() });
    await expect(session.prompt("now")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(s.peer.received.filter((m) => m.method === "turn/start")).toHaveLength(1);
    await session.close();
  });

  it("drops a usage-limit read begun before the account was read again, unread, and reads anew", async () => {
    const limits: unknown[] = [];
    const reads: Msg[] = [];
    const s = scriptedHost({
      ...BASE,
      "account/read": () => CHATGPT(),
      "account/rateLimits/read": (msg) => (reads.push(msg), NO_ANSWER),
    });
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    // the same account: its usage limits are read anew
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    // the first read answers late, malformed: dropped before it is even checked
    s.peer.say({ id: reads[0]!.id as number, result: { rateLimits: { primary: { usedPercent: "full" } } } });
    await settle();
    expect(limits).toEqual([]);
    expect(s.kill).not.toHaveBeenCalled();
    s.peer.say({ id: reads[1]!.id as number, result: { rateLimits: { ...SNAPSHOT, primary: window(30) } } });
    await vi.waitFor(() => expect(limits).toEqual([expect.objectContaining({ primary: window(30) })]));
    await session.close();
  });

  it("reports no usage while the account is being read again or is refused, and withdraws what it reported", async () => {
    const limits: unknown[] = [];
    let account: unknown = CHATGPT("user-1");
    let hold = false;
    let held: Msg | undefined;
    const s = scriptedHost({
      ...BASE,
      "account/read": (msg) => (hold ? ((hold = false), (held = msg), NO_ANSWER) : account),
      "account/rateLimits/read": () => ({ rateLimits: SNAPSHOT }),
    });
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    await vi.waitFor(() => expect(limits).toHaveLength(1));
    // pending: what was reported is withdrawn, and updates are not reported
    hold = true;
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await vi.waitFor(() => expect(held).toBeTruthy());
    s.peer.notify("account/rateLimits/updated", { rateLimits: { ...SNAPSHOT, primary: window(77) } });
    await settle();
    expect(limits).toEqual([expect.objectContaining({ primary: SNAPSHOT.primary }), null]);
    // refused: another account's usage is never reported on this session
    account = CHATGPT("user-2");
    s.peer.say({ id: held!.id as number, result: account });
    await expect(session.prompt("go")).rejects.toMatchObject({ details: { reason: "codex-account-switched" } });
    s.peer.notify("account/rateLimits/updated", { rateLimits: { ...SNAPSHOT, primary: window(88) } });
    await settle();
    expect(limits).toHaveLength(2);
    await session.close();
  });

  it("drops the refresh one account check scheduled once another account update came in", async () => {
    const limits: unknown[] = [];
    const reads: Msg[] = [];
    const accountReads: Msg[] = [];
    const s = scriptedHost({
      ...BASE,
      "account/read": (msg) => (accountReads.push(msg), accountReads.length === 3 ? NO_ANSWER : CHATGPT()),
      "account/rateLimits/read": (msg) => (reads.push(msg), NO_ANSWER),
    });
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    // the first update: confirmed at once, and its refresh is sent and held
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    // a second update before the refresh answers: its re-read is held
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await vi.waitFor(() => expect(accountReads).toHaveLength(3));
    s.peer.say({ id: reads[1]!.id as number, result: { rateLimits: { ...SNAPSHOT, primary: window(99) } } });
    await settle();
    // no refresh goes out while the second check is pending
    expect(reads).toHaveLength(2);
    s.peer.say({ id: accountReads[2]!.id as number, result: CHATGPT() });
    // the first refresh's answer stays dropped once the second check settles; the second refreshes
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    s.peer.say({ id: reads[2]!.id as number, result: { rateLimits: { ...SNAPSHOT, primary: window(12) } } });
    await vi.waitFor(() => expect(limits).toEqual([expect.objectContaining({ primary: window(12) })]));
    await session.close();
  });

  it("never takes a usage-limit read that answers during a turn as evidence about it", async () => {
    const limits: unknown[] = [];
    let readId: unknown;
    const s = scriptedHost(
      turns(
        (peer, turnId) => {
          peer.say({ id: readId as number, result: { rateLimits: { ...SNAPSHOT, primary: window(100) } } });
          setTimeout(() => failedOnLimit(peer, turnId), 10);
        },
        {
          "account/read": () => CHATGPT(),
          "account/rateLimits/read": (msg) => ((readId = msg.id), NO_ANSWER),
        },
      ),
    );
    const session = await open(s.host, { onRateLimits: (l) => limits.push(l) });
    await vi.waitFor(() => expect(readId).toBeDefined());
    const error = (await session.prompt("go").catch((e: unknown) => e)) as OrcaError;
    expect(limits).toHaveLength(1);
    expect(error.message).toContain("Codex reported no single window at its limit for this turn");
    await session.close();
  });

  it("refuses new turns when the account cannot be read again, until a read succeeds", async () => {
    let fail = false;
    const s = scriptedHost(
      turns(completed, {
        "account/read": (msg, peer) => {
          if (!fail) return CHATGPT();
          peer.say({ id: msg.id as number, error: { code: -32603, message: "internal" } });
          return NO_ANSWER;
        },
      }),
    );
    const session = await open(s.host);
    fail = true;
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await expect(session.prompt("go")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      details: { reason: "codex-account-unconfirmed" },
    });
    expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(false);
    fail = false;
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await vi.waitFor(() => expect(s.peer.received.filter((m) => m.method === "account/read")).toHaveLength(3));
    await expect(session.prompt("again")).resolves.toMatchObject({ stopReason: "end_turn" });
    await session.close();
  });

  it("refuses new turns when the account re-read times out", async () => {
    let reads = 0;
    const s = scriptedHost(turns(completed, { "account/read": () => (++reads === 1 ? CHATGPT() : NO_ANSWER) }));
    const session = await open(s.host, { requestTimeoutMs: 50 });
    s.peer.notify("account/updated", { authMode: "chatgpt", planType: "pro", reason: null });
    await expect(session.prompt("go")).rejects.toMatchObject({ details: { reason: "codex-account-unconfirmed" } });
    expect(s.peer.received.some((m) => m.method === "turn/start")).toBe(false);
    await session.close();
  });

  it("reads an account update Codex sent during the open before the session starts", async () => {
    let account: unknown = CHATGPT("user-1");
    const accounts: unknown[] = [];
    const answers = (after: unknown) => ({
      ...BASE,
      "account/read": () => account,
      "thread/start": (_msg: Msg, peer: Peer) => {
        account = after;
        peer.notify("account/updated", { authMode: null, planType: null, reason: null });
        return THREAD();
      },
    });
    // signed out while the thread started: the open is refused
    const out = scriptedHost(answers({ account: null, userId: null, requiresOpenaiAuth: true }));
    await expect(open(out.host)).rejects.toMatchObject({ details: { reason: "codex-login-required" } });
    // another account: the session starts on the account Codex reports now
    account = CHATGPT("user-1");
    const other = scriptedHost(answers(CHATGPT("user-2")));
    const session = await open(other.host, { onAccount: (a) => accounts.push(a) });
    expect(accounts).toHaveLength(1);
    expect(other.peer.received.filter((m) => m.method === "account/read")).toHaveLength(2);
    await session.close();
  });
});

describe("Codex's config (#1160)", () => {
  const refused = async (answers: Record<string, Responder>, more: Partial<Parameters<typeof open>[1]> = {}) => {
    const s = scriptedHost({ ...BASE, ...answers });
    const error = (await open(s.host, more).catch((e: unknown) => e)) as OrcaError;
    expect(s.kill).toHaveBeenCalled();
    return { s, error };
  };

  it("refuses a user config.toml that sets another approval policy before any thread starts", async () => {
    const { s, error } = await refused({
      "config/read": () =>
        configRead(
          {},
          {
            layers: [
              { name: { type: "sessionFlags" }, version: "v", config: {}, disabledReason: null },
              {
                name: { type: "user", file: "/h/.codex/config.toml", profile: null },
                version: "v",
                config: { approval_policy: "never" },
                disabledReason: null,
              },
            ],
          },
        ),
    });
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain('the user config.toml (/h/.codex/config.toml) sets approval_policy = "never"');
    expect(s.peer.received.some((m) => m.method === "thread/start")).toBe(false);
  });

  it("checks again on the thread, and refuses a hook the started thread would run", async () => {
    const { s, error } = await refused({
      "hooks/list": (msg) =>
        msg.params?.["threadId"]
          ? { data: [{ cwd: CWD, hooks: [{ eventName: "preToolUse", source: "project", enabled: true }] }] }
          : NO_HOOKS,
    });
    expect(error.message).toContain("Codex would run the hook preToolUse (project)");
    expect(s.peer.received.some((m) => m.method === "thread/start")).toBe(true);
    expect(s.peer.received.some((m) => m.method === "model/list")).toBe(false);
  });

  it("refuses a thread whose sandbox is not the one ORCA asked for", async () => {
    const { error } = await refused({
      "thread/start": () => THREAD({ sandbox: { type: "readOnly", networkAccess: false } }),
    });
    expect(error.message).toMatch(/Codex started the thread with sandbox "readOnly", not what ORCA asked for/);
    const full = await refused({ "thread/start": () => THREAD({ sandbox: { type: "dangerFullAccess" } }) });
    expect(full.error.message).toMatch(/sandbox "dangerFullAccess"/);
  });

  it("refuses a thread that could write a path ORCA protects", async () => {
    const { error } = await refused({}, { protectedPaths: [`${CWD}/.orca`] });
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toContain(`the thread could write ${CWD}, which overlaps ORCA's protected ${CWD}/.orca`);
    const s = scriptedHost({
      ...BASE,
      "thread/start": () => THREAD({ sandbox: { ...WRITE_SANDBOX, excludeSlashTmp: true, excludeTmpdirEnvVar: true } }),
    });
    const session = await open(s.host, { protectedPaths: ["/tmp/orca-sidecar"] });
    await session.close();
  });

  it("records what it verified, and logs no config value beyond it", async () => {
    const SECRET = "sk-orca-1160-sentinel";
    const records: unknown[] = [];
    const logger = {
      log: (...a: unknown[]) => void records.push(a),
      debug: (...a: unknown[]) => void records.push(a),
      info: (...a: unknown[]) => void records.push(a),
      warn: (...a: unknown[]) => void records.push(a),
      error: (...a: unknown[]) => void records.push(a),
      child: () => logger,
    };
    const verified: unknown[] = [];
    const s = scriptedHost({
      ...BASE,
      "config/read": () =>
        configRead({}, { config: { mcp_servers: { off: { env: { TOKEN: SECRET }, enabled: false } } } }),
    });
    const session = await open(s.host, { logger, onVerifiedConfig: (c) => verified.push(c) });
    expect(verified).toEqual([
      expect.objectContaining({
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        origins: { approval_policy: "sessionFlags", approvals_reviewer: "sessionFlags", sandbox_mode: "sessionFlags" },
      }),
    ]);
    expect(JSON.stringify(records)).toContain("Codex's effective config verified");
    expect(JSON.stringify(records)).not.toContain(SECRET);
    await session.close();
  });
});

describe("opening a session", () => {
  it("handshakes, checks the login, and starts the thread with reviewer user and the given policy", async () => {
    const s = scriptedHost(BASE);
    const session = await open(s.host);
    expect(session.acpSessionId).toBe("thr_1");
    const methods = s.peer.received.map((m) => m.method);
    expect(methods.slice(0, 11)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      // what Codex will run with, checked before the thread starts and again on it
      "config/read",
      "configRequirements/read",
      "hooks/list",
      "thread/start",
      "config/read",
      "configRequirements/read",
      "hooks/list",
      "model/list",
    ]);
    const lists = s.peer.received.filter((m) => m.method === "hooks/list").map((m) => m.params);
    expect(lists).toEqual([{ cwds: [CWD] }, { threadId: "thr_1" }]);
    expect(s.peer.received.find((m) => m.method === "config/read")?.params).toEqual({ includeLayers: true, cwd: CWD });
    expect(s.peer.received.find((m) => m.method === "account/read")?.params).toEqual({});
    // no cwd: the process runs in it, and a named cwd has Codex record the project as trusted
    expect(s.peer.received.find((m) => m.method === "thread/start")?.params).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    // the launch is the agent's command, ORCA's policy as session flags, then app-server
    expect(s.spawnAgent.mock.calls[0]![0]).toMatchObject({
      command: process.execPath,
      args: [
        "-c",
        'approval_policy="on-request"',
        "-c",
        'approvals_reviewer="user"',
        "-c",
        'sandbox_mode="workspace-write"',
        "app-server",
      ],
    });
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

  describe("a Codex that stops before the handshake finishes (#1269)", () => {
    const SECRETISH = "provider said: token sk-live-abc123 for /home/someone/.codex/auth.json";
    const stopped = async (
      stderr: string,
      exitFirst: boolean,
      how: { streamError?: Error; ignoreKill?: boolean } = {},
    ) => {
      // A stream error is raised while ORCA waits on the handshake, once it is listening.
      const s: ReturnType<typeof scriptedHost> = scriptedHost(
        how.streamError ? { initialize: () => (s.stdout.destroy(how.streamError), NO_ANSWER) } : {},
      );
      const handle = await s.spawnAgent(undefined);
      s.spawnAgent.mockClear();
      Object.defineProperty(handle, "stderrTail", { value: () => stderr });
      if (how.ignoreKill) s.kill.mockImplementation(() => undefined);
      if (exitFirst) s.exit({ code: 1, signal: null });
      if (!how.streamError) s.stdout.end();
      const error = await open(s.host, { exitGraceMs: 20 }).then(
        () => expect.unreachable("the session opened"),
        (e: unknown) => e as OrcaError,
      );
      expect(error.code).toBe("AGENT_TRANSPORT");
      // Nothing Codex printed, nor the stream's own error, reaches the public error or a cause.
      expect(error.cause).toBeUndefined();
      const shown = JSON.stringify(error) + error.message + String(error.stack);
      for (const leak of ["sk-live", "/home/someone", "auth.json", "provider said"]) expect(shown).not.toContain(leak);
      return { error, s };
    };

    it("names a recognized reason with a fixed diagnosis, and the exit it observed", async () => {
      const { error } = await stopped(
        `${SECRETISH}\nError: approval_policy = "untrusted" is no longer supported; remove this setting`,
        true,
      );
      expect(error.message).toMatch(
        /exited with code 1 before ORCA's handshake finished: a Codex config sets approval_policy = "untrusted"/,
      );
      expect(error.details).toEqual({
        agentId: "codex",
        reason: "untrusted-approval-policy",
        exited: true,
        exitCode: 1,
        signal: null,
      });
    });

    it("repeats nothing of output it does not recognize", async () => {
      const { error } = await stopped(SECRETISH, true);
      expect(error.message).toMatch(/exited with code 1 .* ORCA does not recognize its reason/);
      expect(error.details).toEqual({
        agentId: "codex",
        reason: "unrecognized",
        exited: true,
        exitCode: 1,
        signal: null,
      });
    });

    it("does not claim an exit it did not see when only the connection closed", async () => {
      const { error, s } = await stopped(SECRETISH, false);
      expect(error.message).toMatch(/closed its connection before ORCA's handshake finished, and ORCA stopped it/);
      expect(error.details).toEqual({ agentId: "codex", reason: "unrecognized", exited: false, stopped: true });
      expect(s.kill).toHaveBeenCalled();
    });

    it("says ORCA only attempted the stop when it did not see the process exit", async () => {
      const { error, s } = await stopped(SECRETISH, false, { ignoreKill: true });
      expect(s.kill).toHaveBeenCalledWith("SIGKILL");
      expect(error.message).toMatch(/ORCA attempted to stop it but did not see it exit/);
      expect(error.message).not.toMatch(/ORCA stopped it/);
      expect(error.details).toEqual({ agentId: "codex", reason: "unrecognized", exited: false, stopped: false });
    });

    it("keeps a sensitive stream error out of the error and its cause", async () => {
      const { error } = await stopped("", true, { streamError: new Error(SECRETISH) });
      expect(error.details).toMatchObject({ reason: "unrecognized", exited: true });
    });
  });

  it("refuses without a policy, with full access, never or untrusted, on another host, and for an ACP agent", async () => {
    const s = scriptedHost(BASE);
    for (const thread of [
      undefined,
      { approvalPolicy: "never", sandbox: "workspace-write" },
      // Codex 0.171.0 refuses untrusted at startup (#1269)
      { approvalPolicy: "untrusted", sandbox: "workspace-write" },
      { approvalPolicy: "on-request", sandbox: "danger-full-access" },
    ])
      await expect(open(s.host, { thread: thread as never })).rejects.toThrow(
        /needs the approval policy on-request \(Codex no longer supports untrusted\)/,
      );
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

describe("asks through ORCA's policy (#1159)", () => {
  const COMMAND = (over: Record<string, unknown> = {}) => ({
    kind: "command",
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "call_1",
    startedAtMs: 1,
    environmentId: null,
    command: "/bin/bash -lc 'cat src/a.ts'",
    cwd: CWD,
    reason: "to read the file",
    commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: `${CWD}/src/a.ts` }],
    proposedExecpolicyAmendment: ["cat"],
    proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }],
    ...over,
  });
  const FILE_CHANGE = (over: Record<string, unknown> = {}) => ({
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "patch_1",
    startedAtMs: 1,
    reason: null,
    grantRoot: null,
    ...over,
  });
  const PERMISSIONS = (over: Record<string, unknown> = {}) => ({
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "perm_1",
    environmentId: null,
    startedAtMs: 1,
    cwd: CWD,
    reason: "needs the network",
    permissions: { network: { enabled: true }, fileSystem: null },
    ...over,
  });
  const PATCH_ITEM = (path = `${CWD}/src/a.ts`) => ({
    type: "fileChange",
    id: "patch_1",
    changes: [{ path, kind: { type: "update", move_path: null }, diff: "@@" }],
    status: "inProgress",
  });
  type Ask = { method: string; params: Record<string, unknown>; before?: (peer: Peer) => void };
  /** A Codex whose each turn sends `asks(n)` in turn, waits for each answer, then completes. */
  const asking = (asks: (n: number) => Ask[]) => {
    let n = 0;
    let next = 0;
    const answers: unknown[] = [];
    const answers$ = { answers };
    const table: Record<string, Responder> = {
      ...BASE,
      "turn/start": (_msg, peer) => {
        const turnId = `turn_${++n}`;
        const list = asks(n);
        void (async () => {
          for (const ask of list) {
            const id = `ask_${++next}`;
            ask.before?.(peer);
            peer.say({ id, method: ask.method, params: ask.params });
            await vi.waitFor(() => expect(peer.received.find((m) => m.id === id && !m.method)).toBeDefined());
            answers.push((peer.received.find((m) => m.id === id && !m.method) as { result: unknown }).result);
          }
          peer.notify("turn/completed", { threadId: "thr_1", turn: { id: turnId, status: "completed", error: null } });
        })();
        return { turn: { id: turnId, status: "inProgress" } };
      },
    };
    return { table, ...answers$ };
  };
  const withPolicy = (permissions: Record<string, unknown>) => agent({ permissions });

  it("declines an ask outside a live turn, and refuses any other ask", async () => {
    const s = scriptedHost(BASE);
    const session = await open(s.host);
    const before = s.peer.received.length;
    s.peer.say({ id: "a1", method: "item/commandExecution/requestApproval", params: COMMAND() });
    s.peer.say({ id: "a2", method: "item/fileChange/requestApproval", params: FILE_CHANGE() });
    s.peer.say({ id: "a3", method: "item/permissions/requestApproval", params: PERMISSIONS() });
    s.peer.say({ id: "a4", method: "item/tool/requestUserInput", params: { threadId: "thr_1" } });
    await vi.waitFor(() => expect(s.peer.received.length).toBe(before + 4));
    const byId = (id: string) => s.peer.received.find((m) => m.id === id);
    expect(byId("a1")).toEqual({ id: "a1", result: { decision: "decline" } });
    expect(byId("a2")).toEqual({ id: "a2", result: { decision: "decline" } });
    expect(byId("a3")).toEqual({ id: "a3", result: { permissions: {}, scope: "turn" } });
    expect(byId("a4")).toEqual({
      id: "a4",
      error: { code: -32601, message: "ORCA does not answer item/tool/requestUserInput yet" },
    });
    await session.close();
  });

  it("asks a person with Codex's reason and parsed actions, and asks again for the same call and in a new thread", async () => {
    const asked: acp.RequestPermissionRequest[] = [];
    const askPermission = vi.fn(async (req: acp.RequestPermissionRequest) => (asked.push(req), "accept"));
    const c = asking(() => [
      { method: "item/commandExecution/requestApproval", params: COMMAND() },
      { method: "item/commandExecution/requestApproval", params: COMMAND({ itemId: "call_2" }) },
    ]);
    const s = scriptedHost(c.table);
    const session = await open(s.host, { askPermission, agent: withPolicy({ default: "ask" }) });
    await expect(session.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(c.answers).toEqual([{ decision: "accept" }, { decision: "accept" }]);
    expect(askPermission).toHaveBeenCalledTimes(2);
    expect(asked[0]!.toolCall).toMatchObject({
      title: "/bin/bash -lc 'cat src/a.ts'",
      kind: "execute",
      rawInput: { command: "/bin/bash -lc 'cat src/a.ts'", cwd: CWD },
    });
    // the card shows Codex's reason, the directory and what Codex parsed the command as
    const shown = JSON.stringify(asked[0]!.toolCall.content);
    expect(shown).toContain("to read the file");
    expect(shown).toContain(`Codex reads it as: read ${CWD}/src/a.ts`);
    expect(asked[0]!.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    await session.close();
    // a new thread asks again too
    const again = asking(() => [{ method: "item/commandExecution/requestApproval", params: COMMAND() }]);
    const t = scriptedHost(again.table);
    const next = await open(t.host, { askPermission, agent: withPolicy({ default: "ask" }) });
    await next.prompt("go");
    expect(askPermission).toHaveBeenCalledTimes(3);
    await next.close();
  });

  it("answers only one-time decisions, whatever the policy or the person says, for every ask kind", async () => {
    const kinds: Ask[] = [
      { method: "item/commandExecution/requestApproval", params: COMMAND() },
      { method: "item/commandExecution/requestApproval", params: COMMAND({ kind: "writeStdin", itemId: "call_s" }) },
      {
        method: "item/commandExecution/requestApproval",
        params: COMMAND({ command: null, networkApprovalContext: { host: "example.com", protocol: "https" } }),
      },
      {
        method: "item/fileChange/requestApproval",
        params: FILE_CHANGE(),
        before: (peer) => peer.notify("item/started", { threadId: "thr_1", turnId: "turn_1", item: PATCH_ITEM() }),
      },
      { method: "item/permissions/requestApproval", params: PERMISSIONS() },
    ];
    const policies: [string, Record<string, unknown>, (() => Promise<string | undefined>) | undefined][] = [
      ["allow", { default: "allow" }, undefined],
      ["deny", { default: "deny" }, undefined],
      ["ask, accepted", { default: "ask" }, async () => "accept"],
      ["ask, declined", { default: "ask" }, async () => "decline"],
      ["ask, dismissed", { default: "ask" }, async () => undefined],
      ["ask, no answerer", { default: "ask" }, undefined],
    ];
    for (const [label, permissions, ask] of policies) {
      const c = asking(() => kinds);
      const s = scriptedHost(c.table);
      const session = await open(s.host, { agent: withPolicy(permissions), ...(ask ? { askPermission: ask } : {}) });
      await session.prompt("go");
      expect(c.answers, label).toHaveLength(kinds.length);
      for (const answer of c.answers) {
        const a = answer as Record<string, unknown>;
        if ("decision" in a) expect(["accept", "decline", "cancel"], label).toContain(a.decision);
        else {
          expect(a.scope, label).toBe("turn");
          expect(a, label).not.toHaveProperty("strictAutoReview");
        }
        expect(JSON.stringify(a), label).not.toMatch(/ForSession|Amendment|"session"/);
      }
      await session.close();
    }
  });

  it("decides a file change by the files of the item Codex started for it", async () => {
    const c = asking((n) =>
      n === 1
        ? [
            {
              method: "item/fileChange/requestApproval",
              params: FILE_CHANGE(),
              before: (peer) =>
                peer.notify("item/started", { threadId: "thr_1", turnId: "turn_1", item: PATCH_ITEM() }),
            },
            // an ask for a change Codex never showed, and one for a write root for the session
            { method: "item/fileChange/requestApproval", params: FILE_CHANGE({ turnId: "turn_1", itemId: "patch_9" }) },
          ]
        : [
            {
              method: "item/fileChange/requestApproval",
              params: FILE_CHANGE({ turnId: "turn_2", grantRoot: CWD }),
              before: (peer) =>
                peer.notify("item/started", { threadId: "thr_1", turnId: "turn_2", item: PATCH_ITEM() }),
            },
          ],
    );
    const s = scriptedHost(c.table);
    const session = await open(s.host, {
      agent: withPolicy({
        rules: [{ match: { kind: "edit", pathPrefix: "src/" }, decision: "allow" }],
        default: "deny",
      }),
    });
    await session.prompt("go");
    await session.prompt("again");
    expect(c.answers).toEqual([{ decision: "accept" }, { decision: "decline" }, { decision: "decline" }]);
    await session.close();
  });

  it("denies an ask that reaches ORCA's own files, whatever the policy says", async () => {
    const c = asking(() => [
      {
        method: "item/fileChange/requestApproval",
        params: FILE_CHANGE(),
        before: (peer) =>
          peer.notify("item/started", {
            threadId: "thr_1",
            turnId: "turn_1",
            item: PATCH_ITEM(`${CWD}/orca.permissions.json`),
          }),
      },
    ]);
    const s = scriptedHost(c.table);
    const session = await open(s.host, {
      agent: withPolicy({ default: "allow" }),
      policyProtectedPaths: { readOnly: [`${CWD}/orca.permissions.json`], noAccess: [] },
    });
    await session.prompt("go");
    expect(c.answers).toEqual([{ decision: "decline" }]);
    await session.close();
  });

  it("declines a write to a running terminal unasked, whatever the policy", async () => {
    const asked = vi.fn(async () => "accept");
    const c = asking(() => [
      { method: "item/commandExecution/requestApproval", params: COMMAND({ kind: "writeStdin" }) },
    ]);
    const s = scriptedHost(c.table);
    const session = await open(s.host, { agent: withPolicy({ default: "allow" }), askPermission: asked });
    await session.prompt("go");
    expect(c.answers).toEqual([{ decision: "decline" }]);
    expect(asked).not.toHaveBeenCalled();
    await session.close();
  });

  it("decides a command's network access on its own, and asks a person once about both", async () => {
    const withNetwork = COMMAND({ networkApprovalContext: { host: "example.com", protocol: "https" } });
    // the command is allowed, its network access is not: declined
    const allowedCommand = { rules: [{ match: { kind: "fetch" }, decision: "deny" }], default: "allow" };
    const c = asking(() => [{ method: "item/commandExecution/requestApproval", params: withNetwork }]);
    const s = scriptedHost(c.table);
    const session = await open(s.host, { agent: withPolicy(allowedCommand) });
    await session.prompt("go");
    expect(c.answers).toEqual([{ decision: "decline" }]);
    await session.close();
    // both ask: one card, naming both effects
    const asked: acp.RequestPermissionRequest[] = [];
    const d = asking(() => [{ method: "item/commandExecution/requestApproval", params: withNetwork }]);
    const t = scriptedHost(d.table);
    const next = await open(t.host, {
      agent: withPolicy({ default: "ask" }),
      askPermission: async (req) => (asked.push(req), "accept"),
    });
    await next.prompt("go");
    expect(d.answers).toEqual([{ decision: "accept" }]);
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0]!.toolCall.content)).toContain("Network access to example.com (https)");
    await next.close();
  });

  it("declines a patch when any one change is refused, a deletion or either side of a move", async () => {
    const patchOf = (changes: unknown[]): Ask => ({
      method: "item/fileChange/requestApproval",
      params: FILE_CHANGE(),
      before: (peer) =>
        peer.notify("item/started", {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "fileChange", id: "patch_1", changes, status: "inProgress" },
        }),
    });
    const edit = { path: `${CWD}/src/a.ts`, kind: { type: "update", move_path: null }, diff: "" };
    const del = { path: `${CWD}/src/keep/b.ts`, kind: { type: "delete" }, diff: "" };
    const moveOut = {
      path: `${CWD}/src/c.ts`,
      kind: { type: "update", move_path: `${CWD}/orca.permissions.json` },
      diff: "",
    };
    const policy = {
      rules: [
        { match: { kind: "delete", pathPrefix: "src/keep/" }, decision: "deny" },
        { match: { kind: "edit", pathPrefix: "src/locked/" }, decision: "deny" },
        { match: { pathPrefix: "src/" }, decision: "allow" },
      ],
      default: "allow",
    };
    // a move the rules allow, onto a destination an edit rule denies
    const moveToDenied = {
      path: `${CWD}/src/d.ts`,
      kind: { type: "update", move_path: `${CWD}/src/locked/d.ts` },
      diff: "",
    };
    // a move whose destination is allowed, out of a directory whose deletions are denied
    const moveFromKept = {
      path: `${CWD}/src/keep/e.ts`,
      kind: { type: "update", move_path: `${CWD}/src/e.ts` },
      diff: "",
    };
    const moveAllowed = { path: `${CWD}/src/f.ts`, kind: { type: "update", move_path: `${CWD}/src/g.ts` }, diff: "" };
    for (const [changes, want] of [
      [[edit], "accept"],
      [[moveAllowed], "accept"],
      [[edit, del], "decline"],
      [[edit, moveOut], "decline"],
      [[moveToDenied], "decline"],
      [[moveFromKept], "decline"],
    ] as const) {
      const c = asking(() => [patchOf([...changes])]);
      const s = scriptedHost(c.table);
      const session = await open(s.host, {
        agent: withPolicy(policy),
        policyProtectedPaths: { readOnly: [`${CWD}/orca.permissions.json`], noAccess: [] },
      });
      await session.prompt("go");
      expect(c.answers, JSON.stringify(changes)).toEqual([{ decision: want }]);
      await session.close();
    }
  });

  describe("bound to this machine's environment", () => {
    const connected = (environmentId: unknown) => (peer: Peer) =>
      peer.notify("thread/environment/connected", { threadId: "thr_1", environmentId });

    it("declines unasked a command in another of Codex's environments", async () => {
      const asked = vi.fn(async () => "accept");
      const c = asking(() => [
        { method: "item/commandExecution/requestApproval", params: COMMAND({ environmentId: "local" }) },
        { method: "item/commandExecution/requestApproval", params: COMMAND({ environmentId: "devbox" }) },
        { method: "item/commandExecution/requestApproval", params: COMMAND({ environmentId: 7 }) },
      ]);
      const s = scriptedHost(c.table);
      const session = await open(s.host, { agent: withPolicy({ default: "allow" }), askPermission: asked });
      await session.prompt("go");
      expect(c.answers).toEqual([{ decision: "accept" }, { decision: "decline" }, { decision: "decline" }]);
      expect(asked).not.toHaveBeenCalled();
      await session.close();
    });

    it("keeps going when Codex reports this machine's environment", async () => {
      const c = asking(() => [
        { method: "item/commandExecution/requestApproval", params: COMMAND(), before: connected("local") },
      ]);
      const s = scriptedHost(c.table);
      const session = await open(s.host, { agent: withPolicy({ default: "allow" }) });
      await session.prompt("go");
      expect(c.answers).toEqual([{ decision: "accept" }]);
      await session.close();
    });

    it("stops the session when Codex connects the thread to another environment mid-turn", async () => {
      const s = scriptedHost({
        ...BASE,
        "turn/start": (_msg, peer) => {
          setImmediate(() => connected("devbox")(peer));
          return { turn: { id: "turn_1", status: "inProgress" } };
        },
      });
      const session = await open(s.host);
      await expect(session.prompt("go")).rejects.toThrow(/environment other than this machine/);
      await expect(session.prompt("again")).rejects.toThrow(/environment other than this machine/);
      await vi.waitFor(() => expect(s.kill).toHaveBeenCalled());
    });

    it("takes no prompt when Codex connected the thread to another environment while it opened", async () => {
      const s = scriptedHost({
        ...BASE,
        "thread/start": (_msg, peer) => (connected("devbox")(peer), THREAD()),
      });
      const session = await open(s.host);
      await expect(session.prompt("go")).rejects.toThrow(/environment other than this machine/);
      expect(s.peer.received.map((m) => m.method)).not.toContain("turn/start");
    });
  });

  it("declines a permissions grant unasked, whatever the policy", async () => {
    const asked = vi.fn(async () => "accept");
    const c = asking(() => [
      { method: "item/permissions/requestApproval", params: PERMISSIONS() },
      {
        method: "item/permissions/requestApproval",
        params: PERMISSIONS({ permissions: { network: null, fileSystem: { read: null, write: [`${CWD}/out`] } } }),
      },
    ]);
    const s = scriptedHost(c.table);
    const session = await open(s.host, { agent: withPolicy({ default: "allow" }), askPermission: asked });
    await session.prompt("go");
    expect(c.answers).toEqual([
      { permissions: {}, scope: "turn" },
      { permissions: {}, scope: "turn" },
    ]);
    expect(asked).not.toHaveBeenCalled();
    await session.close();
  });

  it("answers no ask of a turn Codex reported complete, even one a person then accepts", async () => {
    let accept!: (answer: string) => void;
    const asked = vi.fn(() => new Promise<string | undefined>((r) => (accept = r)));
    const s = scriptedHost({
      ...BASE,
      "turn/start": (_msg, peer) => {
        setImmediate(() =>
          peer.say({ id: "pending", method: "item/commandExecution/requestApproval", params: COMMAND() }),
        );
        return { turn: { id: "turn_1", status: "inProgress" } };
      },
    });
    const session = await open(s.host, { agent: withPolicy({ default: "ask" }), askPermission: asked });
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    s.peer.notify("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed", error: null } });
    accept("accept");
    await vi.waitFor(() => expect(s.peer.received.find((m) => m.id === "pending" && !m.method)).toBeDefined());
    expect(s.peer.received.find((m) => m.id === "pending" && !m.method)).toEqual({
      id: "pending",
      result: { decision: "decline" },
    });
    await turn;
    // completed before turn/start answered: its ask is declined unasked
    const early = scriptedHost({
      ...BASE,
      "turn/start": (msg, peer) => {
        peer.say({ id: "early", method: "item/commandExecution/requestApproval", params: COMMAND() });
        peer.notify("turn/completed", { threadId: "thr_1", turn: { id: "turn_1", status: "completed", error: null } });
        setImmediate(() => peer.say({ id: msg.id, result: { turn: { id: "turn_1", status: "inProgress" } } }));
        return NO_ANSWER;
      },
    });
    const asked2 = vi.fn(async () => "accept");
    const second = await open(early.host, { agent: withPolicy({ default: "ask" }), askPermission: asked2 });
    await second.prompt("go");
    await vi.waitFor(() => expect(early.peer.received.find((m) => m.id === "early" && !m.method)).toBeDefined());
    expect(early.peer.received.find((m) => m.id === "early" && !m.method)).toEqual({
      id: "early",
      result: { decision: "decline" },
    });
    expect(asked2).not.toHaveBeenCalled();
    await session.close();
    await second.close();
  });

  it("declines an ask about another turn or after cancel, and answers cancel when a person stops the turn", async () => {
    // another turn's ask
    const other = asking(() => [
      { method: "item/commandExecution/requestApproval", params: COMMAND({ turnId: "turn_old" }) },
    ]);
    const o = scriptedHost(other.table);
    const first = await open(o.host, { agent: withPolicy({ default: "allow" }) });
    await first.prompt("go");
    expect(other.answers).toEqual([{ decision: "decline" }]);
    await first.close();
    // a person stops the turn while an ask is open: cancel; an ask after that: declined unasked
    let release!: () => void;
    const s = scriptedHost({
      ...BASE,
      "turn/start": () => ({ turn: { id: "turn_1", status: "inProgress" } }),
      "turn/interrupt": (_m, peer) => (
        setImmediate(() => {
          peer.say({ id: "late", method: "item/commandExecution/requestApproval", params: COMMAND() });
          release = () =>
            peer.notify("turn/completed", {
              threadId: "thr_1",
              turn: { id: "turn_1", status: "interrupted", error: null },
            });
        }),
        {}
      ),
    });
    const asked = vi.fn(() => new Promise<string | undefined>(() => {}));
    const session = await open(s.host, { agent: withPolicy({ default: "ask" }), askPermission: asked });
    const turn = session.prompt("go");
    await settle();
    s.peer.say({ id: "open", method: "item/commandExecution/requestApproval", params: COMMAND() });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    await session.cancel();
    await vi.waitFor(() => expect(s.peer.received.find((m) => m.id === "late" && !m.method)).toBeDefined());
    expect(s.peer.received.find((m) => m.id === "open" && !m.method)).toEqual({
      id: "open",
      result: { decision: "cancel" },
    });
    expect(s.peer.received.find((m) => m.id === "late" && !m.method)).toEqual({
      id: "late",
      result: { decision: "decline" },
    });
    expect(asked).toHaveBeenCalledTimes(1);
    release();
    await expect(turn).resolves.toMatchObject({ stopReason: "cancelled" });
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
