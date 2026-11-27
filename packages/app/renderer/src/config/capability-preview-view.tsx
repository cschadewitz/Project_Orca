/** #335: the review step's per-agent capability preview: ids and deciding scopes, never definitions. */
import type { JSX } from "react";
import { Text } from "../ui/index.js";
import type { AgentCapabilityPreview } from "../../../src/configuration-launch-contract.js";

const CHANGE: Record<AgentCapabilityPreview["entries"][number]["change"], string> = {
  added: "added",
  removed: "removed",
  unchanged: "unchanged",
  "source-changed": "now decided by another scope",
};
const KIND = { mcpServer: "MCP server", skill: "Skill" } as const;

export function CapabilityPreview({ agents }: { agents: readonly AgentCapabilityPreview[] }): JSX.Element | null {
  if (agents.length === 0) return null;
  return (
    <section aria-label="Capability changes" className="orca-config__section">
      <Text style="label-strong">Capabilities each agent gets once applied</Text>
      <Text style="caption">
        At the agent&apos;s own scope, compared with the running configuration. Workflow and node selections can narrow
        these, or turn on ones the agent&apos;s scope lists as available.
      </Text>
      {agents.map((agent) => (
        /* Its id, its note and its list each on a line of their own: as inline spans in a bare
           div the id ran straight into its text ("asking-builderNo MCP servers…", #1200). */
        <div
          key={agent.agent}
          role="group"
          aria-label={`Capabilities of ${agent.agent}`}
          className="orca-config__capability"
        >
          <Text style="mono-id">{agent.agent}</Text>
          {agent.agentRemoved && <Text style="caption">Agent removed: it loses everything below.</Text>}
          {agent.entries.length === 0 ? (
            <Text style="caption">No MCP servers or skills.</Text>
          ) : (
            <ul>
              {agent.entries.map((entry) => (
                <li key={`${entry.kind}:${entry.id}`}>
                  <Text style="caption">{KIND[entry.kind]}</Text> <Text style="mono-id">{entry.id}</Text>{" "}
                  <Text style="caption">
                    {CHANGE[entry.change]}, from {entry.source}
                  </Text>
                </li>
              ))}
            </ul>
          )}
          {agent.warnings.map((path) => (
            <Text key={path} style="caption">
              {path}: this selection changes nothing.
            </Text>
          ))}
        </div>
      ))}
    </section>
  );
}
