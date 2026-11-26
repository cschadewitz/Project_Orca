/**
 * The MCP servers ORCA configures for a Codex app-server thread (#1163), and what ORCA reads
 * back about them.
 *
 * - Only the agent's own `mcpServers` run, handed to Codex in `thread/start` and
 *   `thread/resume` (`config.mcp_servers`), never on the command line: their environment can
 *   carry secrets. Codex keeps that config in memory; nothing of it is written to its home.
 * - Each runs with `default_tools_approval_mode = "prompt"`, so every call asks, a tool its
 *   server annotates read-only included: Codex's own approval of those is off, and the ask
 *   goes through ORCA's policy as `<server>: <tool>` (`codexAskRequest`).
 * - A config file that adds a server is refused before the thread starts (#1160), and so is one
 *   that names a server ORCA configures, even disabled: its settings would merge into ORCA's.
 *   Once the thread runs, `mcpServerStatus/list` and Codex's startup reports must name ORCA's
 *   servers only; any other (a plugin's) refuses or breaks the session.
 * - A server that fails to start is reported, never silent: logged with Codex's reason and
 *   given to the session's `onMcpServerStatus`. The session goes on, as on the ACP route, and
 *   that server's calls fail.
 */
import { OrcaError, type McpServerConfig } from "@orca/core";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A name Codex accepts for an MCP server, and that ORCA repeats in an error. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Codex's approval mode for every MCP server ORCA configures: each call asks. */
export const CODEX_MCP_APPROVAL_MODE = "prompt";

/** The `config.mcp_servers` a thread of ORCA's servers starts with, or undefined for none. */
export function codexMcpServersConfig(
  agentId: string,
  servers: readonly McpServerConfig[],
): Record<string, Record<string, unknown>> | undefined {
  if (servers.length === 0) return undefined;
  // Own keys only: a name like `__proto__` assigned to a plain object would set its prototype
  // and drop out of the serialized config while ORCA still counts it as configured.
  const entries: [string, Record<string, unknown>][] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (!SERVER_NAME.test(server.name))
      throw new OrcaError(
        "CONFIG_INVALID",
        `agent ${agentId} has an MCP server whose name Codex does not accept; use letters, digits, "_" and "-" only`,
        { agentId },
      );
    if (seen.has(server.name))
      throw new OrcaError("CONFIG_INVALID", `agent ${agentId} has two MCP servers named ${server.name}`, {
        agentId,
        server: server.name,
      });
    const env = Object.fromEntries(
      Object.entries(server.env).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    seen.add(server.name);
    entries.push([
      server.name,
      {
        command: server.command,
        args: [...server.args],
        ...(Object.keys(env).length ? { env } : {}),
        enabled: true,
        default_tools_approval_mode: CODEX_MCP_APPROVAL_MODE,
      },
    ]);
  }
  const config = Object.fromEntries(entries);
  if (Object.keys(config).length !== servers.length)
    throw new OrcaError("INTERNAL", "an MCP server was lost from the config");
  return config;
}

/** A server's startup as Codex reported it. Codex's reason is redacted of the session's secrets. */
export interface CodexMcpServerStatus {
  server: string;
  status: "starting" | "ready" | "failed" | "cancelled";
  /** Codex's reason, for a failed start. */
  error?: string;
}

const STARTUP_STATES = new Set(["starting", "ready", "failed", "cancelled"]);

/** What is wrong with an `mcpServer/startupStatus/updated` payload, or undefined. */
export function codexMcpStartupProblem(params: Record<string, unknown>): string | undefined {
  if (typeof params.name !== "string" || !params.name) return "an MCP server status without its server";
  if (!STARTUP_STATES.has(params.status as string)) return "an MCP server status ORCA does not know";
  if (!(params.error === null || params.error === undefined || typeof params.error === "string"))
    return "an MCP server status with a malformed error";
  return undefined;
}

/** The refusal for an MCP server running in the thread that ORCA did not configure. */
export function codexForeignMcpServer(agentId: string, names: readonly string[]): OrcaError {
  const shown = names.map((n) => (SERVER_NAME.test(n) ? n : "(a server whose name ORCA does not repeat)"));
  return new OrcaError(
    "NOT_SUPPORTED",
    `agent ${agentId}: Codex runs the MCP server${shown.length > 1 ? "s" : ""} ${shown.join(", ")}, which ORCA did not configure. ` +
      `ORCA refuses the session rather than let calls go to a server outside its view; remove ${shown.length > 1 ? "them" : "it"} from Codex's config or plugins.`,
    { agentId, servers: shown, reason: "codex-mcp-unconfigured" },
  );
}

/**
 * The servers an `mcpServerStatus/list` answer names that ORCA did not configure: empty when
 * every one is ORCA's. A server not listed yet (still starting) is not a problem. Throws a
 * protocol error for an answer ORCA cannot read.
 */
export function codexForeignMcpServers(agentId: string, answer: unknown, own: ReadonlySet<string>): string[] {
  if (
    !isObject(answer) ||
    !Array.isArray(answer.data) ||
    !answer.data.every((s) => isObject(s) && typeof s.name === "string")
  )
    throw new OrcaError(
      "AGENT_PROTOCOL",
      `agent ${agentId}: codex app-server answered mcpServerStatus/list with a shape ORCA does not know`,
      { agentId, method: "mcpServerStatus/list" },
    );
  return (answer.data as { name: string }[]).map((s) => s.name).filter((n) => !own.has(n));
}
