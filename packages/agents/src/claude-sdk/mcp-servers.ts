/**
 * ORCA-run MCP servers on the Claude Agent SDK route (#1125), served to Claude as in-process SDK
 * MCP servers (`type: "sdk"`, so Claude sees `mcpServer.source: "sdk"`).
 *
 * Claude is given only each server's name. Every request it makes goes to ORCA's MCP relay
 * (`mcp-relay.ts`, the same one the ACP route uses) through `McpRelay.serve`, with the same
 * checks: the relay starts the real server on ORCA's side, with its secrets and the session's
 * withheld environment, only for a request `authorize` allows; every request has its deadline;
 * a tool call is decided again at the handoff to the server. What reaches Claude for a refusal or
 * a failure is the relay's code and bounded message.
 *
 * The in-process server speaks the MCP version Claude Code connects with (`initialize` is
 * answered here, from the configured name, with tools only), and relays `tools/list` and
 * `tools/call`: the same requests the relay serves over ACP. Claude names the tool use each call
 * belongs to in `_meta["claudecode/toolUseId"]`, which is passed on so the call can be tied to
 * the permission decision Claude asked ORCA for.
 */
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as acpUnstable from "@agentclientprotocol/sdk/unstable";
import { OrcaError } from "@orca/core";
import type { McpRelay, RelayedMcpServer } from "../mcp-relay.js";

/**
 * A server name Claude can carry in a tool name (`mcp__<name>__<tool>`) without ambiguity:
 * `__` would make the split between server and tool a guess.
 */
const SDK_SERVER_NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/;

/** Claude's tool-use key in an MCP request's `_meta`. */
const TOOL_USE_META = "claudecode/toolUseId";

/** Refuse, before anything starts, server names this route cannot serve unambiguously. */
export function checkClaudeSdkMcpServers(agentId: string, servers: readonly Pick<RelayedMcpServer, "name">[]): void {
  const seen = new Set<string>();
  for (const { name } of servers) {
    if (!SDK_SERVER_NAME.test(name) || name.length > 64)
      throw new OrcaError(
        "NOT_SUPPORTED",
        `agent ${agentId} has driver: claude-agent-sdk and an MCP server named "${name}"; on this route a server's name ` +
          `may hold only letters, digits, "-" and single "_", at most 64, so Claude's tool names stay unambiguous.`,
        { agentId, server: name },
      );
    if (seen.has(name))
      throw new OrcaError("CONFIG_INVALID", `agent ${agentId} has two MCP servers named "${name}"`, {
        agentId,
        server: name,
      });
    seen.add(name);
  }
}

/** Claude's view of the session's servers: one in-process SDK server per name, relayed. */
export function claudeSdkMcpServers(
  relay: McpRelay,
  servers: readonly Pick<RelayedMcpServer, "name">[],
): Record<string, McpSdkServerConfigWithInstance> {
  const out: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const { name } of servers) {
    const instance = new McpServer({ name, version: "0" }, { capabilities: { tools: {} } });
    const serve = async (
      method: "tools/list" | "tools/call",
      params: Record<string, unknown> | undefined,
      signal: AbortSignal,
      toolUseId?: string,
    ) => {
      try {
        return (await relay.serve(name, { method, params, signal }, { toolUseId })).result;
      } catch (error) {
        if (error instanceof acpUnstable.McpProtocolError) throw new McpError(error.code, error.message, error.data);
        throw new McpError(-32603, "the request failed");
      }
    };
    instance.server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
      serve("tools/list", request.params as Record<string, unknown> | undefined, extra.signal),
    );
    instance.server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      const params = { ...(request.params as unknown as Record<string, unknown>) };
      const meta = params["_meta"] as Record<string, unknown> | undefined;
      const toolUseId = typeof meta?.[TOOL_USE_META] === "string" ? meta[TOOL_USE_META] : undefined;
      // Claude's own key is for ORCA, not for the server.
      if (meta && TOOL_USE_META in meta) {
        const { [TOOL_USE_META]: _omit, ...rest } = meta;
        params["_meta"] = rest;
      }
      return serve("tools/call", params, extra.signal, toolUseId);
    });
    out[name] = { type: "sdk", name, instance };
  }
  return out;
}
