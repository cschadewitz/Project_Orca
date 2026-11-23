/**
 * Per-agent knowledge for agents ORCA drives over ACP without a hook of its own (#705 tiers A
 * and B): which versions are qualified, and which of the agent's own settings let tool calls
 * run without reaching ORCA. One module per agent; this one only gathers them.
 */
import { geminiCliFindings, type AgentProfileFinding } from "./gemini-cli.js";
import { piFindings } from "./pi.js";

export * from "./gemini-cli.js";
export * from "./pi.js";

/** Every finding the per-agent modules report for an agent's configuration. */
export function agentProfileFindings(agent: {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, unknown>>;
}): AgentProfileFinding[] {
  return [...geminiCliFindings(agent), ...piFindings(agent)];
}
