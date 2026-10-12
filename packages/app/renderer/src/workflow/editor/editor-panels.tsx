/**
 * The editor's two side panels (#181, #182): the palette and node outline on the left, and
 * the validation panel docked under the canvas.
 *
 * - **The palette** is drag-and-drop *and* click: drag an entry onto the canvas or an edge,
 *   or press it to add that node after the selected one. Each entry is a button, so the
 *   keyboard reaches every node type with Tab and Enter (`⌘⏎` on the canvas brings focus here).
 * - **The outline** is the node list (`.orca-nodelist`): file order, which is not execution
 *   order. Click a row to select the node everywhere; drag a row by its grip, or `⌥↑`/`⌥↓`
 *   on the canvas, to reorder the file.
 * - **The validation panel is always there**, empty when the draft is clean - "a panel that
 *   appears and disappears is a panel people stop watching" (docs/design/70). Every row names
 *   where it is and selects it when pressed.
 */
import { forwardRef, useImperativeHandle, useRef, useState, type DragEvent, type JSX } from "react";
import { draftGraphKey, type DraftGraphPath, type DraftIssue } from "@orca/protocol";
import { Text, WorkflowNodeIcon, asNodeType, textClass } from "../../ui/index.js";
import { PALETTE, type EditorGraph } from "./draft-model.js";
import { NODE_TYPE_MIME, type EditorSelection } from "./editor-canvas.js";
import { SEVERITY_GLYPH, SEVERITY_WORD } from "./editor-inspector.js";

export interface PaletteHandle {
  focus(): void;
}

export interface EditorSidebarProps {
  graph: EditorGraph;
  selection: EditorSelection | undefined;
  readOnly: boolean;
  issues: { byNode: ReadonlyMap<string, DraftIssue[]> };
  onAdd: (type: string) => void;
  onSelect: (selection: EditorSelection) => void;
  onMove: (id: string, before: string | undefined) => void;
}

export const EditorSidebar = forwardRef<PaletteHandle, EditorSidebarProps>(function EditorSidebar(
  { graph, selection, readOnly, issues, onAdd, onSelect, onMove },
  ref,
): JSX.Element {
  const first = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => first.current?.focus() }), []);
  const [dragging, setDragging] = useState<string | undefined>(undefined);

  const startPaletteDrag = (event: DragEvent<HTMLButtonElement>, type: string) => {
    event.dataTransfer.setData(NODE_TYPE_MIME, type);
    event.dataTransfer.setData("text/plain", type);
    event.dataTransfer.effectAllowed = "copy";
  };

  const live = graph.nodes.filter((node) => node.state !== "removed");
  const ghosts = graph.nodes.filter((node) => node.state === "removed");

  return (
    <aside className="orca-wfedit__sidebar" aria-label="Palette and outline">
      {!readOnly && (
        <section aria-labelledby="orca-wfedit-palette">
          <h2 id="orca-wfedit-palette" className={`orca-inspector__group ${textClass("eyebrow")}`}>
            Add a node
          </h2>
          <ul className="orca-wfedit__palette">
            {PALETTE.map((entry, index) => (
              <li key={entry.type}>
                <button
                  ref={index === 0 ? first : undefined}
                  type="button"
                  draggable
                  className={`orca-bare orca-wfedit__palette-item ${textClass("label")}`}
                  aria-description={`${entry.detail}. Press to add after the selected node, or drag onto the canvas.`}
                  onDragStart={(event) => startPaletteDrag(event, entry.type)}
                  onClick={() => onAdd(entry.type)}
                >
                  <WorkflowNodeIcon type={asNodeType(entry.type)} />
                  <span>{entry.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="orca-wfedit-outline">
        <h2 id="orca-wfedit-outline" className={`orca-inspector__group ${textClass("eyebrow")}`}>
          Outline
        </h2>
        <ul className="orca-nodelist" aria-label="Nodes, in file order">
          {[...live, ...ghosts].map((node) => {
            const errors = (issues.byNode.get(node.id) ?? []).filter((issue) => issue.severity === "error").length;
            const selected = selection?.kind === "node" && selection.id === node.id;
            const movable = !readOnly && node.state !== "removed";
            return (
              <li
                key={node.id}
                className={`orca-nodelist__row${selected ? " orca-nodelist__row--selected" : ""}${dragging === node.id ? " orca-wfedit__row--dragging" : ""}`}
                onDragOver={(event) => {
                  if (dragging !== undefined && dragging !== node.id && movable) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging !== undefined && dragging !== node.id) onMove(dragging, node.id);
                  setDragging(undefined);
                }}
              >
                {movable && (
                  <span
                    className="orca-nodelist__grip"
                    draggable
                    aria-hidden="true"
                    title="Drag to reorder"
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", node.id);
                      setDragging(node.id);
                    }}
                    onDragEnd={() => setDragging(undefined)}
                  >
                    ⋮
                  </span>
                )}
                <button
                  type="button"
                  className="orca-bare orca-wfedit__outline-item"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect({ kind: "node", id: node.id })}
                >
                  <span className={`orca-nodelist__type ${textClass("eyebrow")}`}>{node.type}</span>
                  <span
                    className={`orca-nodelist__name ${textClass("mono-strong")}${node.state === "removed" ? " orca-wfedit__struck" : ""}`}
                  >
                    {node.id}
                  </span>
                  <span className={`orca-nodelist__meta ${textClass("caption")}`}>
                    {[
                      node.id === graph.start ? "start" : "",
                      node.state ?? "",
                      errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
});

export interface ValidationPanelProps {
  issues: readonly DraftIssue[];
  /** The graph on the canvas: rows elsewhere say where, and pressing one goes there. */
  path: DraftGraphPath;
  onGo: (issue: DraftIssue) => void;
}

export function ValidationPanel({ issues, path, onGo }: ValidationPanelProps): JSX.Element {
  const count = (severity: DraftIssue["severity"]) => issues.filter((issue) => issue.severity === severity).length;
  const errors = count("error");
  const warnings = count("warning");
  const notes = count("note");
  const here = draftGraphKey(path);
  return (
    <section className="orca-validation orca-wfedit__validation" aria-labelledby="orca-wfedit-validation">
      <header className="orca-wfedit__validation-head">
        <h2 id="orca-wfedit-validation" className={`${textClass("label-strong")} orca-wfedit__heading`}>
          Validation
        </h2>
        <Text style="caption">
          {`${errors} ${errors === 1 ? "error" : "errors"} · ${warnings} ${warnings === 1 ? "warning" : "warnings"} · ${notes} ${notes === 1 ? "note" : "notes"}`}
        </Text>
      </header>
      {issues.length === 0 ? (
        <div className={`orca-validation__row orca-validation__row--ok ${textClass("caption")}`}>
          <span className="orca-validation__glyph" aria-hidden="true">
            ✓
          </span>
          <span>No problems. The draft validates against the running configuration.</span>
        </div>
      ) : (
        <ul className="orca-wfedit__validation-list" aria-label="Problems">
          {issues.map((issue, index) => {
            const key = draftGraphKey(issue.graph);
            const where = [
              key && key !== here ? key : "",
              issue.node ?? (issue.edge !== undefined ? `edge ${issue.edge}` : ""),
            ]
              .filter(Boolean)
              .join(" ▸ ");
            return (
              <li
                key={index}
                className={`orca-validation__row orca-validation__row--${issue.severity === "error" ? "error" : issue.severity === "warning" ? "warn" : "note"} ${textClass("caption")}`}
              >
                <span className="orca-validation__glyph" aria-hidden="true">
                  {SEVERITY_GLYPH[issue.severity]}
                </span>
                <span className="orca-visually-hidden">{SEVERITY_WORD[issue.severity]}: </span>
                <span>{issue.message}</span>
                {where !== "" && (
                  <button
                    type="button"
                    className={`orca-bare orca-validation__where ${textClass("mono-id")}`}
                    onClick={() => onGo(issue)}
                  >
                    {where}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
