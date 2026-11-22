/** Build metadata only; all input values are withheld, including artifact references. */
import {
  sha256,
  templateReferences,
  type RunOverrides,
  type WorkflowDefinition,
  type PromptTemplate,
  redactCapabilityManifest,
} from "@orca/core";
import { workflowRevision } from "./orchestrator.js";
import { nodeCapabilityScope, resolveNodeCapabilities } from "./capabilities.js";
import type { GenerationMaterial } from "./configuration-generation.js";

export function launchProvenance(
  material: GenerationMaterial,
  definition: WorkflowDefinition,
  vars: Record<string, unknown>,
  supplied: Record<string, unknown>,
  overrides?: RunOverrides,
  itemWorkflowSource?: "config.program.itemWorkflow",
) {
  const config = material.snapshot.config;
  const agents = material.agents.withOverrides(overrides);
  const selections = Object.entries(definition.nodes).flatMap(([nodeId, node]) => {
    const instruction =
      node.type === "agent" ? node : node.type === "decision" && node.source.kind === "agent" ? node.source : undefined;
    if (!instruction) return [];
    const { agent, host } = agents.resolve(instruction.agent);
    const role =
      typeof instruction.agent === "object" && "role" in instruction.agent ? instruction.agent.role : undefined;
    const overrideModel = typeof overrides?.model === "string" ? overrides.model : overrides?.model?.[agent.id];
    const model = overrideModel ?? agent.defaultModel;
    const template = instruction.template
      ? material.templates.get(instruction.template, overrides?.templatePack ? { pack: overrides.templatePack } : {})
      : undefined;
    const partials: { id: string; revision: string }[] = [];
    const seen = new Set<string>();
    const capture = (asset: PromptTemplate) => {
      if (seen.has(asset.id)) return;
      seen.add(asset.id);
      for (const id of templateReferences(asset.body)) {
        const partial = material.templates.find(id);
        if (!partial) continue;
        if (!seen.has(id)) partials.push({ id, revision: sha256(JSON.stringify(partial)) });
        capture(partial);
      }
    };
    if (template) capture(template);
    // The same resolution the launch preflight checked and the session open will repeat (#335).
    const capabilities = redactCapabilityManifest(
      resolveNodeCapabilities({
        registry: agents,
        agent,
        workflow: definition.capabilities,
        nodeId,
        node: nodeCapabilityScope(node).scope,
        digests: true,
      }).manifest,
    );
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
                revision: sha256(JSON.stringify(template)),
                partials,
                source: template.id === instruction.template ? "workflow.template" : "run.overrides.templatePack",
              },
            }
          : {}),
        // Always present on new records, even empty: absent means a record from before #335.
        capabilities,
      },
    ];
  });
  const itemWorkflow = overrides?.itemWorkflow ?? vars.itemWorkflow;
  return {
    configGeneration: material.snapshot.id,
    workflow: { id: definition.id, version: definition.version, revision: workflowRevision(definition) },
    inputs: Object.keys(vars).map((name) => ({
      name,
      source: Object.hasOwn(supplied, name) ? ("caller" as const) : ("workflow" as const),
      value: "[REDACTED]" as const,
    })),
    selections,
    ...(typeof itemWorkflow === "string"
      ? {
          itemWorkflow: {
            value: itemWorkflow,
            source: overrides?.itemWorkflow
              ? "run.overrides.itemWorkflow"
              : (itemWorkflowSource ??
                (Object.hasOwn(supplied, "itemWorkflow") ? "caller.vars.itemWorkflow" : "workflow.vars.itemWorkflow")),
          },
        }
      : {}),
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
    // Standalone authorization values or a named header, not prose containing
    // "basic worker". Basic credentials encode a user/password pair separated by ':'.
    const authorization = /^(?:Authorization:\s*)?(Bearer|Basic)\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(value);
    if (authorization) {
      const token = authorization[2]!;
      if (authorization[1]!.toLowerCase() === "bearer" || Buffer.from(token, "base64").includes(0x3a)) add(token);
    }
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
  const catalogServers = Object.values(material.agents.capabilities().catalog.mcpServers);
  for (const agent of material.agents.listAgents()) {
    for (const spec of [agent, ...agent.mcpServers, ...catalogServers]) {
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
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2");
  // These names describe credential configuration, not a credential value. Still
  // inspect their values for recognizable token syntax; do not suppress arbitrary
  // short or path-shaped values of actual password/token fields.
  if (/^--?no[-_]/i.test(normalized) || /(?:^|[-_])(?:file|path|mode|prompt|enabled|disabled)$/i.test(normalized))
    return false;
  return /(?:^|[^a-z0-9])(?:api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|token|secret|password|passwd|pass|pwd|credential|credentials|authorization|auth|bearer)(?:$|[^a-z0-9])/i.test(
    normalized,
  );
}
