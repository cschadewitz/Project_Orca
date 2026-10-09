/** Request-only selectors over sanitized authorized selection metadata; no provider discovery. */
import type { JSX } from "react";
import type { RequestsSubmitParams } from "@orca/protocol";
import { Button, ConfigField, Menu, Text } from "../ui/index.js";

type Overrides = NonNullable<RequestsSubmitParams["overrides"]>;
export interface OverrideChoice {
  id: string;
  label: string;
}
export interface RequestOverrideChoices {
  roles: readonly { id: string; agents: readonly OverrideChoice[] }[];
  /** Model IDs are scoped to their actual agent IDs; wire `model` is singular. */
  models: readonly { agentId: string; choices: readonly OverrideChoice[] }[];
  itemWorkflows: readonly OverrideChoice[];
  templatePacks: readonly OverrideChoice[];
  provenance: readonly string[];
}
function Choice({
  label,
  path,
  choices,
  value,
  locked,
  choose,
}: {
  label: string;
  path: string;
  choices: readonly OverrideChoice[];
  value: string | undefined;
  locked: boolean;
  choose: (value: string | undefined) => void;
}): JSX.Element {
  return (
    <ConfigField label={label} path={path}>
      {(control) => (
        <Menu
          label={label}
          triggerProps={control}
          triggerClassName="orca-input orca-text-mono-body"
          items={[
            { id: "default", label: "Use configured default", disabled: locked },
            ...choices.map((option, index) => ({ id: String(index), label: option.label, disabled: locked })),
          ]}
          onChoose={(item) => choose(item.id === "default" ? undefined : choices[Number(item.id)]?.id)}
        >
          {value === undefined
            ? "Use configured default"
            : (choices.find((option) => option.id === value)?.label ?? "Unavailable selection")}
        </Menu>
      )}
    </ConfigField>
  );
}
export function RequestOverrides({
  choices,
  value,
  locked,
  onChange,
}: {
  choices: RequestOverrideChoices;
  value: Overrides | undefined;
  locked: boolean;
  onChange: (value: Overrides | undefined) => void;
}): JSX.Element {
  const change = (key: "itemWorkflow" | "templatePack", selected: string | undefined) => {
    const next = { ...value };
    if (selected === undefined) delete next[key];
    else next[key] = selected;
    onChange(Object.keys(next).length === 0 ? undefined : next);
  };
  return (
    <section aria-label="Request overrides">
      {choices.roles.map((role) => (
        <Choice
          key={role.id}
          label={`Agent for ${role.id}`}
          path={`overrides.roles.${role.id}`}
          choices={role.agents}
          value={value?.roles?.[role.id]}
          locked={locked}
          choose={(agentId) => {
            const roles = { ...value?.roles };
            if (agentId === undefined) delete roles[role.id];
            else roles[role.id] = agentId;
            const next = { ...value };
            if (Object.keys(roles).length === 0) delete next.roles;
            else next.roles = roles;
            onChange(Object.keys(next).length === 0 ? undefined : next);
          }}
        />
      ))}
      {choices.models.map((model) => (
        <Choice
          key={model.agentId}
          label={`Model for ${model.agentId}`}
          path={`overrides.model.${model.agentId}`}
          choices={model.choices}
          value={typeof value?.model === "object" ? value.model[model.agentId] : undefined}
          locked={locked || typeof value?.model === "string"}
          choose={(modelId) => {
            const models = typeof value?.model === "object" ? { ...value.model } : {};
            if (modelId === undefined) delete models[model.agentId];
            else models[model.agentId] = modelId;
            const next = { ...value };
            if (Object.keys(models).length === 0) delete next.model;
            else next.model = models;
            onChange(Object.keys(next).length === 0 ? undefined : next);
          }}
        />
      ))}
      {typeof value?.model === "string" && (
        <>
          <Text style="caption">
            A global model override is retained. Clear it to select models for individual agents.
          </Text>
          <Button
            disabled={locked}
            disabledReason="The original launch intent is retained."
            onClick={() => {
              const next = { ...value };
              delete next.model;
              onChange(Object.keys(next).length === 0 ? undefined : next);
            }}
          >
            Use configured model defaults
          </Button>
        </>
      )}
      <Choice
        label="Item workflow"
        path="overrides.itemWorkflow"
        choices={choices.itemWorkflows}
        value={value?.itemWorkflow}
        locked={locked}
        choose={(selected) => change("itemWorkflow", selected)}
      />
      <Choice
        label="Template pack"
        path="overrides.templatePack"
        choices={choices.templatePacks}
        value={value?.templatePack}
        locked={locked}
        choose={(selected) => change("templatePack", selected)}
      />
      {choices.provenance.map((line, index) => (
        <Text key={index} style="mono-id">
          {line}
        </Text>
      ))}
    </section>
  );
}
