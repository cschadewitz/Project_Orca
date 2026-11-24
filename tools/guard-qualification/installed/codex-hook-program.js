/**
 * The installed half of Codex's hook route (#1026): the cases a live Codex cannot make (raw hook
 * input, a damaged context file, a call from another working directory) and the ones it refuses
 * itself before ORCA answers, run on ORCA's hook program exactly as the live session installed it.
 *
 * Each world first opens a real session through the daemon's session factory (`connected/
 * codex.js`), so the command line and the context file are the ones ORCA handed that Codex in
 * `CODEX_CONFIG` at that moment. The command is then run as Codex 0.171.0 runs a `command` hook:
 * by the account's login shell with `-c` (`codexHookShell`), in the session's directory, with the
 * frame on stdin, and judged as Codex judges it (`codexHookOutcome`): exit 0 with no output
 * allows, exit 2 with a reason on stderr blocks, and anything else is a defect the case sees,
 * since Codex would let that call through.
 *
 * Unlike the `codex-native-hook` path in `paths.js`, which calls `runClaudePreToolHook` in the
 * test's own process, nothing here is ORCA's code in this process: it is the built program, run
 * by the command line the session installed.
 */
import { spawn } from "node:child_process";
import { codexHookShell, codexPreToolHookCommand } from "@orca/agents";
import { codexNativeHook } from "../paths.js";

/** How Codex 0.171.0 takes a hook's exit, as the `codex-native-hook` path judges it in `paths.js`. */
export function codexHookOutcome(result) {
  if (result.exitCode === 0)
    return result.stdout === "" && result.stderr === "" ? "allow" : "invalid:exit-0-with-output";
  // Codex blocks only on exit 2 with a reason on stderr; any other refusal would let it run.
  if (result.exitCode !== 2) return `invalid:exit-${String(result.exitCode)}`;
  if (result.stdout !== "") return "invalid:stdout";
  if (result.stderr.startsWith("Denied by ORCA: ")) return "deny";
  if (result.stderr.startsWith("Blocked by ORCA: its policy asks a person first")) return "ask";
  if (result.stderr.startsWith("Blocked by ORCA: ")) return "block";
  return "invalid:unrecognised-stderr";
}

const shellWord = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

/** ORCA's hook as the session installed it, from the `CODEX_CONFIG` it handed the agent. */
export function installedCodexHook(codexConfig, runtime, script) {
  const config = JSON.parse(codexConfig ?? "null");
  const hook = config?.hooks?.PreToolUse?.[0]?.hooks?.[0];
  if (config?.hooks?.PreToolUse?.length !== 1 || typeof hook?.command !== "string")
    throw new Error("the session installed no PreToolUse hook");
  const prefix = codexPreToolHookCommand(runtime, script, "").slice(0, -"''".length);
  if (!hook.command.startsWith(prefix)) throw new Error("the installed hook is not ORCA's program");
  const quoted = hook.command.slice(prefix.length);
  const contextFile = quoted.slice(1, -1).replaceAll(`'\\''`, "'");
  if (codexPreToolHookCommand(runtime, script, contextFile) !== hook.command)
    throw new Error("the installed hook's context file could not be read off its command line");
  return { config, hook, contextFile, runtime, script };
}

/**
 * @param {{ live: ReturnType<typeof import("../connected/codex.js").codexConnected>,
 *   runtime: string, script: string }} env the live path whose sessions install the hook this runs
 */
export function codexHookProgram(env) {
  const path = {
    id: "codex-native-hook",
    capabilities: codexNativeHook.capabilities,

    async installed(world) {
      if (!world.installedCodexConfig) await env.live.open(world);
      return installedCodexHook(world.installedCodexConfig, env.runtime, env.script);
    },

    frame: codexNativeHook.frame,

    async decide(world, action) {
      await path.installed(world);
      return path.decideRaw(world, codexNativeHook.frame(world, action));
    },

    /** Send the installed command these stdin bytes; `args` replaces its context-file argument. */
    async decideRaw(world, input, args) {
      const { hook, contextFile, runtime, script } = await path.installed(world);
      const command =
        args === undefined ? hook.command : [runtime, script, "--codex", ...args].map(shellWord).join(" ");
      const shell = codexHookShell();
      if ("error" in shell) throw new Error(shell.error);
      const result = await run(shell.program, [...shell.args, command], input, hook.timeout * 1000, world.workspace);
      return {
        outcome: codexHookOutcome(result),
        detail: { ...result, installed: true, contextFile: args === undefined ? contextFile : undefined },
        surfaces: [result.stdout, result.stderr],
      };
    },
  };
  return path;
}

/** Run a command hook as Codex does; a hook that cannot start or is killed is not a block. */
function run(program, args, input, timeoutMs, cwd) {
  return new Promise((done) => {
    const child = spawn(program, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ exitCode: -1, stdout: "", stderr: `the hook could not start: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ exitCode: signal ? -1 : (code ?? -1), stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
