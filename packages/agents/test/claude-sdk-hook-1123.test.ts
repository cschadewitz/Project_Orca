/**
 * ORCA's native tool hook on the Claude Agent SDK route, in process (#1123): the `PreToolUse`
 * callback decides every call as the ACP route's hook program does (ORCA's own files, the policy,
 * then a call running outside the workspace asks), every failure is an explicit deny, and with
 * `diagnostics.toolCalls: keep` it records the ACP hook's v1 telemetry line per decided call,
 * handed to the engine through the same `attach` / `drain` / `finish` a spool offers.
 *
 * The revoked-grant proof (#704 on this route) is in claude-sdk-permissions-1122.test.ts: "a
 * sidecar grant taken back is asked again", where the hook answers `ask` on the very next call.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOOK_TELEMETRY_LINE_VERSION,
  silentLogger,
  type ConfiguredPermissionPolicy,
  type HookTelemetryLine,
} from "@orca/core";
import {
  CLAUDE_SDK_DENIALS,
  checkClaudePreTool,
  claudeSdkPermissionBridge,
  inProcessHookTelemetry,
  openClaudeSdkSession,
  preToolTelemetryLine,
  type AgentSession,
  type ClaudeHookContext,
  type ClaudePreToolFrame,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));

let dir: string;
let ws: string;
let protectedDir: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-hook-")));
  ws = join(dir, "ws");
  protectedDir = join(dir, "orca-private");
  await mkdir(join(ws, "src"), { recursive: true });
  await mkdir(protectedDir, { recursive: true });
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

const permissions: ConfiguredPermissionPolicy = {
  default: "allow",
  rules: [
    { match: { kind: "execute" }, decision: "ask" },
    { match: { kind: "edit", titlePattern: "secrets/" }, decision: "deny" },
  ],
};

function bridge(extra: Partial<Parameters<typeof claudeSdkPermissionBridge>[0]> = {}) {
  const lines: HookTelemetryLine[] = [];
  const b = claudeSdkPermissionBridge({
    agent: { id: "claude-sdk", permissions },
    sessionId: "sess_x",
    cwd: ws,
    protectedPaths: { noAccess: [protectedDir], readOnly: [] },
    liveTurn: () => ({ id: "turn-1", signal: new AbortController().signal }),
    parentOf: () => undefined,
    onToolCallTelemetry: (line) => lines.push(line),
    logger: silentLogger,
    ...extra,
  });
  const hook = (frame: ClaudePreToolFrame) =>
    b.preToolUse(
      {
        hook_event_name: "PreToolUse",
        tool_name: frame.toolName,
        tool_input: frame.toolInput,
        tool_use_id: frame.toolUseId ?? "",
        session_id: "s",
        transcript_path: "",
        cwd: frame.cwd,
      } as never,
      frame.toolUseId,
      { signal: new AbortController().signal },
    );
  return { ...b, lines, hook };
}

/** A line without what only differs by clock: when and how long. */
const stable = ({ at: _at, latencyMs: _latency, ...rest }: HookTelemetryLine) => rest;

describe("ORCA's native tool hook, in process (#1123)", () => {
  it("records the ACP hook's telemetry line for each call, decided the same way", async () => {
    const frames: ClaudePreToolFrame[] = [
      { toolName: "Read", toolInput: { file_path: join(ws, "src", "a.ts") }, cwd: ws, toolUseId: "t1" },
      { toolName: "Bash", toolInput: { command: "make test", description: "d" }, cwd: ws, toolUseId: "t2" },
      { toolName: "Write", toolInput: { file_path: join(ws, "secrets", "k"), content: "x" }, cwd: ws, toolUseId: "t3" },
      { toolName: "Read", toolInput: { file_path: join(protectedDir, "store") }, cwd: ws, toolUseId: "t4" },
      { toolName: "mcp__tools__touch", toolInput: { path: "a" }, cwd: ws, toolUseId: "t5" },
      { toolName: "Read", toolInput: { file_path: join(ws, "src", "a.ts") }, cwd: dir, toolUseId: "t6" },
    ];
    const context: ClaudeHookContext = {
      version: 1,
      agentId: "claude-sdk",
      permissions,
      permissionFiles: [],
      workspaceCwd: ws,
      protectedPaths: { noAccess: [protectedDir], readOnly: [] },
    };
    const b = bridge();
    for (const frame of frames) await b.hook(frame);
    const acp: HookTelemetryLine[] = [];
    for (const frame of frames)
      acp.push(preToolTelemetryLine(frame, { verdict: await checkClaudePreTool(context, frame) }, "x", 0));
    expect(b.lines.map(stable)).toEqual(acp.map(stable));
    expect(b.lines.map((l) => [l.decision, l.rule])).toEqual([
      ["allow", "policy"],
      ["ask", "policy"],
      ["deny", "policy"],
      ["deny", "protected"],
      ["allow", "policy"],
      ["ask", "cwd-outside-workspace"],
    ]);
    for (const line of b.lines) {
      expect(line.v).toBe(HOOK_TELEMETRY_LINE_VERSION);
      expect(Number.isNaN(Date.parse(line.at))).toBe(false);
    }
  });

  it("denies a call it could not decide, and records the failure as a block", async () => {
    const b = bridge({ loadPolicy: () => Promise.reject(new Error("disk on fire")) });
    const out = await b.hook({ toolName: "Read", toolInput: { file_path: "a" }, cwd: ws, toolUseId: "t1" });
    expect(out).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: CLAUDE_SDK_DENIALS.failed },
    });
    expect(b.lines.map(stable)).toEqual([
      {
        v: HOOK_TELEMETRY_LINE_VERSION,
        tool: "Read",
        toolUseId: "t1",
        input: { file_path: "a" },
        decision: "block",
        rule: "hook-error",
        hookError: "internal error",
      },
    ]);
    // The text of the failure goes nowhere Claude or the store can see.
    expect(JSON.stringify(b.lines)).not.toContain("disk on fire");
  });

  it("never lets a telemetry failure change an answer", async () => {
    const b = bridge({
      onToolCallTelemetry: () => {
        throw new Error("store gone");
      },
    });
    const out = await b.hook({
      toolName: "Write",
      toolInput: { file_path: join(ws, "secrets", "k"), content: "x" },
      cwd: ws,
      toolUseId: "t1",
    });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("asks a person about a call running outside the workspace, though a rule allows it", async () => {
    const asked: string[] = [];
    const b = bridge({
      askPermission: (request) => {
        asked.push(request.toolCall.title ?? "");
        return Promise.resolve(request.options.find((o) => o.kind === "reject_once")!.optionId);
      },
    });
    const frame = { toolName: "Read", toolInput: { file_path: "a.ts" }, cwd: dir, toolUseId: "t1" };
    expect(await b.hook(frame)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const answer = await b.canUseTool("Read", frame.toolInput, {
      signal: new AbortController().signal,
      toolUseID: "t1",
    } as never);
    expect(answer).toMatchObject({ behavior: "deny", message: CLAUDE_SDK_DENIALS.declined });
    expect(asked).toHaveLength(1);
    // The same call in the workspace is the rule's to allow, and nobody is asked.
    expect(await b.hook({ ...frame, cwd: ws, toolUseId: "t2" })).toEqual({});
    expect(
      await b.canUseTool("Read", frame.toolInput, { signal: new AbortController().signal, toolUseID: "t2" } as never),
    ).toMatchObject({ behavior: "allow" });
    expect(asked).toHaveLength(1);
  });

  describe("a call outside the workspace stays a person's to allow, through Claude's ask (#1316 review)", () => {
    /** A bridge whose answerer declines and counts, with the policy as `current` says now. */
    const counted = (current: { policy: ConfiguredPermissionPolicy }, turn = { id: "turn-1" }) => {
      const asked: string[] = [];
      const b = bridge({
        loadPolicy: () =>
          Promise.resolve({ default: current.policy.default ?? "ask", rules: [...current.policy.rules] } as never),
        liveTurn: () => ({ id: turn.id, signal: new AbortController().signal }),
        askPermission: (request) => {
          asked.push(request.toolCall.title ?? "");
          return Promise.resolve(request.options.find((o) => o.kind === "reject_once")!.optionId);
        },
      });
      const ask = (id: string, input: Record<string, unknown> = { file_path: "a.ts" }) =>
        b.canUseTool("Read", input, { signal: new AbortController().signal, toolUseID: id } as never);
      return { b, asked, ask };
    };
    const allowAll: ConfiguredPermissionPolicy = { default: "allow", rules: [] };
    const askAll: ConfiguredPermissionPolicy = { default: "ask", rules: [] };
    const read = (id: string, cwd: string, input: Record<string, unknown> = { file_path: "a.ts" }) => ({
      toolName: "Read",
      toolInput: input,
      cwd,
      toolUseId: id,
    });

    it("when the policy asked at the hook and allows by the time Claude asks", async () => {
      const current = { policy: askAll };
      const { b, asked, ask } = counted(current);
      expect(await b.hook(read("t1", dir))).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
      current.policy = allowAll;
      expect(await ask("t1")).toMatchObject({ behavior: "deny", message: CLAUDE_SDK_DENIALS.declined });
      expect(asked).toHaveLength(1);
    });

    it("when the hook never saw the call, saw other input, or saw it in another turn", async () => {
      const turn = { id: "turn-1" };
      const { b, asked, ask } = counted({ policy: allowAll }, turn);
      expect(await ask("unseen")).toMatchObject({ behavior: "deny" });
      await b.hook(read("t2", ws, { file_path: "a.ts" }));
      expect(await ask("t2", { file_path: "b.ts" })).toMatchObject({ behavior: "deny" });
      await b.hook(read("t3", ws));
      turn.id = "turn-2";
      expect(await ask("t3")).toMatchObject({ behavior: "deny" });
      expect(asked).toHaveLength(3);
      // The control: seen inside, in this turn, with this input, the rule allows it.
      await b.hook(read("t4", ws));
      expect(await ask("t4")).toMatchObject({ behavior: "allow" });
      expect(asked).toHaveLength(3);
    });

    it("once its answer is settled, and once the session has forgotten it", async () => {
      const { b, asked, ask } = counted({ policy: allowAll });
      await b.hook(read("t1", ws));
      expect(await ask("t1")).toMatchObject({ behavior: "allow" });
      // The same use asked again is not covered by the hook's earlier look.
      expect(await ask("t1")).toMatchObject({ behavior: "deny" });
      expect(asked).toHaveLength(1);
      await b.hook(read("old", ws));
      for (let i = 0; i < 1024; i++) await b.hook(read(`n${i}`, ws));
      expect(await ask("old")).toMatchObject({ behavior: "deny" });
      expect(await ask("n1023")).toMatchObject({ behavior: "allow" });
      expect(asked).toHaveLength(2);
    });
  });

  it("takes the session's additional directories as the workspace too", async () => {
    const extra = join(dir, "extra");
    await mkdir(extra);
    const b = bridge({ additionalDirectories: [extra] });
    expect(await b.hook({ toolName: "Read", toolInput: { file_path: "a" }, cwd: extra, toolUseId: "t1" })).toEqual({});
    expect(b.lines.map((l) => l.rule)).toEqual(["policy"]);
  });
});

describe("in-process telemetry, as the engine reads a spool (#1123)", () => {
  const line = (tool: string): HookTelemetryLine => ({
    v: HOOK_TELEMETRY_LINE_VERSION,
    at: new Date(0).toISOString(),
    tool,
    decision: "allow",
    latencyMs: 1,
  });

  it("hands lines to the consumer on drain, drops them with none attached, and stops at finish", async () => {
    const t = inProcessHookTelemetry();
    t.record(line("A"));
    expect(await t.drain()).toEqual({ accepted: 0, rejected: 0, dropped: 1 });
    const got: string[] = [];
    t.attach((lines) => {
      got.push(...lines.map((l) => l.tool));
      return Promise.resolve();
    });
    t.record(line("B"));
    t.record(line("C"));
    expect(await t.drain()).toEqual({ accepted: 2, rejected: 0, dropped: 0 });
    t.record(line("D"));
    expect(await t.finish()).toEqual({ accepted: 1, rejected: 0, dropped: 0 });
    t.record(line("E"));
    expect(await t.drain()).toEqual({ accepted: 1, rejected: 0, dropped: 0 }); // finish's report, again
    expect(got).toEqual(["B", "C", "D"]);
  });

  it("rejects a line that is not a v1 line, and drops a drain whose consumer fails", async () => {
    const t = inProcessHookTelemetry();
    t.attach(() => Promise.reject(new Error("no")));
    t.record({ ...line("A"), latencyMs: -1 });
    t.record(line("B"));
    expect(await t.drain()).toEqual({ accepted: 0, rejected: 1, dropped: 1 });
  });

  it("settles finish in time with a consumer that never answers, and hands it nothing after", async () => {
    const t = inProcessHookTelemetry({ finishTimeoutMs: 100 });
    let calls = 0;
    t.attach(() => {
      calls++;
      return new Promise<void>(() => undefined);
    });
    t.record(line("A"));
    void t.drain(); // the consumer takes A and never answers
    await new Promise((r) => setTimeout(r, 10));
    t.record(line("B"));
    const started = Date.now();
    expect(await t.finish()).toEqual({
      accepted: 0,
      rejected: 0,
      dropped: 2,
      refused: "the consumer did not answer in time",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    t.record(line("C"));
    await t.drain();
    expect(calls).toBe(1);
  });

  it("cuts a long input to the line limit as the hook program does", async () => {
    const t = inProcessHookTelemetry();
    const got: HookTelemetryLine[] = [];
    t.attach((lines) => {
      got.push(...lines);
      return Promise.resolve();
    });
    t.record({ ...line("Write"), input: { file_path: "a", content: "x".repeat(100_000) } });
    expect(await t.drain()).toMatchObject({ accepted: 1 });
    expect(JSON.stringify(got[0]!.input)).toMatch(/left out/);
  });
});

describe.runIf(process.platform !== "win32")("telemetry on a session (#1123)", () => {
  const open = async (toolCallTelemetry?: "off" | "keep") => {
    const claude = join(dir, "claude");
    await writeFile(claude, `#!/bin/sh\ncd "${ws}"\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`);
    await chmod(claude, 0o755);
    const session = await openClaudeSdkSession({
      agent: { id: "claude-sdk", cancelGraceMs: 2_000, permissions },
      hostId: "local",
      cwd: ws,
      preflight: { executable: claude, env: { PATH: process.env.PATH ?? "" } },
      startupTimeoutMs: 10_000,
      exitGraceMs: 2_000,
      toolCallTelemetry,
    });
    sessions.push(session);
    return session;
  };

  it("offers the hook's lines as hookTelemetry with diagnostics.toolCalls: keep, and hands the last ones over at close", async () => {
    const session = await open("keep");
    const got: HookTelemetryLine[] = [];
    session.hookTelemetry!.attach((lines) => {
      got.push(...lines);
      return Promise.resolve();
    });
    await session.prompt(`call ${JSON.stringify({ name: "Read", input: { file_path: join(ws, "src", "a.ts") } })}`);
    await session.hookTelemetry!.drain();
    expect(got.map((l) => [l.tool, l.decision, l.rule])).toEqual([["Read", "allow", "policy"]]);
    await session.prompt(`call ${JSON.stringify({ name: "Bash", input: { command: "ls" }, cwd: dir })}`);
    await session.close();
    expect(got.map((l) => [l.tool, l.decision, l.rule])).toEqual([
      ["Read", "allow", "policy"],
      ["Bash", "ask", "policy"],
    ]);
  });

  it("closes though the engine's consumer never answers", async () => {
    const session = await open("keep");
    session.hookTelemetry!.attach(() => new Promise<void>(() => undefined));
    await session.prompt(`call ${JSON.stringify({ name: "Read", input: { file_path: join(ws, "src", "a.ts") } })}`);
    void session.hookTelemetry!.drain();
    const started = Date.now();
    await session.close();
    await session.closed;
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("offers none by default", async () => {
    const session = await open();
    expect(session.hookTelemetry).toBeUndefined();
  });
});
