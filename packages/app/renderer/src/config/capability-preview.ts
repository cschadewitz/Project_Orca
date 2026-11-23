/** #335: what a configuration candidate changes in each agent's capability set, before it is saved and applied. */
import type { ConfigEffectiveCapabilities } from "@orca/protocol";
import type { AgentCapabilityPreview } from "../../../src/configuration-launch-contract.js";

type AgentSet = ConfigEffectiveCapabilities["agents"][string];

/**
 * Candidate against running, per agent, over both sides' agents: those whose set or warnings
 * differ, new agents, and removed agents (with everything they lose). `undefined` when either side is unknown: no preview beats a wrong one.
 */
export function capabilityPreview(
  running: ConfigEffectiveCapabilities | undefined,
  candidate: ConfigEffectiveCapabilities | undefined,
): readonly AgentCapabilityPreview[] | undefined {
  if (!running || !candidate) return undefined;
  const out: AgentCapabilityPreview[] = [];
  const ids = new Set([...Object.keys(running.agents), ...Object.keys(candidate.agents)]);
  for (const agent of [...ids].sort()) {
    // A removed (or renamed) agent loses everything it had; the new name shows as new.
    const removed = !Object.hasOwn(candidate.agents, agent);
    const after: AgentSet | undefined = removed ? undefined : candidate.agents[agent];
    const before: AgentSet | undefined = Object.hasOwn(running.agents, agent) ? running.agents[agent] : undefined;
    const entries: AgentCapabilityPreview["entries"][number][] = [];
    for (const kind of ["mcpServer", "skill"] as const) {
      const list = (set: AgentSet | undefined) => (kind === "mcpServer" ? set?.mcpServers : set?.skills) ?? [];
      const was = new Map(list(before).map((entry) => [entry.id, entry.source]));
      const now = new Map(list(after).map((entry) => [entry.id, entry.source]));
      for (const [id, source] of now) {
        const previous = was.get(id);
        entries.push({
          kind,
          id,
          source,
          change: previous === undefined ? "added" : previous === source ? "unchanged" : "source-changed",
        });
      }
      for (const [id, source] of was) if (!now.has(id)) entries.push({ kind, id, source, change: "removed" });
    }
    if (removed) {
      out.push({ agent, agentRemoved: true, entries, warnings: [] });
      continue;
    }
    const warnings = (after?.warnings ?? []).map((warning) => warning.path);
    const changed = before === undefined || entries.some((entry) => entry.change !== "unchanged");
    const warned = warnings.join("\0") !== (before?.warnings ?? []).map((warning) => warning.path).join("\0");
    if (changed || warned) out.push({ agent, entries, warnings });
  }
  return out;
}
