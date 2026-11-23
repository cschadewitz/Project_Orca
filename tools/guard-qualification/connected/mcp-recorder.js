#!/usr/bin/env node
/**
 * A stdio MCP server for the #706 connected proof: it offers the tools the cases name and, when
 * one is called, appends `{server, tool, input}` to the file in ORCA_706_MCP_LOG. That line is the
 * call's effect, read independently of anything the agent or ORCA reports.
 *
 * Usage: mcp-recorder.js <server name> <tool>[,<tool>…]
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [server, tools = ""] = process.argv.slice(2);
const names = tools.split(",").filter(Boolean);
const logFile = process.env["ORCA_706_MCP_LOG"];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: server, version: "0.0.0" },
        },
      });
      return;
    case "tools/list":
      send({
        id: msg.id,
        result: {
          tools: names.map((name) => ({
            name,
            description: `${name} (#706 recorder)`,
            inputSchema: { type: "object", additionalProperties: true },
          })),
        },
      });
      return;
    case "tools/call":
      if (logFile)
        appendFileSync(
          logFile,
          `${JSON.stringify({ server, tool: msg.params?.name, input: msg.params?.arguments })}\n`,
        );
      send({ id: msg.id, result: { content: [{ type: "text", text: "recorded" }] } });
      return;
    default:
      send({ id: msg.id, result: {} });
  }
});
