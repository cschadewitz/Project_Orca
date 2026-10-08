/** Candidate-local references are validated identically for raw, patch and structured writes. */
import type { OrcaConfig } from "@orca/core";
import type { ConfigValidationError } from "@orca/protocol";

export function configReferenceErrors(config: OrcaConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];
  const hosts = new Set<string>(),
    agents = new Set<string>();
  config.hosts.forEach((host, index) => {
    if (hosts.has(host.id)) errors.push({ path: `hosts[${index}].id`, message: "Host ID is already configured." });
    hosts.add(host.id);
  });
  config.agents.forEach((agent, index) => {
    if (agents.has(agent.id)) errors.push({ path: `agents[${index}].id`, message: "Agent ID is already configured." });
    agents.add(agent.id);
    if (!hosts.has(agent.hostId))
      errors.push({
        path: `agents[${index}].hostId`,
        message: "Selected host is not configured; retain the referenced host or explicitly update this agent.",
      });
    // Model availability is session-dependent. The runtime validates offered models,
    // using configured declarations only when the session has no model option.
  });
  for (const [role, id] of Object.entries(config.roles))
    if (!agents.has(id))
      errors.push({
        path: `roles.${role}`,
        message: "Selected agent is not configured; retain the referenced agent or explicitly update this role.",
      });
  if (!hosts.has(config.workspace.hostId))
    errors.push({ path: "workspace.hostId", message: "Selected workspace host is not configured." });
  return errors;
}
