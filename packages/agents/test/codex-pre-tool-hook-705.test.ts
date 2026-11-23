/**
 * ORCA's pre-tool hook answering Codex (#705): the same policy as for Claude, read from the
 * frames Codex 0.171 sends, and answered the only way Codex blocks on (exit 2), since an
 * `ask`, an `allow`, exit 1 and unreadable output all let a Codex call run. The real Codex is
 * in `packages/cli/test/codex-hook-acceptance-705.test.ts`.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_HOOK_KEY,
  claudeToolCall,
  codexHookConfig,
  codexHookListProblem,
  codexHookTrustHash,
  codexPatchFiles,
  codexPreToolHookCommand,
  permissionPolicyPath,
  probeCodexHook,
  runClaudePreToolHook,
  type ClaudeHookContext,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";

let root: string;
let workspace: string;
let configDir: string;
let contextFile: string;

const context = (permissions: ClaudeHookContext["permissions"] = { rules: [] }): ClaudeHookContext => ({
  version: 1,
  agentId: "codex",
  permissions,
  permissionFiles: [permissionPolicyPath(configDir)],
  workspaceCwd: workspace,
  protectedPaths: {
    readOnly: [join(configDir, "orca.config.yaml"), permissionPolicyPath(configDir), join(configDir, ".orca")],
    noAccess: [join(configDir, "auth"), join(configDir, ".orca", "private-execution")],
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-705-"));
  configDir = join(root, "config");
  workspace = join(root, "work");
  await mkdir(join(configDir, ".orca", "private-execution", "tool-hooks"), { recursive: true });
  await mkdir(workspace);
  contextFile = join(configDir, ".orca", "private-execution", "tool-hooks", "ctx.json");
  await writeFile(contextFile, JSON.stringify(context()), "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A frame as Codex 0.171 sends it (observed: `tool_name` `Bash` for its shell). */
const frame = (toolName: string, toolInput: Record<string, unknown>, cwd = workspace) =>
  JSON.stringify({
    session_id: "codex-session",
    turn_id: "turn",
    transcript_path: "/dev/null",
    cwd,
    hook_event_name: "PreToolUse",
    model: "gpt-test",
    permission_mode: "bypassPermissions",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "call_1",
  });

const codex = (input: string) => runClaudePreToolHook(["--codex", contextFile], input);

const patch = (...lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch", ""].join("\n");

describe("what Codex's calls are", () => {
  it("reads a patch's files the way Codex's parser does", () => {
    expect(
      codexPatchFiles(
        patch(
          "*** Add File: new.txt",
          "+hi",
          "  *** Update File: src/a.ts",
          "*** Move to: src/b.ts",
          "@@",
          "-x",
          "+y",
          "\u0085*** Delete File: gone.txt",
        ),
      ),
    ).toEqual([
      { op: "add", path: "new.txt" },
      { op: "update", path: "src/a.ts" },
      { op: "move", path: "src/b.ts" },
      // Rust's trim takes U+0085 off; JavaScript's does not, so the hook strips it itself.
      { op: "delete", path: "gone.txt" },
    ]);
  });

  it("refuses to read a patch that names another environment", async () => {
    const r = await codex(
      frame("apply_patch", { command: patch("*** Environment ID: remote", "*** Add File: a", "+x") }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("another environment");
  });

  it("projects Codex's tools as ACP asks would describe them", () => {
    const at = (toolName: string, toolInput: Record<string, unknown>) =>
      claudeToolCall({ toolName, toolInput, cwd: workspace });
    expect(at("Bash", { command: "ls -la" })).toEqual({ title: "ls -la", kind: "execute", locations: [] });
    expect(at("apply_patch", { command: patch("*** Update File: a.ts", "@@", "-x", "+y") })).toEqual({
      title: "Edit a.ts",
      kind: "edit",
      locations: [{ path: join(workspace, "a.ts") }],
    });
    expect(at("apply_patch", { command: patch("*** Delete File: /etc/x") }).kind).toBe("delete");
    expect(at("view_image", { path: "/tmp/i.png" })).toEqual({
      title: "Read /tmp/i.png",
      kind: "read",
      locations: [{ path: "/tmp/i.png" }],
    });
    expect(at("mcp__docs__search", { q: "x" })).toEqual({ title: "docs: search", kind: "other", locations: [] });
  });
});

describe("answering Codex", () => {
  it("allows with exit 0 and nothing else", async () => {
    await writeFile(
      contextFile,
      JSON.stringify(context({ rules: [{ match: { kind: "execute", titlePattern: "^ls$" }, decision: "allow" }] })),
    );
    expect(await codex(frame("Bash", { command: "ls" }))).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("blocks a deny with exit 2 and the reason on stderr", async () => {
    await writeFile(
      contextFile,
      JSON.stringify(context({ rules: [{ match: { kind: "execute", titlePattern: "^rm " }, decision: "deny" }] })),
    );
    const r = await codex(frame("Bash", { command: "rm -rf x" }));
    expect(r).toMatchObject({ exitCode: 2, stdout: "" });
    expect(r.stderr).toContain("Denied by ORCA");
  });

  it("blocks an ask, since Codex cannot pause a call for a person", async () => {
    const r = await codex(frame("Bash", { command: "make deploy" }));
    expect(r).toMatchObject({ exitCode: 2, stdout: "" });
    expect(r.stderr).toContain("cannot pause");
  });

  it("blocks a patch that touches ORCA's own files, among others", async () => {
    await writeFile(contextFile, JSON.stringify(context({ default: "allow", rules: [] })));
    const r = await codex(
      frame("apply_patch", {
        command: patch(
          "*** Add File: ok.txt",
          "+x",
          `*** Update File: ${permissionPolicyPath(configDir)}`,
          "@@",
          "-a",
          "+b",
        ),
      }),
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("ORCA's own files");
  });

  it("blocks when it cannot decide", async () => {
    expect((await codex("not json")).exitCode).toBe(2);
    expect((await runClaudePreToolHook(["--codex"], frame("Bash", { command: "ls" }))).exitCode).toBe(2);
    expect((await runClaudePreToolHook(["--codex", "relative.json"], frame("Bash", { command: "ls" }))).exitCode).toBe(
      2,
    );
  });
});

describe("installing it in Codex", () => {
  it("hashes the hook the way Codex 0.171 does", () => {
    // Both values were read from the real Codex 0.171 (`hooks/list` on its app server, with
    // this hook passed as a session flag).
    const command = codexPreToolHookCommand("/usr/bin/node", "/opt/orca/claude-pre-tool-hook.mjs", "/x/ctx.json");
    expect(codexHookTrustHash(command, 10)).toBe(
      "sha256:b90b4753446a395a8b1c43ebf10ba44ec9feeebeba9153a2ea3372c2f04bf306",
    );
    expect(codexHookTrustHash(command, 30)).toBe(
      "sha256:1622ba2c3880bde4c3fb2b7c8a4a6043dccad178b8cde40a3b0d8afefcd574b4",
    );
  });

  it("quotes every word of the command for the shell", () => {
    expect(codexPreToolHookCommand("/usr/bin/node", "/opt/it's here/hook.mjs", "/x/ctx.json")).toBe(
      `'/usr/bin/node' '/opt/it'\\''s here/hook.mjs' '--codex' '/x/ctx.json'`,
    );
  });

  it("adds the trusted hook beside the agent's own CODEX_CONFIG, turns hosted search off, and never adds it beside other hooks", () => {
    const command = codexPreToolHookCommand("/usr/bin/node", "/opt/hook.mjs", "/x/ctx.json");
    const config = JSON.parse(codexHookConfig(JSON.stringify({ model: "m" }), command)!) as Record<string, unknown>;
    expect(config).toEqual({
      model: "m",
      web_search: "disabled",
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] }],
        state: { [CODEX_HOOK_KEY]: { trusted_hash: codexHookTrustHash(command, 30) } },
      },
    });
    expect(codexHookConfig(undefined, command)).toBeDefined();
    expect(codexHookConfig(JSON.stringify({ hooks: {} }), command)).toBeUndefined();
    expect(codexHookConfig("[1]", command)).toBeUndefined();
    expect(codexHookConfig("{", command)).toBeUndefined();
  });

  it("accepts only Codex's list showing exactly ORCA's hook, trusted and enabled", () => {
    const command = "'node' 'hook' '--codex' 'ctx'";
    const ours = {
      key: CODEX_HOOK_KEY,
      eventName: "preToolUse",
      command,
      matcher: "*",
      enabled: true,
      trustStatus: "trusted",
    };
    expect(codexHookListProblem({ hooks: [ours] }, command)).toBeUndefined();
    expect(codexHookListProblem({ hooks: [] }, command)).toContain("does not list");
    expect(codexHookListProblem({ hooks: [{ ...ours, trustStatus: "untrusted" }] }, command)).toContain(
      "does not trust",
    );
    expect(codexHookListProblem({ hooks: [{ ...ours, trustStatus: "modified" }] }, command)).toContain(
      "does not trust",
    );
    expect(codexHookListProblem({ hooks: [{ ...ours, enabled: false }] }, command)).toContain("turned off");
    expect(codexHookListProblem({ hooks: [{ ...ours, command: "other" }] }, command)).toContain("different hook");
    expect(codexHookListProblem({ hooks: [ours, ours] }, command)).toContain("does not list");
    expect(codexHookListProblem(undefined, command)).toContain("did not list");
  });

  describe("the probe", () => {
    const entry = fileURLToPath(new URL("../src/bin/claude-pre-tool-hook.ts", import.meta.url));
    const bundled = childBundle("codex-pre-tool-hook-705", { entries: { hook: entry } })?.["hook"];

    it.skipIf(bundled === undefined || process.platform === "win32")(
      "sees the real hook block a call through the shell",
      async () => {
        const command = codexPreToolHookCommand(process.execPath, bundled!, contextFile);
        const r = await probeCodexHook({
          command,
          cwd: workspace,
          contextFile,
          env: { ...process.env, SHELL: "/bin/sh" },
        });
        expect(r.blocked).toBe(true);
      },
    );

    it.skipIf(process.platform === "win32")("fails when the command cannot block", async () => {
      for (const command of ["true", "exit 1", "'/no/such/program'"]) {
        const r = await probeCodexHook({
          command,
          cwd: workspace,
          contextFile,
          env: { ...process.env, SHELL: "/bin/sh" },
        });
        expect(r.blocked).toBe(false);
      }
    });
  });
});

/** The hook program, as Codex runs it, answers through its exit code alone. */
describe("the hook process for Codex", () => {
  const entry = fileURLToPath(new URL("../src/bin/claude-pre-tool-hook.ts", import.meta.url));
  const bundled = childBundle("codex-pre-tool-hook-705-process", { entries: { hook: entry } })?.["hook"];

  const run = (input: string) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const args = ["--codex", contextFile];
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

  it("exits 2 for an ask and 0, silently, for an allow", async () => {
    const asked = await run(frame("Bash", { command: "make deploy" }));
    expect(asked.code).toBe(2);
    expect(asked.stdout).toBe("");
    await writeFile(contextFile, JSON.stringify(context({ default: "allow", rules: [] })));
    expect(await run(frame("Bash", { command: "ls" }))).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
