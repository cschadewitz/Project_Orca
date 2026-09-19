/**
 * `StateView` — what a pane shows instead of its content: empty, loading, error,
 * disconnected, no results.
 *
 * Every kind except `loading` has a body and an action, and the types enforce it. A pane
 * that says "nothing here" and stops is a dead end, and a dead end is the thing the
 * information architecture is built to avoid — so "no runs yet" comes with how to start
 * one, and "could not load" comes with retry.
 *
 * `loading` is the exception in both directions: no body, no action, and skeleton rows
 * rather than a glyph, because the useful thing to show while waiting is the shape of
 * what is coming.
 */
import type { JSX } from "react";
import { STATE_VIEW_PRESENTATION, type StateViewKind } from "@orca/design";
import { Button } from "./button.js";

export interface StateViewAction {
  label: string;
  onClick: () => void;
}

export type StateViewProps =
  | { kind: "loading"; title: string; body?: never; action?: never; className?: string }
  | {
      kind: Exclude<StateViewKind, "loading">;
      title: string;
      /** What the person can do about it. */
      body: string;
      action?: StateViewAction;
      className?: string;
    };

export function StateView(props: StateViewProps): JSX.Element {
  const { kind, title, className } = props;
  const { glyph, word } = STATE_VIEW_PRESENTATION[kind];

  return (
    <div
      className={["orca-state", `orca-state--${kind}`, className].filter(Boolean).join(" ")}
      role="status"
      aria-label={word}
    >
      {props.kind === "loading" ? (
        <div className="orca-state__skeleton" aria-hidden="true">
          <span className="orca-skeleton" />
          <span className="orca-skeleton" />
          <span className="orca-skeleton" />
        </div>
      ) : (
        <span className="orca-state__glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      <span className="orca-state__title">{title}</span>
      {props.kind !== "loading" && <span className="orca-state__body">{props.body}</span>}
      {props.kind !== "loading" && props.action !== undefined && (
        <Button tone="primary" onClick={props.action.onClick}>
          {props.action.label}
        </Button>
      )}
    </div>
  );
}
