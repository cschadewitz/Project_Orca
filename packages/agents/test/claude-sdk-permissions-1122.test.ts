/**
 * ORCA's permission policy on a Claude Agent SDK session (#1122): the `PreToolUse` hook and
 * `canUseTool` decide every tool call by ORCA's rules, people and answerer; an allow is for one
 * call and never tells Claude to remember it; a deny says why; an ask outside a live turn, or
 * after the turn was cancelled, is denied and the tool does not run.
 *
 * `claude` is the stand-in (fixtures/claude-sdk-stand-in.mjs): its `call` script makes one tool
 * use the way Claude Code does (hook first, then its own ask) and reports the hook's decision
 * and the permission answer. No account and no model are involved.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type PermissionPolicy } from "@orca/core";
import {
  CLAUDE_SDK_DENIALS,
  claudeSdkPermissionBridge,
  openClaudeSdkSession,
  type AgentSession,
  type ClaudeSdkSessionOptions,
  type PermissionInvocation,
  type SessionUpdateEvent,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));

let dir: string;
let ws: string;
let claude: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-perm-")));
  ws = join(dir, "ws");
  await mkdir(join(ws, "src"), { recursive: true });
  await mkdir(join(dir, "orca"), { recursive: true });
  claude = join(dir, "claude");
  await writeFile(claude, `#!/bin/sh\ncd "${ws}"\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`);
  await chmod(claude, 0o755);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

type Asked = { request: acp.RequestPermissionRequest; invocation?: PermissionInvocation | undefined };

async function open(extra: Partial<ClaudeSdkSessionOptions> = {}) {
  const session = await openClaudeSdkSession({
    agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
    hostId: "local",
    cwd: ws,
    preflight: { executable: claude, env: { PATH: process.env.PATH ?? "" } },
    startupTimeoutMs: 10_000,
    exitGraceMs: 2_000,
    ...extra,
  });
  sessions.push(session);
  return session;
}

/** Ask `answer` for every ask, keeping what was asked. */
function answerer(answer: (request: acp.RequestPermissionRequest) => string | undefined | Promise<string | undefined>) {
  const asked: Asked[] = [];
  return {
    asked,
    askPermission: async (request: acp.RequestPermissionRequest, invocation?: PermissionInvocation) => {
      asked.push({ request, invocation });
      return answer(request);
    },
  };
}

type CallResult = {
  ran: string;
  answer: {
    hook: string | null;
    behavior: string;
    message?: string;
    interrupt?: boolean;
    updatedPermissions?: unknown;
    updatedInput?: unknown;
  } | null;
};

/** One tool use through the stand-in; what the hook and the answer were. */
async function call(
  session: AgentSession,
  c: { name: string; input: Record<string, unknown>; asks?: boolean; extra?: Record<string, unknown>; parent?: string },
): Promise<CallResult> {
  const events: SessionUpdateEvent[] = [];
  const off = session.onUpdate((e) => events.push(e));
  try {
    await session.prompt(`call ${JSON.stringify(c)}`);
  } finally {
    off();
  }
  const text = events
    .filter((e) => e.summary.kind === "agent_message_chunk")
    .map((e) => e.summary.text ?? "")
    .at(-1)!;
  return JSON.parse(text) as CallResult;
}

const fetchCall = { name: "WebFetch", input: { url: "https://example.com/a", prompt: "p" }, asks: true };

describe("ORCA answers Claude's permission asks (#1122)", () => {
  it("allows a call its rules allow for this call only: no updatedPermissions, asked again next time", async () => {
    const decisions: string[] = [];
    const session = await open({
      agent: {
        id: "claude-sdk",
        cancelGraceMs: 2_000,
        permissions: {
          rules: [{ match: { kind: "fetch", titlePattern: "^Fetch https://example\\.com/" }, decision: "allow" }],
        },
      },
      onPermission: (info) => decisions.push(info.decision),
    });
    for (let i = 0; i < 2; i++) {
      const r = await call(session, fetchCall);
      expect(r.ran).toBe("allow");
      // The hook leaves an allowed call to Claude; Claude's own ask reaches ORCA, every time.
      expect(r.answer).toMatchObject({ hook: null, behavior: "allow", updatedInput: fetchCall.input });
      expect(r.answer).not.toHaveProperty("updatedPermissions");
    }
    expect(decisions).toEqual(["allow", "allow"]);
  });

  it("decides each call by the policy as it is now: a sidecar grant taken back is asked again", async () => {
    const sidecar = join(dir, "orca", "orca.permissions.json");
    const grant = { match: { kind: "fetch", titlePattern: "^Fetch https://example\\.com/" }, decision: "allow" };
    await writeFile(sidecar, JSON.stringify({ agents: { "claude-sdk": { rules: [grant] } } }));
    const people = answerer(() => "reject");
    const session = await open({ permissionFiles: [sidecar], askPermission: people.askPermission });
    expect((await call(session, fetchCall)).ran).toBe("allow");
    expect(people.asked).toHaveLength(0);
    await writeFile(sidecar, JSON.stringify({ agents: {} }));
    const after = await call(session, fetchCall);
    // Now the default asks: the hook sends it to Claude's ask, and the person declines.
    expect(after.answer).toMatchObject({ hook: "ask", behavior: "deny", message: CLAUDE_SDK_DENIALS.declined });
    expect(people.asked).toHaveLength(1);
    // A fresh session decides afresh too.
    const fresh = await open({ permissionFiles: [sidecar], askPermission: answerer(() => "allow").askPermission });
    expect((await call(fresh, fetchCall)).answer).toMatchObject({ hook: "ask", behavior: "allow" });
  });

  it("asks the person about what the policy asks, and tells the model when they decline", async () => {
    const people = answerer((r) => (r.toolCall.kind === "execute" ? "reject" : "allow"));
    const session = await open({ askPermission: people.askPermission });
    const bash = await call(session, { name: "Bash", input: { command: "rm -rf build", description: "d" } });
    expect(bash).toMatchObject({
      ran: "deny",
      answer: { hook: "ask", behavior: "deny", message: CLAUDE_SDK_DENIALS.declined },
    });
    const outside = await call(session, { name: "Read", input: { file_path: "/etc/hostname" }, asks: true });
    expect(outside.answer).toMatchObject({ hook: "ask", behavior: "allow" });
    const [first, second] = people.asked;
    expect(first!.request.toolCall).toMatchObject({
      title: "rm -rf build",
      kind: "execute",
      rawInput: { command: "rm -rf build", description: "d" },
    });
    expect(first!.request.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    expect(second!.request.toolCall).toMatchObject({
      title: "Read /etc/hostname",
      kind: "read",
      locations: [{ path: "/etc/hostname" }],
    });
    expect(first!.invocation?.turnId).toBeDefined();
    expect(first!.invocation?.turnId).not.toBe(second!.invocation?.turnId);
  });

  it("sends a call Claude would run by itself to the person when a rule asks about it", async () => {
    const people = answerer(() => "reject");
    const session = await open({
      agent: {
        id: "claude-sdk",
        cancelGraceMs: 2_000,
        permissions: { rules: [{ match: { kind: "read", titlePattern: "^Read src/secret" }, decision: "ask" }] },
      },
      askPermission: people.askPermission,
    });
    // `asks: false`: Claude's own rules would let a read in its working directory through.
    const r = await call(session, { name: "Read", input: { file_path: join(ws, "src/secret.env") } });
    expect(r).toMatchObject({ ran: "deny", answer: { hook: "ask", behavior: "deny" } });
    expect(people.asked[0]!.request.toolCall.title).toBe("Read src/secret.env");
    // Without the rule, the same read just runs.
    const plain = await open();
    expect((await call(plain, { name: "Read", input: { file_path: join(ws, "src/a.ts") } })).ran).toBe("ran");
  });

  it("denies before it runs what the policy denies, and ORCA's own files whatever the rules say", async () => {
    const people = answerer(() => "allow");
    const session = await open({
      agent: {
        id: "claude-sdk",
        cancelGraceMs: 2_000,
        permissions: { default: "allow", rules: [{ match: { kind: "fetch" }, decision: "deny" }] },
      },
      protectedPaths: { readOnly: [], noAccess: [join(dir, "orca")] },
      askPermission: people.askPermission,
    });
    expect(await call(session, fetchCall)).toEqual({ ran: "denied", answer: null });
    expect(await call(session, { name: "Read", input: { file_path: join(dir, "orca", "key") }, asks: true })).toEqual({
      ran: "denied",
      answer: null,
    });
    // Recursive searches stay denied, whatever the policy.
    expect(await call(session, { name: "Grep", input: { pattern: "x", path: ws } })).toEqual({
      ran: "denied",
      answer: null,
    });
    expect(people.asked).toHaveLength(0);
  });

  it("shows the parent tool call and Claude's reason on a subagent's ask", async () => {
    const people = answerer(() => "reject");
    const session = await open({ askPermission: people.askPermission });
    await call(session, {
      name: "Read",
      input: { file_path: "/etc/hostname" },
      asks: true,
      parent: "toolu_task_1",
      extra: {
        agent_id: "agent-7",
        decision_reason: "Path is outside allowed working directories\u0007",
        blocked_path: "/etc/hostname",
      },
    });
    const meta = (people.asked[0]!.request.toolCall._meta as { claudeAgentSdk: Record<string, unknown> })
      .claudeAgentSdk;
    expect(meta).toEqual({
      toolName: "Read",
      decisionReason: "Path is outside allowed working directories",
      blockedPath: "/etc/hostname",
      agentId: "agent-7",
      parentToolCallId: "toolu_task_1",
    });
  });

  it("offers the decline first when Claude says the ask must default to no", async () => {
    const people = answerer(() => "reject");
    const session = await open({ askPermission: people.askPermission });
    await call(session, { ...fetchCall, extra: { default_to_no: true, suppress_always_allow_rule: true } });
    expect(people.asked[0]!.request.options.map((o) => o.kind)).toEqual(["reject_once", "allow_once"]);
    expect(people.asked[0]!.request.toolCall._meta).toMatchObject({
      claudeAgentSdk: { defaultToNo: true, suppressAlwaysAllowRule: true },
    });
  });

  it("never allows a call it cannot describe exactly (a subagent start) without a person", async () => {
    const decisions: string[] = [];
    const session = await open({
      agent: { id: "claude-sdk", cancelGraceMs: 2_000, permissions: { default: "allow", rules: [] } },
      onPermission: (info) => decisions.push(info.decision),
    });
    const r = await call(session, { name: "Task", input: { description: "look around", prompt: "p" }, asks: true });
    expect(r.answer).toMatchObject({ hook: "ask", behavior: "deny", message: CLAUDE_SDK_DENIALS.noAnswerer });
    expect(decisions).toEqual(["ask:no-answerer"]);
  });

  it("denies an ask the person was still answering when the turn was cancelled, and stops Claude", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked!: () => void;
    const reached = new Promise<void>((r) => (asked = r));
    const session = await open({
      askPermission: async () => {
        asked();
        await held;
        return "allow";
      },
    });
    const events: SessionUpdateEvent[] = [];
    session.onUpdate((e) => events.push(e));
    const turn = session.prompt(`call ${JSON.stringify(fetchCall)}`);
    await reached;
    await session.cancel();
    release();
    const outcome = await turn;
    expect(outcome.stopReason).toBe("cancelled");
    // The tool did not run: its result is the refusal.
    const failed = events.filter((e) => e.summary.kind === "tool_call_update").map((e) => e.summary.status);
    expect(failed).toEqual(["failed"]);
  });

  it("denies an ask that comes outside a live turn, before anybody is asked", async () => {
    const people = answerer(() => "allow");
    const bridge = claudeSdkPermissionBridge({
      agent: { id: "claude-sdk" },
      sessionId: "sess_x",
      cwd: ws,
      askPermission: people.askPermission,
      liveTurn: () => undefined,
      parentOf: () => undefined,
      logger: silentLogger,
    });
    const signal = new AbortController().signal;
    expect(await bridge.canUseTool("WebFetch", fetchCall.input, { signal, toolUseID: "t1" } as never)).toMatchObject({
      behavior: "deny",
      message: CLAUDE_SDK_DENIALS.noTurn,
    });
    expect(
      await bridge.preToolUse(
        {
          hook_event_name: "PreToolUse",
          tool_name: "WebFetch",
          tool_input: fetchCall.input,
          tool_use_id: "t1",
        } as never,
        "t1",
        { signal },
      ),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: CLAUDE_SDK_DENIALS.noTurn },
    });
    expect(people.asked).toHaveLength(0);
  });

  it("fails the turn when the answerer fails, and retires the session so nothing late is taken for the next turn", async () => {
    const session = await open({
      askPermission: () => Promise.reject(new Error("the human-input store is gone")),
    });
    await expect(session.prompt(`call ${JSON.stringify(fetchCall)}`)).rejects.toThrow(/human-input store is gone/);
    // Claude's own turn never ended: the session takes no further prompt that could be handed its result.
    await expect(session.prompt("hello")).rejects.toThrow(/stopped after its permission answerer failed|ended/);
    await session.terminated;
  });

  describe("every failure on the way to a verdict is an explicit deny (#1306 review)", () => {
    const turn = { id: "turn-1", signal: new AbortController().signal };
    const bridgeWith = (loadPolicy: () => Promise<PermissionPolicy>, extra: Record<string, unknown> = {}) =>
      claudeSdkPermissionBridge({
        agent: { id: "claude-sdk" },
        sessionId: "sess_x",
        cwd: ws,
        liveTurn: () => turn,
        parentOf: () => undefined,
        loadPolicy,
        decisionTimeoutMs: 100,
        logger: silentLogger,
        ...extra,
      });
    const hook = (b: ReturnType<typeof claudeSdkPermissionBridge>) =>
      b.preToolUse(
        {
          hook_event_name: "PreToolUse",
          tool_name: "WebFetch",
          tool_input: fetchCall.input,
          tool_use_id: "t1",
        } as never,
        "t1",
        { signal: new AbortController().signal },
      );
    const ask = (b: ReturnType<typeof claudeSdkPermissionBridge>) =>
      b.canUseTool("WebFetch", fetchCall.input, { signal: new AbortController().signal, toolUseID: "t1" } as never);
    /** What Claude does: the hook (one policy read, and where the call runs), then its ask. */
    const hookThenAsk = async (b: ReturnType<typeof claudeSdkPermissionBridge>) => {
      await hook(b);
      return ask(b);
    };
    const failedHook = {
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: CLAUDE_SDK_DENIALS.failed },
    };
    const failedAsk = { behavior: "deny", message: CLAUDE_SDK_DENIALS.failed };

    it("a policy read that throws", async () => {
      const b = bridgeWith(() => Promise.reject(new Error("disk gone")));
      expect(await hook(b)).toMatchObject(failedHook);
      expect(await ask(b)).toMatchObject(failedAsk);
    });

    it("a policy read that never ends, well inside the SDK's own timeout", async () => {
      const b = bridgeWith(() => new Promise<PermissionPolicy>(() => undefined));
      const started = Date.now();
      expect(await hook(b)).toMatchObject(failedHook);
      expect(await ask(b)).toMatchObject(failedAsk);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("the read again after an allow, before Claude is told yes", async () => {
      let reads = 0;
      const allowFetch: PermissionPolicy = { default: "ask", rules: [{ match: { kind: "fetch" }, decision: "allow" }] };
      const b = bridgeWith(() => (++reads <= 2 ? Promise.resolve(allowFetch) : Promise.reject(new Error("gone"))));
      expect(await hookThenAsk(b)).toMatchObject(failedAsk);
      expect(reads).toBe(3);
    });

    describe("the policy changing between the verdict and the answer to Claude", () => {
      const allowFetch: PermissionPolicy = { default: "ask", rules: [{ match: { kind: "fetch" }, decision: "allow" }] };
      const askFetch: PermissionPolicy = { default: "ask", rules: [{ match: { kind: "fetch" }, decision: "ask" }] };
      const denyFetch: PermissionPolicy = { default: "ask", rules: [{ match: { kind: "fetch" }, decision: "deny" }] };
      const sequence = (...policies: PermissionPolicy[]) => {
        let n = 0;
        return () => Promise.resolve(policies[Math.min(n++, policies.length - 1)]!);
      };
      const yes = { askPermission: () => Promise.resolve("allow") };

      it("an automatic allow is refused when the policy now asks: nobody answered", async () => {
        const decisions: string[] = [];
        const b = bridgeWith(sequence(allowFetch, allowFetch, askFetch), {
          ...yes,
          onPermission: (i: { decision: string }) => decisions.push(i.decision),
        });
        expect(await hookThenAsk(b)).toMatchObject({ behavior: "deny", message: CLAUDE_SDK_DENIALS.askedSince });
        expect(decisions).toEqual(["allow:ask-since"]);
      });

      it("an automatic allow stands when the policy still allows", async () => {
        const b = bridgeWith(sequence(allowFetch, allowFetch, allowFetch));
        expect(await hookThenAsk(b)).toMatchObject({ behavior: "allow" });
      });

      it("a person's allow-once stands while the policy still asks", async () => {
        const b = bridgeWith(sequence(askFetch, askFetch, askFetch), yes);
        expect(await hookThenAsk(b)).toMatchObject({ behavior: "allow" });
      });

      it("a deny that appears meanwhile wins over an automatic allow and over a person's allow", async () => {
        expect(await hookThenAsk(bridgeWith(sequence(allowFetch, allowFetch, denyFetch)))).toMatchObject({
          behavior: "deny",
          message: CLAUDE_SDK_DENIALS.changed,
        });
        expect(await hookThenAsk(bridgeWith(sequence(askFetch, askFetch, denyFetch), yes))).toMatchObject({
          behavior: "deny",
          message: CLAUDE_SDK_DENIALS.changed,
        });
      });
    });

    it("a tool input the mapping cannot read", async () => {
      const b = bridgeWith(() => Promise.resolve({ default: "allow", rules: [] }));
      const poisoned = new Proxy(
        {},
        {
          get: () => {
            throw new Error("no");
          },
          ownKeys: () => {
            throw new Error("no");
          },
        },
      );
      expect(
        await b.preToolUse(
          { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: poisoned, tool_use_id: "t1" } as never,
          "t1",
          { signal: new AbortController().signal },
        ),
      ).toMatchObject(failedHook);
      expect(
        await b.canUseTool(
          "Read",
          poisoned as never,
          { signal: new AbortController().signal, toolUseID: "t1" } as never,
        ),
      ).toMatchObject(failedAsk);
    });
  });
});
