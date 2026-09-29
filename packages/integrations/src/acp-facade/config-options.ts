/**
 * The ACP facade's session config options (#188, #189): what an ACP client (Kepler's Mode /
 * Model dropdowns, Zed) may select per session, and how a session's choices become the run's
 * `overrides` record (#186).
 *
 * Every option has a default that means "what ORCA does without the option", so a client
 * that never calls `session/set_config_option` gets exactly the pre-#188 behaviour.
 *
 * Models are discovered lazily (#189): `orca/model` starts from each agent's declared
 * `AgentSpec.models`, and once a downstream session for an agent has opened, that agent's
 * own advertised options replace the declaration. Downstream options in the other reserved
 * categories are proxied as `orca/<agentId>/<configId>`.
 */
import type * as acp from "@agentclientprotocol/sdk";
import {
  configOptionValues,
  OrcaError,
  type AgentSpec,
  type RunOverrides,
  type SessionConfigOption,
  type WorkflowDefinition,
} from "@orca/core";

/** The value meaning "no selection: use the configuration". Not a valid workflow or agent id. */
export const DEFAULT_VALUE = "orca:default";
/** `orca/workflow`'s default: a plain prompt is submitted as a Request through the program workflow. */
export const REQUEST_VALUE = "orca:request";

export const WORKFLOW_OPTION = "orca/workflow";
export const ITEM_WORKFLOW_OPTION = "orca/item-workflow";
export const AGENT_OPTION_PREFIX = "orca/agent.";
export const MODEL_OPTION = "orca/model";
export const TEMPLATE_PACK_OPTION = "orca/template-pack";
export const CLIENT_CWD_OPTION = "orca/use-client-cwd";

/** ACP's reserved categories other than `model`, which `orca/model` already covers. */
const PROXIED_CATEGORIES = new Set(["mode", "model_config", "thought_level"]);

const NEXT_RUN = "A change made while a run is in progress applies to the next run.";

/** One session's choices; an absent field is the option's default. */
export interface FacadeSelection {
  workflow?: string;
  itemWorkflow?: string;
  roles: Record<string, string>;
  /** `orca/model`'s value, `<agentId>/<modelId>`. */
  model?: string;
  templatePack?: string;
  useClientCwd?: boolean;
  /** Proxied downstream options, by facade option id (`orca/<agentId>/<configId>`). */
  agentConfig?: Record<string, string | boolean>;
}

export interface ConfigOptionSources {
  workflows: WorkflowDefinition[];
  agents: AgentSpec[];
  /** Template pack ids beyond the default (`TemplateRegistry.packs()`, #191). */
  templatePacks: string[];
  /** Whether the client advertised boolean config options. */
  booleans: boolean;
  /** `orca/use-client-cwd`'s default (the facade's `useClientCwd`). */
  useClientCwd: boolean;
  /** Options each agent's downstream session advertised, once one has opened (#189). */
  discovered?: ReadonlyMap<string, readonly SessionConfigOption[]>;
}

const workflowChoices = (workflows: WorkflowDefinition[]): acp.SessionConfigSelectOption[] =>
  workflows.map((w) => ({
    value: w.id,
    name: w.name,
    ...(w.description ? { description: w.description } : {}),
  }));

function agentChoices(candidates: AgentSpec[]): acp.SessionConfigSelectOptions {
  const fallback: acp.SessionConfigSelectOption = { value: DEFAULT_VALUE, name: "Configured role mapping" };
  const choice = (a: AgentSpec): acp.SessionConfigSelectOption => ({ value: a.id, name: a.name ?? a.id });
  const hosts = [...new Set(candidates.map((a) => a.hostId))];
  if (hosts.length <= 1) return [fallback, ...candidates.map(choice)];
  return [
    { group: DEFAULT_VALUE, name: "Default", options: [fallback] },
    ...hosts.map((host) => ({
      group: host,
      name: host,
      options: candidates.filter((a) => a.hostId === host).map(choice),
    })),
  ];
}

/** Every role some configured agent can fill, in first-seen order. */
export function rolesOf(agents: AgentSpec[]): string[] {
  return [...new Set(agents.flatMap((a) => a.roles))];
}

/** The models an agent offers: what its downstream session advertised, else what config declares. */
export function agentModels(
  agent: AgentSpec,
  discovered?: readonly SessionConfigOption[],
): { id: string; name: string; description?: string }[] {
  const live = discovered?.find((o) => o.category === "model" && o.type === "select");
  if (live)
    return configOptionValues(live).map((v) => ({
      id: v.value,
      name: v.name,
      ...(v.description ? { description: v.description } : {}),
    }));
  return (agent.models ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
  }));
}

function modelChoices(src: ConfigOptionSources): acp.SessionConfigSelectOptions {
  const fallback: acp.SessionConfigSelectOption = { value: DEFAULT_VALUE, name: "Agent default" };
  const offering = src.agents
    .map((agent) => ({ agent, models: agentModels(agent, src.discovered?.get(agent.id)) }))
    .filter((x) => x.models.length > 0);
  const choices = (x: (typeof offering)[number]) =>
    x.models.map((m) => ({
      value: `${x.agent.id}/${m.id}`,
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
    }));
  if (offering.length <= 1) return [fallback, ...offering.flatMap(choices)];
  return [
    { group: DEFAULT_VALUE, name: "Default", options: [fallback] },
    ...offering.map((x) => ({ group: x.agent.id, name: x.agent.name ?? x.agent.id, options: choices(x) })),
  ];
}

const selectChoice = (v: {
  value: string;
  name: string;
  description?: string | undefined;
}): acp.SessionConfigSelectOption => ({
  value: v.value,
  name: v.name,
  ...(v.description ? { description: v.description } : {}),
});

function proxiedOptions(src: ConfigOptionSources, sel: FacadeSelection): acp.SessionConfigOption[] {
  const out: acp.SessionConfigOption[] = [];
  for (const agent of src.agents)
    for (const o of src.discovered?.get(agent.id) ?? []) {
      if (!o.category || !PROXIED_CATEGORIES.has(o.category)) continue;
      if (o.type === "boolean" && !src.booleans) continue;
      const id = `orca/${agent.id}/${o.id}`;
      const chosen = sel.agentConfig?.[id];
      const base = {
        id,
        name: `${agent.name ?? agent.id}: ${o.name}`,
        category: o.category,
        description: `${o.description ? `${o.description} ` : ""}Passed to ${agent.id}. ${NEXT_RUN}`,
      };
      out.push(
        o.type === "boolean"
          ? { ...base, type: "boolean", currentValue: typeof chosen === "boolean" ? chosen : o.currentValue }
          : {
              ...base,
              type: "select",
              currentValue: typeof chosen === "string" ? chosen : o.currentValue,
              options: o.options.map((x) =>
                "group" in x ? { group: x.group, name: x.name, options: x.options.map(selectChoice) } : selectChoice(x),
              ) as acp.SessionConfigSelectOptions,
            },
      );
    }
  return out;
}

/** The complete option list for a session, reflecting its current choices. */
export function buildConfigOptions(src: ConfigOptionSources, sel: FacadeSelection): acp.SessionConfigOption[] {
  const options: acp.SessionConfigOption[] = [
    {
      type: "select",
      id: WORKFLOW_OPTION,
      name: "Workflow",
      category: "mode",
      description: `What a plain prompt does: submit a Request through the program workflow, or run one workflow directly. ${NEXT_RUN}`,
      currentValue: sel.workflow ?? REQUEST_VALUE,
      options: [
        { value: REQUEST_VALUE, name: "Submit a Request through the program workflow" },
        ...workflowChoices(src.workflows),
      ],
    },
    {
      type: "select",
      id: ITEM_WORKFLOW_OPTION,
      name: "Work item workflow",
      category: "_workflow",
      description: `The workflow the program runs for each work item. ${NEXT_RUN}`,
      currentValue: sel.itemWorkflow ?? DEFAULT_VALUE,
      options: [{ value: DEFAULT_VALUE, name: "Configured item workflow" }, ...workflowChoices(src.workflows)],
    },
    ...rolesOf(src.agents).map((role): acp.SessionConfigOption => ({
      type: "select",
      id: `${AGENT_OPTION_PREFIX}${role}`,
      name: `Agent: ${role}`,
      category: "_agent",
      description: `The agent that fills the '${role}' role. ${NEXT_RUN}`,
      currentValue: sel.roles[role] ?? DEFAULT_VALUE,
      options: agentChoices(src.agents.filter((a) => a.roles.includes(role))),
    })),
    {
      type: "select",
      id: MODEL_OPTION,
      name: "Model",
      category: "model",
      description: `The model an agent uses; the list fills in from each agent once it has run. ${NEXT_RUN}`,
      currentValue: sel.model ?? DEFAULT_VALUE,
      options: modelChoices(src),
    },
    {
      type: "select",
      id: TEMPLATE_PACK_OPTION,
      name: "Template pack",
      category: "_template_pack",
      description: `The prompt templates the run's agents are given. ${NEXT_RUN}`,
      currentValue: sel.templatePack ?? DEFAULT_VALUE,
      options: [
        { value: DEFAULT_VALUE, name: "Default templates" },
        ...src.templatePacks.map((id) => ({ value: id, name: id })),
      ],
    },
    ...proxiedOptions(src, sel),
  ];
  if (src.booleans)
    options.push({
      type: "boolean",
      id: CLIENT_CWD_OPTION,
      name: "Work in the client's directory",
      category: "_workspace",
      description: `Run in this session's working directory instead of ORCA's workspace provider. ${NEXT_RUN}`,
      currentValue: sel.useClientCwd ?? src.useClientCwd,
    });
  return options;
}

const flatValues = (o: acp.SessionConfigSelectOptions): string[] =>
  o.flatMap((x) => ("group" in x ? x.options.map((y) => y.value) : [x.value]));

/** Apply one `session/set_config_option` to a selection; throws `CONFIG_INVALID` for an unknown id or value. */
export function applyConfigOption(
  options: acp.SessionConfigOption[],
  sel: FacadeSelection,
  configId: string,
  value: string | boolean,
): FacadeSelection {
  const option = options.find((o) => o.id === configId);
  if (!option)
    throw new OrcaError("CONFIG_INVALID", `unknown config option '${configId}'`, {
      configId,
      known: options.map((o) => o.id),
    });
  if (option.type === "boolean") {
    if (typeof value !== "boolean")
      throw new OrcaError("CONFIG_INVALID", `config option '${configId}' takes a boolean`, { configId });
  } else if (typeof value !== "string" || !flatValues(option.options).includes(value))
    throw new OrcaError("CONFIG_INVALID", `'${String(value)}' is not a value of config option '${configId}'`, {
      configId,
      known: flatValues(option.options),
    });
  if (configId === CLIENT_CWD_OPTION) return { ...sel, useClientCwd: value as boolean };
  const chosen = value === DEFAULT_VALUE || value === REQUEST_VALUE ? undefined : value;
  const set = (key: "workflow" | "itemWorkflow" | "model" | "templatePack"): FacadeSelection => {
    const next = { ...sel };
    if (typeof chosen === "string") next[key] = chosen;
    else delete next[key];
    return next;
  };
  if (configId === WORKFLOW_OPTION) return set("workflow");
  if (configId === ITEM_WORKFLOW_OPTION) return set("itemWorkflow");
  if (configId === MODEL_OPTION) return set("model");
  if (configId === TEMPLATE_PACK_OPTION) return set("templatePack");
  if (configId.startsWith(AGENT_OPTION_PREFIX)) {
    const role = configId.slice(AGENT_OPTION_PREFIX.length);
    const roles = { ...sel.roles };
    if (typeof chosen === "string") roles[role] = chosen;
    else delete roles[role];
    return { ...sel, roles };
  }
  // A proxied downstream option: recorded as given.
  return { ...sel, agentConfig: { ...sel.agentConfig, [configId]: value } };
}

/** The run's override record for a selection, or undefined when nothing is selected. */
export function selectionOverrides(sel: FacadeSelection): RunOverrides | undefined {
  const slash = sel.model?.indexOf("/") ?? -1;
  const overrides: RunOverrides = {
    ...(Object.keys(sel.roles).length ? { roles: { ...sel.roles } } : {}),
    ...(sel.model && slash > 0 ? { model: { [sel.model.slice(0, slash)]: sel.model.slice(slash + 1) } } : {}),
    ...(sel.itemWorkflow ? { itemWorkflow: sel.itemWorkflow } : {}),
    ...(sel.templatePack ? { templatePack: sel.templatePack } : {}),
  };
  return Object.keys(overrides).length ? overrides : undefined;
}
