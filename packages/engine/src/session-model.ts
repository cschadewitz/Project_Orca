/**
 * Applying a run's selected model to an agent session (#187).
 *
 * The model comes from `run.overrides.model` (one id for every agent, or a map keyed by agent
 * id), falling back to the agent's configured `defaultModel`. It is applied through the
 * session's `category: "model"` config option when the agent offers one; an agent that offers
 * none can only be run on a model its config declares in `models`, which is recorded as
 * declared because there is nothing to set.
 */
import type { AgentSession } from "@orca/agents";
import { configOptionValues, OrcaError, type AgentSpec, type RunOverrides, type SessionConfigOption } from "@orca/core";

/** The model a run wants from this agent, or undefined when it selects none. */
export function selectedModel(overrides: RunOverrides | undefined, agent: AgentSpec): string | undefined {
  const m = overrides?.model;
  if (typeof m === "string") return m;
  return m?.[agent.id] ?? agent.defaultModel;
}

type ModelOption = Extract<SessionConfigOption, { type: "select" }>;

export function modelOption(session: AgentSession): ModelOption | undefined {
  return session.configOptions.find((o): o is ModelOption => o.type === "select" && o.category === "model");
}

/** The model the session is on now: the model option's value, or undefined when it has none. */
export function currentModel(session: AgentSession): string | undefined {
  return modelOption(session)?.currentValue;
}

/**
 * Make `session` run on `model`. Resolves to how it got there: `set` (a `session/set_config_option`
 * was sent), `current` (the option already had that value) or `declared` (the agent has no model
 * option and its config lists the id). Throws `AGENT_MODEL_NOT_FOUND` naming what is available when
 * the id is in neither place, and passes the agent's own refusal of the set through as it came.
 */
export async function applyModel(
  session: AgentSession,
  agent: AgentSpec,
  model: string,
): Promise<"set" | "current" | "declared"> {
  const option = modelOption(session);
  if (option) {
    const offered = configOptionValues(option).map((o) => o.value);
    if (!offered.includes(model)) throw notFound(agent, model, offered, "offered by the agent's session");
    if (option.currentValue === model) return "current";
    await session.setConfigOption(option.id, model);
    return "set";
  }
  const declared = (agent.models ?? []).map((m) => m.id);
  if (!declared.includes(model)) throw notFound(agent, model, declared, "declared in its config (`models`)");
  return "declared";
}

function notFound(agent: AgentSpec, model: string, available: string[], where: string): OrcaError {
  return new OrcaError(
    "AGENT_MODEL_NOT_FOUND",
    `agent '${agent.id}' has no model '${model}'; ${
      available.length ? `models ${where}: ${available.join(", ")}` : `it offers no model option and declares no models`
    }`,
    { agentId: agent.id, model, available },
  );
}
