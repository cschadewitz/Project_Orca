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
   * The configured command was checked on that host to be a trusted executable (see
   * `TRUSTED_EXECUTABLE_POLICY`): exactly that absolute, canonical path, no symbolic link
   * anywhere on it, and the file and every directory above it owned by root or the account
   * the agent runs as and writable by no one else. Only then does a grant naming the server
   * pin what is executed; a `"*"` grant covers a server that is not.
   */
  trustedExecutable: boolean;
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
  // An absolute command is exactly that file: no extension is ever appended to it.
  if (isAbsolute(command)) return (await executable(command)) ? command : undefined;
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  const candidates = (base: string) => extensions.map((ext) => base + ext);
  if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
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
 * What a grant naming one MCP server requires of its executable before it covers it (#337):
 *
 * - the configured command is an absolute path, and the file found is exactly that path:
 *   no `PATH` search, no working directory and no appended extension decide it;
 * - the path is canonical: not a symbolic link, with no symbolic link, `.` or `..` in any
 *   directory above it (the path is its own `pwd -P` resolution);
 * - the file is an executable regular file;
 * - the file and every directory above it, up to `/`, is owned by root or by the account the
 *   agent runs as on that host, and is writable by neither its group nor others, with no
 *   ACL (`+`) on any of them.
 *
 * So no one but an administrator of that host, or the agent's own account, can put another
 * program at the granted path. It is checked on the agent's host every time the server is
 * delivered, the same way locally and over SSH, by one POSIX shell script. A Windows host is
 * never trusted this way: its file permissions are not modes this check can read, so only a
 * `"*"` grant covers a catalog server there. A path that fails the check still runs under
 * `"*"`; it is only a narrow grant that does not cover it.
 */
export const TRUSTED_EXECUTABLE_POLICY = "absolute-canonical-admin-owned";

/**
 * The POSIX shell lines that exit 0 when `$p` meets `TRUSTED_EXECUTABLE_POLICY` and non-zero
 * otherwise. Run in a subshell: they set options and exit.
 */
const TRUST_CHECK = [
  // The verdict must not depend on the environment being judged: the configured `PATH` (or
  // a function from a login profile) could otherwise supply its own `ls` or `id`. Tools are
  // found on a fixed system `PATH` only, through `command` (never a function), in the C locale.
  "PATH=/usr/bin:/bin; export PATH; LC_ALL=C; export LC_ALL",
  "set -f",
  "case $p in /*) ;; *) exit 5 ;; esac",
  '[ -f "$p" ] && [ ! -L "$p" ] && [ -x "$p" ] || exit 5',
  'd=$(cd -P -- "${p%/*}/" && pwd -P) || exit 5',
  '[ "${d%/}/${p##*/}" = "$p" ] || exit 5',
  "u=$(command id -u) || exit 5",
  "x=$p",
  "while :; do",
  '  l=$(command ls -ldn -- "$x") || exit 5',
  "  set -- $l",
  '  [ "$3" = 0 ] || [ "$3" = "$u" ] || exit 5',
  "  case $1 in ?????w* | ????????w* | ??????????+*) exit 5 ;; esac",
  '  [ "$x" = / ] && break',
  '  x=${x%/*}; [ -n "$x" ] || x=/',
  "done",
].join("\n");

/** A script that prints `1` when `command` names a trusted executable and `0` when not. */
export function trustedExecutableScript(command: string): string {
  return `p=${shellQuote(command)}\nif ( ${TRUST_CHECK}\n) >/dev/null 2>&1; then echo 1; else echo 0; fi`;
}

/** Whether `command` meets `TRUSTED_EXECUTABLE_POLICY` on the daemon's own machine. */
async function trustedLocal(host: Pick<AgentHost, "exec">, command: string): Promise<boolean> {
  if (process.platform === "win32" || !isAbsolute(command)) return false;
  try {
    const { code, stdout } = await host.exec(trustedExecutableScript(command), { timeoutMs: AVAILABILITY_TIMEOUT_MS });
    return code === 0 && stdout.trim() === "1";
  } catch {
    return false;
  }
}

/**
 * The executable a catalog MCP server's command names on the host the agent runs on, found
 * the way ORCA defines it, so the agent can be handed exactly that and not search again:
 *
 * - an absolute command is exactly that file, which must be an executable regular file;
 * - a relative path (`./server`) is resolved against the session's working directory;
 * - a bare name is searched for on the server's literal `env.PATH`, else the agent's, else
 *   the host's own (on SSH, the remote login shell's).
 *
 * The answer is an absolute path, with whether it is a trusted executable (an absolute
 * command meeting `TRUSTED_EXECUTABLE_POLICY`), or `missing` (not found, not executable, or
 * not a file) or `unreachable` (the host did not answer). ORCA never installs or fetches one.
 * Finding the file is not proof the server works: the agent starts it, and a server that
 * fails after starting is the agent's to report.
 */
export async function resolveMcpServerCommand(
  host: Pick<AgentHost, "spec" | "exec">,
  server: Pick<ResolvedMcpServerConfig, "command" | "env">,
  context: { cwd: string; agentEnv: Env },
): Promise<{ path: string; trusted: boolean } | { reason: "missing" | "unreachable" }> {
  const path = configuredPath(server, context.agentEnv);
  if (host.spec.type === "local") {
    const found = await findLocal(server.command, context.cwd, path ?? process.env.PATH);
    if (!found) return { reason: "missing" };
    return { path: found, trusted: found === server.command && (await trustedLocal(host, server.command)) };
  }
  // One quiet command on that host. It prints only the absolute path it found, and only
  // after checking it is an executable regular file, with whether an absolute command is a
  // trusted executable there.
  const absolute = server.command.startsWith("/");
  const script = [
    "{ set +xv && exec 2>/dev/null; } || exit 4",
    `cd ${shellQuote(context.cwd)} || exit 3`,
    ...(path === undefined ? [] : [`PATH=${shellQuote(path)}`, "export PATH"]),
    absolute ? `p=${shellQuote(server.command)}` : `p=$(command -v -- ${shellQuote(server.command)}) || exit 3`,
    'case $p in /*) ;; */*) p="$PWD/$p" ;; *) exit 3 ;; esac',
    '[ -f "$p" ] && [ -x "$p" ] || exit 3',
    ...(absolute ? [`if ( ${TRUST_CHECK}\n) >/dev/null 2>&1; then t=1; else t=0; fi`] : ["t=0"]),
    'printf \'__orca_path__=%s:%s\\n\' "$t" "$p"',
  ].join("\n");
  try {
    const { code, stdout } = await host.exec(script, { timeoutMs: AVAILABILITY_TIMEOUT_MS });
    if (code === 3) return { reason: "missing" };
    // A login profile may print first; the answer is the one marked line at the end.
    const last = stdout.endsWith("\n") ? stdout.slice(stdout.lastIndexOf("\n", stdout.length - 2) + 1, -1) : "";
    const answer = last.startsWith(PATH_MARKER) ? last.slice(PATH_MARKER.length) : "";
    const trusted = answer.startsWith("1:");
    const found = /^[01]:/.test(answer) ? answer.slice(2) : "";
    if (code !== 0 || !found.startsWith("/") || found.length > MAX_PATH_LENGTH) return { reason: "unreachable" };
    return { path: found, trusted: trusted && absolute && found === server.command };
  } catch {
    return { reason: "unreachable" };
  }
}
