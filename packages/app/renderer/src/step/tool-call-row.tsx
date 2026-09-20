/**
 * `ToolCallRow` — one tool call a step's agent made, as a head that always reads and a
 * body that opens.
 *
 * The head is the row: the tool's name in mono (rule 8 — a tool name is something ORCA
 * produced), a one-line argument summary that truncates rather than wraps, and the state.
 * State is never colour alone (rule 4): `.orca-tool--pending`, `--failed` and `--awaiting`
 * tint the row, and the word beside the name is what actually says which. A call waiting
 * on a person also says what it is waiting to be allowed to do, because that is the one
 * thing a person looking at the screen can act on.
 *
 * The body is `args` and `result` verbatim, in a well. Both were cut to 2,000 characters
 * when the event was written (`toolCallBody` in `@orca/core`, #220) and carry their full
 * length, so a body that was cut says so with the number rather than ending mid-token and
 * letting the reader assume that was all of it.
 *
 * It is a `<details>`, not a `useState`: the disclosure triangle, the `Enter`/`Space`
 * contract and the "expanded" state a screen reader announces are all the element's, and a
 * hand-rolled one would be a second, worse implementation of a widget the platform has.
 * (`Menu` is the primitive for *popovers*; an inline disclosure is not one.)
 */
import type { JSX } from "react";
import { Text, textClass } from "../ui/index.js";
import type { ToolCall, ToolCallState } from "./tool-calls.js";

/** The word beside the name. Colour is the third channel, never the first (rule 4). */
const STATE_WORD: Record<ToolCallState, string> = {
  pending: "running",
  ok: "done",
  failed: "failed",
  "awaiting-permission": "waiting for permission",
};

/** Which modifier the component layer draws for each state. `ok` is quiet (rule 6). */
const STATE_CLASS: Record<ToolCallState, string> = {
  pending: "orca-tool--pending",
  ok: "",
  failed: "orca-tool--failed",
  "awaiting-permission": "orca-tool--awaiting",
};

export interface ToolCallRowProps {
  call: ToolCall;
  /** Open on first render. A failed call is worth opening; a hundred successful ones are not. */
  expanded?: boolean;
}

export function ToolCallRow({ call, expanded }: ToolCallRowProps): JSX.Element {
  const open = expanded ?? call.state === "failed";
  const body = call.args !== undefined || call.result !== undefined;

  return (
    <details className={["orca-tool", STATE_CLASS[call.state]].filter(Boolean).join(" ")} {...(open ? { open } : {})}>
      <summary className="orca-tool__head">
        <span className={`orca-tool__name ${textClass("mono-strong")}`}>{call.tool}</span>
        <span className={`orca-tool__arg ${textClass("mono-id")}`}>{call.argSummary}</span>
        <span className={`orca-tool__meta ${textClass("caption")}`}>
          {call.decision !== undefined && <span className="orca-faint">{call.decision}</span>}
          <span>{STATE_WORD[call.state]}</span>
        </span>
      </summary>
      {call.question !== undefined && <div className={`orca-tool__body ${textClass("mono-log")}`}>{call.question}</div>}
      {body && (
        <div className={`orca-tool__body ${textClass("mono-log")}`}>
          <Part label="args" body={call.args} />
          <Part label="result" body={call.result} />
        </div>
      )}
    </details>
  );
}

function Part({ label, body }: { label: string; body: ToolCall["args"] }): JSX.Element | null {
  if (body === undefined) return null;
  const cut = body.length - body.text.length;
  return (
    <>
      <Text style="caption" className="orca-faint" as="div">
        {label}
        {cut > 0 &&
          ` — showing ${body.text.length.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} characters`}
      </Text>
      <div>{body.text}</div>
    </>
  );
}
