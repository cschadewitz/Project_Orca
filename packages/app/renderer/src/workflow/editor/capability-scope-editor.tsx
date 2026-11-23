/**
 * The inspector's capability scope control (#335), for a workflow or an agent node: per kind,
 * the ids to turn on, turn off, or use exclusively. Each change commits at once as one draft
 * operation. Ids come from the configuration's catalog when it could be read; any id can also
 * be typed (an agent's own inline server, or a catalog the app cannot see).
 */
import { useState, type JSX } from "react";
import { Button, Menu, Text, textClass } from "../../ui/index.js";
import type { DraftCapabilityScope } from "@orca/protocol";
import {
  CAPABILITY_ID,
  SCOPE_KINDS,
  SCOPE_OPS,
  addToScope,
  normalizeScope,
  removeFromScope,
  type CapabilityChoices,
  type Scope,
  type ScopeKind,
  type ScopeOp,
} from "./capability-scope.js";

const KIND_LABEL: Record<ScopeKind, string> = { mcpServers: "MCP servers", skills: "Skills" };
const OP_LABEL: Record<ScopeOp, string> = { enable: "Turn on", disable: "Turn off", replace: "Use only" };

export function CapabilityScopeEditor({
  scope,
  label,
  choices,
  readOnly,
  onCommit,
}: {
  scope: Scope;
  /** Prefixes control names, e.g. "review" for a node or "Workflow". */
  label: string;
  choices: CapabilityChoices | undefined;
  readOnly: boolean;
  onCommit: (scope: DraftCapabilityScope | undefined) => void;
}): JSX.Element {
  const commit = (next: Scope) => onCommit(normalizeScope(next));
  return (
    <div className="orca-wfedit__capabilities" role="group" aria-label={`${label} capabilities`}>
      <Text style="caption">
        Narrow the agent&apos;s MCP servers and skills for this scope, or turn on ones its configuration lists as
        available.
      </Text>
      {SCOPE_KINDS.map((kind) => {
        const selection = scope[kind] ?? {};
        const conflict = !!selection.replace?.length && !!(selection.enable?.length || selection.disable?.length);
        return (
          <div key={kind} role="group" aria-label={`${label} ${KIND_LABEL[kind]}`}>
            <Text style="label-strong">{KIND_LABEL[kind]}</Text>
            {SCOPE_OPS.map((op) => (
              <IdList
                key={op}
                name={`${label} ${KIND_LABEL[kind]} ${OP_LABEL[op]}`}
                title={OP_LABEL[op]}
                ids={selection[op] ?? []}
                choices={choices?.[kind]}
                readOnly={readOnly}
                onAdd={(id) => commit(addToScope(scope, kind, op, id))}
                onRemove={(id) => commit(removeFromScope(scope, kind, op, id))}
              />
            ))}
            {conflict && (
              <Text style="caption">
                &quot;Use only&quot; cannot be combined with &quot;Turn on&quot; or &quot;Turn off&quot;.
              </Text>
            )}
          </div>
        );
      })}
    </div>
  );
}

function IdList({
  name,
  title,
  ids,
  choices,
  readOnly,
  onAdd,
  onRemove,
}: {
  name: string;
  title: string;
  ids: readonly string[];
  choices: readonly string[] | undefined;
  readOnly: boolean;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const offered = (choices ?? []).filter((id) => !ids.includes(id));
  const valid = CAPABILITY_ID.test(typed) && !ids.includes(typed);
  return (
    <div className="orca-wfedit__row">
      <Text style="caption">{title}:</Text>
      {ids.length === 0 && <Text style="caption">none</Text>}
      {ids.map((id) => (
        <span key={id} className="orca-wfedit__row">
          <span className={textClass("mono-body")}>{id}</span>
          {!readOnly && (
            <Button size="sm" aria-label={`Remove ${id} from ${name}`} onClick={() => onRemove(id)}>
              ✕
            </Button>
          )}
        </span>
      ))}
      {!readOnly && offered.length > 0 && (
        <Menu
          label={`Add to ${name}`}
          items={offered.map((id) => ({ id, label: id }))}
          onChoose={(item) => onAdd(item.id)}
        >
          Add
        </Menu>
      )}
      {!readOnly && (
        <input
          aria-label={`Type an id for ${name}`}
          className={`orca-input ${textClass("mono-body")}`}
          value={typed}
          placeholder="id"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && valid) {
              onAdd(typed);
              setTyped("");
            }
          }}
        />
      )}
    </div>
  );
}
