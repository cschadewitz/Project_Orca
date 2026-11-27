/**
 * Claude Code on an SSH host through the Claude Agent SDK (#1130).
 *
 * The SDK and ORCA's permission bridge stay in the daemon; only `claude` runs on the other
 * machine, started over the host's own SSH configuration (identity file, port, login shell) the
 * way the ACP route starts an agent there: `ssh -T … -- bash -lc 'cd <cwd> && exec env … claude …'`,
 * with the SDK's stream-json on stdin and stdout. It runs as the person's own login on that
 * machine, with the Claude Code and sign-in found there. ORCA reads no credentials there and
 * offers no login: an unauthenticated `claude` is refused with `claude auth login` guidance that
 * names the host.
 *
 * What does not hold on that machine yet, and so is refused or left out:
 * - The pre-tool hook's qualification (`nativeToolHook: experimental`) is refused on any
 *   non-local host by the session factory, as on the ACP route: the image there is not attested.
 * - Secret references are read only on ORCA's own machine (`claudeSdkSecrets`), so an agent
 *   with one is refused on an SSH host.
 * - The bridge cannot check a call's directory on that machine, so no rule allows a call that
 *   runs there: each is a person's to allow (`workspaceScope` in the bridge), and deny rules
 *   and protected paths apply as everywhere.
 *
 * The environment handed to `claude` is only what the session sets (the agent's own `env`,
 * what ORCA adds, and the SDK's own variables), on top of the remote login shell's. None of the
 * daemon's environment crosses. Variable names are checked; values are quoted for the remote
 * shell. Withheld names are unset there before `claude` starts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { CLAUDE_SDK_DEFAULT_COMMAND, isSecretRef, OrcaError, type AgentSpec } from "@orca/core";
import { shellQuote } from "../host.js";
import type { SshHost } from "../hosts/ssh-host.js";
import {
  CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS,
  isClaudeCredentialVariable,
  probeClaude,
  runBounded,
  type ClaudeSdkPreflight,
} from "./launch.js";

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/**
 * The remote shell line that starts `command` in `cwd` with `env` added and `withheld` unset:
 * names are checked, everything else is quoted.
 */
export function claudeSdkRemoteScript(o: {
  agentId: string;
  hostId: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  withheld?: readonly string[] | undefined;
}): string {
  const names = [...Object.keys(o.env), ...(o.withheld ?? [])];
  for (const name of names)
    if (!VARIABLE.test(name))
      throw new OrcaError(
        "CONFIG_INVALID",
        `agent ${o.agentId}: environment variable name '${name}' cannot be set on host '${o.hostId}'`,
        { agentId: o.agentId, hostId: o.hostId },
      );
  const unset = (o.withheld ?? []).map((name) => `unset ${name} && `).join("");
  const assignments = Object.entries(o.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const env = assignments.length ? `env ${assignments.join(" ")} ` : "";
  return `${unset}cd ${shellQuote(o.cwd)} && exec ${env}${shellQuote(o.command)} ${o.args.map(shellQuote).join(" ")}`.trim();
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

/**
 * `claudeSdkPreflight` for `claude` on an SSH host: its version and whether it is signed in,
 * asked there over the host's SSH configuration, each probe bounded. The executable is the
 * agent's `command` as the remote login shell finds it; the environment is the remote one.
 */
export async function claudeSdkSshPreflight(options: ClaudeSdkSshPreflightOptions): Promise<ClaudeSdkPreflight> {
  const { host, agent, cwd } = options;
  const env = claudeSdkRemoteEnvironment(agent, options.orcaEnv, options.withheldEnv);
  const executable = agent.command.length > 0 ? agent.command : CLAUDE_SDK_DEFAULT_COMMAND;
  const timeoutMs = options.timeoutMs ?? CLAUDE_SDK_PREFLIGHT_TIMEOUT_MS;
  const run = (args: string[]) =>
    runBounded(
      host.spec.sshBinary,
      sshArgs(
        host,
        claudeSdkRemoteScript({
          agentId: agent.id,
          hostId: host.id,
          command: executable,
          args,
          cwd,
          env,
          withheld: options.withheldEnv,
        }),
      ),
      { cwd: process.cwd(), env: sshEnv(), timeoutMs, signal: options.signal },
    );
  const place = { where: `on host ${host.id}`, there: `on ${host.id}` };
  return { executable, env, ...(await probeClaude(agent.id, executable, run, place)) };
}

/**
 * How a session on `host` starts its `claude` (`ClaudeSdkSessionOptions.remote`): ssh, in its
 * own process group so a kill reaches it, stdin and stdout piped for stream-json, stderr
 * dropped. Closing the session ends ssh's stdin; killing ssh closes the channel, so the remote
 * `claude` loses its input and output and exits.
 */
export function claudeSdkSshSpawner(
  host: SshHost,
  agentId: string,
  withheld?: readonly string[],
): (o: { command: string; args: string[]; cwd: string; env: Record<string, string> }) => ChildProcess {
  return (o) =>
    spawn(host.spec.sshBinary, sshArgs(host, claudeSdkRemoteScript({ agentId, hostId: host.id, ...o, withheld })), {
      env: sshEnv(),
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
      windowsHide: true,
    });
}
