/**
 * `DependencyNode` — one box on the plan's dependency graph (#171), over `.orca-node` and the
 * `.orca-dep--<state>` modifiers.
 *
 * A node is a work item, a decision or something outside the plan, and the three share one
 * shell with a different icon and word in the eyebrow — a decision is a diamond, an external
 * target a dashed box, an item a plain one — so the target kind is never carried by shape
 * alone either. Its state (open, satisfied, failed, waived) is the edge colour's word, said
 * on the node's meta line as well as by its border (rule 4). The name is mono (rule 8).
 *
 * Like `WorkflowNode` it is an `option`: the canvas is one tab stop and selection is
 * `aria-activedescendant`. It never drags.
 */
import type { JSX } from "react";
import type { DependencyState } from "@orca/design";
import { textClass } from "./text.js";

export type DependencyTarget = "item" | "decision" | "external";

const TARGET_WORD: Record<DependencyTarget, string> = {
  item: "work item",
  decision: "decision",
  external: "external",
};

export interface DependencyNodeProps {
  /** The DOM id, so the canvas can name it in `aria-activedescendant`. */
  id: string;
  /** The slug, the decision key or the external key. Drawn in mono. */
  name: string;
  /** The item's title or the decision's, when there is one. */
  title?: string | undefined;
  target: DependencyTarget;
  state: DependencyState;
  /** Said on the node when it sits on a `blocks` cycle. */
  inCycle?: boolean;
  selected?: boolean;
  onOpen?: () => void;
}

export function DependencyNode({
  id,
  name,
  title,
  target,
  state,
  inCycle,
  selected,
  onOpen,
}: DependencyNodeProps): JSX.Element {
  const classes = ["orca-node", "orca-dep", `orca-dep--${state}`];
  if (selected) classes.push("orca-node--selected");
  const words = [state, ...(inCycle ? ["on a cycle"] : [])];
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected === true}
      aria-label={`${words.join(", ")}, ${TARGET_WORD[target]} ${name}${title ? `, ${title}` : ""}`}
      className={classes.join(" ")}
      onClick={onOpen}
    >
      <span className={`orca-node__kind ${textClass("eyebrow")}`}>
        <TargetIcon target={target} />
        {TARGET_WORD[target]}
      </span>
      <span className={`orca-node__name ${textClass("mono-strong")}`}>{name}</span>
      <span className={`orca-node__meta ${textClass("caption")}`}>{words.join(" · ")}</span>
    </div>
  );
}

function TargetIcon({ target }: { target: DependencyTarget }): JSX.Element {
  return (
    <svg
      className="orca-node__icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
    >
      {target === "decision" ? (
        <path d="M8 2 L14 8 L8 14 L2 8 Z" />
      ) : target === "external" ? (
        <rect x="2.5" y="2.5" width="11" height="11" strokeDasharray="2 2" />
      ) : (
        <rect x="2.5" y="2.5" width="11" height="11" />
      )}
    </svg>
  );
}
