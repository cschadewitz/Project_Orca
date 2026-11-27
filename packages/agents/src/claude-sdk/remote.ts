/**
 * Claude Code on an SSH host through the Claude Agent SDK (#1130).
 *
 * The SDK and ORCA's permission bridge stay in the daemon; only `claude` runs on the other
 * machine, started over the host's own SSH configuration (identity file, port, login shell) the
 * way the ACP route starts an agent there, with the SDK's stream-json on the connection's stdin
 * and stdout. It runs as the person's own login on that machine, with the Claude Code and
 * sign-in found there. ORCA reads no credentials there and offers no login: an unauthenticated
 * `claude` is refused with `claude auth login` guidance that names the host. The host must be
 * Linux (ownership below reads `/proc`) with bash as the remote shell (the relay below uses
 * `read -t`) and `flock` (util-linux); anything else is refused before `claude` starts.
 *
 * **No value in an argument list.** The remote command line holds names, the directory, the
 * command and its arguments, never an environment value: ORCA writes each value to the
 * connection's stdin first (`NAME base64`, then an end line), and the remote shell reads and
 * exports them with builtins (`read`, `export`; `base64 -d` reads its input from a pipe)
 * before `claude` starts. So a value appears in no process's arguments on either machine, and
 * in no error or log ORCA writes.
 *
 * **Ownership is a marker, not a number.** Every process of a launch carries
 * `ORCA_CLAUDE_SDK_LAUNCH=<token>` in its environment, the token unique to that launch. A stop
 * (by the host or by ORCA) signals a process only after reading that marker in its
 * `/proc/<pid>/environ`, immediately before the signal, so a reused pid or group id, or another
 * launch's process, is never signalled. A process that clears its own environment is not
 * followed.
 *
 * **One supervisor, explicit states.** Each launch has a state file on the host (`starting`,
 * `admitted`, `running`, `stopping`, `stopped`, `done`; see `supervisorFunctions`) that is
 * written only while holding the launch's lock (`flock`).
 * The remote shell holds the lock from before `claude` starts until `claude` carries the
 * marker, and again while it stops what `claude` left; a stop (ORCA's, or the host's own)
 * holds it while it marks the launch `stopping` and kills what carries the marker. So a stop
 * never runs while a launch is started but not yet visible, and a launch a stop overtook never
 * starts. `stopped` and `done` are written only on evidence that no marked process runs or
 * can start; otherwise it stays `stopping`, the stop is reported unconfirmed, and the watchdog
 * keeps trying (`claudeSdkRemoteScript`, `claudeSdkRemoteStopScript`).
 *
 * **The host stops it by itself.** `claude`'s stdin comes through a relay in the remote shell,
 * which forwards ORCA's lines, drops ORCA's heartbeat (`CLAUDE_SDK_REMOTE_PING`, every
 * `heartbeat.intervalMs` while the input is between lines), and records a beat for every line it
 * reads. A watchdog, a separate process that forwards nothing, stops the launch as a stop does
 * when no beat is recorded for `heartbeat.timeoutS` (ORCA unreachable, the connection silently
 * gone, or a `claude` that stopped reading so the relay is stuck writing to it), or
 * `heartbeat.graceS` after the input ended (ORCA closed it, or the connection did). Its
 * deadlines are elapsed time (`/proc/uptime`), not the wall clock. None of this needs a
 * connection back, and the relay and the watchdog end by themselves once the launch is `done`
 * or `stopped`.
 *
 * **ORCA confirms it.** After every session end ORCA also runs the stop over a new SSH
 * connection and checks that no marked process of the launch runs (`ClaudeSdkRemoteLaunch.stop`). A stop
 * that cannot be confirmed (the host unreachable, the lock not free in time) is not reported as
 * closure: the session's `terminated` rejects with reason `remote-cleanup-unconfirmed`, and the
 * host's own heartbeat stop is what remains.
 *
 * What "confirmed" covers is the supervised processes, those that carry the marker: a
 * descendant that drops it from its environment is not one, and an empty scan says nothing
 * about it. A host that crashes is not covered either. A stop that cannot show that no marked
 * process runs and none can start (a state record it cannot read or write included) leaves the
 * launch `stopping` or as it was, and reports it unconfirmed.
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
import { Writable } from "node:stream";
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
/** ORCA's heartbeat line on `claude`'s input, which the remote relay drops. */
export const CLAUDE_SDK_REMOTE_PING = "ORCA-CLAUDE-SDK-PING";
/** The environment marker every process of a launch carries. */
export const CLAUDE_SDK_LAUNCH_VARIABLE = "ORCA_CLAUDE_SDK_LAUNCH";
/** Where the remote shell keeps each launch's state files, under the remote `$HOME`. */
const STATE_DIR = '"$HOME/.cache/orca/claude-sdk"';
/** How long the stop's own SSH connection may take beyond the host's connect timeout: the lock's wait, the kills, a margin. */
const STOP_MARGIN_MS = 30_000;
/** How long a script waits for a launch's lock, in seconds; no holder keeps it longer than about fifteen. */
const LOCK_WAIT_S = 20;
/** How many tenths of a second admission waits for `claude` to carry the marker. */
const ADMIT_TRIES = 100;
/** Exit codes the remote scripts use. */
const EXIT = { refused: 125, unsupported: 126, missing: 127, stopped: 137, survived: 4, busy: 5, state: 6 } as const;

/** The host-side stop when ORCA goes silent: a heartbeat this often, given up after `timeoutS`. */
export interface ClaudeSdkRemoteHeartbeat {
  intervalMs: number;
  timeoutS: number;
  /** After the input ends, how long `claude` has to exit before the host stops it. */
  graceS: number;
}
export const CLAUDE_SDK_REMOTE_HEARTBEAT: ClaudeSdkRemoteHeartbeat = { intervalMs: 5_000, timeoutS: 30, graceS: 10 };

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
    if (!VARIABLE.test(name) || name === CLAUDE_SDK_LAUNCH_VARIABLE)
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

/** A fresh launch token: names this launch's marker and state files on the host. */
export function claudeSdkRemoteToken(): string {
  return randomBytes(16).toString("hex");
}

function checkToken(token: string): void {
  if (!TOKEN.test(token)) throw new OrcaError("INTERNAL", "a remote launch token must be 32 lowercase hex digits");
}

/**
 * The supervisor's shell functions, shared by the launch, the watchdog and the stop. Each launch
 * has a state file (`<token>.state`) written only while holding its lock (`<token>.lock`,
 * `flock`), and every process it starts carries its marker. The states:
 * - `starting`: admission began; `claude` may not start yet (its process waits for `admitted`).
 * - `admitted <pid> <start>`: the one process that may start `claude`, named by pid and
 *   `/proc` start time, is allowed to.
 * - `running <pid> <start>`: that process carries the marker, or has exited.
 * - `stopping [<pid> <start>]`: a stop was asked for and is not confirmed yet.
 * - `stopped`: a stop confirmed that no marked process runs and nothing can start.
 * - `done`: `claude` exited and the launch confirmed that nothing of it is left.
 * - `orca_own` prints the pid of every process carrying the marker; `orca_reap` signals each
 *   one (after reading the marker again) until none is left, failing when one outlives about
 *   five seconds of kills.
 * - `orca_up` reads elapsed time (`/proc/uptime`, in hundredths of a second) into `orca_u`, so no deadline
 *   depends on the wall clock.
 * - `orca_state` reads and checks the record into `orca_st` (a pid into `orca_sp`, its start
 *   time into `orca_ss`): empty only when there is no record; one it cannot read or that is not
 *   a state is `invalid` and fails (exit 6). `orca_set` replaces it whole (write, then rename)
 *   and fails when it cannot; every failure to read or write a transition leaves the stop
 *   unconfirmed and keeps a launch from starting.
 * - `orca_is <pid> <start>` is true while that very process (pid and start time) runs and is
 *   not a zombie; `orca_settle` waits, bounded, until it is gone or carries the marker.
 * - `orca_stop`, with the lock held, takes the launch to `stopped` on evidence only, and leaves
 *   it `stopping` (exit 4) when it cannot show that nothing of it runs or can start.
 */
function supervisorFunctions(token: string): string[] {
  return [
    `orca_k=${CLAUDE_SDK_LAUNCH_VARIABLE}=${token}`,
    `orca_sf="$orca_d/${token}.state"`,
    `orca_lk="$orca_d/${token}.lock"`,
    `orca_mine() { tr '\\000' '\\n' < "/proc/$1/environ" 2>/dev/null | grep -qxF "$orca_k"; }`,
    `orca_own() {`,
    `  for orca_e in /proc/[0-9]*; do`,
    `    orca_q=\${orca_e#/proc/}`,
    `    orca_mine "$orca_q" && printf '%s\\n' "$orca_q"`,
    `  done`,
    `  return 0`,
    `}`,
    `orca_reap() {`,
    `  orca_i=0`,
    `  while :; do`,
    `    orca_any=`,
    `    for orca_q in $(orca_own); do`,
    `      orca_any=1`,
    // The marker is read again right before the signal: a pid reused since the scan is not ours.
    `      orca_mine "$orca_q" && kill -9 "$orca_q" 2>/dev/null`,
    `    done`,
    `    [ -z "$orca_any" ] && return 0`,
    `    orca_i=$((orca_i + 1))`,
    `    [ "$orca_i" -gt 50 ] && return ${EXIT.survived}`,
    `    sleep 0.1`,
    `  done`,
    `}`,
    `orca_up() { IFS=' .' read -r orca_u orca_cs _ < /proc/uptime; orca_u=$orca_u$orca_cs; }`,
    // Absent is the only empty state; a record that cannot be read, is cut short (no newline)
    // or is not one of the states is `invalid` and fails the read.
    `orca_state() {`,
    `  orca_st=; orca_sp=; orca_ss=; orca_rest=`,
    `  [ -e "$orca_sf" ] || [ -L "$orca_sf" ] || return 0`,
    `  if { IFS=' ' read -r orca_st orca_sp orca_ss orca_rest < "$orca_sf"; } 2>/dev/null; then`,
    `    case "$orca_st:$orca_sp:$orca_ss:$orca_rest" in`,
    `      starting:::|stopping:::|stopped:::|done:::) return 0 ;;`,
    `      admitted:?*:?*:|running:?*:?*:|stopping:?*:?*:)`,
    `        case $orca_sp$orca_ss in *[!0-9]*) ;; *) return 0 ;; esac ;;`,
    `    esac`,
    `  fi`,
    `  orca_st=invalid; orca_sp=; orca_ss=`,
    `  return ${EXIT.state}`,
    `}`,
    // Replaced whole by a rename, so a reader sees the old record or the new one, never a part.
    `orca_set() { printf '%s\\n' "$1" > "$orca_sf.new" && mv -f "$orca_sf.new" "$orca_sf"; }`,
    // Field 22 of /proc/<pid>/stat, the start time, is the 20th after the command name.
    `orca_ident() {`,
    `  orca_z=`,
    `  { read -r orca_z < "/proc/$1/stat"; } 2>/dev/null || return 1`,
    `  orca_z=\${orca_z##*) }`,
    `  set -f; set -- $orca_z; set +f`,
    `  [ "$1" = Z ] && return 1`,
    `  orca_id=\${20}`,
    `}`,
    `orca_is() { [ -n "$1" ] && orca_ident "$1" && [ "$orca_id" = "$2" ]; }`,
    `orca_settle() {`,
    `  orca_j=0`,
    `  while orca_is "$1" "$2" && ! orca_mine "$1"; do`,
    `    orca_j=$((orca_j + 1))`,
    `    [ "$orca_j" -gt ${ADMIT_TRIES} ] && return ${EXIT.survived}`,
    `    sleep 0.1`,
    `  done`,
    `  return 0`,
    `}`,
    `orca_stop() {`,
    // A record that cannot be read names no admitted process: what is marked is killed, and
    // the stop stays unconfirmed.
    `  if ! orca_state; then orca_reap; return ${EXIT.state}; fi`,
    `  case $orca_st in`,
    // Nothing admitted: no process may start claude, and none will be allowed to now.
    `    ''|starting) if ! orca_set stopped; then orca_reap; return ${EXIT.state}; fi`,
    `      orca_reap && return 0`,
    `      orca_set stopping; return ${EXIT.survived} ;;`,
    `    done|stopped) orca_reap && return 0`,
    `      orca_set stopping; return ${EXIT.survived} ;;`,
    `  esac`,
    // admitted, running or stopping: the one process that could still start claude is known.
    `  orca_c="$orca_sp $orca_ss"`,
    `  if ! orca_set "stopping $orca_c"; then orca_settle $orca_c; orca_reap; return ${EXIT.state}; fi`,
    `  orca_settle $orca_c && orca_reap || return ${EXIT.survived}`,
    `  orca_set stopped || return ${EXIT.state}`,
    `  return 0`,
    `}`,
  ];
}

/**
 * A launch's files are removed once it ended (`done` or `stopped`) more than a day ago; a
 * launch still starting or running keeps them. This age is the one place a wall clock is read,
 * and only for housekeeping.
 */
const TIDY = [
  `for orca_f in "$orca_d"/*.state; do`,
  `  [ -f "$orca_f" ] || continue`,
  `  orca_g=; read -r orca_g _ < "$orca_f"`,
  `  case $orca_g in done|stopped) ;; *) continue ;; esac`,
  `  [ -n "$(find "$orca_f" -mmin +1440 2>/dev/null)" ] && rm -f "\${orca_f%.state}".*`,
  `done`,
];

/** What both scripts need on the host: bash, `/proc` and `flock`. */
const SUPPORTED = `[ -n "\${BASH_VERSION:-}" ] && [ -r /proc/self/environ ] && command -v flock >/dev/null 2>&1 || exit ${EXIT.unsupported}`;

/**
 * The remote shell script that starts `command` in `cwd`: `withheld` unset, the variables
 * `names` read from stdin (`claudeSdkRemoteEnvInput`) and exported, then the launch, as a
 * supervisor with explicit states:
 *
 * 1. **Admission**, holding the lock: a stop that came first (`stopping` or `stopped`) ends
 *    it (137) before anything starts. Otherwise `starting`, the relay and the watchdog, and the
 *    process that will become `claude`, which waits until the state names it. The shell then
 *    writes `admitted <pid> <start>`, and holds the lock until that process carries the marker
 *    or has exited, so a stop never finds a launch that is started but not yet visible, and a
 *    stop after a remote shell that died here knows which process to watch. A process that does
 *    not carry it within about ten seconds is killed by its pid, which is safe because it is the
 *    shell's own child, not yet waited for. Hangup, interrupt and terminate are deferred
 *    meanwhile. Then `running <pid> <start>`.
 * 2. **Running**: `claude`'s input through the relay; the shell waits for it.
 * 3. **End**, holding the lock: every process of the launch killed and checked gone, then
 *    `done`. When one outlives the kills the state becomes `stopping`, so the watchdog keeps
 *    trying. When a stop came first, the shell finishes it (`orca_stop`) and exits 137.
 *
 * The watchdog stops the launch the same way under the lock (`orca_stop`) when the heartbeat
 * ends, and tries again every second while the state is `stopping`; it and the relay end by
 * themselves once the state is `done` or `stopped`, the two states that are confirmed. Exits
 * 127 when `command` is not found there, 126 on a host without bash, `/proc` or `flock`, 125
 * on input it refuses, 137 when a stop came first. Names are checked, the rest quoted; no value
 * is in it.
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
  heartbeat?: ClaudeSdkRemoteHeartbeat | undefined;
}): string {
  checkNames(o.agentId, o.hostId, [...o.names, ...(o.withheld ?? [])]);
  checkToken(o.token);
  const beat = o.heartbeat ?? CLAUDE_SDK_REMOTE_HEARTBEAT;
  if (!Number.isInteger(beat.timeoutS) || beat.timeoutS < 1 || !Number.isInteger(beat.graceS) || beat.graceS < 0)
    throw new OrcaError("INTERNAL", "a remote heartbeat timeout and grace are whole seconds");
  const accepted = o.names.length ? o.names.join("|") : "''";
  const command = shellQuote(o.command);
  const run = `${command} ${o.args.map(shellQuote).join(" ")}`.trim();
  return [
    SUPPORTED,
    ...(o.withheld ?? []).map((name) => `unset ${name} || exit ${EXIT.refused}`),
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
    `orca_env || exit ${EXIT.refused}`,
    `unset -f orca_env; unset orca_l orca_n orca_v`,
    `cd ${shellQuote(o.cwd)} || exit ${EXIT.refused}`,
    `command -v ${command} >/dev/null 2>&1 || exit ${EXIT.missing}`,
    `orca_d=${STATE_DIR}`,
    `(umask 077 && mkdir -p "$orca_d") || exit ${EXIT.refused}`,
    ...TIDY,
    ...supervisorFunctions(o.token),
    `orca_hb="$orca_d/${o.token}.beat"`,
    `orca_eof="$orca_d/${o.token}.eof"`,
    // The relay: ORCA's lines to claude, its heartbeat dropped, each line read (heartbeat or
    // not) recorded as a beat (elapsed time). It decides nothing and is never signalled: it ends
    // when the input ends (recorded for the watchdog), when claude stops taking input, or once
    // the launch is done or stopped.
    `orca_relay() {`,
    `  orca_buf=`,
    `  while :; do`,
    `    IFS= read -r -t 1 orca_line`,
    `    orca_r=$?`,
    `    if [ "$orca_r" -eq 0 ]; then`,
    `      orca_up; printf '%s\\n' "$orca_u" > "$orca_hb"`,
    `      orca_line=$orca_buf$orca_line`,
    `      orca_buf=`,
    `      [ "$orca_line" = ${CLAUDE_SDK_REMOTE_PING} ] && continue`,
    `      printf '%s\\n' "$orca_line" || return 1`,
    `    elif [ "$orca_r" -gt 128 ]; then`,
    `      if [ -n "$orca_line" ]; then orca_buf=$orca_buf$orca_line; orca_up; printf '%s\\n' "$orca_u" > "$orca_hb"; fi`,
    `      orca_state`,
    `      case $orca_st in done|stopped) return 1 ;; esac`,
    `    else`,
    `      orca_line=$orca_buf$orca_line`,
    `      [ -n "$orca_line" ] && printf '%s' "$orca_line"`,
    `      orca_up; printf '%s\\n' "$orca_u" > "$orca_eof"`,
    `      return 0`,
    `    fi`,
    `  done`,
    `}`,
    // Admission, under the lock.
    `exec 9>>"$orca_lk" || exit ${EXIT.refused}`,
    `flock -w ${LOCK_WAIT_S} 9 || exit ${EXIT.refused}`,
    `orca_state || exit ${EXIT.refused}`,
    `case $orca_st in stopped|stopping) exit ${EXIT.stopped} ;; '') ;; *) exit ${EXIT.refused} ;; esac`,
    `orca_up; printf '%s\\n' "$orca_u" > "$orca_hb" || exit ${EXIT.refused}`,
    `orca_set starting || exit ${EXIT.refused}`,
    `trap : HUP INT TERM`,
    // The watchdog, apart from the relay so a relay blocked on a claude that stopped reading
    // cannot hold it: no beat for the timeout, or the grace over after the input ended, and the
    // launch is stopped under the lock (its own descriptor, so the lock is really taken). It only
    // ever signals through orca_reap.
    `(`,
    `  exec </dev/null >/dev/null 2>&1 8>>"$orca_lk"`,
    `  while :; do`,
    `    orca_state`,
    `    case $orca_st in done|stopped) exit 0 ;; esac`,
    `    orca_up; orca_w=`,
    `    if [ -f "$orca_eof" ]; then`,
    `      read -r orca_w < "$orca_eof"; orca_lim=${beat.graceS * 100}`,
    `    else`,
    `      read -r orca_w < "$orca_hb"; orca_lim=${beat.timeoutS * 100}`,
    `    fi`,
    // A stop not confirmed yet (or a record that cannot be read) is tried again every second; a
    // beat file read while it is
    // rewritten reads empty, and that round is skipped.
    `    case $orca_st in stopping|invalid) orca_w=0 ;; esac`,
    `    case $orca_w in ''|*[!0-9]*) sleep 1; continue ;; esac`,
    `    if [ $((orca_u - orca_w)) -ge "$orca_lim" ] && flock -w ${LOCK_WAIT_S} 8; then`,
    `      orca_stop && exit 0`,
    `      flock -u 8`,
    `    fi`,
    `    sleep 1`,
    `  done`,
    `) 9>&- &`,
    `exec 3<&0 </dev/null`,
    // claude's input from the relay through a process substitution, so wait waits for claude
    // alone; fd 3 closed for claude only after the relay, expanded first, took it. Neither
    // keeps the lock's descriptor.
    // The process that becomes claude waits until the state names it (pid and start time),
    // so nothing starts claude before the stop could know which process to watch; anything
    // else (a stop, or no admission within the bound) ends it before claude starts.
    `(`,
    `  orca_i=0`,
    `  until orca_state && [ "$orca_st" = admitted ] && [ "$orca_sp" = "$BASHPID" ]; do`,
    `    case $orca_st in starting|''|invalid) ;; *) exit ${EXIT.stopped} ;; esac`,
    `    orca_i=$((orca_i + 1))`,
    `    [ "$orca_i" -gt ${ADMIT_TRIES} ] && exit ${EXIT.refused}`,
    `    sleep 0.1`,
    `  done`,
    `  export "$orca_k"`,
    `  exec ${run}`,
    `) < <(exec 2>/dev/null 9>&-; orca_relay <&3) 3<&- 9>&- &`,
    `orca_p=$!`,
    `exec 3<&-`,
    `orca_ident "$orca_p" || orca_id=0`,
    `orca_ps=$orca_id`,
    // Not admitted: the state stays `starting`, and the process, never let start claude, is killed.
    `if ! orca_set "admitted $orca_p $orca_ps"; then kill -9 "$orca_p" 2>/dev/null; wait "$orca_p"; exit ${EXIT.refused}; fi`,
    `orca_i=0`,
    `until orca_mine "$orca_p" || ! orca_is "$orca_p" "$orca_ps"; do`,
    `  orca_i=$((orca_i + 1))`,
    // Still not claude: it is the shell's own child, not yet waited for, so its pid is its own.
    `  if [ "$orca_i" -gt ${ADMIT_TRIES} ]; then kill -9 "$orca_p" 2>/dev/null; break; fi`,
    `  sleep 0.1`,
    `done`,
    // Not recorded as running: the state still names it as admitted, and it is ended here.
    `orca_set "running $orca_p $orca_ps" || kill -9 "$orca_p" 2>/dev/null`,
    `flock -u 9`,
    `trap - HUP INT TERM`,
    `wait "$orca_p"`,
    `orca_x=$?`,
    // The end, under the lock: what claude left is stopped and checked gone, then done.
    `flock -w ${LOCK_WAIT_S} 9 || exit "$orca_x"`,
    `orca_was=`,
    `if orca_state && [ "$orca_st" = running ]; then`,
    `  orca_was=running`,
    `  orca_reap && orca_set done || orca_set "stopping $orca_sp $orca_ss"`,
    `else`,
    `  orca_stop`,
    `fi`,
    `flock -u 9`,
    `[ "$orca_was" = running ] || exit ${EXIT.stopped}`,
    `exit "$orca_x"`,
  ].join("\n");
}

/**
 * The remote shell script that stops the launch `token`, holding its lock (so never while a
 * launch is being admitted or ended), through `orca_stop`: `stopped` only on evidence that
 * no marked process runs or can start, otherwise `stopping`, which the watchdog keeps
 * trying. Before admission (no state, or `starting` left by a remote shell that died there)
 * nothing may start `claude`, so `stopped` holds at once. Once a process was admitted, the stop
 * waits until that process (pid and start time) is gone or carries the marker, then kills
 * every marked process and checks them gone. Exits 0 when `stopped` (or `done`) is confirmed, 4
 * when it is not (one outlived the kills, or the admitted process neither went nor took the
 * marker), 5 when the lock is not free in time, 126 on a host without bash, `/proc` or `flock`.
 */
export function claudeSdkRemoteStopScript(token: string): string {
  checkToken(token);
  return [
    SUPPORTED,
    `orca_d=${STATE_DIR}`,
    `(umask 077 && mkdir -p "$orca_d") || exit ${EXIT.refused}`,
    ...supervisorFunctions(token),
    `exec 9>>"$orca_lk" || exit ${EXIT.refused}`,
    `flock -w ${LOCK_WAIT_S} 9 || exit ${EXIT.busy}`,
    `orca_stop`,
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

/** What a stop found: `stopped` once no marked process of the launch runs on the host. */
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
  if (r.code === EXIT.survived) return "a process of the launch outlived the kills";
  if (r.code === EXIT.busy) return "the launch's lock was not free in time";
  if (r.code === EXIT.state) return "the launch's state on the host could not be read or written";
  if (r.code === EXIT.unsupported) return "the host lacks bash, /proc or flock";
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

/** The error a session or preflight reports when it cannot confirm the host stopped its launch. */
export function claudeSdkRemoteCleanupUnconfirmed(agentId: string, hostId: string, reason: string): OrcaError {
  return new OrcaError(
    "AGENT_TRANSPORT",
    `agent ${agentId}: ORCA could not confirm that Claude Code stopped on host ${hostId} (${reason}); ` +
      `the host stops it by itself once ORCA's heartbeat stops arriving`,
    { agentId, host: hostId, reason: "remote-cleanup-unconfirmed", detail: reason },
  );
}

/**
 * `claudeSdkPreflight` for `claude` on an SSH host: its version and whether it is signed in,
 * asked there over the host's SSH configuration, each probe bounded and, when it did not
 * finish, stopped there (a stop that cannot be confirmed fails the preflight). The executable
 * is the agent's `command` as the remote login shell finds it; the environment is the remote
 * one, written to stdin.
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
    if (result.timedOut || result.aborted || result.overLimit || result.signal !== null) {
      const stop = await stopRemote(host, token);
      if (!stop.stopped) throw claudeSdkRemoteCleanupUnconfirmed(agent.id, host.id, stop.reason ?? "unknown");
    }
    if (result.code === EXIT.unsupported)
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agent.id}: host ${host.id} is not one ORCA runs Claude Code on through the Claude Agent SDK; it needs Linux, bash as the remote shell, and flock.`,
        { agentId: agent.id, host: host.id },
      );
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
  /** Stop what this launch started on the host and confirm it is gone. A confirmed stop is kept; a failed one is tried again. */
  stop: () => Promise<ClaudeSdkRemoteStop>;
}

/**
 * `child.stdin` replaced by a writer that forwards the SDK's input and, while it is between
 * lines, adds ORCA's heartbeat, until the input ends or the process exits.
 */
function withHeartbeat(child: ChildProcess, intervalMs: number): void {
  const real = child.stdin;
  if (!real) return;
  let atLineStart = true;
  let writing = 0;
  const timer = setInterval(() => {
    if (atLineStart && writing === 0 && !real.destroyed && !real.writableEnded)
      real.write(`${CLAUDE_SDK_REMOTE_PING}\n`);
  }, intervalMs);
  timer.unref();
  const stopBeat = () => clearInterval(timer);
  child.once("exit", stopBeat);
  real.once("close", stopBeat);
  real.on("error", () => undefined);
  const relay = new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text.length) atLineStart = text.endsWith("\n");
      writing++;
      real.write(chunk, encoding, (error) => {
        writing--;
        callback(error ?? null);
      });
    },
    final(callback) {
      stopBeat();
      real.end(() => callback());
    },
    destroy(error, callback) {
      stopBeat();
      real.destroy(error ?? undefined);
      callback(error);
    },
  });
  relay.on("error", () => undefined);
  Object.defineProperty(child, "stdin", { value: relay, configurable: true });
}

/**
 * The launch of one session's `claude` on `host`: ssh, in its own process group so a kill
 * reaches it, stdin (with ORCA's heartbeat) and stdout piped for stream-json, stderr dropped;
 * the host owns the launch (see the module comment), and `stop` ends it there.
 */
export function claudeSdkSshLaunch(
  host: SshHost,
  agentId: string,
  withheld?: readonly string[],
  heartbeat: ClaudeSdkRemoteHeartbeat = CLAUDE_SDK_REMOTE_HEARTBEAT,
): ClaudeSdkRemoteLaunch {
  const token = claudeSdkRemoteToken();
  let confirmed: Promise<ClaudeSdkRemoteStop> | undefined;
  let attempt: Promise<ClaudeSdkRemoteStop> | undefined;
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
        heartbeat,
      });
      const child = spawn(host.spec.sshBinary, sshArgs(host, script), {
        env: sshEnv(),
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
        windowsHide: true,
      });
      // First on stdin, ahead of anything the SDK writes.
      child.stdin?.write(claudeSdkRemoteEnvInput(o.env));
      withHeartbeat(child, heartbeat.intervalMs);
      return child;
    },
    stop: () => {
      if (confirmed) return confirmed;
      return (attempt ??= stopRemote(host, token).then((r) => {
        if (r.stopped) confirmed = Promise.resolve(r);
        attempt = undefined;
        return r;
      }));
    },
  };
}
