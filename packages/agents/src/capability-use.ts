/**
 * The server-verified use decision for catalog capabilities (#337): what a session open asks
 * before an agent is given an MCP server from the shared catalog. It mirrors the secret use
 * decision (#336): one current authority of the run's owner must name each server, the host
 * it runs on with that host's endpoint binding, and the definition it was granted for.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { Env, ResolvedMcpServerConfig } from "@orca/core";
import type { AgentHost } from "./host.js";

/** One catalog MCP server a session is about to be given, on the agent's host. */
export interface CapabilityUse {
  kind: "mcpServer";
  /** The catalog id. */
  id: string;
  hostId: string;
  /** `secretHostBinding` of that host's spec: the endpoint the server will run on. */
  hostBinding: string;
  /** `mcpServerDefinitionDigest` of the definition as resolved now. */
  definition: string;
  /**
   * The configured command is an absolute path on that host, so what the grant pins is the
   * executable itself: no `PATH` search and no working-directory resolution decide it. Only
   * a `"*"` grant covers a server whose command is not.
   */
  absoluteCommand: boolean;
}

/** Whether `command` is an absolute path on a host of that type (POSIX for SSH hosts). */
export function isAbsoluteCommand(command: string, hostType: "local" | "ssh"): boolean {
  return hostType === "ssh" ? command.startsWith("/") : isAbsolute(command);
}

/**
 * `m1:` plus 32 hex digits of a sha256 over what the server is: its command, arguments and
 * environment, with secret references as references (never a value). A grant pinned to it
 * does not follow an id the config points at another command.
 */
export function mcpServerDefinitionDigest(server: Pick<ResolvedMcpServerConfig, "command" | "args" | "env">): string {
  const env = Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `m1:${createHash("sha256")
    .update(JSON.stringify([server.command, server.args, env]))
    .digest("hex")
    .slice(0, 32)}`;
}

/** Resolves when the run may be given every one of `uses` now; throws an `OrcaError` when not. */
export type CapabilityUseCheck = (request: { runId: string; uses: CapabilityUse[] }) => Promise<void>;

const AVAILABILITY_TIMEOUT_MS = 15_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A literal `PATH` the server (or else the agent) is configured with; a secret reference is not one. */
function configuredPath(server: Pick<ResolvedMcpServerConfig, "env">, agentEnv: Env): string | undefined {
  for (const env of [server.env, agentEnv]) {
    const value = env.PATH;
    if (typeof value === "string") return value;
  }
  return undefined;
}

async function executable(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    if (process.platform === "win32") return true;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findLocal(command: string, cwd: string, path: string | undefined): Promise<string | undefined> {
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  const candidates = (base: string) => extensions.map((ext) => base + ext);
  if (isAbsolute(command) || command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
    for (const candidate of candidates(resolve(cwd, command))) if (await executable(candidate)) return candidate;
    return undefined;
  }
  for (const dir of (path ?? "").split(delimiter).filter(Boolean))
    for (const candidate of candidates(join(resolve(cwd, dir), command)))
      if (await executable(candidate)) return candidate;
  return undefined;
}

/** The longest executable path a host's answer may name; anything else is not an answer. */
const MAX_PATH_LENGTH = 4096;
const PATH_MARKER = "__orca_path__=";

/**
 * The executable a catalog MCP server's command names on the host the agent runs on, found
 * the way ORCA defines it, so the agent can be handed exactly that and not search again:
 *
 * - an absolute command is that file, which must be an executable regular file;
 * - a relative path (`./server`) is resolved against the session's working directory;
 * - a bare name is searched for on the server's literal `env.PATH`, else the agent's, else
 *   the host's own (on SSH, the remote login shell's).
 *
 * The answer is an absolute path, or `missing` (not found, not executable, or not a file)
 * or `unreachable` (the host did not answer). ORCA never installs or fetches one. Finding the
 * file is not proof the server works: the agent starts it, and a server that fails after
 * starting is the agent's to report.
 */
export async function resolveMcpServerCommand(
  host: Pick<AgentHost, "spec" | "exec">,
  server: Pick<ResolvedMcpServerConfig, "command" | "env">,
  context: { cwd: string; agentEnv: Env },
): Promise<{ path: string } | { reason: "missing" | "unreachable" }> {
  const path = configuredPath(server, context.agentEnv);
  if (host.spec.type === "local") {
    const found = await findLocal(server.command, context.cwd, path ?? process.env.PATH);
    return found ? { path: found } : { reason: "missing" };
  }
  // One quiet command on that host. It prints only the absolute path it found, and only
  // after checking it is an executable regular file.
  const script = [
    "{ set +xv && exec 2>/dev/null; } || exit 4",
    `cd ${shellQuote(context.cwd)} || exit 3`,
    ...(path === undefined ? [] : [`PATH=${shellQuote(path)}`, "export PATH"]),
    `p=$(command -v -- ${shellQuote(server.command)}) || exit 3`,
    'case $p in /*) ;; */*) p="$PWD/$p" ;; *) exit 3 ;; esac',
    '[ -f "$p" ] && [ -x "$p" ] || exit 3',
    "printf '__orca_path__=%s\\n' \"$p\"",
  ].join("; ");
  try {
    const { code, stdout } = await host.exec(script, { timeoutMs: AVAILABILITY_TIMEOUT_MS });
    if (code === 3) return { reason: "missing" };
    // A login profile may print first; the answer is the one marked line at the end.
    const last = stdout.endsWith("\n") ? stdout.slice(stdout.lastIndexOf("\n", stdout.length - 2) + 1, -1) : "";
    const found = last.startsWith(PATH_MARKER) ? last.slice(PATH_MARKER.length) : "";
    if (code !== 0 || !found.startsWith("/") || found.length > MAX_PATH_LENGTH) return { reason: "unreachable" };
    return { path: found };
  } catch {
    return { reason: "unreachable" };
  }
}
