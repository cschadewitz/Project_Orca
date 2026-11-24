/**
 * The installed half of Claude's hook route (#1026): the cases a live Claude Code cannot make
 * (raw hook input, a damaged context file, the installed settings, a call from another working
 * directory) and the ones it refuses itself before ORCA answers, run on ORCA's hook program
 * exactly as the live session installed it.
 *
 * Each world first opens a real session through the daemon's session factory (`connected/
 * claude.js`), so the program, its arguments and the context file are the ones ORCA wrote for
 * that session at that moment, read back from the `session/new` settings it handed the agent.
 * The program is then run as Claude Code runs a `command` hook: that executable, those
 * arguments, the frame on stdin, its timeout, and a hook that cannot start or exits non-zero
 * counted as a block (`onFailure: "block"`).
 *
 * Unlike the `claude-native-hook` path in `paths.js`, which calls `runClaudePreToolHook` in the
 * test's own process, nothing here is ORCA's code in this process: it is the built program, its
 * output guard and its exit code.
 */
import { spawn } from "node:child_process";
import { claudeNativeHook, hookOutcome } from "../paths.js";

/** The PreToolUse hook entry ORCA installed, from the `_meta` it sent at session/new. */
export function installedPreToolHook(meta) {
  const settings = meta?.claudeCode?.options?.settings;
  const hook = settings?.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook || typeof hook.command !== "string" || !Array.isArray(hook.args))
    throw new Error("the session installed no PreToolUse hook");
  return { settings, hook, contextFile: hook.args.at(-1), script: hook.args.slice(0, -1) };
}

/**
 * @param {{ live: ReturnType<typeof import("../connected/claude.js").claudeConnected> }} env
 *   the live path, whose sessions install the hook this runs
 */
export function claudeHookProgram(env) {
  const path = {
    id: "claude-native-hook",
    capabilities: claudeNativeHook.capabilities,
    /** Settings from the first session this path opened; F03 reads them without a world. */
    installedSettings: undefined,

    async installed(world) {
      if (!world.installedMeta) await env.live.open(world);
      const installed = installedPreToolHook(world.installedMeta);
      path.installedSettings ??= installed.settings;
      return installed;
    },

    frame: claudeNativeHook.frame,

    async decide(world, action) {
      await path.installed(world);
      return path.decideRaw(world, claudeNativeHook.frame(world, action));
    },

    /** Send the installed program these stdin bytes; `args` replaces its context-file argument. */
    async decideRaw(world, input, args) {
      const { hook, contextFile, script } = await path.installed(world);
      const argv = args === undefined ? [...script, contextFile] : [...script, ...args];
      const result = await run(hook.command, argv, input, hook.timeout * 1000, world.workspace);
      return {
        outcome: hookOutcome(result),
        detail: { ...result, installed: true },
        surfaces: [result.stdout, result.stderr],
      };
    },

    settings() {
      if (!path.installedSettings) throw new Error("no session has installed the hook yet");
      return path.installedSettings;
    },
  };
  return path;
}

/** Run a command hook the way Claude Code does: failure to start or a non-zero exit blocks. */
function run(command, args, input, timeoutMs, cwd) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ exitCode: 2, stdout: "", stderr: `the hook could not start: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ exitCode: signal ? 2 : (code ?? 2), stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
