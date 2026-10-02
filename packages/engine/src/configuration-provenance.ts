/** Build metadata only; all input values are withheld, including artifact references. */
import type { RunOverrides, WorkflowDefinition } from "@orca/core";
import { workflowRevision } from "./orchestrator.js";
import type { GenerationMaterial } from "./configuration-generation.js";

export function launchProvenance(
  material: GenerationMaterial,
  definition: WorkflowDefinition,
  vars: Record<string, unknown>,
  supplied: Record<string, unknown>,
  overrides?: RunOverrides,
) {
  const config = material.snapshot.config;
  const agents = material.agents.withOverrides(overrides);
  const selections = Object.entries(definition.nodes).flatMap(([nodeId, node]) => {
    if (node.type !== "agent") return [];
    const { agent, host } = agents.resolve(node.agent);
    const role = typeof node.agent === "object" && "role" in node.agent ? node.agent.role : undefined;
    const overrideModel = typeof overrides?.model === "string" ? overrides.model : overrides?.model?.[agent.id];
    const model = overrideModel ?? agent.defaultModel;
    const template = node.template
      ? material.templates.get(node.template, overrides?.templatePack ? { pack: overrides.templatePack } : {})
      : undefined;
    return [
      {
        nodeId,
        ...(role ? { role } : {}),
        agent: {
          value: agent.id,
          source: role
            ? overrides?.roles?.[role]
              ? "run.overrides.roles"
              : config.roles[role]
                ? "config.roles"
                : "agent.roles"
            : "workflow.agent",
        },
        host: { value: host.id, source: "agent.hostId" },
        ...(model
          ? { model: { value: model, source: overrideModel ? "run.overrides.model" : "agent.defaultModel" } }
          : {}),
        ...(template
          ? {
              template: {
                value: template.id,
                source: template.id === node.template ? "workflow.template" : "run.overrides.templatePack",
              },
            }
          : {}),
      },
    ];
  });
  return {
    configGeneration: material.snapshot.id,
    workflow: { id: definition.id, version: definition.version, revision: workflowRevision(definition) },
    inputs: Object.keys(vars).map((name) => ({
      name,
      source: Object.hasOwn(supplied, name) ? ("caller" as const) : ("workflow" as const),
      value: "[REDACTED]" as const,
    })),
    selections,
    ...(overrides?.templatePack
      ? { templatePack: { value: overrides.templatePack, source: "run.overrides.templatePack" } }
      : {}),
  };
}

/** Configured literals are known to the execution boundary; ambient/resolved credentials are not captured. */
export function configuredGenerationSecrets(material: GenerationMaterial): string[] {
  return material.snapshot.config.agents
    .flatMap((agent) => [
      ...Object.values(agent.env),
      ...agent.args,
      ...agent.mcpServers.flatMap((server) => [...Object.values(server.env), ...server.args]),
    ])
    .filter((value) => value.length > 0);
}
