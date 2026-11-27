/**
 * Claude Code on an SSH host through the Claude Agent SDK (#1130).
 *
 * The SDK and ORCA's permission bridge stay in the daemon; only `claude` runs on the other
 * machine, started over the host's own SSH configuration (identity file, port, login shell) the
 * way the ACP route starts an agent there, with the SDK's stream-json on the connection's stdin
 * and stdout. It runs as the person's own login on that machine, with the Claude Code and
 * sign-in found there. ORCA reads no credentials there and offers no login: an unauthenticated
 * `claude` is refused with `claude auth login` guidance that names the host.
 *
 * **No value in an argument list.** The remote command line holds names, the directory, the
 * command and its arguments, never an environment value: ORCA writes each value to the
 * connection's stdin first (`NAME base64`, then an end line), and the remote shell reads and
 * exports them with builtins (`read`, `export`; `base64 -d` reads its input from a pipe)
 * before `claude` starts and is handed the rest of stdin. So a value appears in no process's
 * arguments on either machine, and in no error or log ORCA writes.
 *
 * **The remote side owns the process.** The remote shell starts `claude` in a process group of
 * its own (`setsid`, or job control where there is none), records the group under a token
 * unique to this launch (`$HOME/.cache/orca/claude-sdk/<token>.pid`), waits for it, and kills
 * the whole group when `claude` exits, so nothing it started stays. ORCA's stop
 * (`ClaudeSdkRemoteLaunch.stop`) is a second SSH connection that kills that group and checks it
 * is gone; it runs after every session ends, however it ends, and its tombstone
 * (`<token>.stop`) keeps a launch it overtook from starting `claude` at all. A process that
 * leaves the group (a new session of its own) is not followed, as on ORCA's own machine.
 *
 * What does not hold on that machine yet, and so is refused or left out:
 * - The pre-tool hook's qualification (`nativeToolHook: experimental`) is refused on any
 *   non-local host by the session factory, as on the ACP route: the image there is not attested.
 * - Secret references are read only on ORCA's own machine (`claudeSdkSecrets`), so an agent
 *   with one is refused on an SSH host.
 * - The bridge cannot check a call's directory on that machine, so no rule allows a call that
 *   runs there: each is a person's to allow (`remoteWorkspace` in the bridge), and deny rules
 *   and protected paths apply as everywhere.
 *
 * The environment handed to `claude` is only what the session sets (the agent's own `env`,
 * what ORCA adds, and the SDK's own variables), on top of the remote login shell's. None of the
 * daemon's environment crosses. Withheld names are unset there before `claude` starts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CLAUDE_SDK_DEFAULT_COMMAND, isSecretRef, OrcaError, type AgentSpec } from "@orca/core";
import { shellQuote } from "../host.js";
import type { SshHost } from "../hosts/ssh-host.js";
import {
  CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS,
  isClaudeCredentialVariable,
  probeClaude,
  runBounded,
  type BoundedResult,
  type ClaudeSdkPreflight,
} from "./launch.js";

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN = /^[0-9a-f]{32}$/;
/** The line that ends the environment ORCA writes to stdin before `claude` starts. */
export const CLAUDE_SDK_REMOTE_ENV_END = "ORCA-CLAUDE-SDK-ENV-END";
/** Where the remote shell records each launch's process group, under the remote `$HOME`. */
const STATE_DIR = '"$HOME/.cache/orca/claude-sdk"';
/** How long the stop's own SSH connection may take beyond the host's connect timeout. */
const STOP_MARGIN_MS = 10_000;

export interface ClaudeSdkSshPreflightOptions {
  host: SshHost;
  agent: Pick<AgentSpec, "id" | "command" | "env">;
  /** The working directory on that machine. */
  cwd: string;
  /** What ORCA adds to the session's environment. */
  orcaEnv?: Readonly<Record<string, string>>;
  /** Names unset on that machine before `claude` runs. */
  withheldEnv?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

/**
 * The remote session's environment: the agent's literal `env` and what ORCA adds, without
 * Claude credential variables ORCA itself would carry (a person's own `env` keeps theirs) and
 * without the withheld names.
 */
export function claudeSdkRemoteEnvironment(
  agent: Pick<AgentSpec, "id" | "env">,
  orcaEnv: Readonly<Record<string, string>> = {},
  withheld: readonly string[] = [],
): Record<string, string> {
  const unset = new Set(withheld.map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(orcaEnv))
    if (!isClaudeCredentialVariable(k) && !unset.has(k.toUpperCase())) env[k] = v;
  for (const [k, v] of Object.entries(agent.env)) {
    if (isSecretRef(v) || typeof v !== "string")
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agent.id} takes ${k} from a secret reference; with driver: claude-agent-sdk secrets are read only on ORCA's own machine.`,
        { agentId: agent.id, variable: k },
      );
    env[k] = v;
  }
  return env;
}

function checkNames(agentId: string, hostId: string, names: readonly string[]): void {
  for (const name of names)
    if (!VARIABLE.test(name))
      throw new OrcaError(
        "CONFIG_INVALID",
        `agent ${agentId}: environment variable name '${name}' cannot be set on host '${hostId}'`,
        { agentId, hostId },
      );
}

/**
 * What ORCA writes to stdin before anything else: one `NAME base64(value)` line per variable,
 * then the end line. The remote shell reads exactly this much and leaves the rest for `claude`.
 */
export function claudeSdkRemoteEnvInput(env: Readonly<Record<string, string>>): string {
  const lines = Object.entries(env).map(([k, v]) => `${k} ${Buffer.from(v, "utf8").toString("base64")}\n`);
  return `${lines.join("")}${CLAUDE_SDK_REMOTE_ENV_END}\n`;
}

/** A fresh launch token: names this launch's state files on the host. */
export function claudeSdkRemoteToken(): string {
  return randomBytes(16).toString("hex");
}

function checkToken(token: string): void {
  if (!TOKEN.test(token)) throw new OrcaError("INTERNAL", "a remote launch token must be 32 lowercase hex digits");
}

/**
 * The remote shell script that starts `command` in `cwd`: `withheld` unset, the variables
 * `names` read from stdin (`claudeSdkRemoteEnvInput`) and exported, `claude` started in a
 * process group of its own, recorded under `token`, waited for, and its whole group killed when
 * it exits. Exits 127 when `command` is not found there. Names are checked, the rest quoted;
 * no value is in it.
 */
export function claudeSdkRemoteScript(o: {
  agentId: string;
  hostId: string;
  command: string;
  args: readonly string[];
  cwd: string;
  /** The names `claudeSdkRemoteEnvInput` carries; only these are accepted from stdin. */
  names: readonly string[];
  withheld?: readonly string[] | undefined;
  token: string;
}): string {
  checkNames(o.agentId, o.hostId, [...o.names, ...(o.withheld ?? [])]);
  checkToken(o.token);
  const accepted = o.names.length ? o.names.join("|") : "''";
  const command = shellQuote(o.command);
  const run = `${command} ${o.args.map(shellQuote).join(" ")}`.trim();
  return [
    ...(o.withheld ?? []).map((name) => `unset ${name} || exit 125`),
    // The environment, from stdin, with builtins only; any other name or a bad line ends it.
    `orca_env() {`,
    `  while IFS= read -r orca_l; do`,
    `    [ "$orca_l" = ${CLAUDE_SDK_REMOTE_ENV_END} ] && return 0`,
    `    orca_n=\${orca_l%% *}`,
    `    case $orca_n in ${accepted}) ;; *) return 1 ;; esac`,
    `    orca_v=$(printf '%s' "\${orca_l#* }" | base64 -d && printf x) || return 1`,
    `    export "$orca_n=\${orca_v%x}" || return 1`,
    `  done`,
    `  return 1`,
    `}`,
    `orca_env || exit 125`,
    `unset -f orca_env; unset orca_l orca_n orca_v`,
    `cd ${shellQuote(o.cwd)} || exit 125`,
    `command -v ${command} >/dev/null 2>&1 || exit 127`,
    `orca_d=${STATE_DIR}`,
    `(umask 077 && mkdir -p "$orca_d") || exit 125`,
    `find "$orca_d" -name '*.stop' -mmin +1440 -exec rm -f {} + 2>/dev/null`,
    `orca_f="$orca_d/${o.token}.pid"`,
    `orca_t="$orca_d/${o.token}.stop"`,
    // Starting, then a stop that came first: nothing may run.
    `printf 'starting\\n' > "$orca_f" || exit 125`,
    `if [ -e "$orca_t" ]; then rm -f "$orca_f" "$orca_t"; exit 137; fi`,
    // Its own process group: setsid where there is one, job control otherwise. stdin goes
    // through fd 3: an asynchronous command's own stdin is /dev/null without job control.
    `exec 3<&0`,
    `if command -v setsid >/dev/null 2>&1; then setsid ${run} <&3 3<&- & else set -m; ${run} <&3 3<&- & fi`,
    `orca_p=$!`,
    `exec 3<&-`,
    // The group must exist before it is recorded: otherwise a stop could not reach what it starts.
    `orca_i=0`,
    `while kill -0 "$orca_p" 2>/dev/null && ! kill -0 -"$orca_p" 2>/dev/null; do`,
    `  orca_i=$((orca_i + 1))`,
    `  if [ "$orca_i" -gt 50 ]; then kill -9 "$orca_p" 2>/dev/null; rm -f "$orca_f"; exit 125; fi`,
    `  sleep 0.1`,
    `done`,
    `printf '%s\\n' "$orca_p" > "$orca_f" || { kill -9 -"$orca_p" "$orca_p" 2>/dev/null; exit 125; }`,
    // A stop that came while it started: it ends here too.
    `if [ -e "$orca_t" ]; then kill -9 -"$orca_p" "$orca_p" 2>/dev/null; wait "$orca_p"; rm -f "$orca_f" "$orca_t"; exit 137; fi`,
    `wait "$orca_p"`,
    `orca_s=$?`,
    `kill -9 -"$orca_p" 2>/dev/null`,
    `rm -f "$orca_f"`,
    `exit "$orca_s"`,
  ].join("\n");
}

/**
 * The remote shell script that stops the launch `token`: a tombstone first (so a launch that
 * has not recorded its group yet never starts `claude`), then the recorded group killed and
 * checked gone. Exits 0 once nothing of it runs, 3 on a malformed record, 4 when the group
 * outlives the kill.
 */
export function claudeSdkRemoteStopScript(token: string): string {
  checkToken(token);
  return [
    `orca_d=${STATE_DIR}`,
    `(umask 077 && mkdir -p "$orca_d") || exit 125`,
    `: > "$orca_d/${token}.stop" || exit 125`,
    `orca_f="$orca_d/${token}.pid"`,
    // Gone or never started: nothing runs. Starting: wait for the group it records.
    `orca_i=0`,
    `while :; do`,
    `  [ -f "$orca_f" ] || exit 0`,
    `  orca_p=$(cat "$orca_f" 2>/dev/null)`,
    `  case $orca_p in '' | starting) ;; *[!0-9]*) exit 3 ;; *) break ;; esac`,
    `  orca_i=$((orca_i + 1))`,
    `  [ "$orca_i" -gt 50 ] && exit 4`,
    `  sleep 0.1`,
    `done`,
    `kill -9 -"$orca_p" 2>/dev/null`,
    `orca_i=0`,
    `while kill -0 -"$orca_p" 2>/dev/null; do`,
    `  orca_i=$((orca_i + 1))`,
    `  [ "$orca_i" -gt 50 ] && exit 4`,
    `  sleep 0.1`,
    `done`,
    `rm -f "$orca_f" "$orca_d/${token}.stop"`,
    `exit 0`,
  ].join("\n");
}

/** ssh's own argument list for `script` on `host`: its configuration, then the login shell. */
function sshArgs(host: SshHost, script: string): string[] {
  return [...host.baseArgs(), "--", ...host.remoteCommand(script)];
}

/** ssh itself runs with the daemon's environment (its agent socket, its config); nothing of it is forwarded. */
function sshEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

/** What a stop found: `stopped` once nothing of the launch runs on the host. */
export interface ClaudeSdkRemoteStop {
  stopped: boolean;
  /** Why it could not be confirmed: the stop's own exit, timeout or cancellation. */
  reason?: string | undefined;
}

function stopReason(r: BoundedResult): string | undefined {
  if (r.timedOut) return "the stop did not answer in time";
  if (r.spawnError) return `ssh could not be started (${r.spawnError})`;
  if (r.signal) return `the stop ended on ${r.signal}`;
  if (r.code === 0) return undefined;
  if (r.code === 3) return "the host's record of the process group is malformed";
  if (r.code === 4) return "the process group outlived the kill";
  if (r.code === 255) return "ssh could not reach the host";
  return `the stop exited with ${r.code}`;
}

/** Stop the launch `token` on `host` over a connection of its own, bounded. */
async function stopRemote(host: SshHost, token: string): Promise<ClaudeSdkRemoteStop> {
  const r = await runBounded(host.spec.sshBinary, sshArgs(host, claudeSdkRemoteStopScript(token)), {
    cwd: process.cwd(),
    env: sshEnv(),
    timeoutMs: host.spec.connectTimeoutMs + STOP_MARGIN_MS,
  });
  const reason = stopReason(r);
  return reason ? { stopped: false, reason } : { stopped: true };
}

/**
 * `claudeSdkPreflight` for `claude` on an SSH host: its version and whether it is signed in,
 * asked there over the host's SSH configuration, each probe bounded and, when it did not
 * finish, stopped there. The executable is the agent's `command` as the remote login shell
 * finds it; the environment is the remote one, written to stdin.
 */
export async function claudeSdkSshPreflight(options: ClaudeSdkSshPreflightOptions): Promise<ClaudeSdkPreflight> {
  const { host, agent, cwd } = options;
  const env = claudeSdkRemoteEnvironment(agent, options.orcaEnv, options.withheldEnv);
  const executable = agent.command.length > 0 ? agent.command : CLAUDE_SDK_DEFAULT_COMMAND;
  const timeoutMs = options.timeoutMs ?? CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS;
  const run = async (args: string[]) => {
    const token = claudeSdkRemoteToken();
    const script = claudeSdkRemoteScript({
      agentId: agent.id,
      hostId: host.id,
      command: executable,
      args,
      cwd,
      names: Object.keys(env),
      withheld: options.withheldEnv,
      token,
    });
    const result = await runBounded(host.spec.sshBinary, sshArgs(host, script), {
      cwd: process.cwd(),
      env: sshEnv(),
      timeoutMs,
      signal: options.signal,
      input: claudeSdkRemoteEnvInput(env),
    });
    // A probe cut short may still run there; it is stopped before the preflight answers.
    if (result.timedOut || result.aborted || result.overLimit || result.signal !== null) await stopRemote(host, token);
    return result;
  };
  const place = { where: `on host ${host.id}`, there: `on ${host.id}` };
  return { executable, env, ...(await probeClaude(agent.id, executable, run, place)) };
}

/**
 * How one session on a remote host starts and stops its `claude` (`ClaudeSdkSessionOptions.remote`).
 */
export interface ClaudeSdkRemoteLaunch {
  hostId: string;
  /** Start `claude`; the environment is written to its stdin before the SDK writes anything. */
  spawn: (o: { command: string; args: string[]; cwd: string; env: Record<string, string> }) => ChildProcess;
  /** Kill what this launch started on the host and confirm it is gone. Idempotent. */
  stop: () => Promise<ClaudeSdkRemoteStop>;
}

/**
 * The launch of one session's `claude` on `host`: ssh, in its own process group so a kill
 * reaches it, stdin and stdout piped for stream-json, stderr dropped; the remote side owns the
 * process group (see the module comment), and `stop` ends it there.
 */
export function claudeSdkSshLaunch(
  host: SshHost,
  agentId: string,
  withheld?: readonly string[],
): ClaudeSdkRemoteLaunch {
  const token = claudeSdkRemoteToken();
  let stopping: Promise<ClaudeSdkRemoteStop> | undefined;
  return {
    hostId: host.id,
    spawn: (o) => {
      const script = claudeSdkRemoteScript({
        agentId,
        hostId: host.id,
        command: o.command,
        args: o.args,
        cwd: o.cwd,
        names: Object.keys(o.env),
        withheld,
        token,
      });
      const child = spawn(host.spec.sshBinary, sshArgs(host, script), {
        env: sshEnv(),
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
        windowsHide: true,
      });
      // First on stdin, ahead of anything the SDK writes.
      child.stdin?.write(claudeSdkRemoteEnvInput(o.env));
      return child;
    },
    stop: () => (stopping ??= stopRemote(host, token)),
  };
}
