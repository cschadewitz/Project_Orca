/**
 * The hook side of tool-call telemetry (#1000): the pre-tool hook records each call it answers,
 * for both its Claude and Codex dialects, into the spool ORCA made beside its context, and only
 * there. Recording never changes an answer: the line is written after the answer is out, and a
 * line that cannot be written is simply not written.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TELEMETRY_LINE_LIMIT, HookTelemetryLineSchema, type HookTelemetryLine } from "@orca/core";
import { childBundle } from "@orca/testing/child-bundle";
import {
  fitHookTelemetryLine,
  nativeToolHookSession,
  openHookTelemetrySpool,
  permissionPolicyPath,
  recordHookTelemetry,
  runClaudePreToolHook,
  type ClaudeHookContext,
  type HookTelemetrySpool,
} from "../src/index.js";

const posix = process.platform !== "win32";
let root: string;
let workspace: string;
let hookDir: string;
let contextFile: string;
let noAccess: string[];
let spool: HookTelemetrySpool;
let got: HookTelemetryLine[];

const context = (over: Partial<ClaudeHookContext> = {}): ClaudeHookContext => ({
  version: 1,
  agentId: "claude",
  permissions: { rules: [{ match: { kind: "execute", titlePattern: "^ls$" }, decision: "allow" }] },
  permissionFiles: [permissionPolicyPath(join(root, "config"))],
  workspaceCwd: workspace,
  protectedPaths: { readOnly: [], noAccess },
  telemetry: spool.target,
  ...over,
});
const writeContext = (c: unknown) => writeFile(contextFile, JSON.stringify(c), { mode: 0o600 });

let seq = 0;
const frame = (toolName: string, toolInput: Record<string, unknown>, toolUseId = `toolu_${++seq}`) =>
  JSON.stringify({
    session_id: "s",
    cwd: workspace,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-1000-hook-"));
  workspace = join(root, "work");
  hookDir = join(root, "store", "private-execution", "tool-hooks");
  noAccess = [join(root, "store", "private-execution")];
  await mkdir(workspace);
  await mkdir(join(root, "config"));
  await mkdir(hookDir, { recursive: true, mode: 0o700 });
  contextFile = join(hookDir, "context.json");
  spool = await openHookTelemetrySpool({ dir: hookDir, protectedPaths: { readOnly: [], noAccess } });
  got = [];
  spool.attach(async (lines) => {
    got.push(...lines);
  });
  await writeContext(context());
});

afterEach(async () => {
  await spool.finish();
  await rm(root, { recursive: true, force: true });
});

/** Run the hook, then record its line the way the hook program does, and drain. */
async function hookAndDrain(args: string[], input: string) {
  const result = await runClaudePreToolHook(args, input);
  if (result.telemetry) recordHookTelemetry(result.telemetry.target, result.telemetry.line);
  await spool.drain();
  return result;
}

describe.runIf(process.platform !== "win32")("what the hook records", () => {
  it("records a Claude call's answer with its kind, title, input and reason", async () => {
    const allowed = await hookAndDrain([contextFile], frame("Bash", { command: "ls" }, "toolu_a"));
    expect(allowed).toMatchObject({ exitCode: 0, stdout: "" });
    const asked = await hookAndDrain([contextFile], frame("Bash", { command: "rm -rf x" }, "toolu_b"));
    expect(asked.stdout).toContain('"permissionDecision":"ask"');
    expect(got).toEqual([
      expect.objectContaining({
        v: 1,
        tool: "Bash",
        toolUseId: "toolu_a",
        kind: "execute",
        title: "ls",
        input: { command: "ls" },
        decision: "allow",
        rule: "policy",
      }),
      expect.objectContaining({ toolUseId: "toolu_b", title: "rm -rf x", decision: "ask", rule: "policy" }),
    ]);
    for (const line of got) {
      expect(HookTelemetryLineSchema.safeParse(line).success).toBe(true);
      expect(line.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records a Codex call too, with the policy's answer, though the hook blocks an ask for Codex", async () => {
    const asked = await hookAndDrain(["--codex", contextFile], frame("Bash", { command: "rm -rf x" }));
    expect(asked.exitCode).toBe(2);
    expect(got).toEqual([expect.objectContaining({ tool: "Bash", decision: "ask", rule: "policy" })]);
  });

  it("records nothing for ORCA's own Codex startup probe", async () => {
    const probe = await hookAndDrain(
      ["--codex", contextFile],
      frame("Bash", { command: "orca-probe" }, `orca-hook-probe:${"a".repeat(32)}`),
    );
    expect(probe.exitCode).toBe(2);
    expect(probe.telemetry).toBeUndefined();
    expect(got).toEqual([]);
  });

  it("records the hook's own failure as a block once its context is read", async () => {
    const broken = await hookAndDrain([contextFile], "not json");
    expect(broken.exitCode).toBe(2);
    expect(got).toEqual([
      expect.objectContaining({
        tool: "(unreadable)",
        decision: "block",
        rule: "hook-error",
        hookError: "tool call input is not JSON",
      }),
    ]);
    expect(got[0]).not.toHaveProperty("input");
  });

  it("records a call the hook cannot decide, with what it was", async () => {
    const patch = "*** Begin Patch\n*** Environment ID: other\n*** End Patch\n";
    const blocked = await hookAndDrain(["--codex", contextFile], frame("apply_patch", { command: patch }));
    expect(blocked.exitCode).toBe(2);
    expect(got).toEqual([
      expect.objectContaining({ tool: "apply_patch", decision: "block", input: { command: patch } }),
    ]);
  });

  it("records nothing without telemetry in the context, or for a spool anywhere but beside it", async () => {
    await writeContext(context({ telemetry: undefined }));
    expect((await hookAndDrain([contextFile], frame("Bash", { command: "ls" }))).telemetry).toBeUndefined();
    await writeContext(context({ telemetry: { ...spool.target, file: join(root, "elsewhere.spool") } }));
    expect((await hookAndDrain([contextFile], frame("Bash", { command: "ls" }))).telemetry).toBeUndefined();
    expect(got).toEqual([]);
  });

  it("blocks on telemetry in its context that is not ORCA's shape, as on any unreadable context", async () => {
    for (const telemetry of [
      "yes",
      { file: "relative.spool", dev: "1", ino: "2" },
      { file: spool.file, dev: 1, ino: "2" },
      { file: spool.file, dev: "1", ino: "-2" },
    ]) {
      await writeContext({ ...context(), telemetry });
      const r = await hookAndDrain([contextFile], frame("Bash", { command: "ls" }));
      expect(r.exitCode).toBe(2);
      // The context was not read, so there is no spool to trust: nothing is recorded.
      expect(r.telemetry).toBeUndefined();
    }
    expect(got).toEqual([]);
  });

  it("writes nothing into a spool whose identity is not the one in the context", async () => {
    await writeContext(context({ telemetry: { ...spool.target, ino: "1" } }));
    const r = await hookAndDrain([contextFile], frame("Bash", { command: "ls" }));
    expect(r.telemetry).toBeDefined();
    // The writer checks the open file against the recorded identity, and skips the line.
    expect(got).toEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("recording never changes the answer", () => {
  const broken = () => {
    throw new Error("line could not be built");
  };
  const cases = [
    ["Claude, allow", [() => contextFile], { command: "ls" }, { exitCode: 0, stdout: "", stderr: "" }],
    ["Claude, ask", [() => contextFile], { command: "rm -rf x" }, { exitCode: 0 }],
    ["Codex, allow", [() => "--codex", () => contextFile], { command: "ls" }, { exitCode: 0, stdout: "", stderr: "" }],
    ["Codex, ask (blocked)", [() => "--codex", () => contextFile], { command: "rm -rf x" }, { exitCode: 2 }],
  ] as const;
  it.each(cases)(
    "%s: a line that cannot be built leaves the answer exactly as without telemetry",
    async (_what, argv, input, expected) => {
      const args = argv.map((a) => a());
      const call = frame("Bash", input, "toolu_same");
      await writeContext(context({ telemetry: undefined }));
      const plain = await runClaudePreToolHook(args, call);
      await writeContext(context());
      const failing = await runClaudePreToolHook(args, call, { telemetryLine: broken });
      expect(plain).toMatchObject(expected);
      expect(failing).toEqual(plain);
      expect(failing.telemetry).toBeUndefined();
    },
  );

  it.each([
    ["Claude", [] as string[]],
    ["Codex", ["--codex"]],
  ])("%s: a hook failure stays a block when its line cannot be built", async (_what, prefix) => {
    const plain = await runClaudePreToolHook([...prefix, contextFile], "not json");
    const failing = await runClaudePreToolHook([...prefix, contextFile], "not json", { telemetryLine: broken });
    expect(plain.exitCode).toBe(2);
    expect({ ...failing, telemetry: undefined }).toEqual({ ...plain, telemetry: undefined });
    expect(failing.telemetry).toBeUndefined();
  });
});

describe.runIf(process.platform !== "win32")("fitting a line", () => {
  const base: HookTelemetryLine = {
    v: 1,
    at: "2026-11-23T10:00:00.000Z",
    tool: "Write",
    kind: "edit",
    title: "Write /w/a.txt",
    decision: "allow",
    latencyMs: 1,
  };
  const size = (l: HookTelemetryLine) => Buffer.byteLength(`${JSON.stringify(l)}\n`);

  it("keeps a line that fits as it is", () => {
    const line = { ...base, input: { file_path: "/w/a.txt", content: "hi" } };
    expect(fitHookTelemetryLine(line)).toBe(line);
  });

  it("leaves out long input values whole, never cut, and keeps the short ones", () => {
    const secretish = `sk-${"x".repeat(20_000)}`;
    const fitted = fitHookTelemetryLine({ ...base, input: { file_path: "/w/a.txt", content: secretish } })!;
    expect(fitted.input).toEqual({ file_path: "/w/a.txt", content: "[left out: 20005 characters]" });
    expect(size(fitted)).toBeLessThanOrEqual(HOOK_TELEMETRY_LINE_LIMIT);
  });

  it("leaves out the title, then the whole input, when that is still too much", () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, "v".repeat(40)]));
    const noInput = fitHookTelemetryLine({ ...base, input: many })!;
    expect(noInput.input).toMatch(/^\[left out: \d+ characters\]$/);
    expect(noInput.title).toBe(`[left out: ${base.title!.length} characters]`);

    const command = `echo ${"y".repeat(10_000)}`;
    const noTitle = fitHookTelemetryLine({ ...base, tool: "Bash", title: command, input: { command } })!;
    expect(noTitle.title).toBe(`[left out: ${command.length} characters]`);
    expect(noTitle.input).toEqual({ command: `[left out: ${command.length + 2} characters]` });
    expect(size(noTitle)).toBeLessThanOrEqual(HOOK_TELEMETRY_LINE_LIMIT);
  });

  it("gives up on a line whose bare fields do not fit", () => {
    expect(fitHookTelemetryLine({ ...base, tool: "t".repeat(HOOK_TELEMETRY_LINE_LIMIT) })).toBeUndefined();
  });
});

describe.runIf(process.platform !== "win32")("the hook process", () => {
  const entry = fileURLToPath(new URL("../src/bin/claude-pre-tool-hook.ts", import.meta.url));
  const bundled = childBundle("claude-pre-tool-hook-1000", { entries: { hook: entry } })?.["hook"];
  const run = (args: string[], input: string, preload: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        bundled ? [...preload, bundled, ...args] : [...preload, "--import", "tsx", entry, ...args],
        { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    });

  it("answers exactly as without telemetry, and appends the line after", async () => {
    const asked = await run([contextFile], frame("Bash", { command: "rm -rf x" }, "toolu_p"));
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain('"permissionDecision":"ask"');
    const allowed = await run([contextFile], frame("Bash", { command: "ls" }));
    expect(allowed).toEqual({ code: 0, stdout: "", stderr: "" });
    await spool.drain();
    expect(got.map((l) => [l.title, l.decision])).toEqual([
      ["rm -rf x", "ask"],
      ["ls", "allow"],
    ]);
  });

  it.each([[[] as string[]], [["--codex"]]])(
    "answers as before and exits at once when a FIFO stands where the spool was (%j)",
    async (prefix) => {
      await rm(spool.file);
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkfifo", ["-m", "600", spool.file]);
      const startedAt = Date.now();
      const allowed = await run([...prefix, contextFile], frame("Bash", { command: "ls" }));
      expect(allowed).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await rm(spool.file);
    },
  );

  it.each([
    ["Claude ask, on stdout", [] as string[], { code: 0, stdout: '"permissionDecision":"ask"', stderr: "" }],
    ["Codex block, on stderr", ["--codex"], { code: 2, stdout: "", stderr: "Blocked by ORCA" }],
  ])("%s: the whole answer arrives even when recording never completes", async (_what, prefix, expected) => {
    // Every open of the spool hangs for good (and holds the process), as a stuck file
    // system would; the marker shows the recorder really started.
    const marker = join(root, "recorder-started");
    const preload = join(root, "hang-open.mjs");
    await writeFile(
      preload,
      [
        'import { createRequire, syncBuiltinESMExports } from "node:module";',
        'import { writeFileSync } from "node:fs";',
        'const fsp = createRequire(import.meta.url)("node:fs/promises");',
        'fsp.open = () => { writeFileSync(process.env.ORCA_TEST_MARKER, "1"); setInterval(() => {}, 1000); return new Promise(() => {}); };',
        "syncBuiltinESMExports();",
      ].join("\n"),
    );
    // Without telemetry: the answer as it is.
    await writeContext(context({ telemetry: undefined }));
    const plain = await run([...prefix, contextFile], frame("Bash", { command: "rm -rf x" }, "toolu_w"));
    await writeContext(context());
    const startedAt = Date.now();
    const hung = await run(
      [...prefix, contextFile],
      frame("Bash", { command: "rm -rf x" }, "toolu_w"),
      ["--import", pathToFileURL(preload).href],
      { ORCA_TEST_MARKER: marker },
    );
    expect(await readFile(marker, "utf8")).toBe("1");
    expect(hung).toEqual(plain);
    expect(hung.code).toBe(expected.code);
    expect(hung.stdout).toContain(expected.stdout);
    expect(hung.stderr).toContain(expected.stderr);
    if (expected.stdout)
      expect(JSON.parse(hung.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("answers the same when the spool is gone", async () => {
    await rm(spool.file);
    const allowed = await run([contextFile], frame("Bash", { command: "ls" }));
    expect(allowed).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await readdir(hookDir)).toEqual(["context.json"]);
  });
});

describe.runIf(process.platform !== "win32")("the session's spool", () => {
  const session = (toolCallTelemetry?: "off" | "keep") =>
    nativeToolHookSession({
      agentId: "claude",
      permissions: { rules: [] },
      permissionFiles: [],
      workspaceCwd: workspace,
      protectedPaths: { readOnly: [], noAccess },
      contextDir: hookDir,
      runtime: process.execPath,
      script: "/opt/orca/hook.mjs",
      agentEnv: {},
      toolCallTelemetry,
    });
  const contexts = async () => (await readdir(hookDir)).filter((f) => f.endsWith(".json") && f !== "context.json");

  it("makes a spool beside the context only when the agent keeps telemetry, and reads it last at cleanup", async () => {
    const off = session();
    await off.prepare();
    expect(off.telemetry()).toBeUndefined();
    const [offFile] = await contexts();
    expect(JSON.parse(await readFile(join(hookDir, offFile!), "utf8"))).not.toHaveProperty("telemetry");
    await off.cleanup();

    const kept = session("keep");
    await kept.prepare();
    const own = kept.telemetry()!;
    const [file] = await contexts();
    expect(JSON.parse(await readFile(join(hookDir, file!), "utf8")).telemetry).toEqual(own.target);
    const lines: HookTelemetryLine[] = [];
    own.attach(async (l) => {
      lines.push(...l);
    });
    // The hook's last line, written after the engine's last drain.
    recordHookTelemetry(own.target, {
      v: 1,
      at: "2026-11-23T10:00:00.000Z",
      tool: "Bash",
      decision: "allow",
      latencyMs: 1,
    });
    await kept.cleanup();
    expect(lines).toHaveLength(1);
    expect((await readdir(hookDir)).filter((f) => f !== "context.json" && f !== spool.file.split("/").pop())).toEqual(
      [],
    );
  });

  it.runIf(posix)("refuses to make a spool outside ORCA's agent-denied paths", async () => {
    const s = nativeToolHookSession({
      agentId: "claude",
      permissions: { rules: [] },
      permissionFiles: [],
      workspaceCwd: workspace,
      protectedPaths: { readOnly: [], noAccess: [] },
      contextDir: hookDir,
      runtime: process.execPath,
      script: "/opt/orca/hook.mjs",
      agentEnv: {},
      toolCallTelemetry: "keep",
    });
    await expect(s.prepare()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await s.cleanup();
  });
});
