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

async function findLocal(command: string, cwd: string, path: string | undefined): Promise<boolean> {
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  const candidates = (base: string) => extensions.map((ext) => base + ext);
  if (isAbsolute(command) || command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
    for (const candidate of candidates(resolve(cwd, command))) if (await executable(candidate)) return true;
    return false;
  }
  for (const dir of (path ?? "").split(delimiter).filter(Boolean))
    for (const candidate of candidates(join(resolve(cwd, dir), command))) if (await executable(candidate)) return true;
  return false;
}

/**
 * Whether a catalog MCP server's command can be started on the host the agent runs on, from
 * the session's working directory: an executable file at that path, or found on the `PATH`
 * the agent will start it with. ORCA never installs or fetches one. This is a check that the
 * binary is there, not that the server works: the agent starts it, and a server that fails
 * after starting is the agent's to report.
 *
 * Returns undefined when the command is there, or a reason (`missing`, `unreachable`).
 */
export async function mcpServerCommandAvailable(
  host: Pick<AgentHost, "spec" | "exec">,
  server: Pick<ResolvedMcpServerConfig, "command" | "env">,
  context: { cwd: string; agentEnv: Env },
): Promise<"missing" | "unreachable" | undefined> {
  const path = configuredPath(server, context.agentEnv);
  if (host.spec.type === "local")
    return (await findLocal(server.command, context.cwd, path ?? process.env.PATH)) ? undefined : "missing";
  const lookup = `command -v -- ${shellQuote(server.command)} >/dev/null`;
  const script = `{ set +xv && exec 2>/dev/null; } || exit 4; cd ${shellQuote(context.cwd)} || exit 3; ${
    path === undefined ? lookup : `PATH=${shellQuote(path)}; export PATH; ${lookup}`
  } || exit 3; exit 0`;
  try {
    const { code } = await host.exec(script, { timeoutMs: AVAILABILITY_TIMEOUT_MS });
    return code === 0 ? undefined : code === 3 ? "missing" : "unreachable";
  } catch {
    return "unreachable";
  }
}
