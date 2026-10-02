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
              : material.snapshot.effectiveRoles?.[role] &&
                  material.snapshot.effectiveRoles[role] !== config.roles[role]
                ? "plugin.roles"
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

/**
 * Defense-in-depth needles for identifiable configured credentials. A command argument or
 * env value is not inherently secret: treating `acp`, `mcp` or FORCE_COLOR=1 as a needle
 * destroys unrelated public history. Explicit sensitive workflow inputs are collected by
 * protectExecutionInputs separately; all config bytes stay in protected generation storage.
 * This is not arbitrary-secret discovery or taint tracking. Credential-named fields/options
 * and recognizable credential syntax cover configured literals without guessing by entropy.
 */
export function configuredGenerationSecrets(material: GenerationMaterial): string[] {
  const secrets = new Set<string>();
  const add = (value: string) => {
    if (value) secrets.add(value);
  };
  const inspect = (value: string): void => {
    // Common standalone credential formats, including a literal supplied positionally.
    for (const match of value.matchAll(
      /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
    ))
      add(match[0]);
    for (const match of value.matchAll(/(?:Bearer|Basic)\s+([^\s"']+)/gi)) add(match[1]!);
    const header = /^([^:]+):\s*(.+)$/.exec(value);
    if (header && credentialKey(header[1]!)) add(header[2]!);
    try {
      const url = new URL(value);
      if (url.password) {
        add(value);
        add(url.password);
        add(decodeURIComponent(url.password));
      }
      for (const [key, item] of url.searchParams) {
        if (!credentialKey(key)) continue;
        add(value);
        add(item);
        add(encodeURIComponent(item));
      }
    } catch {
      // Most command arguments are not URLs.
    }
  };
  for (const agent of material.agents.listAgents()) {
    for (const spec of [agent, ...agent.mcpServers]) {
      for (const [key, value] of Object.entries(spec.env)) {
        if (credentialKey(key)) add(value);
        inspect(value);
      }
      for (const [index, value] of spec.args.entries()) {
        const assignment = /^([^=]+)=(.*)$/s.exec(value);
        if (assignment && credentialKey(assignment[1]!)) add(assignment[2]!);
        else if (/^-/.test(value) && credentialKey(value) && spec.args[index + 1] !== undefined)
          add(spec.args[index + 1]!);
        inspect(value);
      }
    }
  }
  return [...secrets];
}
function credentialKey(key: string): boolean {
  return /(?:^|[^a-z0-9])(?:api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|token|secret|password|passwd|pass|pwd|credential|credentials|authorization|auth|bearer)(?:$|[^a-z0-9])/i.test(
    key.replace(/([a-z])([A-Z])/g, "$1_$2"),
  );
}
