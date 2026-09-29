/**
 * Session config options: the SDK's shapes converted into ORCA's own
 * (`SessionConfigOption` in @orca/core), so the engine never depends on the
 * ACP SDK. Legacy `modes` become one select with `category: "mode"`; when an
 * agent sends both, `configOptions` wins, as the ACP spec requires.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { SessionConfigOption, SessionConfigSelectOption } from "@orca/core";

const selectOption = (o: acp.SessionConfigSelectOption): SessionConfigSelectOption => ({
  value: o.value,
  name: o.name,
  ...(o.description ? { description: o.description } : {}),
});

export function normalizeConfigOption(sdk: acp.SessionConfigOption): SessionConfigOption {
  const base = {
    id: sdk.id,
    name: sdk.name,
    ...(sdk.description ? { description: sdk.description } : {}),
    ...(sdk.category ? { category: sdk.category } : {}),
  };
  if (sdk.type === "boolean") return { type: "boolean", ...base, currentValue: sdk.currentValue };
  const groups = sdk.options.filter((o): o is acp.SessionConfigSelectGroup => "group" in o);
  const options =
    groups.length > 0
      ? groups.map((g) => ({ group: g.group, name: g.name, options: g.options.map(selectOption) }))
      : (sdk.options as acp.SessionConfigSelectOption[]).map(selectOption);
  return { type: "select", ...base, currentValue: sdk.currentValue, options };
}

/** The options a `session/new` (or load) response carries, `configOptions` preferred over `modes`. */
export function normalizeSessionConfig(created: {
  configOptions?: acp.SessionConfigOption[] | null;
  modes?: acp.SessionModeState | null;
}): SessionConfigOption[] {
  if (created.configOptions) return created.configOptions.map(normalizeConfigOption);
  if (!created.modes) return [];
  return [
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: created.modes.currentModeId,
      options: created.modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        ...(m.description ? { description: m.description } : {}),
      })),
    },
  ];
}

/** One line naming each option's current value, for the event log. */
export function describeConfigOptions(options: readonly acp.SessionConfigOption[]): string {
  if (options.length === 0) return "config options: none";
  return `config options: ${options.map((o) => `${o.id}=${String(o.currentValue)}`).join(", ")}`;
}
