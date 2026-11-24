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
import { createHash } from "node:crypto";
import { codexHookShell } from "@orca/agents";
import { codexFailClosedLine, codexInstalledHookProblems } from "../check-support-matrix.js";
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
const unquote = (w) => w.slice(1, -1).replaceAll(`'\\''`, "'");

/**
 * ORCA's hook as the session installed it: the `hooks` and `web_search` of the `CODEX_CONFIG`
 * it handed the agent (the receipt's `installedSettings`), and the runtime, program and context
 * file its fail-closed line runs.
 */
export function installedCodexHook(codexConfig) {
  const config = JSON.parse(codexConfig ?? "null");
  const settings = { hooks: config?.hooks, web_search: config?.web_search };
  const problems = codexInstalledHookProblems(settings);
  if (problems.length) throw new Error(`the session did not install ORCA's hook: ${problems.join("; ")}`);
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  const words = /timeout -s KILL \d+ ('(?:[^']|'\\'')*') ('(?:[^']|'\\'')*') '--codex' ('(?:[^']|'\\'')*') 2>&1/.exec(
    hook.command,
  );
  const [runtime, script, contextFile] = words.slice(1).map(unquote);
  return { settings, hook, runtime, script, contextFile };
}

/**
 * Faults the end-to-end check in `guard-receipts.yml` injects to produce a real nonqualifying
 * receipt, as for Claude (`installed/claude-hook-program.js`): `lets-everything-through` runs
 * a program that exits 0 with no output in place of the installed line.
 */
export const PROGRAM_FAULTS = ["lets-everything-through"];

/**
 * @param {{ live: ReturnType<typeof import("../connected/codex.js").codexConnected>, fault?: string }} env
 *   the live path whose sessions install the hook this runs, and a fault to inject
 */
export function codexHookProgram(env) {
  if (env.fault !== undefined && !PROGRAM_FAULTS.includes(env.fault)) throw new Error(`unknown fault ${env.fault}`);
  const path = {
    id: "codex-native-hook",
    capabilities: codexNativeHook.capabilities,
    /** Settings from the first session this path opened. */
    installedSettings: undefined,

    async installed(world) {
      if (!world.installedCodexConfig) await env.live.open(world);
      const installed = installedCodexHook(world.installedCodexConfig);
      path.installedSettings ??= installed.settings;
      return installed;
    },

    frame: codexNativeHook.frame,

    async decide(world, action) {
      await path.installed(world);
      return path.decideRaw(world, codexNativeHook.frame(world, action));
    },

    /**
     * Send the installed command line these stdin bytes. `args` replaces its context-file
     * argument: the same fail-closed line, around the same runtime and program, with those
     * arguments after `--codex`.
     */
    async decideRaw(world, input, args) {
      const { hook, runtime, script } = await path.installed(world);
      const command =
        args === undefined
          ? hook.command
          : args.length === 1
            ? codexFailClosedLine(runtime, script, args[0])
            : codexFailClosedLine(runtime, script, "").replace(
                `'--codex' '' 2>&1`,
                `${["--codex", ...args].map(shellWord).join(" ")} 2>&1`,
              );
      const shell = codexHookShell();
      if ("error" in shell) throw new Error(shell.error);
      const result =
        env.fault === "lets-everything-through"
          ? await run(process.execPath, ["-e", ""], input, hook.timeout * 1000, world.workspace)
          : await run(shell.program, [...shell.args, command], input, hook.timeout * 1000, world.workspace);
      (world.programCalls ??= []).push(programRecord(hook, args, input, result));
      return {
        outcome: codexHookOutcome(result),
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

/** Program output kept in the receipt; a run that says more is recorded as truncated. */
export const PROGRAM_OUTPUT_LIMIT = 64 * 1024;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** One run of the installed command line, as the receipt records it (as for Claude). */
export function programRecord(hook, args, input, result) {
  const keep = (text) =>
    Buffer.byteLength(text) <= PROGRAM_OUTPUT_LIMIT ? text : { truncated: true, sha256: sha256(text) };
  return {
    command: hook.command,
    args: args === undefined ? "installed" : "replaced",
    input: { sha256: sha256(input), bytes: Buffer.byteLength(input) },
    exitCode: result.exitCode,
    stdout: keep(result.stdout),
    stderr: keep(result.stderr),
    outcome: codexHookOutcome(result),
  };
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
