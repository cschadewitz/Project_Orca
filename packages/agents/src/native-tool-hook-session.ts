/**
 * Installing ORCA's pre-tool hook (`claude-pre-tool-hook.ts`) in an opted-in agent's session:
 * the Claude ACP adapter (#704) or the Codex ACP adapter (#705).
 *
 * `nativeToolHook: experimental` (the hook is not guard-qualified; `on` is refused until it is,
 * `nativeToolHookNotQualified`) is a promise that the agent's tool calls are checked, so every session
 * this cannot guard is refused, never opened without the hook. Only ORCA's session factory
 * installs it; any other way of opening such an agent is refused (`nativeToolHookRefused`).
 * When installed, the session factory holds the session away
 * from ORCA's host services, and from the MCP servers ORCA runs for it, until its runtime is
 * admitted, and ORCA checks every relayed MCP request again when it is dispatched.
 *
 * The two adapters take the hook at different moments, and ORCA knows which adapter it runs,
 * and at what version, only once the agent has answered `initialize`:
 *
 * - **Before the agent starts** (`prepare`): ORCA writes the session's context file (the
 *   rules, sidecars, workspace and protected paths the hook decides with) with owner-only
 *   permissions into a private directory ORCA protects from agents, and builds the
 *   environment that hands Codex its hook: `CODEX_CONFIG`, which the Codex ACP adapter passes
 *   to Codex as session flags. The hook goes there with its trust recorded beside it
 *   (`hooks.state`, keyed and hashed the way Codex 0.171 keys and hashes it), so Codex runs it
 *   without asking anybody to trust it and without writing to the user's Codex config. An
 *   agent that is not Codex ignores the variable.
 * - **After `initialize`** (`sessionMeta`):
 *   - **The Claude adapter** gets the hook in `session/new`'s
 *     `_meta.claudeCode.options.settings`, as an object, plus a session-start hook that
 *     records the process id of the Claude Code that ran it.
 *   - **The Codex adapter** has had it since it started; ORCA asks the adapter
 *     (`_codex/hooks/list`) and refuses the session unless Codex reports exactly ORCA's hook
 *     as trusted and enabled, and runs the hook once, through the same shell Codex will use,
 *     on a call it must block, and refuses unless it blocks and signs a receipt for that very
 *     call with the key in the session's context file (`probeCodexHook`). A Codex that hashed differently,
 *     a config that turned the hook off, or a shell that cannot run it would otherwise let
 *     every call through. ORCA also attests the Codex the adapter actually started, before
 *     the session is created.
 *   - **Anything else** is refused: another adapter, an agent that does not say who it is, an
 *     adapter version or a platform the acceptance tests do not run
 *     (`*_HOOK_VERIFIED_PAIRS`, `*_HOOK_VERIFIED_PLATFORMS`).
 * - **The runtime is attested on ORCA's own evidence**, never on what the adapter or the
 *   runtime says about itself. A report only points at a process; ORCA executes nothing it
 *   names. From its own side ORCA checks that the process is a live descendant of the agent
 *   process it started, and hashes the image that process actually runs (`/proc/<pid>/exe`,
 *   the kernel's handle on the running file, not a path) against the digest pinned for the
 *   adapter's verified pair on this platform and architecture. For Claude that happens in
 *   `verifyRuntime`, after the session starts and before it is given work; for Codex it
 *   happens in `sessionMeta`, before the session is created.
 *
 * The verified pairs are the ones `claude-hook-acceptance.yml` and `codex-hook-acceptance.yml`
 * install and run against the real agent. Another version may behave differently (an older
 * Claude Code may ignore `onFailure: "block"`; another Codex may hash its hooks differently),
 * so a session there would only look guarded.
 *
 * The hook runs on the agent's machine, so this applies to agents on the daemon's own host.
 * The factory refuses an opted-in agent on an SSH host before anything starts. `cleanup`
 * removes the context file and the runtime record when the session ends.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { userInfo } from "node:os";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OrcaError, type ConfiguredPermissionPolicy } from "@orca/core";
import {
  CLAUDE_PRE_TOOL_TIMEOUT_SECONDS,
  claudePreToolHookSettings,
  claudeRuntimeAttestationFile,
  CODEX_PROBE_TOOL_USE_ID,
  codexProbeReceipt,
  type ClaudeHookContext,
  type ClaudeRuntimeAttestation,
} from "./claude-pre-tool-hook.js";
import { openHookTelemetrySpool, type HookTelemetrySpool } from "./hook-telemetry.js";
import type { ProtectedPaths } from "./permissions.js";

/** Whether the agent asks for ORCA's hook at all: `experimental`, or `on`, which is refused. */
export function nativeToolHookRequested(agent: {
  nativeToolHook?: "on" | "off" | "experimental" | undefined;
}): boolean {
  return agent.nativeToolHook === "on" || agent.nativeToolHook === "experimental";
}

/**
 * The refusal for `nativeToolHook: on` (#704 review). `on` is kept for a guard-qualified hook,
 * which no agent has yet, so a config that set it before the hook shipped stays inactive until
 * its owner opts in again with `experimental`, explicitly accepting an unqualified hook.
 */
export function nativeToolHookNotQualified(agent: {
  id: string;
  nativeToolHook?: "on" | "off" | "experimental" | undefined;
}): OrcaError | undefined {
  if (agent.nativeToolHook !== "on") return undefined;
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agent.id} has nativeToolHook: on, which is kept for a guard-qualified hook, and no agent is qualified yet. ` +
      `ORCA refuses the session rather than run it with less than that. To use ORCA's experimental, unqualified hook, ` +
      `set nativeToolHook: experimental (see docs/agent-hook-coverage.md for what it does not cover); ` +
      `to run the agent without a hook, remove nativeToolHook.`,
    { agentId: agent.id },
  );
}

/**
 * The refusal for `nativeToolHook` wherever ORCA would open the agent without installing
 * its hook (#704): `openAcpSession` called directly rather than through the session factory
 * (`orca ping` with no daemon answering, an ephemeral bootstrap), and remote delegation, whose
 * agents run on another daemon. Each refuses such an agent before anything starts.
 */
export function nativeToolHookRefused(
  agent: { id: string; nativeToolHook?: "on" | "off" | "experimental" | undefined },
  where: "outside-factory" | "remote-delegation",
): OrcaError | undefined {
  if (!nativeToolHookRequested(agent)) return undefined;
  const why =
    where === "remote-delegation"
      ? `it is an orca-daemon agent, and ORCA's tool hook does not apply to a remote daemon's agents`
      : `ORCA installs its hook only in sessions its daemon or a workflow run opens, not in this one-off session ` +
        `(to check this agent, ping it through a running daemon)`;
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agent.id} has nativeToolHook: ${agent.nativeToolHook}, but ${why}. ` +
      `ORCA refuses the session rather than run it unguarded; remove nativeToolHook to run it without the hook.`,
    { agentId: agent.id },
  );
}

/** The names the Claude ACP adapter reports in `initialize`'s `agentInfo`. */
export const CLAUDE_ADAPTER_NAMES: readonly string[] = [
  "@agentclientprotocol/claude-agent-acp",
  "@zed-industries/claude-code-acp",
];

/**
 * The adapter and Claude Code pairs whose installed hook behaviour `claude-hook-acceptance.yml`
 * observes, each one installed and run there: the adapter version `initialize` reports, the
 * Claude Code version it runs, and the SHA-256 of that Claude Code's executable image for each
 * `<platform>-<arch>` the acceptance run covers. ORCA hashes the image the session's runtime
 * process actually runs and accepts only the pinned digest of the adapter's pair; the
 * adapter's own report says nothing about the runtime (an environment variable can point it
 * at another Claude Code). Adding a pair or an image is a reviewed change to both.
 */
export const CLAUDE_HOOK_VERIFIED_PAIRS: readonly {
  adapter: string;
  runtime: string;
  images: Readonly<Record<string, string>>;
}[] = [
  {
    adapter: "0.109.1",
    runtime: "2.1.330",
    // @anthropic-ai/claude-agent-sdk-linux-x64@0.3.330, `claude`.
    images: { "linux-x64": "f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb" },
  },
];

/** The adapter versions in `CLAUDE_HOOK_VERIFIED_PAIRS`. */
export const CLAUDE_HOOK_VERIFIED_ADAPTERS: readonly string[] = CLAUDE_HOOK_VERIFIED_PAIRS.map((p) => p.adapter);

/** The platforms (`process.platform`) that workflow runs the acceptance test on. */
export const CLAUDE_HOOK_VERIFIED_PLATFORMS: readonly NodeJS.Platform[] = ["linux"];

/**
 * Where the hook program is, as built: `bin/claude-pre-tool-hook.js` beside this module in
 * the package's `dist`, or `claude-pre-tool-hook.mjs` beside the bundled daemon
 * (`packages/app/scripts/build-daemon.js`). Undefined when neither exists, which is the case
 * when this runs from source.
 */
export function claudePreToolHookScript(): string | undefined {
  for (const rel of ["./bin/claude-pre-tool-hook.js", "./claude-pre-tool-hook.mjs"]) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** The name the Codex ACP adapter reports in `initialize`'s `agentInfo`. */
export const CODEX_ADAPTER_NAMES: readonly string[] = ["@agentclientprotocol/codex-acp"];

/**
 * The Codex adapter and Codex pairs `codex-hook-acceptance.yml` installs and runs: the adapter
 * version `initialize` reports, the Codex version it runs, and the SHA-256 of that Codex's
 * executable image for each `<platform>-<arch>` the acceptance run covers. ORCA hashes the
 * image the Codex process the adapter started actually runs and accepts only the pinned
 * digest; `CODEX_PATH` can point the adapter at another Codex, and nothing Codex says about
 * itself is taken as evidence. Adding a pair or an image is a reviewed change to both.
 */
export const CODEX_HOOK_VERIFIED_PAIRS: readonly {
  adapter: string;
  runtime: string;
  images: Readonly<Record<string, string>>;
}[] = [
  {
    adapter: "2.9.0",
    runtime: "0.171.0",
    // @openai/codex-linux-x64@0.171.0, vendor/x86_64-unknown-linux-musl/bin/codex.
    images: { "linux-x64": "b76a027d6b210f9a8da7aaf321dd235c700f0ef7a794d4a5314b9af6c134f0f0" },
  },
];

/** The adapter versions in `CODEX_HOOK_VERIFIED_PAIRS`. */
export const CODEX_HOOK_VERIFIED_ADAPTERS: readonly string[] = CODEX_HOOK_VERIFIED_PAIRS.map((p) => p.adapter);

/**
 * The Codex process the adapter (process `agentPid`) actually runs: its descendant started
 * with `app-server` that has no such descendant of its own (the native binary, under the Node
 * wrapper when the adapter uses its bundled Codex). Only the pid is found here; the image it
 * runs is attested by `processImageDigest`, which is ORCA's own evidence. Linux only, which is
 * the only platform the hook is installed on.
 */
export async function codexRuntimeProcess(agentPid: number | undefined): Promise<{ pid: number } | { error: string }> {
  if (agentPid === undefined) return { error: "the agent's process id is unknown" };
  const table = await processTable();
  const below = (pid: number, root: number): boolean => {
    for (let p = table.get(pid)?.ppid, hops = 0; p !== undefined && hops < 64; p = table.get(p)?.ppid, hops++)
      if (p === root) return true;
    return false;
  };
  const servers = [...table.entries()]
    .filter(([pid, p]) => p.argv.includes("app-server") && below(pid, agentPid))
    .map(([pid]) => pid);
  const leaves = servers.filter((pid) => !servers.some((other) => other !== pid && below(other, pid)));
  if (leaves.length !== 1)
    return {
      error:
        leaves.length === 0
          ? "no Codex app-server runs under the adapter"
          : "several Codex app-servers run under the adapter",
    };
  return { pid: leaves[0]! };
}

/**
 * The environment Codex runs its hooks in, read from the Codex process itself (#705): Codex
 * starts a hook from an empty environment and replays its own, with the directory of its
 * helper programs (`codex-path`, beside its `bin`) put first on `PATH`. Reading the process
 * rather than rebuilding what ORCA meant to give it keeps the probe to exactly what the hook
 * will see: the variables ORCA withheld are absent, the secrets it delivered are present, and
 * whatever the adapter changed on the way is included.
 */
export async function codexHookEnvironment(pid: number): Promise<NodeJS.ProcessEnv | { error: string }> {
  let raw: string;
  let exe: string;
  try {
    [raw, exe] = await Promise.all([readFile(`/proc/${pid}/environ`, "utf8"), readlink(`/proc/${pid}/exe`)]);
  } catch (e) {
    return {
      error: `the Codex process's environment cannot be read (${(e as NodeJS.ErrnoException).code ?? "unknown"})`,
    };
  }
  const env: NodeJS.ProcessEnv = {};
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  const helpers = join(dirname(dirname(exe)), "codex-path");
  const isDir = await stat(helpers).then(
    (st) => st.isDirectory(),
    () => false,
  );
  if (isDir) env["PATH"] = env["PATH"] ? `${helpers}:${env["PATH"]}` : helpers;
  return env;
}

/** The platforms that workflow runs on. */
export const CODEX_HOOK_VERIFIED_PLATFORMS: readonly NodeJS.Platform[] = ["linux"];

/** Codex's own timeout for the hook, in seconds; a hook that runs out lets the call through. */
export const CODEX_PRE_TOOL_TIMEOUT_SECONDS = 30;

/** One word for a POSIX shell, quoted so nothing in it is interpreted. */
const shellWord = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The shell Codex 0.171 starts a hook in, as `<shell> -c <command>` (observed by the acceptance
 * suite, which records the hook shell's own arguments): the account's login shell from the
 * system's user database, not `$SHELL`, and not as a login shell. ORCA knows this only for the
 * shells Codex names (bash, zsh, sh); for any other login shell it cannot say which shell
 * Codex would fall back to, and refuses rather than check the hook in the wrong one.
 */
export function codexHookShell(
  loginShell: string | undefined = userInfo().shell ?? undefined,
): { program: string; args: string[] } | { error: string } {
  if (!loginShell) return { error: "this account has no login shell" };
  if (!["bash", "zsh", "sh"].includes(basename(loginShell)))
    return {
      error: `this account's login shell is ${loginShell}, and ORCA knows how Codex runs hooks only in bash, zsh or sh`,
    };
  return { program: loginShell, args: ["-c"] };
}

/** ORCA's hook program as one command line: each word quoted, nothing else. */
export function codexPreToolHookProgram(runtime: string, script: string, contextFile: string): string {
  return [runtime, script, "--codex", contextFile].map(shellWord).join(" ");
}

/**
 * How long ORCA's program may run inside the hook, in seconds: short of Codex's own timeout,
 * so the program is stopped, and the call blocked, before Codex would give up and let it run.
 */
export const CODEX_PRE_TOOL_PROGRAM_SECONDS = CODEX_PRE_TOOL_TIMEOUT_SECONDS - 5;

/** What the fail-closed line says when ORCA's program did not answer in ORCA's form. */
export const CODEX_HOOK_FAILED_REASON =
  "Blocked by ORCA: its hook did not answer, so the call does not run (ORCA's permission policy).";

/**
 * How much of the program's output the fail-closed line reads, in bytes. ORCA's answers are far
 * shorter; anything longer is cut there, and a cut answer is never an allow.
 */
export const CODEX_HOOK_OUTPUT_LIMIT = 4096;

/**
 * The fail-closed line around one program, given as shell words (#1026). It keeps the
 * program's completion apart from its output: the program (under `timeout`, in a process
 * group of its own) writes its stdout and stderr to a file whose size the shell limits, and
 * the line takes its exit status from `wait` once it has ended. Output past
 * `CODEX_HOOK_OUTPUT_LIMIT` is never a verdict. Sent TERM, INT or HUP, the line kills the
 * program's group and blocks. It accepts only two verdicts, each in a strict form:
 *
 * - allow: exit 0 and no output at all;
 * - block: exit 2 and exactly one line of printable text beginning `Denied by ORCA: ` or
 *   `Blocked by ORCA: `, optionally followed by exactly one `orca-hook-receipt: ` line of 64
 *   lowercase hex digits (the startup probe's receipt). That answer is passed on as is.
 *
 * Every other outcome (a crash, a kill, a missing runtime, a hang stopped by `timeout`, any
 * other exit, output in any other form, output cut at the limit) is exit 2 with
 * `CODEX_HOOK_FAILED_REASON`, which Codex blocks on. The line itself still runs under Codex,
 * which lets a call through if the line's own shell fails; `checkCodexFailClosedLine` checks
 * at admission that the line blocks on this install.
 */
export function codexFailClosedLine(programWords: string): string {
  const fail = `{ printf '%s\\n' ${shellWord(CODEX_HOOK_FAILED_REASON)} >&2; exit 2; }`;
  return [
    // A newline, without one in the command line itself.
    "nl=$(printf '\\nx')",
    "nl=${nl%x}",
    `d=$(mktemp -d 2>/dev/null) || ${fail}`,
    // `timeout` runs the program in a process group of its own; asked to stop, the line takes
    // that group with it before it blocks.
    `t=`,
    `trap 'rm -rf "$d"' EXIT`,
    `trap ${shellWord(`[ -n "$t" ] && { kill -KILL -"$t" 2>/dev/null; kill -KILL "$t" 2>/dev/null; }; ${fail}`)} TERM INT HUP`,
    // The program writes to a file, not a pipe, so nothing it leaves behind can hold the line
    // open; a write past the file-size limit (16 blocks of 512 bytes) ends the program.
    `exec 3<&0`,
    `( ulimit -f 16; exec timeout -s KILL ${CODEX_PRE_TOOL_PROGRAM_SECONDS} ${programWords} <&3 >"$d/o" 2>&1 ) 2>/dev/null & t=$!`,
    // Its exit status, apart from its output, and only once it has ended.
    `{ wait "$t"; s=$?; } 2>/dev/null; t=`,
    `n=$(wc -c <"$d/o" 2>/dev/null)`,
    `[ "$n" -le ${CODEX_HOOK_OUTPUT_LIMIT} ] 2>/dev/null || ${fail}`,
    `if [ "$s" = 0 ] && [ "$n" = 0 ]; then exit 0; fi`,
    `[ "$s" = 2 ] || ${fail}`,
    `out=$(head -c ${CODEX_HOOK_OUTPUT_LIMIT} "$d/o")`,
    `r=\${out%%"$nl"*}`,
    `rest=\${out#"$r"}`,
    `rest=\${rest#"$nl"}`,
    `case "$r" in "Denied by ORCA: "?*|"Blocked by ORCA: "?*) ;; *) ${fail} ;; esac`,
    `case "$r" in *[![:print:]]*) ${fail} ;; esac`,
    `h=\${rest#"orca-hook-receipt: "}`,
    `if [ -n "$rest" ]; then if [ "$h" = "$rest" ] || [ \${#h} -ne 64 ]; then ${fail}; fi; case "$h" in *[!0-9a-f]*) ${fail} ;; esac; fi`,
    `printf '%s\\n' "$out" >&2`,
    "exit 2",
  ].join("; ");
}

/**
 * The command line Codex runs (through `codexHookShell`) for the hook: ORCA's program inside
 * the fail-closed line (`codexFailClosedLine`). Codex 0.171.0 lets a call through when its
 * hook exits 1, exits 2 with nothing on stderr, or runs out of time, and has no setting that
 * changes that; the line turns each of those failures of ORCA's program into a block.
 */
export function codexPreToolHookCommand(runtime: string, script: string, contextFile: string): string {
  return codexFailClosedLine(codexPreToolHookProgram(runtime, script, contextFile));
}

/** How one run of a command in the hook shell ended (`runInHookShell`). */
type HookShellRun =
  | { ended: "exit"; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { ended: "overflow" | "aborted"; stderr: string; reason?: unknown }
  | { ended: "spawn-error"; code: string; stderr: string };

/** How long a stopped command line has to end, after TERM, before ORCA kills its group. */
const HOOK_SHELL_STOP_GRACE_MS = 1_000;

/**
 * Run one command line in the hook shell, as Codex runs the hook, as the leader of a process
 * group of its own, reading at most `stderrLimit` bytes of stderr. It ends when the shell has
 * exited and its streams have closed (`exit`), when stderr passes the limit (`overflow`), or
 * when `signal` aborts (`aborted`, with the signal's reason). On overflow and abort it settles
 * at once and stops only what it owns: it sends TERM to the shell it started (on which the
 * fail-closed line kills the program's own group, `codexFailClosedLine`). After
 * `HOOK_SHELL_STOP_GRACE_MS` it sends KILL to the shell's group, which it created, only while
 * that group provably still exists (the shell is not yet reaped, or a member still holds the
 * stream ORCA reads), then closes its streams. A run that ended normally is left as it is. Completion (`exit`, with its code) is never taken from the output.
 */
function runInHookShell(opts: {
  shell: { program: string; args: string[] };
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string | undefined;
  stderrLimit: number;
  signal: AbortSignal;
}): Promise<HookShellRun> {
  return new Promise((resolve) => {
    let stderr = "";
    if (opts.signal.aborted) {
      resolve({ ended: "aborted", stderr, reason: opts.signal.reason });
      return;
    }
    let settled = false;
    let exited = false;
    const child = spawn(opts.shell.program, [...opts.shell.args, opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"],
      // The leader of a process group of its own, which only ORCA's own signals address.
      detached: true,
    });
    let streamOpen = true;
    child.on("exit", () => (exited = true));
    child.stderr?.on("close", () => (streamOpen = false));
    const stop = () => {
      // Nothing ORCA started is left: a normal end needs no cleanup.
      if (exited && !streamOpen) return;
      const pid = child.pid;
      if (!exited) child.kill("SIGTERM");
      const grace = setTimeout(() => {
        // The group is ORCA's: its leader has not been reaped, or a member still holds the
        // stream ORCA reads, so the group still exists and its id cannot have been reused.
        if (pid !== undefined && (!exited || streamOpen))
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        child.stdin?.destroy();
        child.stderr?.destroy();
      }, HOOK_SHELL_STOP_GRACE_MS);
      grace.unref();
    };
    const settle = (run: HookShellRun, stopping: boolean) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener("abort", onAbort);
      if (stopping) stop();
      resolve(run);
    };
    const onAbort = () => settle({ ended: "aborted", stderr, reason: opts.signal.reason }, true);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (Buffer.byteLength(stderr, "utf8") > opts.stderrLimit) settle({ ended: "overflow", stderr }, true);
    });
    child.stderr?.on("error", () => undefined);
    child.on("error", (e: NodeJS.ErrnoException) =>
      settle({ ended: "spawn-error", code: errnoCode(e.code), stderr }, false),
    );
    child.on("close", (code, signal) => settle({ ended: "exit", code, signal, stderr }, false));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.stdin);
  });
}

/** One deadline for the whole of a Codex session's admission checks, in milliseconds. */
export const CODEX_ADMISSION_DEADLINE_MS = 45_000;

/** Why an admission check stopped early: its deadline, or the session's own cancellation. */
const abortedBy = (reason: unknown, deadline: AbortSignal | undefined): "timeout" | "cancelled" =>
  reason instanceof DOMException && reason.name === "TimeoutError" && deadline !== undefined ? "timeout" : "cancelled";

/**
 * Programs that fail in the ways the line must block, for `checkCodexFailClosedLine`: each a
 * Node one-liner run by the same runtime as ORCA's hook.
 */
const FAIL_CLOSED_CHECKS: readonly { name: string; code: string }[] = [
  { name: "crash", code: 'process.stderr.write("TypeError: x\\n");process.exit(1)' },
  { name: "quiet exit 2", code: "process.exit(2)" },
  { name: "exit 0 with output", code: 'process.stdout.write("{}\\n")' },
  { name: "a block in another form", code: 'process.stderr.write("Denied by ORCA: x\\nmore\\n");process.exit(2)' },
  { name: "output past the limit", code: `process.stdout.write("x".repeat(${2 * CODEX_HOOK_OUTPUT_LIMIT}))` },
];

/**
 * Check at admission that the fail-closed line blocks on this install (#1026): run it, as
 * Codex would (`codexHookShell`, in the session's directory), around programs that crash,
 * exit 2 quietly, answer allow with output, answer a block in another form and overflow the
 * limit, and require each run to end with exit 2 and exactly `CODEX_HOOK_FAILED_REASON` on
 * stderr. A shell, `mktemp`, `timeout`, `head` or `wc` that does not behave as the line needs
 * fails here, and the session is refused, rather than letting a later failure of ORCA's
 * program through. The startup probe (`probeCodexHook`) checks the other half: that ORCA's
 * own block passes through the line.
 *
 * The checks run one at a time under `signal`, the admission's single deadline joined with
 * the session's cancellation: when it aborts, the running check is stopped with its process
 * group and nothing further starts.
 */
export async function checkCodexFailClosedLine(opts: {
  runtime: string;
  cwd: string;
  shell: { program: string; args: string[] };
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ ok: true } | { ok: false; check: string; detail: string }> {
  const expected = `${CODEX_HOOK_FAILED_REASON}\n`;
  const signal = opts.signal ?? AbortSignal.timeout(CODEX_ADMISSION_DEADLINE_MS);
  for (const check of FAIL_CLOSED_CHECKS) {
    const run = await runInHookShell({
      shell: opts.shell,
      command: codexFailClosedLine([opts.runtime, "-e", check.code].map(shellWord).join(" ")),
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdin: undefined,
      stderrLimit: Buffer.byteLength(expected),
      signal,
    });
    const detail = ((): string | undefined => {
      switch (run.ended) {
        case "aborted":
          return abortedBy(run.reason, signal) === "timeout"
            ? "the admission deadline passed"
            : "the session was cancelled";
        case "spawn-error":
          return `the shell could not be started (${run.code})`;
        case "overflow":
          return "more on stderr than the line's reason";
        case "exit":
          if (run.signal !== null) return `killed by ${run.signal}`;
          if (run.code !== 2) return `exit ${run.code}`;
          return run.stderr === expected ? undefined : "another reason than the line's own";
      }
    })();
    if (detail !== undefined) return { ok: false, check: check.name, detail };
  }
  return { ok: true };
}

/** Sorted keys, as `serde_json`'s `sort_all_objects` leaves them. */
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

/**
 * The hash Codex 0.171 trusts a `PreToolUse` command hook by (`hook_hash` in
 * `codex-rs/hooks/src/engine/discovery.rs`, `version_for_toml` in `codex-rs/config`): SHA-256
 * of the hook's normalized identity as JSON with sorted keys. ORCA checks after `initialize`
 * that Codex agrees, so a Codex that hashes differently is refused, not trusted blindly.
 */
export function codexHookTrustHash(command: string, timeoutSeconds: number): string {
  const identity = {
    event_name: "pre_tool_use",
    matcher: "*",
    hooks: [{ type: "command", command, timeout: timeoutSeconds, async: false }],
  };
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortKeys(identity)))
    .digest("hex")}`;
}

/** The key Codex lists a session-flag hook under: its source, event, group and handler. */
export const CODEX_HOOK_KEY = "/<session-flags>/config.toml:pre_tool_use:0:0";

/**
 * `CODEX_CONFIG` with ORCA's hook in it, trusted, beside whatever the agent's own
 * `CODEX_CONFIG` set, and Codex's hosted web search turned off (it runs at the model
 * provider, so no hook sees it). Undefined when the agent's own already sets hooks: ORCA's
 * would not be the one Codex lists first, and ORCA does not reorder somebody else's.
 */
export function codexHookConfig(base: string | undefined, command: string): string | undefined {
  let config: Record<string, unknown> = {};
  if (base !== undefined && base !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(base);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || "hooks" in parsed) return undefined;
    config = parsed as Record<string, unknown>;
  }
  return JSON.stringify({
    ...config,
    // Codex's web search runs at the model provider, where no hook sees it, so it is off.
    web_search: "disabled",
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: CODEX_PRE_TOOL_TIMEOUT_SECONDS }] }],
      state: { [CODEX_HOOK_KEY]: { trusted_hash: codexHookTrustHash(command, CODEX_PRE_TOOL_TIMEOUT_SECONDS) } },
    },
  });
}

/** What the Codex adapter's `_codex/hooks/list` says about one hook (the fields ORCA reads). */
interface CodexListedHook {
  key?: unknown;
  eventName?: unknown;
  command?: unknown;
  matcher?: unknown;
  enabled?: unknown;
  trustStatus?: unknown;
  currentHash?: unknown;
}

/** Why Codex's list does not show ORCA's hook in force, or undefined when it does. */
export function codexHookListProblem(listed: unknown, command: string): string | undefined {
  const hooks = (listed as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(hooks)) return "the adapter did not list its hooks";
  const ours = (hooks as CodexListedHook[]).filter((h) => h.key === CODEX_HOOK_KEY);
  if (ours.length !== 1) return "Codex does not list ORCA's hook";
  const h = ours[0]!;
  if (h.eventName !== "preToolUse" || h.command !== command || h.matcher !== "*")
    return "Codex lists a different hook where ORCA's should be";
  if (h.enabled !== true) return "Codex lists ORCA's hook as turned off";
  if (h.trustStatus !== "trusted")
    return `Codex does not trust ORCA's hook (it reports ${String(h.trustStatus)}, hash ${String(h.currentHash)})`;
  return undefined;
}

/** The most stderr the probe reads; a hook that says more than this has not answered it. */
const PROBE_STDERR_LIMIT = 16 * 1024;

export interface CodexProbeDiagnostics {
  /** How the probe ended; only `blocked` lets the session open. */
  outcome: "blocked" | "timeout" | "cancelled" | "overflow" | "spawn-error" | "signal" | "exit" | "no-receipt";
  /** The shell the command ran in. */
  shell: string;
  exitCode?: number | null;
  signal?: string;
  /** How much the command wrote on stderr, in bytes, up to the probe's bound. */
  stderrBytes: number;
  /** Whether stderr carried a receipt line, and whether it was the one for this call. */
  receipt: "matched" | "mismatched" | "absent";
  elapsedMs: number;
}

/** An errno name as Node reports it (`ENOENT`), or `unknown`: never free text. */
function errnoCode(code: unknown): string {
  return typeof code === "string" && /^E[A-Z0-9]{1,15}$/.test(code) ? code : "unknown";
}

/** A receipt-shaped line, whoever wrote it. */
const RECEIPT_LINE = /^orca-hook-receipt:/;

/**
 * Run the hook's command line the way Codex does (`codexHookShell`, in the session's directory)
 * on a call that ORCA's own protected paths must block, and say whether ORCA's hook blocked
 * it. An exit status alone is not taken as proof: a profile, an alias or another program on
 * the shell's path can exit 2 too. The probe's frame carries a fresh nonce, and the session
 * counts as guarded only if the command exits 2 and its stderr, read up to a fixed bound
 * within the hook's timeout, carries the receipt line the hook signs with the context's
 * `probeKey` for that nonce (`codexProbeReceipt`). A matching receipt proves that whatever
 * the command ran could read this session's context file and answered this very call with a
 * block in ORCA's format, which is what ORCA's hook does. It is not proof of which program
 * that was: another process under the same OS account could read the file too. What it rules
 * out is a shell, profile or program that exits 2 without having made ORCA's decision. A
 * shell or runtime that cannot run the hook fails here instead of letting calls through.
 *
 * The deadline bounds the caller, not only the shell: when it passes, the probe settles as a
 * refusal at once, kills the command's whole process group and closes its streams, so a
 * descendant still holding a descriptor cannot keep the session's startup waiting.
 */
export async function probeCodexHook(opts: {
  command: string;
  cwd: string;
  contextFile: string;
  /** The `probeKey` written into the context file the command names. */
  probeKey: string;
  /** The shell to run it in, as Codex would (`codexHookShell`). */
  shell: { program: string; args: string[] };
  env?: NodeJS.ProcessEnv | undefined;
  /** Its own deadline; by default Codex's hook timeout, when no `signal` is given. */
  timeoutMs?: number | undefined;
  /** Stops the probe (the admission's deadline joined with the session's cancellation). */
  signal?: AbortSignal | undefined;
}): Promise<{ blocked: boolean; detail: string; diagnostics: CodexProbeDiagnostics }> {
  const env = opts.env ?? process.env;
  const shell = opts.shell.program;
  const nonce = randomBytes(16).toString("hex");
  const toolUseId = `orca-hook-probe:${nonce}`;
  if (!CODEX_PROBE_TOOL_USE_ID.test(toolUseId)) throw new Error("probe id does not match the hook's pattern");
  const frame = JSON.stringify({
    session_id: "orca-hook-probe",
    hook_event_name: "PreToolUse",
    tool_name: "view_image",
    // The context file sits under ORCA's private store, which no rule opens to an agent.
    tool_input: { path: opts.contextFile },
    tool_use_id: toolUseId,
    cwd: opts.cwd,
  });
  const expected = Buffer.from(codexProbeReceipt(opts.probeKey, nonce), "utf8");
  const receipt = (stderr: string): CodexProbeDiagnostics["receipt"] => {
    const lines = stderr.split("\n");
    const matched = lines.some((line) => {
      const got = Buffer.from(line, "utf8");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
    return matched ? "matched" : lines.some((line) => RECEIPT_LINE.test(line)) ? "mismatched" : "absent";
  };
  const started = Date.now();
  // Its own deadline unless the caller gives one; the caller's signal stops it either way.
  const deadline =
    opts.signal === undefined || opts.timeoutMs !== undefined
      ? AbortSignal.timeout(opts.timeoutMs ?? CODEX_PRE_TOOL_TIMEOUT_SECONDS * 1000)
      : undefined;
  const signal = AbortSignal.any([...(deadline ? [deadline] : []), ...(opts.signal ? [opts.signal] : [])]);
  const run = await runInHookShell({
    shell: opts.shell,
    command: opts.command,
    cwd: opts.cwd,
    env,
    stdin: frame,
    stderrLimit: PROBE_STDERR_LIMIT,
    signal,
  });
  const result = (
    outcome: CodexProbeDiagnostics["outcome"],
    detail: string,
    extra: Pick<CodexProbeDiagnostics, "exitCode" | "signal"> = {},
  ) => ({
    blocked: outcome === "blocked",
    detail,
    diagnostics: {
      outcome,
      shell,
      ...extra,
      stderrBytes: Buffer.byteLength(run.stderr, "utf8"),
      receipt: receipt(run.stderr),
      elapsedMs: Date.now() - started,
    },
  });
  // What the command wrote is never quoted: a login shell's profile writes there too, and a
  // refusal is shown and stored. The detail is a fixed phrase per outcome plus bounded numbers.
  // Only a command that ran to its end can block; its output alone never decides.
  switch (run.ended) {
    case "aborted":
      return deadline?.aborted
        ? result(
            "timeout",
            `the hook did not answer within ${opts.timeoutMs ?? CODEX_PRE_TOOL_TIMEOUT_SECONDS * 1000} ms`,
          )
        : abortedBy(run.reason, opts.signal) === "timeout"
          ? result("timeout", "the admission deadline passed")
          : result("cancelled", "the session was cancelled");
    case "overflow":
      return result("overflow", "the hook wrote more than the probe reads");
    case "spawn-error":
      return result("spawn-error", `the shell could not be started (${run.code})`);
    case "exit":
      if (run.signal) return result("signal", `killed by ${run.signal}`, { signal: run.signal });
      if (run.code !== 2) return result("exit", `exit ${run.code}`, { exitCode: run.code });
      if (receipt(run.stderr) !== "matched")
        return result("no-receipt", "exit 2 without ORCA's hook's receipt for this call", { exitCode: run.code });
      return result("blocked", "blocked, with the hook's receipt", { exitCode: run.code });
  }
}

/* ------------------------------------ both ------------------------------------ */

export interface NativeToolHookSessionOptions {
  /**
   * Variables `runtime` needs to run the hook program as a plain Node, given to the agent so
   * the hooks it starts inherit them: `ELECTRON_RUN_AS_NODE=1` when ORCA's runtime is the
   * desktop app's Electron binary. Claude Code runs the hook with no environment of its own.
   */
  runtimeEnv?: Readonly<Record<string, string>> | undefined;
  agentId: string;
  permissions: ConfiguredPermissionPolicy;
  permissionFiles: readonly string[];
  workspaceCwd: string;
  additionalDirectories?: readonly string[] | undefined;
  protectedPaths?: ProtectedPaths | undefined;
  /** A directory only ORCA uses, protected from agents; the context file is written here. */
  contextDir: string;
  /** The runtime and the hook program, both absolute. No program: the session is refused. */
  runtime: string;
  script: string | undefined;
  /** The platform and architecture the agent runs on; `process`'s unless a test says otherwise. */
  platform?: NodeJS.Platform | undefined;
  arch?: string | undefined;
  /** How a process's image is attested; `processImageDigest` unless a test says otherwise. */
  imageDigest?:
    ((pid: number, agentPid: number | undefined) => Promise<{ sha256: string } | { error: string }>) | undefined;
  /** How the Codex process an adapter runs is found; `codexRuntimeProcess` unless a test says otherwise. */
  codexProcess?: ((agentPid: number | undefined) => Promise<{ pid: number } | { error: string }>) | undefined;
  /** The shell Codex runs hooks in; `codexHookShell` unless a test says otherwise. */
  codexShell?: (() => { program: string; args: string[] } | { error: string }) | undefined;
  /**
   * The run's cancellation. A Codex session's admission checks stop when it aborts, and the
   * open fails with `CANCELLED`.
   */
  signal?: AbortSignal | undefined;
  /** The single deadline for a Codex session's admission checks; `CODEX_ADMISSION_DEADLINE_MS` by default. */
  codexAdmissionDeadlineMs?: number | undefined;
  /** The environment Codex runs hooks in; `codexHookEnvironment` unless a test says otherwise. */
  codexEnvironment?: ((pid: number) => Promise<NodeJS.ProcessEnv | { error: string }>) | undefined;
  /**
   * The environment the agent is spawned with (the daemon's, then the agent's own), which
   * the Codex hook's `CODEX_CONFIG` builds on and its probe runs in.
   */
  agentEnv: NodeJS.ProcessEnv;
  /**
   * Whether the hook records each call it answers (#1000): `keep` makes a telemetry spool
   * beside the context file and gives the hook its path. Off unless the agent keeps it.
   */
  toolCallTelemetry?: "off" | "keep" | undefined;
}

export type NativeToolHookStatus = "pending" | "claude" | "claude-verified" | "codex";

/** A process's parent and start time, from `/proc/<pid>/stat` (Linux). */
async function procStat(pid: number): Promise<{ ppid: number; start: string } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After the name: state, ppid, ...; starttime is field 22 overall, 20 here.
    return { ppid: Number(fields[1]), start: fields[19]! };
  } catch {
    return undefined;
  }
}

/** Reads `/proc` (Linux): each process's parent and argument list. */
async function processTable(): Promise<Map<number, { ppid: number; argv: string[] }>> {
  const table = new Map<number, { ppid: number; argv: string[] }>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const argv = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0").filter((a) => a !== "");
      table.set(Number(name), { ppid, argv });
    } catch {
      // Gone, or not ours to read.
    }
  }
  return table;
}

/**
 * ORCA's own evidence for the image a process runs (Linux): the process must be a live
 * descendant of `agentPid`, the agent process ORCA started, and the same process (same start
 * time) before and after its image is read; the digest is of `/proc/<pid>/exe`, which opens
 * the file the kernel is running for it, wherever that is now and whatever is at its old
 * path. Nothing is executed.
 */
export async function processImageDigest(
  pid: number,
  agentPid: number | undefined,
): Promise<{ sha256: string } | { error: string }> {
  if (agentPid === undefined) return { error: "the agent's process id is unknown" };
  if (!Number.isInteger(pid) || pid <= 1 || pid === agentPid) return { error: `process ${pid} is not the runtime` };
  const lineage = async (): Promise<string | undefined> => {
    const self = await procStat(pid);
    if (!self) return undefined;
    for (let p = self.ppid, hops = 0; p > 1 && hops < 64; hops++) {
      if (p === agentPid) return self.start;
      const up = await procStat(p);
      if (!up) return undefined;
      p = up.ppid;
    }
    return undefined;
  };
  const before = await lineage();
  if (before === undefined) return { error: `process ${pid} is not running under the agent ORCA started` };
  let sha256: string;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(`/proc/${pid}/exe`)) hash.update(chunk as Buffer);
    sha256 = hash.digest("hex");
  } catch (error) {
    return { error: `its image cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if ((await lineage()) !== before) return { error: `process ${pid} changed while its image was read` };
  return { sha256 };
}

export interface NativeToolHookSession {
  /** Write the context file and build the agent's extra environment. Call once, before spawning. */
  prepare: () => Promise<{ env: Record<string, string> }>;
  /** For `OpenSessionOptions.sessionMeta`. Throws (refusing the session) unless the hook is in force. */
  sessionMeta: (
    agentInfo: { name: string; version: string } | undefined,
    ext: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    agentPid: number | undefined,
    /** The session's cancellation; a Codex admission stops its checks when it aborts. */
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown> | undefined>;
  /** Which agent took the hook, and whether its runtime has been attested. */
  status: () => NativeToolHookStatus;
  /**
   * Check, once the session has started and before it is given work, that the runtime it runs
   * is the image pinned for the adapter's version. Claude only: Codex's runtime is attested in
   * `sessionMeta`, before the session is created, so this does nothing there. Throws (refusing
   * the session) when the runtime did not report itself, is not under the agent ORCA started,
   * or runs another image.
   */
  verifyRuntime: () => Promise<void>;
  /**
   * The session's telemetry spool (#1000), once `prepare` has made one: only with
   * `toolCallTelemetry: keep`. The session factory hands it to the session as `hookTelemetry`.
   */
  telemetry: () => HookTelemetrySpool | undefined;
  /**
   * Remove the context file and the runtime record, if written, after the telemetry spool's
   * last drain. Safe to call more than once.
   */
  cleanup: () => Promise<void>;
}

/** The hook, ready to be installed in one opted-in session. */
export function nativeToolHookSession(opts: NativeToolHookSessionOptions): NativeToolHookSession {
  let status: NativeToolHookStatus = "pending";
  let file: string | undefined;
  let adapterVersion: string | undefined;
  let agentProcess: number | undefined;
  let codexCommand: string | undefined;
  /** The key the hook signs its probe receipt with; written into the context file only. */
  let probeKey: string | undefined;
  let codexEnv: string | undefined;
  let spool: HookTelemetrySpool | undefined;
  /** The pinned image for one adapter version, and the digest of what a process really runs. */
  const attest = async (
    pairs: readonly { adapter: string; runtime: string; images: Readonly<Record<string, string>> }[],
    adapter: string,
    pid: number,
    agent: string,
  ) => {
    const pair = pairs.find((p) => p.adapter === adapter);
    const pinned = pair?.images[target()];
    if (!pair || pinned === undefined)
      throw refuse(`ORCA has no verified ${agent} image for adapter ${adapter} on ${target()}`);
    const image = await (opts.imageDigest ?? processImageDigest)(pid, agentProcess);
    if ("error" in image) throw refuse(`ORCA could not attest the ${agent} the session runs (${image.error})`, { pid });
    if (image.sha256 !== pinned)
      throw refuse(
        `the ${agent} the session runs is not the one ORCA verified with adapter ${adapter} (${agent} ${pair.runtime}, image ${pinned.slice(0, 12)}…, not ${image.sha256.slice(0, 12)}…)`,
        { adapter, image: image.sha256, pinned },
      );
  };
  const target = () => `${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`;
  const refuse = (why: string, details: Record<string, unknown> = {}) =>
    new OrcaError(
      "NOT_SUPPORTED",
      `agent ${opts.agentId} has nativeToolHook: experimental, but ${why}, so ORCA cannot check its tool calls. ` +
        `ORCA refuses the session rather than run it unguarded; remove nativeToolHook to run it without the hook.`,
      { agentId: opts.agentId, ...details },
    );
  const verified = (
    agentInfo: { name: string; version: string },
    versions: readonly string[],
    platforms: readonly NodeJS.Platform[],
    platform: NodeJS.Platform,
  ) => {
    if (!versions.includes(agentInfo.version))
      throw refuse(
        `it runs ${agentInfo.name} ${agentInfo.version}, and ORCA has verified the hook only with ${versions.join(", ")}`,
        { adapter: agentInfo.name, version: agentInfo.version, verified: [...versions] },
      );
    if (!platforms.includes(platform))
      throw refuse(
        `ORCA has verified the hook with ${agentInfo.name} only on ${platforms.join(", ")}, not ${platform}`,
        {
          platform,
        },
      );
  };
  return {
    status: () => status,
    telemetry: () => spool,
    cleanup: async () => {
      // The hook writes nothing once the agent is gone; the last lines are read before the
      // context goes. `finish` never throws and is idempotent.
      if (spool !== undefined) await spool.finish();
      if (file === undefined) return;
      const f = file;
      file = undefined;
      await rm(f, { force: true });
      await rm(claudeRuntimeAttestationFile(f), { force: true });
    },
    verifyRuntime: async () => {
      if (status === "codex") return;
      if (status !== "claude" || file === undefined || adapterVersion === undefined)
        throw refuse("the hook was not installed in the session");
      let attestation: Partial<ClaudeRuntimeAttestation>;
      try {
        attestation = JSON.parse(
          await readFile(claudeRuntimeAttestationFile(file), "utf8"),
        ) as Partial<ClaudeRuntimeAttestation>;
      } catch {
        throw refuse("the Claude Code runtime did not report itself when the session started");
      }
      if (attestation.version !== 1 || typeof attestation.pid !== "number")
        throw refuse("the Claude Code runtime's report is unreadable");
      await attest(CLAUDE_HOOK_VERIFIED_PAIRS, adapterVersion, attestation.pid, "Claude Code");
      status = "claude-verified";
    },
    prepare: async () => {
      if (opts.script === undefined) throw refuse("ORCA's hook program is missing from this build");
      probeKey = randomBytes(32).toString("hex");
      const context: ClaudeHookContext = {
        version: 1,
        agentId: opts.agentId,
        permissions: opts.permissions,
        permissionFiles: [...opts.permissionFiles],
        workspaceCwd: opts.workspaceCwd,
        ...(opts.additionalDirectories?.length ? { additionalDirectories: [...opts.additionalDirectories] } : {}),
        // The hook program is read-only to the agent's native tools too, beside ORCA's own files.
        protectedPaths: {
          readOnly: [...(opts.protectedPaths?.readOnly ?? []), opts.script],
          noAccess: [...(opts.protectedPaths?.noAccess ?? [])],
          ...(opts.protectedPaths?.agentAreas ? { agentAreas: [...opts.protectedPaths.agentAreas] } : {}),
        },
        // Signs the hook's receipt for the startup probe of a Codex session.
        probeKey,
      };
      await mkdir(opts.contextDir, { recursive: true, mode: 0o700 });
      if (opts.toolCallTelemetry === "keep") {
        // Beside the context, in ORCA's agent-denied directory; refused (and the session with
        // it) when that directory is not one.
        spool = await openHookTelemetrySpool({
          dir: opts.contextDir,
          protectedPaths: { readOnly: [], noAccess: [...(opts.protectedPaths?.noAccess ?? [])] },
        });
        context.telemetry = spool.target;
      }
      file = join(opts.contextDir, `${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(context), { encoding: "utf8", mode: 0o600, flag: "wx" });
      codexCommand = codexPreToolHookCommand(opts.runtime, opts.script, file);
      codexEnv = codexHookConfig(opts.agentEnv["CODEX_CONFIG"], codexCommand);
      return { env: { ...(opts.runtimeEnv ?? {}), ...(codexEnv === undefined ? {} : { CODEX_CONFIG: codexEnv }) } };
    },
    sessionMeta: async (agentInfo, ext, agentPid, cancelled) => {
      if (file === undefined || opts.script === undefined || codexCommand === undefined || probeKey === undefined)
        throw refuse("the hook was not prepared before the agent started");
      const key = probeKey;
      if (!agentInfo) throw refuse("the agent did not say at initialize which adapter it is");
      agentProcess = agentPid;
      const platform = opts.platform ?? process.platform;

      if (CLAUDE_ADAPTER_NAMES.includes(agentInfo.name)) {
        verified(agentInfo, CLAUDE_HOOK_VERIFIED_ADAPTERS, CLAUDE_HOOK_VERIFIED_PLATFORMS, platform);
        // The image is pinned per architecture; one the acceptance run does not cover is refused.
        if (CLAUDE_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === agentInfo.version)?.images[target()] === undefined)
          throw refuse(`ORCA has no verified Claude Code image for ${target()}`, { platform: target() });
        status = "claude";
        adapterVersion = agentInfo.version;
        return {
          claudeCode: {
            options: {
              settings: claudePreToolHookSettings({
                command: opts.runtime,
                args: [opts.script, file],
                attestArgs: [opts.script, "--attest", file],
                timeoutSeconds: CLAUDE_PRE_TOOL_TIMEOUT_SECONDS,
              }),
            },
          },
        };
      }

      if (CODEX_ADAPTER_NAMES.includes(agentInfo.name)) {
        verified(agentInfo, CODEX_HOOK_VERIFIED_ADAPTERS, CODEX_HOOK_VERIFIED_PLATFORMS, platform);
        if (CODEX_HOOK_VERIFIED_PAIRS.find((p) => p.adapter === agentInfo.version)?.images[target()] === undefined)
          throw refuse(`ORCA has no verified Codex image for ${target()}`, { platform: target() });
        if (codexEnv === undefined)
          throw refuse(
            "the agent's own CODEX_CONFIG already sets hooks, or is not a JSON object, so ORCA cannot add its own",
          );
        // One deadline for every check below, joined with the run's cancellation and the
        // session's own end: when any fires, the step running is stopped and nothing further
        // starts.
        const deadline = AbortSignal.timeout(opts.codexAdmissionDeadlineMs ?? CODEX_ADMISSION_DEADLINE_MS);
        const admission = AbortSignal.any([
          deadline,
          ...(cancelled ? [cancelled] : []),
          ...(opts.signal ? [opts.signal] : []),
        ]);
        const stopped = async <T>(step: Promise<T>): Promise<T> => {
          let onAbort = () => undefined as void;
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () =>
              reject(
                opts.signal?.aborted
                  ? new OrcaError("CANCELLED", "the run was cancelled while ORCA checked the agent's hook", {
                      agentId: opts.agentId,
                    })
                  : refuse(
                      deadline.aborted
                        ? "ORCA's startup checks of the hook did not finish within their deadline"
                        : "the session ended before ORCA's startup checks of the hook finished",
                      { admission: deadline.aborted ? "timeout" : "cancelled" },
                    ),
              );
            if (admission.aborted) onAbort();
            else admission.addEventListener("abort", onAbort, { once: true });
          });
          try {
            return await Promise.race([step, aborted]);
          } finally {
            admission.removeEventListener("abort", onAbort);
          }
        };
        let listed: unknown;
        try {
          listed = await stopped(ext("_codex/hooks/list", { cwd: opts.workspaceCwd }));
        } catch (error) {
          if (admission.aborted) throw error;
          throw refuse(
            `the adapter could not list its hooks (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        const problem = codexHookListProblem(listed, codexCommand);
        if (problem !== undefined) throw refuse(problem);
        // The adapter has started Codex by now (it answered from it); attest that process.
        const found = await stopped((opts.codexProcess ?? codexRuntimeProcess)(agentPid));
        if ("error" in found) throw refuse(`ORCA could not tell which Codex the adapter runs (${found.error})`);
        await stopped(attest(CODEX_HOOK_VERIFIED_PAIRS, agentInfo.version, found.pid, "Codex"));
        // The probe runs in the environment Codex itself will give the hook, not in a copy of
        // what ORCA meant to give the agent.
        const env = await stopped((opts.codexEnvironment ?? codexHookEnvironment)(found.pid));
        if ("error" in env) throw refuse(`ORCA could not run its startup check as Codex runs the hook: ${env.error}`);
        const shell = (opts.codexShell ?? codexHookShell)();
        if ("error" in shell)
          throw refuse(`ORCA could not run its startup check as Codex runs the hook: ${shell.error}`);
        const line = await stopped(
          checkCodexFailClosedLine({ runtime: opts.runtime, cwd: opts.workspaceCwd, shell, env, signal: admission }),
        );
        if (!line.ok)
          throw refuse(
            `the fail-closed line around the hook does not block on this install (${line.check}: ${line.detail})`,
            { failClosedCheck: line.check },
          );
        const probe = await stopped(
          probeCodexHook({
            command: codexCommand,
            cwd: opts.workspaceCwd,
            contextFile: file,
            probeKey: key,
            shell,
            env,
            signal: admission,
          }),
        );
        if (!probe.blocked)
          throw refuse(`the hook did not block a call it must block when run as Codex runs it (${probe.detail})`, {
            probe: probe.diagnostics,
          });
        status = "codex";
        adapterVersion = agentInfo.version;
        return undefined;
      }

      throw refuse(`it runs ${agentInfo.name}, which does not take ORCA's hook`, { adapter: agentInfo.name });
    },
  };
}
