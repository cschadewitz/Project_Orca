/**
 * The CLI's selection flags (#190, #126): `--agent role=agentId`, `--model [agentId=]modelId`,
 * `--item-workflow id` and `--template-pack name`, turned into the run's `RunOverrides` (#186)
 * and checked against the config before a run is started, so a typo fails with the known set
 * rather than on the first step that needs it.
 */
import type { AgentRegistry } from "@orca/agents";
import {
  OrcaError,
  type AgentSelector,
  type RunOverrides,
  type TemplateRegistry,
  type WorkflowRegistry,
} from "@orca/core";
import type { CommandContext } from "./index.js";

/** What a selection is checked against: the loaded config's agents and workflows. */
export interface SelectionScope {
  agents: AgentRegistry;
  workflows: WorkflowRegistry;
  /** The workflows the run will start with; their agent nodes decide which agents are in play. */
  workflowIds: string[];
  /** When given, `--template-pack` must name a pack that overrides at least one template. */
  templates?: TemplateRegistry;
}

/** Template packs present in the registry (`TemplateRegistry.packs`, shared with the ACP facade). */
export function knownTemplatePacks(templates: TemplateRegistry): string[] {
  return templates.packs();
}

/**
 * Refuse a template pack that overrides nothing - a typo'd pack name would otherwise run every
 * prompt from the base set and say nothing. `TEMPLATE_NOT_FOUND`, listing the packs there are.
 */
export function requireTemplatePack(templates: TemplateRegistry, pack: string): string[] {
  const overridden = templates.packOverrides(pack);
  if (!overridden.length)
    throw new OrcaError("TEMPLATE_NOT_FOUND", `template pack '${pack}' overrides no template`, {
      pack,
      known: knownTemplatePacks(templates),
    });
  return overridden;
}

function list(v: string | boolean | string[] | undefined): string[] {
  if (v === undefined || typeof v === "boolean") return [];
  return Array.isArray(v) ? v : [v];
}

function pair(flag: string, raw: string): [string, string] {
  const i = raw.indexOf("=");
  if (i <= 0 || i === raw.length - 1)
    throw new OrcaError(
      "CONFIG_INVALID",
      `--${flag} expects ${flag === "agent" ? "role=agentId" : "agentId=modelId"}, got '${raw}'`,
    );
  return [raw.slice(0, i), raw.slice(i + 1)];
}

function requireAgent(agents: AgentRegistry, id: string): void {
  const known = agents.listAgents().map((a) => a.id);
  if (!known.includes(id)) throw new OrcaError("AGENT_NOT_FOUND", `agent '${id}' not configured`, { known });
}

/** Every role any configured agent or the config's role map names. */
function knownRoles(
  agents: AgentRegistry,
  config: { roles: Record<string, string> },
  used: Iterable<string>,
): string[] {
  const roles = new Set<string>([...Object.keys(config.roles), ...used]);
  for (const a of agents.listAgents()) for (const r of a.roles) roles.add(r);
  return [...roles].sort();
}

/**
 * Walk a workflow and the workflows it names (subworkflows, fan-out bodies, a plan-dispatch
 * item workflow), yielding every node. Unknown workflow ids are skipped: `validate` owns that.
 */
function* nodesOf(workflows: WorkflowRegistry, ids: string[]): Generator<Record<string, unknown>> {
  const seen = new Set<string>();
  const pending = [...ids];
  const walk = function* (value: unknown): Generator<Record<string, unknown>> {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) yield* walk(v);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.type === "string") yield obj;
    if (typeof obj.workflow === "string") pending.push(obj.workflow);
    for (const v of Object.values(obj)) yield* walk(v);
  };
  while (pending.length) {
    const id = pending.shift()!;
    if (seen.has(id) || !workflows.has(id)) continue;
    seen.add(id);
    yield* walk(workflows.get(id).nodes);
  }
}

/** True when the workflow (or one it names) has a node of the given type. */
export function workflowHasNodeType(workflows: WorkflowRegistry, id: string, type: string): boolean {
  for (const n of nodesOf(workflows, [id])) if (n.type === type) return true;
  return false;
}

/**
 * Build the run's overrides from the selection flags, or `undefined` when none was given.
 * Fails with `AGENT_NOT_FOUND` for an unknown role or agent, `CONFIG_INVALID` for a model an
 * agent does not declare or a bare `--model` with more or fewer than one agent in play, and
 * `WORKFLOW_NOT_FOUND` for an unknown item workflow.
 */
export function selectionOverrides(
  ctx: CommandContext,
  scope: SelectionScope & { config: { roles: Record<string, string> } },
): RunOverrides | undefined {
  const { agents, workflows } = scope;
  const roles: Record<string, string> = {};
  const selectors: AgentSelector[] = [];
  const itemWorkflow = ctx.flags["item-workflow"] as string | undefined;
  if (itemWorkflow !== undefined) workflows.get(itemWorkflow); // WORKFLOW_NOT_FOUND with the known set
  const workflowIds = [...scope.workflowIds, ...(itemWorkflow ? [itemWorkflow] : [])];
  for (const n of nodesOf(workflows, workflowIds)) {
    const sel = n.agent;
    if (typeof sel === "string" || (sel && typeof sel === "object")) selectors.push(sel as AgentSelector);
  }
  const usedRoles = selectors.flatMap((s) => (typeof s === "object" && "role" in s ? [s.role] : []));

  for (const raw of list(ctx.flags.agent)) {
    const [role, agentId] = pair("agent", raw);
    const known = knownRoles(agents, scope.config, usedRoles);
    if (!known.includes(role)) throw new OrcaError("AGENT_NOT_FOUND", `no agent fills role '${role}'`, { role, known });
    requireAgent(agents, agentId);
    roles[role] = agentId;
  }

  const scoped = agents.withOverrides(Object.keys(roles).length ? { roles } : undefined);
  const inPlay = [
    ...new Set(
      selectors.flatMap((s) => {
        try {
          return [scoped.resolve(s).agent.id];
        } catch {
          return [];
        }
      }),
    ),
  ];

  const model: Record<string, string> = {};
  for (const raw of list(ctx.flags.model)) {
    let agentId: string;
    let modelId: string;
    if (raw.includes("=")) [agentId, modelId] = pair("model", raw);
    else {
      if (inPlay.length !== 1)
        throw new OrcaError(
          "CONFIG_INVALID",
          `--model ${raw} needs an agent (--model <agentId>=<modelId>): ${inPlay.length ? `this run uses ${inPlay.join(", ")}` : "this run uses no agent"}`,
          { agents: inPlay },
        );
      [agentId, modelId] = [inPlay[0]!, raw];
    }
    requireAgent(agents, agentId);
    const declared = agents.resolve(agentId).agent.models;
    // An agent that declares no models may still offer some; only a declared list can refuse.
    if (declared && !declared.some((m) => m.id === modelId))
      throw new OrcaError("CONFIG_INVALID", `model '${modelId}' not configured for agent '${agentId}'`, {
        agent: agentId,
        known: declared.map((m) => m.id),
      });
    model[agentId] = modelId;
  }

  const templatePack = ctx.flags["template-pack"] as string | undefined;
  if (templatePack !== undefined && scope.templates) requireTemplatePack(scope.templates, templatePack);
  const overrides: RunOverrides = {
    ...(Object.keys(roles).length ? { roles } : {}),
    ...(Object.keys(model).length ? { model } : {}),
    ...(itemWorkflow ? { itemWorkflow } : {}),
    ...(templatePack ? { templatePack } : {}),
  };
  return Object.keys(overrides).length ? overrides : undefined;
}
