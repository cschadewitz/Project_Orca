/**
 * The title Claude's ACP adapter gives a tool call, reproduced from the tool's name and input
 * (#1119 review). A typed `titlePattern` rule is written against the title an ACP ask carries,
 * so a call that reaches ORCA another way (the Claude Agent SDK's `canUseTool` and hooks) must be
 * matched against that same text, or switching routes could slip past a title-based deny.
 *
 * Reproduced exactly for the tools whose adapter title depends only on the input and the
 * session's cwd, as `@agentclientprotocol/claude-agent-acp` 0.109.1 writes it (its
 * `tool-calls/reporters`): Bash and PowerShell, Read, Write, Edit, WebFetch, WebSearch, and
 * every tool its generic reporter titles (MCP tools as `server: tool`, an unknown tool by its
 * name). For any other tool, or input of a type the adapter would turn into text in its own
 * way, this returns undefined and the caller keeps the call restricted (`PolicyCall.approximate`).
 */
import path from "node:path";

/** The tools the adapter has its own reporter for; every other name gets the generic one. */
const ADAPTER_REPORTED = new Set([
  "Agent",
  "Task",
  "Bash",
  "PowerShell",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "ReportFindings",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "Skill",
  "SendMessage",
  "TaskStop",
  "ListAgents",
  "Monitor",
]);

/**
 * Names ORCA's own Claude mapping (`claudeToolCall`) reads differently from the adapter's generic
 * reporter: for these the two routes would not describe the call alike, so no title is claimed.
 */
const MAPPED_DIFFERENTLY = new Set(["MultiEdit", "apply_patch", "view_image", "Other"]);

/** The adapter's `inputString`: a non-empty string field, else undefined. */
const inputString = (input: Record<string, unknown>, key: string): string | undefined => {
  const v = input[key];
  return typeof v === "string" && v !== "" ? v : undefined;
};

/** The adapter's `toDisplayPath`: workspace-relative inside the cwd, as written outside it. */
function toDisplayPath(filePath: string, cwd: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd)
    return path.relative(resolvedCwd, resolvedFile);
  return filePath;
}

/** Claude Code's split of `mcp__<server>__<tool>`, as the adapter does it. */
function mcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0) return undefined;
  const tool = rest.slice(separator + 2);
  return tool ? { server: rest.slice(0, separator), tool } : undefined;
}

/** A field that is absent, or a finite number: the only inputs whose adapter text is certain. */
const optionalNumber = (v: unknown): v is number | undefined =>
  v === undefined || (typeof v === "number" && Number.isFinite(v));

/** The adapter's title for this call, or undefined when it cannot be reproduced with certainty. */
export function claudeAcpTitle(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return inputString(input, "command") ?? "Terminal";
    case "Read": {
      const { offset, limit } = input;
      if (!optionalNumber(offset) || !optionalNumber(limit)) return undefined;
      const filePath = inputString(input, "file_path");
      let range = "";
      if (limit !== undefined && limit > 0) range = ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`;
      else if (offset) range = ` (from line ${offset})`;
      return `Read ${filePath ? toDisplayPath(filePath, cwd) : "File"}${range}`;
    }
    case "Write": {
      // The adapter also takes `path` for the file; ORCA's mapping places the call by `file_path`.
      if (typeof input["file_path"] !== "string") return undefined;
      const filePath = input["file_path"];
      return filePath ? `Write ${toDisplayPath(filePath, cwd)}` : "Preparing file…";
    }
    case "Edit": {
      const filePath = inputString(input, "file_path");
      return filePath ? `Edit ${toDisplayPath(filePath, cwd)}` : "Edit";
    }
    case "WebFetch": {
      const { url, offset } = input;
      if ((url !== undefined && typeof url !== "string") || !optionalNumber(offset)) return undefined;
      return url ? `Fetch ${url}${offset ? ` (from char ${offset})` : ""}` : "Fetch";
    }
    case "WebSearch": {
      const { query } = input;
      if (query !== undefined && typeof query !== "string") return undefined;
      return query ? `Search "${query}"` : "Web search";
    }
    default: {
      if (ADAPTER_REPORTED.has(toolName) || MAPPED_DIFFERENTLY.has(toolName)) return undefined;
      const mcp = mcpToolName(toolName);
      return mcp ? `${mcp.server}: ${mcp.tool}` : toolName || "Unknown Tool";
    }
  }
}
