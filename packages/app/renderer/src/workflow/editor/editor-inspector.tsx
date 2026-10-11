/**
 * The editor's inspector (#181): whatever is selected, as fields. A node's name and type, the
 * fields its type takes, and its outgoing connections; an edge's ends, condition and label;
 * with nothing selected, the workflow itself.
 *
 * It is `ConfigField` at the inspector's narrower label column (docs/design/70: "the inspector
 * is `ConfigField` at a narrower label column"), so every field states the YAML path it edits
 * - the draft is a file, and the path is how a person finds the line in it.
 *
 * **A field commits when it is left or on Enter, never per keystroke.** Each commit is one
 * draft operation and one undo step; a commit per character would make undo useless and send
 * the daemon a revision per letter. Structured values the form has no control for - artifact
 * inputs, completion policy, a decision's source - are edited as YAML in place, parsed here
 * before anything is sent, and the field says why when they do not parse.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type JSX } from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { DraftGraphPath, DraftIssue, DraftOperation } from "@orca/protocol";
import {
  Button,
  Chip,
  ConfigField,
  Menu,
  Text,
  textClass,
  type ConfigFieldControl,
  type MenuItem,
} from "../../ui/index.js";
import { nestedSteps, type EditorGraph, type EditorNode } from "./draft-model.js";
import type { EditorSelection } from "./editor-canvas.js";

export interface InspectorHandle {
  /** F2: put the cursor in the selected node's name. */
  focusName(): void;
  /** C: open the "connect to" menu for the selected node. */
  openConnect(): void;
  /** Whether keyboard focus is inside the inspector — on a control a selection change takes away. */
  holdsFocus(): boolean;
}

export interface EditorInspectorProps {
  graph: EditorGraph;
  path: DraftGraphPath;
  /** The YAML path of this graph, for the field paths: `` at the root, `nodes.loop.body.graph.` below. */
  yamlPrefix: string;
  selection: EditorSelection | undefined;
  issues: { byNode: ReadonlyMap<string, DraftIssue[]>; byEdge: ReadonlyMap<number, DraftIssue[]> };
  readOnly: boolean;
  /** The workflow's own document, for the nothing-selected view. */
  workflow: { name?: string; description?: string } | undefined;
  /** Registered workflow ids, for a subworkflow's target. */
  workflows: readonly string[];
  onApply: (ops: DraftOperation[]) => Promise<boolean>;
  onSelect: (selection: EditorSelection | undefined) => void;
  /**
   * Delete the selection — the node or edge this inspector is showing — the way the canvas's
   * Delete key does, so both leave the selection and focus in the same place.
   */
  onDelete: (detach: boolean) => void;
  onOpenNested: (step: { node: string; branch?: string; forEach?: true }) => void;
}

const NODE_TYPES = ["agent", "decision", "gate", "set", "loop", "parallel", "subworkflow", "end"];

/** One field a node type takes, and the control that edits it. */
interface FieldSpec {
  key: string;
  label: string;
  kind: "text" | "textarea" | "number" | "choice" | "expression" | "yaml" | "list" | "agent" | "workflow";
  choices?: readonly string[];
  help?: string;
}

const COMMON: readonly FieldSpec[] = [
  { key: "name", label: "Display name", kind: "text", help: "What the canvas shows instead of the id." },
  { key: "description", label: "Description", kind: "textarea" },
];

const FIELDS: Record<string, readonly FieldSpec[]> = {
  agent: [
    { key: "agent", label: "Agent", kind: "agent", help: "A role from the configuration, or a specific agent id." },
    {
      key: "template",
      label: "Template",
      kind: "text",
      help: "A registered prompt template id. Use this or a prompt.",
    },
    { key: "prompt", label: "Prompt", kind: "textarea", help: "An inline prompt. Use this or a template." },
    { key: "inputs", label: "Inputs", kind: "yaml", help: "Artifacts this step reads." },
    { key: "produces", label: "Produces", kind: "yaml", help: "Artifacts this step writes." },
    { key: "completion", label: "Completion", kind: "yaml" },
    { key: "vars", label: "Variables", kind: "yaml" },
    { key: "maxAttempts", label: "Attempts", kind: "number" },
  ],
  decision: [
    {
      key: "source",
      label: "Decided by",
      kind: "yaml",
      help: "An expression, an artifact field, an agent or a person.",
    },
    {
      key: "options",
      label: "Options",
      kind: "list",
      help: "Comma-separated option ids. Each edge's condition picks one.",
    },
    { key: "defaultOption", label: "Default option", kind: "text" },
  ],
  gate: [
    { key: "question", label: "Question", kind: "textarea" },
    { key: "options", label: "Options", kind: "list", help: "Comma-separated option ids." },
    { key: "autoApproveWhen", label: "Approve itself when", kind: "expression" },
    { key: "autoOption", label: "Option when automatic", kind: "text" },
  ],
  set: [
    {
      key: "vars",
      label: "Variables",
      kind: "yaml",
      help: "Names and values; a value starting with = is an expression.",
    },
  ],
  loop: [
    { key: "mode", label: "Mode", kind: "choice", choices: ["while", "until", "forEach"] },
    { key: "condition", label: "Condition", kind: "expression", help: "For while and until." },
    { key: "items", label: "Items", kind: "expression", help: "For forEach." },
    { key: "itemVar", label: "Item variable", kind: "text" },
    { key: "maxIterations", label: "At most", kind: "number" },
    { key: "breakOnFailure", label: "Stop on failure", kind: "choice", choices: ["true", "false"] },
  ],
  parallel: [
    { key: "concurrency", label: "At once", kind: "number" },
    { key: "join", label: "Finish when", kind: "choice", choices: ["all", "any"] },
    { key: "failFast", label: "Stop on failure", kind: "choice", choices: ["true", "false"] },
    { key: "forEach", label: "For each", kind: "yaml" },
  ],
  subworkflow: [
    { key: "workflow", label: "Workflow", kind: "workflow" },
    { key: "vars", label: "Variables", kind: "yaml" },
  ],
  end: [
    { key: "outcome", label: "Outcome", kind: "choice", choices: ["success", "failure", "cancelled"] },
    { key: "message", label: "Message", kind: "text" },
  ],
  start: [],
};

/** Fields an inspector never shows as "other": the type, and the nested graphs, which open instead. */
const STRUCTURAL = new Set(["type", "body", "branches"]);

export const EditorInspector = forwardRef<InspectorHandle, EditorInspectorProps>(
  function EditorInspector(props, ref): JSX.Element {
    const { selection, graph } = props;
    const nameInput = useRef<HTMLInputElement>(null);
    const aside = useRef<HTMLElement>(null);
    const [connectOpen, setConnectOpen] = useState(false);
    useImperativeHandle(
      ref,
      () => ({
        focusName: () => {
          nameInput.current?.focus();
          nameInput.current?.select();
        },
        openConnect: () => setConnectOpen(true),
        holdsFocus: () => aside.current?.contains(document.activeElement) ?? false,
      }),
      [],
    );

    const node = selection?.kind === "node" ? graph.nodes.find((n) => n.id === selection.id) : undefined;
    const edge = selection?.kind === "edge" ? graph.edges.find((e) => e.index === selection.index) : undefined;

    return (
      <aside ref={aside} className="orca-inspector orca-wfedit__inspector" aria-label="Inspector">
        {node ? (
          <NodeInspector
            {...props}
            node={node}
            nameRef={nameInput}
            connectOpen={connectOpen}
            onConnectOpen={setConnectOpen}
          />
        ) : edge ? (
          <EdgeInspector {...props} edgeIndex={edge.index} />
        ) : (
          <WorkflowInspector {...props} />
        )}
      </aside>
    );
  },
);

/* ---------- a node ---------- */

function NodeInspector({
  node,
  graph,
  yamlPrefix,
  issues,
  readOnly,
  workflows,
  onApply,
  onSelect,
  onDelete,
  onOpenNested,
  nameRef,
  connectOpen,
  onConnectOpen,
}: EditorInspectorProps & {
  node: EditorNode;
  nameRef: React.RefObject<HTMLInputElement | null>;
  connectOpen: boolean;
  onConnectOpen: (open: boolean) => void;
}): JSX.Element {
  const at = `${yamlPrefix}nodes.${node.id}`;
  const removed = node.state === "removed";
  const locked = readOnly || removed;
  const specs = [...COMMON, ...(FIELDS[node.type] ?? [])];
  const known = new Set(specs.map((spec) => spec.key));
  const others = Object.keys(node.raw).filter((key) => !known.has(key) && !STRUCTURAL.has(key));
  const outgoing = graph.edges.filter((edge) => edge.from === node.id);
  const nodeIssues = issues.byNode.get(node.id) ?? [];
  const inner = nestedSteps(node);
  const set = (key: string, value: unknown) =>
    onApply([
      value === undefined
        ? { op: "updateNode", id: node.id, unset: [key] }
        : { op: "updateNode", id: node.id, set: { [key]: value } },
    ]);

  const targets: MenuItem[] = graph.nodes
    .filter((n) => n.id !== node.id && n.id !== graph.start && n.state !== "removed")
    .map((n) => ({ id: n.id, label: n.id, hint: n.type }));

  return (
    <>
      <div className="orca-inspector__head">
        <Chip>{node.type}</Chip>
        {/* The title truncates at its end when the pane is narrower than the id, so the whole
            id is in its title (components.css, `.orca-inspector__title`). */}
        <span className={`orca-inspector__title ${textClass("mono-strong")}`} title={node.id}>
          {node.id}
        </span>
        {node.state && <Text style="caption">{node.state}</Text>}
      </div>
      <div className="orca-inspector__body">
        {removed && (
          <p className={textClass("caption")}>
            This node is removed in the draft. Undo brings it back; its edges stay until you delete or reconnect them.
          </p>
        )}
        {nodeIssues.length > 0 && (
          <ul className="orca-wfedit__issues" aria-label="Problems with this node">
            {nodeIssues.map((issue, index) => (
              <li key={index} className={textClass("caption")}>
                <span aria-hidden="true">{SEVERITY_GLYPH[issue.severity]}</span> {SEVERITY_WORD[issue.severity]}:{" "}
                {issue.message}
              </li>
            ))}
          </ul>
        )}

        <div className="orca-inspector__group">Node</div>
        <ConfigField label="Id" path={at} help="Renaming updates every edge that names it.">
          {(control) => (
            <CommitInput
              control={control}
              inputRef={nameRef}
              value={node.id}
              mono
              readOnly={locked}
              pattern="^[A-Za-z0-9_-]+$"
              onCommit={(to) =>
                void onApply([{ op: "renameNode", id: node.id, to }]).then(
                  (ok) => ok && onSelect({ kind: "node", id: to }),
                )
              }
            />
          )}
        </ConfigField>
        {node.id !== graph.start && (
          <ConfigField label="Type" path={`${at}.type`} help="Fields the new type does not use are kept and flagged.">
            {(control) =>
              locked ? (
                <span {...control} className={textClass("mono-body")}>
                  {node.type}
                </span>
              ) : (
                <Menu
                  label="Node type"
                  items={NODE_TYPES.map((type) => ({ id: type, label: type }))}
                  onChoose={(item) =>
                    item.id !== node.type && void onApply([{ op: "changeType", id: node.id, type: item.id }])
                  }
                  triggerClassName={`orca-input ${textClass("mono-body")}`}
                  triggerProps={control}
                >
                  {node.type}
                </Menu>
              )
            }
          </ConfigField>
        )}

        <div className="orca-inspector__group">Configuration</div>
        {specs.map((spec) => (
          <FieldEditor
            key={spec.key}
            spec={spec}
            path={`${at}.${spec.key}`}
            value={node.raw[spec.key]}
            readOnly={locked}
            workflows={workflows}
            issue={nodeIssues.find(
              (issue) => issue.path.endsWith(`.${spec.key}`) || issue.path.includes(`.${spec.key}.`),
            )}
            onCommit={(value) => void set(spec.key, value)}
          />
        ))}
        {others.map((key) => (
          <FieldEditor
            key={key}
            spec={{ key, label: key, kind: "yaml" }}
            path={`${at}.${key}`}
            value={node.raw[key]}
            readOnly={locked}
            workflows={workflows}
            issue={nodeIssues.find((issue) => issue.path.endsWith(`.${key}`))}
            onCommit={(value) => void set(key, value)}
          />
        ))}

        {inner.length > 0 && (
          <>
            <div className="orca-inspector__group">Inside</div>
            <div className="orca-wfedit__row">
              {inner.map((step) => (
                <Button
                  key={`${step.branch ?? ""}${step.forEach ? "*" : ""}`}
                  size="sm"
                  onClick={() => onOpenNested(step)}
                >
                  {`Open ${step.label}`}
                </Button>
              ))}
            </div>
          </>
        )}

        {node.type !== "end" && !removed && (
          <>
            <div className="orca-inspector__group">Connections out</div>
            {outgoing.length === 0 && <Text style="caption">Nothing follows this node yet.</Text>}
            <ul className="orca-wfedit__edges">
              {outgoing.map((edge) => (
                <li key={edge.index} className="orca-wfedit__edge">
                  <button
                    type="button"
                    className={`orca-bare orca-wfedit__edge-link ${textClass("mono-body")}`}
                    onClick={() => onSelect({ kind: "edge", index: edge.index })}
                  >
                    {`→ ${edge.to}`}
                  </button>
                  <Text style="caption">{edge.label ?? edge.when ?? "always"}</Text>
                </li>
              ))}
            </ul>
            {!readOnly && (
              <div className="orca-wfedit__row">
                <Menu
                  label="Connect to"
                  items={targets}
                  open={connectOpen}
                  onOpenChange={onConnectOpen}
                  onChoose={(item) => void onApply([{ op: "addEdge", from: node.id, to: item.id }])}
                  triggerClassName={`orca-btn orca-btn--sm ${textClass("label")}`}
                >
                  Connect to…
                </Menu>
              </div>
            )}
          </>
        )}

        {!readOnly && (
          <>
            <div className="orca-inspector__group">Actions</div>
            <div className="orca-wfedit__row">
              {!removed && node.type === "start" && node.id !== graph.start && (
                <Button size="sm" onClick={() => void onApply([{ op: "setStart", id: node.id }])}>
                  Make this the start
                </Button>
              )}
              {/* The default tone, and no confirmation - the policy panel's Remove, for the same
                  reason. Delete edits the draft and nothing else: the node is struck through in
                  it, Undo (⌘Z) brings it back, and the workflow file is untouched until Review
                  and publish, which shows the diff before it writes. A destructive control
                  confirms only an act with no way back (docs/design/60-implementation.md), and
                  in this editor that act is Discard, which asks. Red on every resting inspector
                  was saturation no status put there (the brand book's Colour); the danger tone
                  is for the control that commits, like the armed Discard every change.
                  Both go through the editor's delete, the canvas Delete key's: the button goes
                  with the node, so the selection moves to the next node and focus to the canvas
                  rather than falling to the page body (`workflow-editor.tsx`). */}
              {!removed && node.id !== graph.start && (
                <>
                  <Button size="sm" onClick={() => onDelete(false)}>
                    Delete
                  </Button>
                  <Button size="sm" tone="ghost" onClick={() => onDelete(true)}>
                    Delete with its connections
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/* ---------- an edge ---------- */

function EdgeInspector({
  edgeIndex,
  graph,
  yamlPrefix,
  issues,
  readOnly,
  onApply,
  onDelete,
}: EditorInspectorProps & { edgeIndex: number }): JSX.Element {
  const edge = graph.edges.find((e) => e.index === edgeIndex)!;
  const at = `${yamlPrefix}edges[${edge.index}]`;
  const nodes: MenuItem[] = graph.nodes
    .filter((n) => n.state !== "removed")
    .map((n) => ({ id: n.id, label: n.id, hint: n.type }));
  const edgeIssues = issues.byEdge.get(edge.index) ?? [];
  const update = (patch: Omit<Extract<DraftOperation, { op: "updateEdge" }>, "op" | "index" | "graph">) =>
    void onApply([{ op: "updateEdge", index: edge.index, ...patch }]);

  return (
    <>
      <div className="orca-inspector__head">
        <Chip>edge</Chip>
        <span className={`orca-inspector__title ${textClass("mono-strong")}`} title={`${edge.from} → ${edge.to}`}>
          {`${edge.from} → ${edge.to}`}
        </span>
        {edge.added && <Text style="caption">added</Text>}
      </div>
      <div className="orca-inspector__body">
        {edgeIssues.map((issue, index) => (
          <p key={index} className={textClass("caption")}>
            <span aria-hidden="true">{SEVERITY_GLYPH[issue.severity]}</span> {SEVERITY_WORD[issue.severity]}:{" "}
            {issue.message}
          </p>
        ))}
        {(["from", "to"] as const).map((end) => (
          <ConfigField key={end} label={end === "from" ? "From" : "To"} path={`${at}.${end}`}>
            {(control) =>
              readOnly ? (
                <span {...control} className={textClass("mono-body")}>
                  {edge[end]}
                </span>
              ) : (
                <Menu
                  label={end === "from" ? "Edge source" : "Edge target"}
                  items={nodes}
                  onChoose={(item) => update({ [end]: item.id })}
                  triggerClassName={`orca-input ${textClass("mono-body")}`}
                  triggerProps={control}
                >
                  {edge[end]}
                </Menu>
              )
            }
          </ConfigField>
        ))}
        <ConfigField
          label="Only when"
          path={`${at}.when`}
          help="An expression. Leave it empty for the default path; a decision's edges usually test choice == 'option'."
        >
          {(control) => (
            <CommitInput
              control={control}
              value={edge.when ?? ""}
              mono
              readOnly={readOnly}
              onCommit={(text) => update({ when: text === "" ? null : text })}
            />
          )}
        </ConfigField>
        <ConfigField label="Label" path={`${at}.label`} help="What the canvas prints on the edge.">
          {(control) => (
            <CommitInput
              control={control}
              value={edge.label ?? ""}
              readOnly={readOnly}
              onCommit={(text) => update({ label: text === "" ? null : text })}
            />
          )}
        </ConfigField>
        {/* Quiet like the node's Delete: it takes the edge out of the draft, which Undo puts
            back and only Review and publish writes. The selection moves to the node the edge
            left from, and focus to the canvas, as the node's Delete does. */}
        {!readOnly && (
          <div className="orca-wfedit__row">
            <Button size="sm" onClick={() => onDelete(false)}>
              Delete edge
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/* ---------- the workflow ---------- */

function WorkflowInspector({ graph, path, workflow, readOnly, onApply }: EditorInspectorProps): JSX.Element {
  const starts = graph.nodes.filter((n) => n.type === "start" && n.state !== "removed");
  const title = path.length === 0 ? (workflow?.name ?? "") : path.map((step) => step.node).join(" ▸ ");
  return (
    <>
      <div className="orca-inspector__head">
        <Chip>{path.length === 0 ? "workflow" : "inline graph"}</Chip>
        <span className={`orca-inspector__title ${textClass("mono-strong")}`} title={title}>
          {title}
        </span>
      </div>
      <div className="orca-inspector__body">
        <Text style="caption">
          Select a node or an edge to edit it. Drag nodes from the palette onto the canvas, or onto an edge to insert
          one.
        </Text>
        {path.length === 0 && (
          <>
            <div className="orca-inspector__group">Workflow</div>
            <ConfigField label="Name" path="name">
              {(control) => (
                <CommitInput
                  control={control}
                  value={workflow?.name ?? ""}
                  readOnly={readOnly}
                  onCommit={(name) => name !== "" && void onApply([{ op: "setWorkflow", name }])}
                />
              )}
            </ConfigField>
            <ConfigField label="Description" path="description">
              {(control) => (
                <CommitInput
                  control={control}
                  value={workflow?.description ?? ""}
                  multiline
                  readOnly={readOnly}
                  onCommit={(description) =>
                    void onApply([{ op: "setWorkflow", description: description === "" ? null : description }])
                  }
                />
              )}
            </ConfigField>
          </>
        )}
        <div className="orca-inspector__group">This graph</div>
        <Text style="caption">
          {`${graph.nodes.filter((n) => n.state !== "removed").length} nodes, ${graph.edges.length} edges, starting at `}
          <span className={textClass("mono-body")}>{graph.start || "nothing"}</span>
          {starts.length > 1 ? " — more than one start node" : ""}
        </Text>
      </div>
    </>
  );
}

/* ---------- controls ---------- */

export const SEVERITY_GLYPH = { error: "✕", warning: "◆", note: "·" } as const;
export const SEVERITY_WORD = { error: "Error", warning: "Warning", note: "Note" } as const;

function FieldEditor({
  spec,
  path,
  value,
  readOnly,
  workflows,
  issue,
  onCommit,
}: {
  spec: FieldSpec;
  path: string;
  value: unknown;
  readOnly: boolean;
  workflows: readonly string[];
  issue: DraftIssue | undefined;
  onCommit: (value: unknown) => void;
}): JSX.Element {
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => setError(undefined), [value]);
  const shown = error ?? (issue?.severity === "error" ? issue.message : undefined);
  return (
    <ConfigField
      label={spec.label}
      path={path}
      {...(spec.help ? { help: spec.help } : {})}
      {...(shown ? { error: shown } : {})}
    >
      {(control) => {
        switch (spec.kind) {
          case "choice":
            return readOnly ? (
              <span {...control} className={textClass("mono-body")}>
                {display(value)}
              </span>
            ) : (
              <Menu
                label={spec.label}
                items={[...(spec.choices ?? []).map((c) => ({ id: c, label: c })), { id: "", label: "(not set)" }]}
                onChoose={(item) =>
                  onCommit(
                    item.id === "" ? undefined : item.id === "true" ? true : item.id === "false" ? false : item.id,
                  )
                }
                triggerClassName={`orca-input ${textClass("mono-body")}`}
                triggerProps={control}
              >
                {value === undefined ? "(not set)" : display(value)}
              </Menu>
            );
          case "workflow":
            return readOnly ? (
              <span {...control} className={textClass("mono-body")}>
                {display(value)}
              </span>
            ) : (
              <Menu
                label="Workflow to run"
                items={workflows.map((id) => ({ id, label: id }))}
                onChoose={(item) => onCommit(item.id)}
                triggerClassName={`orca-input ${textClass("mono-body")}`}
                triggerProps={control}
              >
                {display(value) || "Choose"}
              </Menu>
            );
          case "agent":
            return <AgentControl control={control} value={value} readOnly={readOnly} onCommit={onCommit} />;
          case "number":
            return (
              <CommitInput
                control={control}
                value={display(value)}
                readOnly={readOnly}
                inputMode="numeric"
                onCommit={(text) => {
                  if (text === "") return onCommit(undefined);
                  const n = Number(text);
                  if (!Number.isFinite(n)) return setError("Enter a number.");
                  onCommit(n);
                }}
              />
            );
          case "list":
            if (Array.isArray(value) && value.some((item) => typeof item !== "string"))
              return (
                <YamlInput control={control} value={value} readOnly={readOnly} onError={setError} onCommit={onCommit} />
              );
            return (
              <CommitInput
                control={control}
                value={Array.isArray(value) ? value.join(", ") : display(value)}
                mono
                readOnly={readOnly}
                onCommit={(text) => {
                  const items = text
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean);
                  onCommit(items.length ? items : undefined);
                }}
              />
            );
          case "yaml":
            return (
              <YamlInput control={control} value={value} readOnly={readOnly} onError={setError} onCommit={onCommit} />
            );
          case "textarea":
            return (
              <CommitInput
                control={control}
                value={display(value)}
                multiline
                readOnly={readOnly}
                onCommit={(text) => onCommit(text === "" ? undefined : text)}
              />
            );
          default:
            return (
              <CommitInput
                control={control}
                value={display(value)}
                mono={spec.kind === "expression"}
                readOnly={readOnly}
                onCommit={(text) => onCommit(text === "" ? undefined : text)}
              />
            );
        }
      }}
    </ConfigField>
  );
}

/** `{ role: builder }`, `{ id: codex }` or a bare string: which kind, and the value. */
function AgentControl({
  control,
  value,
  readOnly,
  onCommit,
}: {
  control: ConfigFieldControl;
  value: unknown;
  readOnly: boolean;
  onCommit: (value: unknown) => void;
}): JSX.Element {
  const record = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  const kind = record && typeof record.id === "string" ? "id" : "role";
  const current = typeof value === "string" ? value : record ? display(record[kind]) : "";
  return (
    <span className="orca-wfedit__row">
      {!readOnly && (
        <Menu
          label="Agent by"
          items={[
            { id: "role", label: "role" },
            { id: "id", label: "agent id" },
          ]}
          onChoose={(item) => current && onCommit({ [item.id]: current })}
          triggerClassName={`orca-input ${textClass("mono-body")}`}
        >
          {kind === "id" ? "agent id" : "role"}
        </Menu>
      )}
      <CommitInput
        control={control}
        value={current}
        mono
        readOnly={readOnly}
        onCommit={(text) => onCommit(text === "" ? undefined : { [kind]: text })}
      />
    </span>
  );
}

/** A value the form has no control for, as YAML. Parsed before it is sent; a parse error stays here. */
function YamlInput({
  control,
  value,
  readOnly,
  onError,
  onCommit,
}: {
  control: ConfigFieldControl;
  value: unknown;
  readOnly: boolean;
  onError: (message: string | undefined) => void;
  onCommit: (value: unknown) => void;
}): JSX.Element {
  const text = useMemo(() => (value === undefined ? "" : stringifyYaml(value).trimEnd()), [value]);
  return (
    <CommitInput
      control={control}
      value={text}
      multiline
      mono
      readOnly={readOnly}
      onCommit={(next) => {
        if (next.trim() === "") return onCommit(undefined);
        try {
          onError(undefined);
          onCommit(parseYaml(next) as unknown);
        } catch (error) {
          onError(`This is not valid YAML: ${(error as Error).message.split("\n")[0]}`);
        }
      }}
    />
  );
}

/**
 * A text control that keeps its own text while it is being typed in and commits once - on
 * Enter (for one line) or when it is left. Escape puts the committed value back.
 */
function CommitInput({
  control,
  value,
  onCommit,
  multiline = false,
  mono = false,
  readOnly,
  pattern,
  inputMode,
  inputRef,
}: {
  control: ConfigFieldControl;
  value: string;
  onCommit: (value: string) => void;
  multiline?: boolean;
  mono?: boolean;
  readOnly: boolean;
  pattern?: string;
  inputMode?: "numeric";
  inputRef?: React.RefObject<HTMLInputElement | null>;
}): JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text === value) return;
    if (pattern !== undefined && !new RegExp(pattern).test(text)) {
      setText(value);
      return;
    }
    onCommit(text);
  };
  const className = `orca-input ${textClass(mono ? "mono-body" : "body")}${multiline ? " orca-wfedit__textarea" : ""}`;
  if (multiline)
    return (
      <textarea
        {...control}
        className={className}
        value={text}
        readOnly={readOnly}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Escape") setText(value);
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) commit();
        }}
      />
    );
  return (
    <input
      {...control}
      ref={inputRef}
      className={className}
      value={text}
      readOnly={readOnly}
      {...(inputMode ? { inputMode } : {})}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") setText(value);
      }}
    />
  );
}

/** A value as one line of text: a string as itself, a number or boolean spelled, anything else as JSON. */
function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return `${value}`;
  return JSON.stringify(value) ?? "";
}
