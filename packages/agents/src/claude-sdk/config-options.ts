/**
 * The model and effort choices of a Claude Agent SDK session (#1120), as ORCA session config
 * options: one `model` select (`category: "model"`, which a run's model selection sets, #187)
 * and, for a model that takes one, an `effort` select (`category: "thought_level"`).
 *
 * The models are the ones Claude Code itself lists at `initialize`. Their names and
 * descriptions are the CLI's text, shown to people as the choices' labels only: they are cut
 * to a short length, control characters are taken out, and a row without a usable id is left
 * out. Nothing here reaches an error message except the ids ORCA was asked for.
 */
import type { SessionConfigOption, SessionConfigSelectOption } from "@orca/core";

export const CLAUDE_SDK_MODEL_OPTION = "model";
export const CLAUDE_SDK_EFFORT_OPTION = "effort";
/** The effort value that sets none: Claude Code's own default for the model. */
export const CLAUDE_SDK_DEFAULT_EFFORT = "default";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS: readonly ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ClaudeModelChoice {
  value: string;
  name: string;
  description?: string;
  efforts: readonly ClaudeEffort[];
}

/** A model id: what Claude Code lists and `setModel` takes. Anything else is not offered. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 200;
const MAX_MODELS = 64;

function label(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  if (clean.length === 0) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean;
}

/** The models Claude Code listed at `initialize`, cleaned; duplicates and bad rows left out. */
export function claudeModelChoices(models: unknown): ClaudeModelChoice[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const choices: ClaudeModelChoice[] = [];
  for (const row of models.slice(0, MAX_MODELS) as unknown[]) {
    if (typeof row !== "object" || row === null) continue;
    const m = row as Record<string, unknown>;
    if (typeof m.value !== "string" || !MODEL_ID.test(m.value) || seen.has(m.value)) continue;
    seen.add(m.value);
    const efforts =
      m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)
        ? EFFORTS.filter((e) => (m.supportedEffortLevels as unknown[]).includes(e))
        : [];
    const description = label(m.description, MAX_DESCRIPTION);
    choices.push({
      value: m.value,
      name: label(m.displayName, MAX_LABEL) ?? m.value,
      ...(description ? { description } : {}),
      efforts,
    });
  }
  return choices;
}

/** The model a session starts on: Claude Code's `default` row when it lists one, else the first. */
export function initialModel(choices: readonly ClaudeModelChoice[]): string | undefined {
  return (choices.find((c) => c.value === "default") ?? choices[0])?.value;
}

/** The session's config options for `model` and `effort` as they stand. */
export function claudeSdkConfigOptions(
  choices: readonly ClaudeModelChoice[],
  model: string | undefined,
  effort: string,
): SessionConfigOption[] {
  if (choices.length === 0 || model === undefined) return [];
  const options: SessionConfigOption[] = [
    {
      type: "select",
      id: CLAUDE_SDK_MODEL_OPTION,
      name: "Model",
      category: "model",
      currentValue: model,
      options: choices.map((c): SessionConfigSelectOption => ({
        value: c.value,
        name: c.name,
        ...(c.description ? { description: c.description } : {}),
      })),
    },
  ];
  const efforts = choices.find((c) => c.value === model)?.efforts ?? [];
  if (efforts.length > 0)
    options.push({
      type: "select",
      id: CLAUDE_SDK_EFFORT_OPTION,
      name: "Effort",
      category: "thought_level",
      currentValue: effort,
      options: [
        { value: CLAUDE_SDK_DEFAULT_EFFORT, name: "Default", description: "Claude Code's default for the model" },
        ...efforts.map((e) => ({ value: e, name: e[0]!.toUpperCase() + e.slice(1) })),
      ],
    });
  return options;
}

/** Whether `model` takes `effort` (`default` always fits). */
export function effortFits(choices: readonly ClaudeModelChoice[], model: string, effort: string): boolean {
  if (effort === CLAUDE_SDK_DEFAULT_EFFORT) return true;
  return (choices.find((c) => c.value === model)?.efforts ?? []).includes(effort as ClaudeEffort);
}
