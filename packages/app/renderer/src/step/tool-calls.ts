/**
 * Folding a step's log into its tool calls — the arithmetic behind `ToolCallRow`, as a
 * plain module with a plain test.
 *
 * A tool call is not an event. It is a `tool_call` update that opens it, any number of
 * `tool_call_update`s that grow it, and — when the agent had to ask — an `agent.permission`
 * event that settles it. The list a step shows is the *current* state of each of those, in
 * the order they opened, so the fold is a reduction over the log rather than a filter of it.
 *
 * Three things the wire decides and this module only reads:
 *
 * - **`args` and `result` are capped at write time.** `toolCallBody` in `@orca/core` cuts
 *   both to 2,000 characters when the event is appended and records the full `length`
 *   beside the text, so a row can say "showing 2,000 of 41,318" without the renderer ever
 *   having held the rest. They have been on `AgentUpdateSummary` since #220 and are absent
 *   on a log written before it, which is a row with nothing to expand rather than an empty
 *   one.
 * - **`awaiting-permission` comes from `human.requested`, not from the tool call.** ACP's
 *   own status has no such value: a call whose permission is outstanding is `pending` like
 *   any other. What says otherwise is a `human.requested` of kind `permission` naming the
 *   call, and what settles it is the `agent.permission` event the engine appends with the
 *   `decision` — which is the transition, and the only place the log records one.
 * - **A denial is a failure of the call, not of the run.** `agent.permission` with a
 *   refusing decision leaves the row `failed` with the decision as its reason, because
 *   that is what happened to the tool call; whether the step survives it is the step's.
 */
import type { AgentUpdate, LogEvent } from "./line-buffer.js";

export type ToolCallState = "pending" | "ok" | "failed" | "awaiting-permission";

/** `args` / `result` as the event carries them: cut at write time, with the full length. */
export interface ToolCallBody {
  text: string;
  /** The length before the cut, so a row can say how much it is not showing. */
  length: number;
}

export interface ToolCall {
  /** The ACP call id; a row's identity and its DOM id. */
  id: string;
  /** What the call is called — the agent's own title, or the tool kind when it gave none. */
  tool: string;
  /** `read`, `edit`, `execute`, … Absent when the agent did not classify the call. */
  toolKind?: string;
  /** One line of argument summary; the whole payload is in `args`. */
  argSummary: string;
  state: ToolCallState;
  /** Paths the call touched, as the agent reported them. */
  locations: readonly string[];
  args?: ToolCallBody;
  result?: ToolCallBody;
  /** What a person answered when the call had to ask, once it has been answered. */
  decision?: string;
  /** The question they were asked, while it is still open. */
  question?: string;
}

/** ACP statuses that finish a call, and what each one means for the row. */
const SETTLED: Readonly<Record<string, ToolCallState>> = {
  completed: "ok",
  complete: "ok",
  success: "ok",
  failed: "failed",
  error: "failed",
  cancelled: "failed",
};

/** Decisions that refuse. Anything else — `allow`, `allow_always`, `approve` — lets the call run. */
const REFUSALS = new Set(["deny", "denied", "reject", "rejected", "cancel", "cancelled", "no"]);

/** Whether a decision string refused the call. */
export function refuses(decision: string): boolean {
  return REFUSALS.has(
    decision
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
}

/**
 * A one-line summary of what the tool was called with. The body is JSON far more often
 * than not, and a person scanning a list of calls wants the subject — a path, a command —
 * rather than the envelope; so an object of scalars is rendered as `key=value` pairs and
 * anything else is shown as it arrived, on one line.
 */
export function summarizeArgs(args: ToolCallBody | undefined, locations: readonly string[]): string {
  if (args === undefined) return locations.join(" ");
  const parsed = parseJson(args.text);
  if (parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)) {
    const pairs = Object.entries(parsed as Record<string, unknown>)
      .filter(([, value]) => value !== null && typeof value !== "object")
      .map(([key, value]) => `${key}=${String(value)}`);
    if (pairs.length > 0) return oneLine(pairs.join(" "));
  }
  return oneLine(args.text);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A row never wraps (rule 9), so a summary is one line whatever the payload did. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const bodyOf = (body: AgentUpdate["args"]): ToolCallBody | undefined =>
  body === undefined ? undefined : { text: body.text, length: body.length };

/**
 * Every tool call in a step's log, in the order the agent opened them. `events` is the page
 * `runs.events({ stepRunId })` answered with — the same read the output pane makes, so a
 * step costs one call and not two.
 */
export function foldToolCalls(events: readonly LogEvent[]): ToolCall[] {
  const order: string[] = [];
  const calls = new Map<string, ToolCall>();

  const upsert = (id: string): ToolCall => {
    const existing = calls.get(id);
    if (existing) return existing;
    const created: ToolCall = { id, tool: id, argSummary: "", state: "pending", locations: [] };
    calls.set(id, created);
    order.push(id);
    return created;
  };

  for (const event of events) {
    switch (event.type) {
      case "agent.update": {
        const update = event.payload.update;
        if (update.toolCallId === undefined) break;
        if (update.kind !== "tool_call" && update.kind !== "tool_call_update") break;
        const call = upsert(update.toolCallId);
        apply(call, update);
        break;
      }
      case "human.requested": {
        if (event.payload.kind !== "permission") break;
        const toolCallId = toolCallOf(event.payload.context);
        if (toolCallId === undefined) break;
        const call = upsert(toolCallId);
        call.state = "awaiting-permission";
        call.question = event.payload.question;
        break;
      }
      case "agent.permission": {
        // The settling transition: before this event the call was waiting on a person,
        // after it the call is going ahead or it is not.
        const toolCallId = event.payload.toolCallId;
        if (toolCallId === undefined) break;
        const call = upsert(toolCallId);
        call.decision = event.payload.decision;
        delete call.question;
        call.state = refuses(event.payload.decision) ? "failed" : "pending";
        break;
      }
      default:
        break;
    }
  }

  return order.flatMap((id) => {
    const call = calls.get(id);
    return call ? [{ ...call, argSummary: summarizeArgs(call.args, call.locations) }] : [];
  });
}

/** Fold one update into the call it is about. Absent fields leave what is already there. */
function apply(call: ToolCall, update: AgentUpdate): void {
  if (update.title !== undefined) call.tool = update.title;
  else if (call.tool === call.id && update.toolKind !== undefined) call.tool = update.toolKind;
  if (update.toolKind !== undefined) call.toolKind = update.toolKind;
  if (update.locations !== undefined) call.locations = update.locations;
  const args = bodyOf(update.args);
  if (args !== undefined) call.args = args;
  const result = bodyOf(update.result);
  if (result !== undefined) call.result = result;
  if (update.status === undefined) return;
  const settled = SETTLED[update.status];
  // A call waiting on a person stays waiting until the permission event settles it: ACP's
  // own `pending` cannot tell the two apart, and the ask is the more specific fact.
  if (settled !== undefined) call.state = settled;
  else if (call.state !== "awaiting-permission") call.state = "pending";
}

/** The tool call a permission ask is about, as the engine records it in `context`. */
function toolCallOf(context: Record<string, unknown>): string | undefined {
  const value = context["toolCallId"] ?? context["toolCall"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
