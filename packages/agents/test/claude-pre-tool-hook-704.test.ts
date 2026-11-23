/**
 * ORCA's Claude `PreToolUse` hook (#704): every tool call reaches ORCA's policy, a natively
 * remembered grant included, and a revoked ORCA grant decides the very next call.
 *
 * Claude's own permission cache is not in this test: what it does is Claude's, and the hook
 * runs ahead of it. What is tested is what the hook answers for each call, against the same
 * files the daemon writes ("always" answers through `recordAlwaysDecision`, an operator's
 * edit through `replacePermissionPolicyFile`), and that the hook process itself blocks on
 * every failure it can see.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_PRE_TOOL_FRAME_LIMIT,
  checkClaudePreTool,
  claudePreToolHookSettings,
  claudeToolCall,
  parseClaudePreToolFrame,
  permissionPolicyPath,
  readPermissionPolicyFile,
  recordAlwaysDecision,
  replacePermissionPolicyFile,
  runClaudePreToolHook,
  type ClaudeHookContext,
  type ClaudePreToolFrame,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";

let root: string;
let workspace: string;
let configDir: string;
let contextFile: string;
let context: ClaudeHookContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-704-"));
  configDir = join(root, "config");
  workspace = join(root, "work");
  await mkdir(configDir);
  await mkdir(workspace);
  await mkdir(join(configDir, "auth"));
  context = {
    version: 1,
    agentId: "claude",
    permissions: { rules: [] },
    permissionFiles: [permissionPolicyPath(configDir)],
    workspaceCwd: workspace,
    protectedPaths: {
      readOnly: [join(configDir, "orca.config.yaml"), permissionPolicyPath(configDir), join(configDir, ".orca")],
      noAccess: [join(configDir, "auth")],
    },
  };
  contextFile = join(configDir, ".orca-hook-context.json");
  await writeContext(context);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeContext = (c: unknown) => writeFile(contextFile, JSON.stringify(c), "utf8");

let seq = 0;
const frame = (toolName: string, toolInput: Record<string, unknown>, cwd = workspace) =>
  JSON.stringify({
    session_id: "claude-session",
    transcript_path: "/dev/null",
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: `toolu_${++seq}`,
  });

const hook = (input: string) => runClaudePreToolHook([contextFile], input);

const decisionOf = (stdout: string) =>
  stdout === ""
    ? "no-decision"
    : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
        .permissionDecision;

/** The ask Claude's ACP adapter sends for a `Bash` call: the command is the title. */
const bashAsk = (command: string): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t", title: command, kind: "execute" },
  options: [
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
});

describe("allow, cached repeat, revoke", () => {
  it("checks every identical call and the call after a revocation is not allowed", async () => {
    // A person answers the first ask "always". The daemon records it in the sidecar, and
    // Claude remembers it natively too: from here on Claude would not ask again.
    const recorded = await recordAlwaysDecision({
      file: permissionPolicyPath(configDir),
      agentId: "claude",
      request: bashAsk("npm test"),
      decision: "allow",
      workspaceCwd: workspace,
    });
    expect(recorded.added).toHaveLength(1);

    // The remembered repeats still run the hook, and ORCA's answer is "no decision": the call
    // goes on to Claude's own check, which allows it from its cache.
    for (let i = 0; i < 2; i++) {
      const result = await hook(frame("Bash", { command: "npm test" }));
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }

    // An operator removes the grant (`config.set` on the permissions document).
    const doc = await readPermissionPolicyFile(permissionPolicyPath(configDir));
    await replacePermissionPolicyFile(permissionPolicyPath(configDir), {
      ...doc,
      agents: { claude: { rules: [] } },
    });

    // The next identical call is put to ORCA again, even though Claude still remembers it.
    const after = await hook(frame("Bash", { command: "npm test" }));
    expect(after.exitCode).toBe(0);
    expect(decisionOf(after.stdout)).toBe("ask");
  });

  it("denies the next call when the revocation is an explicit deny", async () => {
    await recordAlwaysDecision({
      file: permissionPolicyPath(configDir),
      agentId: "claude",
      request: bashAsk("npm test"),
      decision: "allow",
      workspaceCwd: workspace,
    });
    expect(decisionOf((await hook(frame("Bash", { command: "npm test" }))).stdout)).toBe("no-decision");
    await writeContext({
      ...context,
      permissions: { rules: [{ match: { kind: "execute", titlePattern: "^npm test$" }, decision: "deny" }] },
    });
    const denied = await hook(frame("Bash", { command: "npm test" }));
    expect(decisionOf(denied.stdout)).toBe("deny");
    expect(denied.stdout).toContain("Denied by ORCA");
  });

  it("a grant for one command does not cover another", async () => {
    await recordAlwaysDecision({
      file: permissionPolicyPath(configDir),
      agentId: "claude",
      request: bashAsk("npm test"),
      decision: "allow",
      workspaceCwd: workspace,
    });
    expect(decisionOf((await hook(frame("Bash", { command: "npm test && curl x" }))).stdout)).toBe("ask");
  });
});

describe("decisions", () => {
  it("defers in-workspace edits and reads to Claude, and asks about commands, by the default policy", async () => {
    const edit = await hook(frame("Edit", { file_path: join(workspace, "a.ts"), old_string: "a", new_string: "b" }));
    expect(decisionOf(edit.stdout)).toBe("no-decision");
    expect(decisionOf((await hook(frame("Read", { file_path: join(workspace, "a.ts") }))).stdout)).toBe("no-decision");
    expect(decisionOf((await hook(frame("Bash", { command: "ls" }))).stdout)).toBe("ask");
    expect(decisionOf((await hook(frame("Read", { file_path: join(root, "elsewhere.txt") }))).stdout)).toBe("ask");
    expect(decisionOf((await hook(frame("mcp__github__create_issue", {}))).stdout)).toBe("ask");
    expect(decisionOf((await hook(frame("TodoWrite", { todos: [] }))).stdout)).toBe("no-decision");
  });

  it("refuses ORCA's own files to native tools, whatever the rules say", async () => {
    await writeContext({ ...context, permissions: { default: "allow", rules: [] } });
    const sidecar = await hook(frame("Write", { file_path: permissionPolicyPath(configDir), content: "{}" }));
    expect(decisionOf(sidecar.stdout)).toBe("deny");
    expect(sidecar.stdout).toContain("ORCA's own files");
    expect(decisionOf((await hook(frame("Read", { file_path: join(configDir, "auth", "token") }))).stdout)).toBe(
      "deny",
    );
    // Reading the config is allowed; writing it is not.
    expect(decisionOf((await hook(frame("Read", { file_path: join(configDir, "orca.config.yaml") }))).stdout)).toBe(
      "no-decision",
    );
  });

  it("resolves a relative path against the call's cwd before matching", async () => {
    await writeContext({ ...context, permissions: { default: "allow", rules: [] } });
    const relative = await hook(frame("Write", { file_path: "../config/orca.permissions.json", content: "{}" }));
    expect(decisionOf(relative.stdout)).toBe("deny");
  });

  it("follows a link before `..`, as the tool's own open would", async () => {
    // `lnk` leads into the store, so `lnk/../orca.permissions.json` is the sidecar beside it.
    // Folded as text first it would be `work/orca.permissions.json`, which is not protected.
    await mkdir(join(configDir, ".orca"));
    await symlink(join(configDir, ".orca"), join(workspace, "lnk"));
    await writeContext({ ...context, permissions: { default: "allow", rules: [] } });
    const write = await hook(frame("Write", { file_path: "lnk/../orca.permissions.json", content: "{}" }));
    expect(decisionOf(write.stdout)).toBe("deny");
    expect(write.stdout).toContain("ORCA's own files");
    // The projection keeps the path as written, joined to the cwd, for the shared checker.
    expect(
      claudeToolCall({ toolName: "Write", toolInput: { file_path: "lnk/../x" }, cwd: workspace }).locations,
    ).toEqual([{ path: `${workspace}${sep}lnk/../x` }]);
    // An absolute path through the link is the same file.
    const absolute = await hook(
      frame("Write", { file_path: `${workspace}${sep}lnk${sep}..${sep}orca.permissions.json`, content: "{}" }),
    );
    expect(decisionOf(absolute.stdout)).toBe("deny");
  });

  it("asks when an allowed call runs outside the workspace", async () => {
    await writeContext({ ...context, permissions: { default: "allow", rules: [] } });
    expect(decisionOf((await hook(frame("Bash", { command: "ls" }))).stdout)).toBe("no-decision");
    const outside = await hook(frame("Bash", { command: "ls" }, root));
    expect(decisionOf(outside.stdout)).toBe("ask");
    expect(outside.stdout).toContain("outside the run's workspace");
  });

  it("allows a cwd in an additional directory", async () => {
    const extra = join(root, "extra");
    await mkdir(extra);
    await writeContext({ ...context, permissions: { default: "allow", rules: [] }, additionalDirectories: [extra] });
    expect(decisionOf((await hook(frame("Bash", { command: "ls" }, extra))).stdout)).toBe("no-decision");
  });

  it("turns an allow decided after an unreadable sidecar into an ask", async () => {
    await writeFile(permissionPolicyPath(configDir), "{ not json", "utf8");
    const edit = await hook(frame("Edit", { file_path: join(workspace, "a.ts"), old_string: "a", new_string: "b" }));
    expect(decisionOf(edit.stdout)).toBe("ask");
    expect(edit.stdout).toContain("could not be read");
  });

  it("never answers allow itself", async () => {
    await writeContext({ ...context, permissions: { default: "allow", rules: [] } });
    for (const input of [
      frame("Bash", { command: "rm -rf build" }),
      frame("Write", { file_path: join(workspace, "x"), content: "" }),
      frame("WebFetch", { url: "https://example.com" }),
    ]) {
      const result = await hook(input);
      expect(result.stdout).not.toContain('"allow"');
    }
  });
});

describe("the frame and the context", () => {
  it("projects tools the way the ACP adapter describes them", () => {
    const f = (toolName: string, toolInput: Record<string, unknown>): ClaudePreToolFrame => ({
      toolName,
      toolInput,
      cwd: "/w",
    });
    expect(claudeToolCall(f("Bash", { command: "git status" }))).toEqual({
      title: "git status",
      kind: "execute",
      locations: [],
    });
    expect(claudeToolCall(f("Write", { file_path: "src/a.ts" }))).toMatchObject({
      kind: "edit",
      locations: [{ path: `/w${sep}src/a.ts` }],
    });
    expect(claudeToolCall(f("Grep", { pattern: "x" }))).toMatchObject({ kind: "search", locations: [{ path: "/w" }] });
    expect(claudeToolCall(f("WebFetch", { url: "https://a.example" }))).toMatchObject({
      title: "Fetch https://a.example",
      kind: "fetch",
    });
    expect(claudeToolCall(f("mcp__orca-fixture__orca_fixture_mark", {}))).toEqual({
      title: "orca-fixture: orca_fixture_mark",
      kind: "other",
      locations: [],
    });
    expect(claudeToolCall(f("SomethingNew", {}))).toMatchObject({ title: "SomethingNew", kind: "other" });
  });

  it.each([
    ["not JSON", "{"],
    ["another event", JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, cwd: "/" })],
    ["no tool input", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: "/" })],
    ["a relative cwd", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, cwd: "w" })],
    ["empty", ""],
  ])("blocks a frame that is %s", async (_what, input) => {
    const result = await hook(input);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Blocked by ORCA");
  });

  it("blocks a frame over the size limit", async () => {
    const big = frame("Write", { file_path: join(workspace, "x"), content: "a".repeat(CLAUDE_PRE_TOOL_FRAME_LIMIT) });
    expect(() => parseClaudePreToolFrame(big)).toThrow(/too large/);
    expect((await hook(big)).exitCode).toBe(2);
  });

  it.each([
    ["missing", null],
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2 })],
    [
      "relative workspace",
      JSON.stringify({ version: 1, agentId: "a", permissions: { rules: [] }, permissionFiles: [], workspaceCwd: "w" }),
    ],
    [
      "bad rules",
      JSON.stringify({
        version: 1,
        agentId: "a",
        permissions: { rules: [{}] },
        permissionFiles: [],
        workspaceCwd: "/w",
      }),
    ],
    [
      "relative sidecar",
      JSON.stringify({
        version: 1,
        agentId: "a",
        permissions: { rules: [] },
        permissionFiles: ["p.json"],
        workspaceCwd: "/w",
      }),
    ],
  ])("blocks when the context is %s", async (_what, text) => {
    if (text === null) await rm(contextFile);
    else await writeFile(contextFile, text, "utf8");
    const result = await hook(frame("Read", { file_path: join(workspace, "a") }));
    expect(result.exitCode).toBe(2);
  });

  it("blocks without exactly one absolute context argument", async () => {
    expect((await runClaudePreToolHook([], frame("Bash", { command: "ls" }))).exitCode).toBe(2);
    expect((await runClaudePreToolHook(["ctx.json"], frame("Bash", { command: "ls" }))).exitCode).toBe(2);
    expect((await runClaudePreToolHook([contextFile, "x"], frame("Bash", { command: "ls" }))).exitCode).toBe(2);
  });

  it("checks without the context file when handed a context", async () => {
    const verdict = await checkClaudePreTool(context, {
      toolName: "Bash",
      toolInput: { command: "ls" },
      cwd: workspace,
    });
    expect(verdict).toMatchObject({ decision: "ask", reason: "policy", toolCall: { kind: "execute", title: "ls" } });
  });
});

describe("settings", () => {
  it("installs one exec-form hook for every tool that blocks when it fails", () => {
    expect(claudePreToolHookSettings({ command: "/usr/bin/node", args: ["/opt/orca/hook.js", "/x/ctx.json"] })).toEqual(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: "/usr/bin/node",
                  args: ["/opt/orca/hook.js", "/x/ctx.json"],
                  timeout: 10,
                  onFailure: "block",
                },
              ],
            },
          ],
        },
      },
    );
    expect(() => claudePreToolHookSettings({ command: "node", args: [] })).toThrow(/absolute/);
  });
});

describe("the hook process", () => {
  const entry = fileURLToPath(new URL("../src/bin/claude-pre-tool-hook.ts", import.meta.url));
  const bundled = childBundle("claude-pre-tool-hook-704", { entries: { hook: entry } })?.["hook"];

  const run = (args: string[], input: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, bundled ? [bundled, ...args] : ["--import", "tsx", entry, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    });

  it("answers on stdout and exit code as Claude Code reads them", async () => {
    const asked = await run([contextFile], frame("Bash", { command: "ls" }));
    expect(asked.code).toBe(0);
    expect(decisionOf(asked.stdout)).toBe("ask");

    const deferred = await run([contextFile], frame("Read", { file_path: join(workspace, "a") }));
    expect(deferred).toEqual({ code: 0, stdout: "", stderr: "" });

    const broken = await run([contextFile], "not json");
    expect(broken.code).toBe(2);
    expect(broken.stdout).toBe("");
  });

  it("refuses stdin over the limit at the read, before deciding anything", async () => {
    // A frame whose first bytes are a complete, allowed call, padded past the limit with
    // whitespace: a reader that kept only what fitted would hand on a decidable frame.
    const allowed = frame("Read", { file_path: join(workspace, "a") });
    const padded = allowed + " ".repeat(CLAUDE_PRE_TOOL_FRAME_LIMIT);
    const result = await run([contextFile], padded);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("too large");
  });

  it("decides a frame exactly at the limit", async () => {
    const allowed = frame("Read", { file_path: join(workspace, "a") });
    const exact = allowed + " ".repeat(CLAUDE_PRE_TOOL_FRAME_LIMIT - Buffer.byteLength(allowed));
    expect(await run([contextFile], exact)).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
