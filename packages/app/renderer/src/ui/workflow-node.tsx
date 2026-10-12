/**
 * `WorkflowNode` — one box on the workflow canvas, over `.orca-node` and its nine type
 * modifiers (`packages/design/css/components.css`).
 *
 * It is here in `ui/` rather than in `workflow/` because it is a primitive over a class the
 * design system already owns, and because the editor (#181) draws the same box with four
 * more states (added, changed, removed, invalid) — `.orca-node--added` and friends are
 * already in the component layer waiting for it. A node that lived inside the viewer's
 * directory would be a node the editor had to reach across for or re-derive.
 *
 * Three things it does that are rules rather than choices:
 *
 * - **The type is a glyph *and* a word.** Every icon here is `aria-hidden` with the type
 *   spelled beside it in the kind eyebrow, for the same reason a status is never colour
 *   alone (RULES.md rule 4): an icon set nobody has seen before carries nothing on its own.
 *   The icons are inline SVG on the 16px grid rather than a font, because they are shapes
 *   rather than characters and there is no bundled face that has them.
 * - **The name is mono** (rule 8) — a node name is a string ORCA produced, and the whole
 *   canvas reads as machine text with the overlay's prose beside it.
 * - **It is an `option`, not a `button`.** Selection on the canvas is
 *   `aria-activedescendant` over one tab stop, like every list in this app, so a node is a
 *   focusable-by-proxy row inside the canvas's `listbox` and never a tab stop of its own.
 *   Sixteen tab stops would be sixteen presses to cross one graph.
 */
import type { JSX } from "react";
import { STATUS_PRESENTATION, type RunStatus } from "@orca/design";
import { StatusChip } from "./status-chip.js";
import { textClass } from "./text.js";

/** The nine types the design system has an icon for. Anything else draws the generic box. */
export type WorkflowNodeType =
  "start" | "end" | "agent" | "decision" | "gate" | "set" | "loop" | "parallel" | "subworkflow";

export const WORKFLOW_NODE_TYPES: readonly WorkflowNodeType[] = [
  "start",
  "end",
  "agent",
  "decision",
  "gate",
  "set",
  "loop",
  "parallel",
  "subworkflow",
];

const KNOWN = new Set<string>(WORKFLOW_NODE_TYPES);

/**
 * The node type as one of the nine, or `undefined` for anything else.
 *
 * `WorkflowNodeView.type` is the node type verbatim and may be a `custom:<name>` a plugin
 * registered, which the protocol is explicit about: "a client that does not know a type draws
 * the generic node rather than dropping it".
 */
export const asNodeType = (type: string): WorkflowNodeType | undefined =>
  KNOWN.has(type) ? (type as WorkflowNodeType) : undefined;

/**
 * What a run did at this node, when a run is overlaid. Absent means the definition view,
 * which is the graph on its own.
 */
export interface WorkflowNodeRunState {
  status: RunStatus;
  /** How many times the run entered this node. Shown from two upwards; one attempt is no news. */
  attempts?: number;
  /** The node the run is at right now. */
  current?: boolean;
}

export interface WorkflowNodeProps {
  /** The DOM id, so the canvas can name it in `aria-activedescendant`. */
  id: string;
  /** One of the nine, or undefined for a `custom:*` the app has no icon for. */
  type: WorkflowNodeType | undefined;
  /** The type as written, which is what the eyebrow prints — `custom:plan-await` and all. */
  typeLabel: string;
  /** The author's name for the node, or its id when it has none. Drawn in mono. */
  name: string;
  runState?: WorkflowNodeRunState;
  /** True when a run is overlaid and this node was not traversed. */
  untaken?: boolean;
  selected?: boolean;
  /** A container's hidden children, as a count: `2 nested graphs`. Absent when nothing is hidden. */
  collapsed?: string;
  /**
   * In the editor (#181): how the draft differs from the published workflow here. Drawn with
   * the design system's draft states, and said in the accessible name, because a border colour
   * alone carries nothing (rule 4).
   */
  draft?: "added" | "changed" | "removed";
  /** In the editor: validation found errors on this node. */
  invalid?: boolean;
  /** A short word pinned to the box's corner - `start`, `2 errors` - spelled out, never an icon alone. */
  flag?: string;
  onOpen?: (id: string) => void;
}

/** Which overlay state a status draws as. Four modifiers, eight statuses, no ninth state. */
function overlayModifier(status: RunStatus, current: boolean): string {
  if (current) return "orca-node--current";
  switch (status) {
    case "running":
      return "orca-node--current";
    case "waiting":
    case "blocked":
    case "held":
      return "orca-node--waiting";
    case "failed":
    case "cancelled":
      return "orca-node--failed";
    case "succeeded":
    case "stale":
      return "orca-node--ran";
  }
}

/**
 * The accessible name, status first (docs/design/50-accessibility-and-keyboard.md: "the
 * status is in the accessible name, first"). With no run overlaid there is no status and the
 * name starts with the type, because that is then the first thing true about the node.
 */
export function workflowNodeName(
  props: Pick<WorkflowNodeProps, "typeLabel" | "name" | "runState" | "untaken" | "draft" | "invalid" | "flag">,
): string {
  const parts: string[] = [];
  if (props.runState) parts.push(STATUS_PRESENTATION[props.runState.status].word);
  parts.push(props.typeLabel, props.name);
  if (props.draft) parts.push(props.draft);
  if (props.invalid) parts.push("has errors");
  if (props.flag !== undefined && !props.invalid) parts.push(props.flag);
  if (props.runState?.current) parts.push("current node");
  if (props.runState?.attempts !== undefined && props.runState.attempts > 1) {
    parts.push(`attempt ${props.runState.attempts}`);
  }
  if (props.untaken) parts.push("not taken");
  return parts.join(", ");
}

export function WorkflowNode({
  id,
  type,
  typeLabel,
  name,
  runState,
  untaken,
  selected,
  collapsed,
  draft,
  invalid,
  flag,
  onOpen,
}: WorkflowNodeProps): JSX.Element {
  const classes = ["orca-node"];
  if (type) classes.push(`orca-node--${type}`);
  if (runState) classes.push(overlayModifier(runState.status, runState.current === true));
  if (untaken) classes.push("orca-node--untaken");
  if (draft) classes.push(`orca-node--${draft}`);
  if (invalid) classes.push("orca-node--invalid");
  if (selected) classes.push("orca-node--selected");

  return (
    <div
      id={id}
      role="option"
      aria-selected={selected === true}
      aria-label={workflowNodeName({
        typeLabel,
        name,
        ...(runState ? { runState } : {}),
        ...(untaken ? { untaken } : {}),
        ...(draft ? { draft } : {}),
        ...(invalid ? { invalid } : {}),
        ...(flag !== undefined ? { flag } : {}),
      })}
      className={classes.join(" ")}
      onClick={onOpen ? () => onOpen(id) : undefined}
    >
      {flag !== undefined && (
        <span className={`orca-node__flag ${textClass("eyebrow")}`} aria-hidden="true">
          {flag}
        </span>
      )}
      <span className={`orca-node__kind ${textClass("eyebrow")}`}>
        <WorkflowNodeIcon type={type} />
        {typeLabel}
      </span>
      <span className={`orca-node__name ${textClass("mono-strong")}`}>{name}</span>
      {/* One meta line: the status word beside its glyph, the attempt when there was more
          than one, and the count of whatever a collapsed container is hiding. Everything on
          it is a fact the daemon sent — there is no progress and no estimate here (rule 12). */}
      {(runState || collapsed !== undefined) && (
        <span className={`orca-node__meta ${textClass("caption")}`}>
          {/* `StatusChip`, not a glyph of this component's own: the glyph and the word come
              from `STATUS_PRESENTATION` in one place and nothing re-declares them. */}
          {runState && <StatusChip status={runState.status} />}
          {runState?.attempts !== undefined && runState.attempts > 1 && <span>attempt {runState.attempts}</span>}
          {collapsed !== undefined && <span>{collapsed}</span>}
        </span>
      )}
    </div>
  );
}

/**
 * The nine icons, on the 16px grid, drawn in `currentColor` so the node's own ink carries
 * them. Each one says something about what the node *does* rather than being decorative:
 * a start is a filled disc and an end a ringed one, a decision is a diamond, a gate is a
 * barred way through, a `set` is an equals, a loop is a circuit, a parallel is two lanes,
 * a subworkflow is a box within a box, and an agent — the only node a person is represented
 * at — is a speech rectangle.
 *
 * A type with no icon (a plugin's `custom:*`) draws the generic square, which is the
 * protocol's instruction rather than a fallback this file invented.
 */
export function WorkflowNodeIcon({ type }: { type: WorkflowNodeType | undefined }): JSX.Element {
  const shape = ((): JSX.Element => {
    switch (type) {
      case "start":
        return <circle cx="8" cy="8" r="5" fill="currentColor" stroke="none" />;
      case "end":
        return (
          <>
            <circle cx="8" cy="8" r="6" />
            <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
          </>
        );
      case "agent":
        return (
          <>
            <rect x="2" y="3" width="12" height="8" rx="1" />
            <path d="M5 11 L5 14 L8 11" />
          </>
        );
      case "decision":
        return <path d="M8 2 L14 8 L8 14 L2 8 Z" />;
      case "gate":
        return (
          <>
            <path d="M3 3 L3 13" />
            <path d="M13 3 L13 13" />
            <path d="M3 8 L10 8" />
            <path d="M7 5 L10 8 L7 11" />
          </>
        );
      case "set":
        return (
          <>
            <path d="M3 6 L13 6" />
            <path d="M3 10 L13 10" />
          </>
        );
      case "loop":
        return (
          <>
            <path d="M13 8 A5 5 0 1 1 8 3" />
            <path d="M8 1 L8 5 L11 3 Z" fill="currentColor" stroke="none" />
          </>
        );
      case "parallel":
        return (
          <>
            <rect x="2" y="2" width="12" height="4" rx="1" />
            <rect x="2" y="10" width="12" height="4" rx="1" />
          </>
        );
      case "subworkflow":
        return (
          <>
            <rect x="1" y="3" width="14" height="10" rx="1" />
            <rect x="5" y="6" width="6" height="4" rx="1" />
          </>
        );
      default:
        return <rect x="3" y="3" width="10" height="10" rx="1" />;
    }
  })();

  return (
    <svg
      className="orca-node__icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
    >
      {shape}
    </svg>
  );
}
