/**
 * The ACP facade's session config options (#188): what an ACP client (Kepler's Mode / Model
 * dropdowns, Zed) may select per session, and how a session's choices become the run's
 * `overrides` record (#186).
 *
 * Every option has a default that means "what ORCA does without the option", so a client
 * that never calls `session/set_config_option` gets exactly the pre-#188 behaviour.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { OrcaError, type AgentSpec, type RunOverrides, type WorkflowDefinition } from "@orca/core";

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

const NEXT_RUN = "A change made while a run is in progress applies to the next run.";

/** One session's choices; an absent field is the option's default. */
export interface FacadeSelection {
  workflow?: string;
  itemWorkflow?: string;
  roles: Record<string, string>;
  model?: string;
  templatePack?: string;
  useClientCwd?: boolean;
}

export interface ConfigOptionSources {
  workflows: WorkflowDefinition[];
  agents: AgentSpec[];
  /** Template pack ids beyond the default; empty until template packs exist (#191). */
  templatePacks: string[];
  /** Whether the client advertised boolean config options. */
  booleans: boolean;
  /** `orca/use-client-cwd`'s default (the facade's `useClientCwd`). */
  useClientCwd: boolean;
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
      description: `The model the agents use. ${NEXT_RUN}`,
      currentValue: sel.model ?? DEFAULT_VALUE,
      options: [{ value: DEFAULT_VALUE, name: "Agent default" }],
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
    return { ...sel, useClientCwd: value };
  }
  if (typeof value !== "string" || !flatValues(option.options).includes(value))
    throw new OrcaError("CONFIG_INVALID", `'${String(value)}' is not a value of config option '${configId}'`, {
      configId,
      known: flatValues(option.options),
    });
  const chosen = value === DEFAULT_VALUE || value === REQUEST_VALUE ? undefined : value;
  const set = <K extends keyof FacadeSelection>(key: K): FacadeSelection => {
    const next = { ...sel };
    if (chosen === undefined) delete next[key];
    else (next as Record<string, unknown>)[key] = chosen;
    return next;
  };
  if (configId === WORKFLOW_OPTION) return set("workflow");
  if (configId === ITEM_WORKFLOW_OPTION) return set("itemWorkflow");
  if (configId === MODEL_OPTION) return set("model");
  if (configId === TEMPLATE_PACK_OPTION) return set("templatePack");
  const role = configId.slice(AGENT_OPTION_PREFIX.length);
  const roles = { ...sel.roles };
  if (chosen === undefined) delete roles[role];
  else roles[role] = chosen;
  return { ...sel, roles };
}

/** The run's override record for a selection, or undefined when nothing is selected. */
export function selectionOverrides(sel: FacadeSelection): RunOverrides | undefined {
  const overrides: RunOverrides = {
    ...(Object.keys(sel.roles).length ? { roles: { ...sel.roles } } : {}),
    ...(sel.model ? { model: sel.model } : {}),
    ...(sel.itemWorkflow ? { itemWorkflow: sel.itemWorkflow } : {}),
    ...(sel.templatePack ? { templatePack: sel.templatePack } : {}),
  };
  return Object.keys(overrides).length ? overrides : undefined;
}
