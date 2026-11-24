/**
 * ORCA's pre-tool hook answering Codex (#705): the same policy as for Claude, read from the
 * frames Codex 0.171 sends, and answered the only way Codex blocks on (exit 2), since an
 * `ask`, an `allow`, exit 1 and unreadable output all let a Codex call run. The real Codex is
 * in `packages/cli/test/codex-hook-acceptance-705.test.ts`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  codexPreToolHookProgram,
  CODEX_HOOK_FAILED_REASON,
  CODEX_HOOK_OUTPUT_LIMIT,
  checkCodexFailClosedLine,
  codexProbeReceipt,
  permissionPolicyPath,
  probeCodexHook,
  codexHookEnvironment,
  codexHookShell,
  runClaudePreToolHook,
  type ClaudeHookContext,
} from "@orca/agents";
import { childBundle } from "@orca/testing/child-bundle";

let root: string;
let workspace: string;
let configDir: string;
let contextFile: string;
/** The probe key written into each test's context file. */
const PROBE_KEY = "ab".repeat(32);
/** The shell the probe runs a command in, as Codex runs a hook in a `sh` login shell. */
const SH = { program: "/bin/sh", args: ["-c"] };

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
  probeKey: PROBE_KEY,
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

  describe("the startup probe's receipt", () => {
    const NONCE = "12".repeat(16);
    const probeFrame = (toolName: string, toolInput: Record<string, unknown>, id = `orca-hook-probe:${NONCE}`) => {
      const f = JSON.parse(frame(toolName, toolInput)) as Record<string, unknown>;
      return JSON.stringify({ ...f, tool_use_id: id });
    };
    const receipt = codexProbeReceipt(PROBE_KEY, NONCE);

    it("is signed only for a probe's frame that the hook decided to block", async () => {
      const blocked = await codex(probeFrame("view_image", { path: contextFile }));
      expect(blocked.exitCode).toBe(2);
      expect(blocked.stderr.split("\n")).toContain(receipt);
    });

    it("is not given for an allow, for another id, or without a key", async () => {
      await writeFile(contextFile, JSON.stringify(context({ default: "allow", rules: [] })));
      const allowed = await codex(probeFrame("view_image", { path: join(workspace, "x.png") }));
      expect(allowed).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      await writeFile(contextFile, JSON.stringify(context()));
      for (const id of ["call_1", `orca-hook-probe:${NONCE}x`, "orca-hook-probe:"]) {
        const r = await codex(probeFrame("view_image", { path: contextFile }, id));
        expect([id, r.exitCode, r.stderr.includes("orca-hook-receipt")]).toEqual([id, 2, false]);
      }
      const { probeKey: _, ...keyless } = context();
      await writeFile(contextFile, JSON.stringify(keyless));
      const r = await codex(probeFrame("view_image", { path: contextFile }));
      expect([r.exitCode, r.stderr.includes("orca-hook-receipt")]).toEqual([2, false]);
    });

    it("is not given when the hook cannot decide", async () => {
      const r = await codex(probeFrame("view_image", { path: contextFile }).slice(0, -1));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).not.toContain("orca-hook-receipt");
      await writeFile(contextFile, JSON.stringify({ ...context(), probeKey: "short" }));
      const bad = await codex(probeFrame("view_image", { path: contextFile }));
      expect(bad.stderr).not.toContain("orca-hook-receipt");
    });
  });

  it("blocks when it cannot decide", async () => {
    expect((await codex("not json")).exitCode).toBe(2);
    expect((await runClaudePreToolHook(["--codex"], frame("Bash", { command: "ls" }))).exitCode).toBe(2);
    expect((await runClaudePreToolHook(["--codex", "relative.json"], frame("Bash", { command: "ls" }))).exitCode).toBe(
      2,
    );
  });
});

describe("the fail-closed line around ORCA's program (#1026)", () => {
  // Codex runs the hook in the account's login shell: bash, zsh or sh (`codexHookShell`).
  const SHELLS = ["/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh"].filter((p) => existsSync(p));
  /** Run the installed command line as Codex does, with a stand-in for ORCA's program. */
  const runLine = async (programBody: string | undefined, shell = SH.program) => {
    const script = join(root, "program.sh");
    if (programBody !== undefined) await writeFile(script, programBody, "utf8");
    const runtime = programBody === undefined ? join(root, "no-such-runtime") : "/bin/sh";
    return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(shell, ["-c", codexPreToolHookCommand(runtime, script, contextFile)], { cwd: workspace });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (exitCode) => done({ exitCode, stdout, stderr }));
      child.stdin.end("{}");
    });
  };
  const failed = { exitCode: 2, stdout: "", stderr: `${CODEX_HOOK_FAILED_REASON}\n` };
  const receipt = `orca-hook-receipt: ${"0123456789abcdef".repeat(4)}`;

  for (const shell of SHELLS)
    it.skipIf(process.platform === "win32")(
      `passes on ORCA's allow and ORCA's block, and nothing else (${shell})`,
      async () => {
        expect(await runLine("cat >/dev/null; exit 0", shell)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
        expect(await runLine("cat >/dev/null; echo 'Denied by ORCA: its policy.' >&2; exit 2", shell)).toEqual({
          exitCode: 2,
          stdout: "",
          stderr: "Denied by ORCA: its policy.\n",
        });
        expect(
          await runLine(`cat >/dev/null; printf 'Blocked by ORCA: a.\\n${receipt}\\n' >&2; exit 2`, shell),
        ).toEqual({
          exitCode: 2,
          stdout: "",
          stderr: `Blocked by ORCA: a.\n${receipt}\n`,
        });
      },
    );

  for (const shell of SHELLS)
    it.skipIf(process.platform === "win32")(
      `blocks, with a fixed reason, whenever the program fails (${shell})`,
      async () => {
        for (const body of [
          "cat >/dev/null; exit 1",
          // Codex lets a quiet exit 2 through; the line does not.
          "cat >/dev/null; exit 2",
          "cat >/dev/null; echo 'something else' >&2; exit 2",
          "cat >/dev/null; echo 'Denied by ORCA: x' >&2; exit 3",
          // An allow with output is not ORCA's allow.
          'cat >/dev/null; echo \'{"decision":"allow"}\'; exit 0',
          "cat >/dev/null; printf '\\n' ; exit 0",
          "cat >/dev/null; kill -9 $$",
          // A block in any form but ORCA's strict one.
          "cat >/dev/null; echo 'Denied by ORCA: ' >&2; exit 2",
          "cat >/dev/null; printf 'Denied by ORCA: a\\nDenied by ORCA: b\\n' >&2; exit 2",
          "cat >/dev/null; printf 'Denied by ORCA: a\\nsomething else\\n' >&2; exit 2",
          "cat >/dev/null; printf 'Denied by ORCA: a\\norca-hook-receipt: 00\\n' >&2; exit 2",
          `cat >/dev/null; printf 'Denied by ORCA: a\\n${receipt.toUpperCase()}\\n' >&2; exit 2`,
          `cat >/dev/null; printf 'Denied by ORCA: a\\n${receipt}\\n${receipt}\\n' >&2; exit 2`,
          "cat >/dev/null; printf 'Denied by ORCA: a\\033[2Kb\\n' >&2; exit 2",
          "cat >/dev/null; printf 'x\\nDenied by ORCA: a\\n' >&2; exit 2",
          // Output past the limit is cut, and a cut answer is never an allow.
          `cat >/dev/null; head -c ${2 * CODEX_HOOK_OUTPUT_LIMIT} /dev/zero | tr '\\0' x; exit 0`,
          `cat >/dev/null; head -c ${2 * CODEX_HOOK_OUTPUT_LIMIT} /dev/zero | tr '\\0' x >&2; printf '\\n0'; exit 0`,
        ])
          expect([body, await runLine(body, shell)]).toEqual([body, failed]);
        // The runtime itself is missing.
        expect(await runLine(undefined, shell)).toEqual(failed);
      },
    );

  it("stops the program short of Codex's own timeout", () => {
    expect(codexPreToolHookCommand("/n", "/s", "/c")).toContain("timeout -s KILL 25 '/n' '/s' '--codex' '/c' 2>&1");
  });

  it("has no newline in the command line itself", () => {
    expect(codexPreToolHookCommand("/n", "/s", "/c")).not.toContain("\n");
  });

  it.skipIf(process.platform === "win32")("is checked at admission: it blocks on this install", async () => {
    expect(await checkCodexFailClosedLine({ runtime: process.execPath, cwd: workspace, shell: SH })).toEqual({
      ok: true,
    });
  });

  it.skipIf(process.platform !== "linux")(
    "stops at once when its signal aborts, with everything the running check started",
    async () => {
      // A runtime that never ends: the check is mid-run when the signal aborts.
      const marker = join(root, "check.pid");
      const runtime = join(root, "hangs.sh");
      await writeFile(runtime, `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
      const cancel = new AbortController();
      setTimeout(() => cancel.abort("session closed"), 300);
      const started = Date.now();
      const got = await checkCodexFailClosedLine({ runtime, cwd: workspace, shell: SH, signal: cancel.signal });
      expect(got).toEqual({ ok: false, check: "crash", detail: "the session was cancelled" });
      expect(Date.now() - started).toBeLessThan(5_000);
      const pid = Number(await readFile(marker, "utf8"));
      await new Promise((r) => setTimeout(r, 100));
      const state = await readFile(`/proc/${pid}/stat`, "utf8").then(
        (t) => t.slice(t.lastIndexOf(")") + 2, t.lastIndexOf(")") + 3),
        () => "gone",
      );
      expect(["gone", "Z"]).toContain(state);
      // At its deadline the same way, and with an aborted signal nothing starts at all.
      expect(
        await checkCodexFailClosedLine({ runtime, cwd: workspace, shell: SH, signal: AbortSignal.timeout(200) }),
      ).toEqual({ ok: false, check: "crash", detail: "the admission deadline passed" });
      await rm(marker, { force: true });
      expect(
        await checkCodexFailClosedLine({ runtime, cwd: workspace, shell: SH, signal: AbortSignal.abort("gone") }),
      ).toEqual({ ok: false, check: "crash", detail: "the session was cancelled" });
      expect(existsSync(marker)).toBe(false);
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")("refuses an install where it does not block", async () => {
    // A shell that runs nothing: every check exits 0, which the line must never do on a failure.
    const got = await checkCodexFailClosedLine({
      runtime: process.execPath,
      cwd: workspace,
      shell: { program: "/bin/true", args: [] },
    });
    expect(got).toMatchObject({ ok: false, check: "crash", detail: "exit 0" });
    // With no `timeout` or `head` on the path every call is blocked, so this check passes;
    // the startup probe then refuses the session, as ORCA's own block cannot pass either.
    const noTimeout = await checkCodexFailClosedLine({
      runtime: process.execPath,
      cwd: workspace,
      shell: SH,
      env: { PATH: join(root, "empty") },
    });
    expect(noTimeout).toEqual({ ok: true });
  });
});

describe("installing it in Codex", () => {
  it("hashes the hook the way Codex 0.171 does", () => {
    // Both values were read from the real Codex 0.171 (`hooks/list` on its app server, with
    // this hook passed as a session flag).
    const command = codexPreToolHookProgram("/usr/bin/node", "/opt/orca/claude-pre-tool-hook.mjs", "/x/ctx.json");
    expect(codexHookTrustHash(command, 10)).toBe(
      "sha256:b90b4753446a395a8b1c43ebf10ba44ec9feeebeba9153a2ea3372c2f04bf306",
    );
    expect(codexHookTrustHash(command, 30)).toBe(
      "sha256:1622ba2c3880bde4c3fb2b7c8a4a6043dccad178b8cde40a3b0d8afefcd574b4",
    );
  });

  it("quotes every word of the command for the shell", () => {
    expect(codexPreToolHookProgram("/usr/bin/node", "/opt/it's here/hook.mjs", "/x/ctx.json")).toBe(
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
    const probe = (command: string, probeKey = PROBE_KEY) =>
      probeCodexHook({ command, cwd: workspace, contextFile, probeKey, shell: SH, env: process.env });

    it.skipIf(bundled === undefined || process.platform === "win32")(
      "sees the real hook block a call through the shell, with its receipt",
      async () => {
        const r = await probe(codexPreToolHookCommand(process.execPath, bundled!, contextFile));
        expect(r).toEqual({
          blocked: true,
          detail: "blocked, with the hook's receipt",
          diagnostics: {
            outcome: "blocked",
            shell: "/bin/sh",
            exitCode: 2,
            stderrBytes: expect.any(Number),
            receipt: "matched",
            elapsedMs: expect.any(Number),
          },
        });
      },
    );

    it.skipIf(bundled === undefined || process.platform === "win32")(
      "does not take the real hook's block as proof under another key",
      async () => {
        // The hook signed with the context's key; the probe expects another one.
        const r = await probe(codexPreToolHookCommand(process.execPath, bundled!, contextFile), "cd".repeat(32));
        expect(r.blocked).toBe(false);
        expect(r.detail).toContain("without ORCA's hook's receipt");
      },
    );

    it.skipIf(process.platform === "win32")("does not take an exit status alone as proof", async () => {
      for (const [command, outcome, receipt] of [
        ["true", "exit", "absent"],
        ["exit 1", "exit", "absent"],
        ["'/no/such/program'", "exit", "absent"],
        // Exits 2 with a reason, as a block would, but is not ORCA's hook.
        ["cat >/dev/null; echo 'Denied by ORCA: protected' >&2; exit 2", "no-receipt", "absent"],
        // Echoes the whole frame, nonce and all, back to stderr.
        ["cat >&2; exit 2", "no-receipt", "absent"],
        // A receipt-shaped line that is not signed for this call.
        [`cat >/dev/null; echo 'orca-hook-receipt: ${"0".repeat(64)}' >&2; exit 2`, "no-receipt", "mismatched"],
        // Says far more than the probe reads.
        ["cat >/dev/null; head -c 100000 /dev/zero | tr '\\0' x >&2; exit 2", "overflow", "absent"],
      ] as const) {
        const r = await probe(command);
        expect([command, r.blocked, r.diagnostics.outcome, r.diagnostics.receipt]).toEqual([
          command,
          false,
          outcome,
          receipt,
        ]);
      }
    });

    it.skipIf(process.platform !== "linux")(
      "refuses at its deadline, even while something the command started holds its streams",
      async () => {
        const marker = join(root, "descendant.pid");
        for (const command of [
          // Never answers.
          "sleep 30",
          // Answers, but leaves a descendant holding stderr open, so the stream never closes.
          `(sleep 30 >&2 & echo $! > '${marker}'); exit 2`,
          // A descendant in the background holding stdin and stderr, the shell waiting on it.
          "sleep 30 <&0 >&2 & wait",
        ]) {
          const started = Date.now();
          const r = await probeCodexHook({
            command,
            cwd: workspace,
            contextFile,
            probeKey: PROBE_KEY,
            shell: SH,
            env: process.env,
            timeoutMs: 500,
          });
          const took = Date.now() - started;
          expect([command, r.blocked]).toEqual([command, false]);
          expect(r.detail).toContain("did not answer within 500 ms");
          expect(r.diagnostics.outcome).toBe("timeout");
          // The caller is released at the deadline, not when the descendant finally lets go.
          expect(took).toBeLessThan(5_000);
        }
        // And the descendant went with the command's process group.
        const pid = Number(await readFile(marker, "utf8"));
        await new Promise((r) => setTimeout(r, 100));
        // Gone, or a zombie its reaper has not collected yet: either way it no longer runs.
        const state = await readFile(`/proc/${pid}/stat`, "utf8").then(
          (t) => t.slice(t.lastIndexOf(")") + 2, t.lastIndexOf(")") + 3),
          () => "gone",
        );
        expect(["gone", "Z"]).toContain(state);
      },
      30_000,
    );

    it.skipIf(process.platform === "win32")(
      "never quotes what the command wrote: fixed reason codes and bounded numbers only",
      async () => {
        const r = await probe(
          `cat >/dev/null; printf 'profile-secret-words \\033[31mred\\033[0m\\norca-hook-receipt: ${"1".repeat(64)}\\n' >&2; exit 1`,
        );
        expect(r.detail).toBe("exit 1");
        expect(JSON.stringify(r)).not.toContain("profile-secret-words");
        expect(r.diagnostics).toMatchObject({ outcome: "exit", exitCode: 1, receipt: "mismatched" });
        const missing = await probeCodexHook({
          command: "true",
          cwd: tmpdir(),
          contextFile: join(tmpdir(), "none"),
          probeKey: PROBE_KEY,
          shell: { program: join(tmpdir(), "orca-no-such-shell"), args: ["-c"] },
        });
        expect(missing.detail).toBe("the shell could not be started (ENOENT)");
        expect(missing.diagnostics.outcome).toBe("spawn-error");
      },
    );

    it.skipIf(process.platform !== "linux")("stops when the session's signal aborts, and says so", async () => {
      const cancel = new AbortController();
      setTimeout(() => cancel.abort("session closed"), 200);
      const started = Date.now();
      const r = await probeCodexHook({
        command: "sleep 30",
        cwd: workspace,
        contextFile,
        probeKey: PROBE_KEY,
        shell: SH,
        env: process.env,
        signal: cancel.signal,
      });
      expect(r.blocked).toBe(false);
      expect(r.diagnostics.outcome).toBe("cancelled");
      expect(r.detail).toBe("the session was cancelled");
      expect(Date.now() - started).toBeLessThan(5_000);
      // The admission's deadline, given as the signal, reads as a timeout.
      const late = await probeCodexHook({
        command: "sleep 30",
        cwd: workspace,
        contextFile,
        probeKey: PROBE_KEY,
        shell: SH,
        env: process.env,
        signal: AbortSignal.timeout(200),
      });
      expect(late.diagnostics.outcome).toBe("timeout");
      expect(late.detail).toBe("the admission deadline passed");
    });

    it.skipIf(process.platform === "win32")("does not accept a receipt from an earlier probe", async () => {
      // A receipt for a nonce of the test's choosing, replayed to a probe that picked its own.
      const old = codexProbeReceipt(PROBE_KEY, "0".repeat(32));
      const r = await probe(`cat >/dev/null; echo '${old}' >&2; exit 2`);
      expect(r.blocked).toBe(false);
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

/** What ORCA reads off a running process as the environment Codex gives its hooks. */
describe("the environment Codex runs its hooks in", () => {
  it.skipIf(process.platform !== "linux")("is the process's own environment, read from the system", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      env: { PATH: "/usr/bin:/bin", ONLY_HERE: "a=b=c", EMPTY: "" },
      stdio: "ignore",
    });
    try {
      await new Promise((r) => child.once("spawn", r));
      const env = await codexHookEnvironment(child.pid!);
      // No `codex-path` beside this program, so PATH is as it was.
      expect(env).toEqual({ PATH: "/usr/bin:/bin", ONLY_HERE: "a=b=c", EMPTY: "" });
    } finally {
      child.kill();
    }
  });

  it.skipIf(process.platform !== "linux")("is refused, not guessed, when it cannot be read", async () => {
    expect(await codexHookEnvironment(2 ** 22 + 12345)).toEqual({ error: expect.stringContaining("cannot be read") });
  });
});

/** The shell Codex starts a hook in: the account's login shell, with `-c`. */
describe("the shell Codex runs its hooks in", () => {
  it("is the login shell Codex knows, run with -c and not as a login shell", () => {
    expect(codexHookShell("/bin/bash")).toEqual({ program: "/bin/bash", args: ["-c"] });
    expect(codexHookShell("/usr/bin/zsh")).toEqual({ program: "/usr/bin/zsh", args: ["-c"] });
    expect(codexHookShell("/bin/sh")).toEqual({ program: "/bin/sh", args: ["-c"] });
  });

  it("is refused for a login shell ORCA does not know Codex's choice for", () => {
    expect(codexHookShell("/usr/bin/fish")).toEqual({ error: expect.stringContaining("/usr/bin/fish") });
    expect(codexHookShell("")).toEqual({ error: "this account has no login shell" });
  });
});
