/**
 * The Claude Agent SDK session driver (#1120): one streaming `query()` per session, turns that
 * settle on `result`, interrupt and close, ACP-shaped updates, and the tool gate that holds
 * until ORCA answers Claude's permission asks (#1122).
 *
 * `claude` here is a stand-in (fixtures/claude-sdk-stand-in.mjs) that speaks the SDK's control
 * protocol, so no account and no model are involved.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrcaError } from "@orca/core";
import {
  claudeContent,
  openClaudeSdkSession,
  sessionUpdates,
  startupTermination,
  toolRefusal,
  type AgentSession,
  type ClaudeSdkSessionOptions,
  type SessionUpdateEvent,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));
const SENTINEL = "SENTINEL-7c1e-cli-text";

let dir: string;
let claude: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-session-")));
  claude = join(dir, "claude");
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`);
  await chmod(claude, 0o755);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

async function open(env: Record<string, string> = {}, extra: Partial<ClaudeSdkSessionOptions> = {}) {
  const session = await openClaudeSdkSession({
    agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
    hostId: "local",
    cwd: dir,
    preflight: { executable: claude, env: { PATH: process.env.PATH ?? "", ...env } },
    startupTimeoutMs: 10_000,
    exitGraceMs: 2_000,
    ...extra,
  });
  sessions.push(session);
  return session;
}

function collect(session: AgentSession): SessionUpdateEvent[] {
  const events: SessionUpdateEvent[] = [];
  session.onUpdate((e) => events.push(e));
  return events;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const texts = (events: SessionUpdateEvent[]) =>
  events.filter((e) => e.summary.kind === "agent_message_chunk").map((e) => e.summary.text);

describe.runIf(process.platform !== "win32")("Claude Agent SDK session (#1120)", () => {
  it("runs turns over one claude, with the fixed launch flags and no settings, MCP or session files", async () => {
    const logFile = join(dir, "log.jsonl");
    const session = await open({ STAND_IN_LOG: logFile });
    const events = collect(session);
    const first = await session.prompt("hello there");
    expect(first.stopReason).toBe("end_turn");
    const second = await session.prompt([{ type: "text", text: "hello again" }]);
    expect(second.stopReason).toBe("end_turn");
    expect(texts(events)).toEqual(["you said: hello there", "you said: hello again"]);
    expect(events.map((e) => e.summary.kind)).toContain("agent_thought_chunk");
    expect(session.configOptions).toEqual([]);
    expect(session.promptCapabilities).toEqual({ embeddedContext: false });

    const lines = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const starts = lines.filter((l) => l.argv);
    expect(starts).toHaveLength(1); // one process for every turn
    const argv = starts[0]!.argv as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        "--input-format",
        "stream-json",
        "--setting-sources=",
        "--permission-mode=default",
        "--no-session-persistence",
        "--strict-mcp-config",
      ]),
    );
    expect(starts[0]!.cwd).toBe(dir);
    const init = lines.find((l) => (l.in as { request?: { subtype?: string } })?.request?.subtype === "initialize");
    expect((init!.in as { request: Record<string, unknown> }).request).toMatchObject({
      hooks: { PreToolUse: [{ onFailure: "block" }] },
    });
  });

  it("gives claude only the environment it was handed, not the daemon's", async () => {
    process.env.ORCA_TEST_DAEMON_ONLY = "leak";
    try {
      const session = await open({ ORCA_TEST_AGENT_VALUE: "kept" });
      const events = collect(session);
      await session.prompt("env");
      const env = JSON.parse(texts(events)[0]!) as Record<string, string>;
      expect(env.ORCA_TEST_AGENT_VALUE).toBe("kept");
      expect(env.ORCA_TEST_DAEMON_ONLY).toBeUndefined();
      expect(Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_"))).toEqual([]);
    } finally {
      delete process.env.ORCA_TEST_DAEMON_ONLY;
    }
  });

  it("lets only an unprotected Read and TodoWrite run, maps tool calls and plans, and denies every ask", async () => {
    const session = await open();
    const events = collect(session);
    await session.prompt(`tools ${join(dir, "notes.txt")}`);
    expect(JSON.parse(texts(events).at(-1)!)).toEqual({ read: "ran", bash: "denied", grep: "denied", todo: "ran" });
    const calls = events.filter((e) => e.summary.kind === "tool_call").map((e) => e.summary);
    expect(calls.map((c) => [c.title, c.toolKind])).toEqual([
      ["Read", "read"],
      ["Bash", "execute"],
      ["Grep", "search"],
      ["TodoWrite", "think"],
    ]);
    expect(calls[0]!.locations).toEqual([join(dir, "notes.txt")]);
    const updates = events.filter((e) => e.summary.kind === "tool_call_update").map((e) => e.summary);
    expect(updates.map((u) => [u.toolCallId, u.status])).toEqual([
      ["t1", "completed"],
      ["t2", "failed"],
      ["t2g", "failed"],
      ["t3", "completed"],
    ]);
    const plan = events.find((e) => e.summary.kind === "plan")!.summary;
    expect(plan.planEntries).toEqual([
      { content: "look", status: "completed", priority: "medium" },
      { content: "write", status: "in_progress", priority: "medium" },
    ]);

    // A read of a path ORCA protects is denied too.
    const guarded = await open({}, { protectedPaths: { readOnly: [], noAccess: [join(dir, "secret")] } });
    const guardedEvents = collect(guarded);
    await guarded.prompt(`tools ${join(dir, "secret", "key")}`);
    expect(JSON.parse(texts(guardedEvents).at(-1)!)).toMatchObject({ read: "denied" });

    // An ask Claude's own rules raise is answered no.
    const asker = await open();
    const askEvents = collect(asker);
    await asker.prompt("ask");
    expect(texts(askEvents).at(-1)).toBe("deny");
  });

  it("ends a turn as cancelled on cancel, a prompt signal or a timeout, and the session goes on", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.prompt("slow");
    await until(() => texts(events).includes("working"));
    await session.cancel();
    expect((await turn).stopReason).toBe("cancelled");

    const ac = new AbortController();
    const signalled = session.prompt("slow", { signal: ac.signal });
    await until(() => texts(events).filter((t) => t === "working").length === 2);
    ac.abort("stop");
    expect((await signalled).stopReason).toBe("cancelled");

    expect((await session.prompt("slow", { timeoutMs: 200 })).stopReason).toBe("cancelled");
    expect((await session.prompt("hello")).stopReason).toBe("end_turn");
    await expect(session.prompt("hello", { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("fails a turn that does not end after the interrupt and stops claude", async () => {
    const session = await open({}, { cancelGraceMs: 300 });
    const events = collect(session);
    const turn = session.prompt("wedge");
    await until(() => texts(events).includes("working"));
    await session.cancel();
    await expect(turn).rejects.toThrow(/did not end its turn within 300ms of an interrupt/);
    await session.terminated;
    await session.closed;
    await expect(session.prompt("hello")).rejects.toThrow(/session has ended/);
  });

  it("refuses a second turn while one runs", async () => {
    const session = await open();
    const events = collect(session);
    const turn = session.prompt("slow");
    await until(() => texts(events).includes("working"));
    await expect(session.prompt("hello")).rejects.toMatchObject({ code: "RUN_STATE" });
    await session.cancel();
    await turn;
  });

  it("maps result errors without any CLI text, and max turns to max_turn_requests", async () => {
    const session = await open();
    const failure = (await session.prompt(`fail ${SENTINEL}`).catch((x: unknown) => x)) as OrcaError;
    expect(failure).toBeInstanceOf(OrcaError);
    expect(failure.code).toBe("AGENT_PROTOCOL");
    expect(failure.message + JSON.stringify(failure.details)).not.toContain(SENTINEL);
    expect((await session.prompt("maxturns")).stopReason).toBe("max_turn_requests");
  });

  it("fails the turn when claude exits during it, and ends the session", async () => {
    const session = await open();
    const failure = (await session.prompt("die").catch((x: unknown) => x)) as OrcaError;
    expect(failure.code).toBe("AGENT_TRANSPORT");
    await session.closed;
    await session.terminated;
  });

  it("close ends claude and everything it started", async () => {
    const session = await open();
    const events = collect(session);
    await session.prompt("grandchild");
    const pid = Number(texts(events)[0]);
    expect(alive(pid)).toBe(true);
    await session.close();
    await session.terminated;
    await until(() => !alive(pid));
  });

  it("kills a claude that outlives the end of its input", async () => {
    const session = await open({ STAND_IN_STUBBORN: "1" }, { exitGraceMs: 300 });
    await session.prompt("hello");
    const started = Date.now();
    await session.close();
    await session.terminated;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses Windows before starting anything", async () => {
    const logFile = join(dir, "log.jsonl");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      await expect(open({ STAND_IN_LOG: logFile })).rejects.toThrow(/only on Linux and macOS for now/);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    await expect(readFile(logFile, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("fails the open, with nothing left running, when claude does not start a session", async () => {
    const silent = (await open({ STAND_IN_STARTUP: "silent" }, { startupTimeoutMs: 300 }).catch(
      (x: unknown) => x,
    )) as OrcaError;
    expect(silent.code).toBe("AGENT_TRANSPORT");
    expect(silent.message).toMatch(/did not answer in time/);
    await startupTermination(silent);

    const exits = (await open({ STAND_IN_STARTUP: "exit" }).catch((x: unknown) => x)) as OrcaError;
    expect(exits.message).toMatch(/exited before it answered|refused to start a session/);
    await startupTermination(exits);

    const old = (await open({ STAND_IN_STARTUP: "old" }).catch((x: unknown) => x)) as OrcaError;
    expect(old.message).toMatch(/refused to start a session/);
    expect(old.message + JSON.stringify(old.details)).not.toMatch(/onFailure/);
    await startupTermination(old);

    const ac = new AbortController();
    const opening = open({ STAND_IN_STARTUP: "silent" }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(opening).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(open({}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("tool gate (#1120 until #1122)", () => {
  const cwd = "/work";
  it("allows only TodoWrite and a Read of an unprotected file; denies everything else", () => {
    expect(toolRefusal("Read", { file_path: "/work/a.ts" }, cwd, undefined)).toBeUndefined();
    expect(toolRefusal("TodoWrite", { todos: [] }, cwd, undefined)).toBeUndefined();
    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "Task", "mcp__x__y", "NotebookEdit", "Glob", "Grep"])
      expect(toolRefusal(tool, {}, cwd, undefined)).toMatch(/#1122/);
    expect(toolRefusal("Read", {}, cwd, undefined)).toMatch(/#1122/);
  });

  it("denies a read of a path ORCA keeps from agents", () => {
    const protectedPaths = { readOnly: ["/work/.orca"], noAccess: ["/home/me/.orca/auth"] };
    expect(toolRefusal("Read", { file_path: "/home/me/.orca/auth/key" }, cwd, protectedPaths)).toMatch(/protects/);
    expect(toolRefusal("Read", { file_path: "/work/.orca/config.yaml" }, cwd, protectedPaths)).toBeUndefined();
  });

  it("denies a search whose own path is free but which holds a protected path below it (#1274 review)", () => {
    const protectedPaths = { readOnly: [], noAccess: ["/work/secrets"] };
    expect(toolRefusal("Grep", { pattern: "token", path: "/work" }, cwd, protectedPaths)).toMatch(/#1122/);
    expect(toolRefusal("Glob", { pattern: "**/*", path: "/work" }, cwd, protectedPaths)).toMatch(/#1122/);
    expect(toolRefusal("Grep", { pattern: "token" }, cwd, protectedPaths)).toMatch(/#1122/);
  });
});

describe("prompt content and update mapping (#1120)", () => {
  it("turns ORCA prompt blocks into Claude content and refuses what it cannot carry", () => {
    expect(claudeContent("hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(
      claudeContent([
        { type: "text", text: "a" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "resource_link", name: "spec", uri: "file:///w/spec.md" },
      ]),
    ).toEqual([
      { type: "text", text: "a" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "[spec](file:///w/spec.md)" },
    ]);
    expect(() => claudeContent([{ type: "image", mimeType: "image/tiff", data: "" }])).toThrow(/image\/tiff/);
    expect(() => claudeContent([{ type: "resource", resource: { uri: "file:///x", text: "x" } }])).toThrow(
      /resource block/,
    );
  });

  it("reports a tool result only for a tool call it saw", () => {
    const tools = new Map<string, string>();
    const stray = sessionUpdates(
      {
        type: "user",
        parent_tool_use_id: null,
        session_id: "s",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] },
      } as never,
      tools,
    );
    expect(stray).toEqual([]);
  });
});
