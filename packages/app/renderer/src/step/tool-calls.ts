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
  const fold = new ToolCallFold();
  fold.add(events);
  return [...fold.snapshot()];
}

type Version<T> = { seq: number; value: T };
type Detail = "title" | "toolKind" | "locations" | "args" | "result";
interface CallEntry {
  first: number;
  details: Map<Detail, Version<AgentUpdate>>;
  firstKind?: Version<AgentUpdate>;
  ask?: Version<string>;
  decision?: Version<string>;
  settled?: Version<string>;
  pending?: Version<string>;
}

/**
 * A compact, sequence-aware tool projection. Keep the latest value of each field and
 * state transition, never streamed text or a history of updates. Permission events can
 * precede an older coalesced agent batch on the wire; field clocks let that batch fill
 * missing details without undoing the newer decision. Earlier pages work the same way.
 * Storage grows with distinct calls, not with chunks or updates to a call.
 */
export class ToolCallFold {
  private entries = new Map<string, CallEntry>();
  private cached: readonly ToolCall[] = [];
  private dirty = false;

  private entry(id: string, seq: number): CallEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { first: seq, details: new Map() };
      this.entries.set(id, entry);
      this.dirty = true;
    }
    if (seq < entry.first) {
      entry.first = seq;
      this.dirty = true;
    }
    return entry;
  }

  /** Accept only the already public/projected wire summary. `text` is never retained. */
  update(seq: number, update: AgentUpdate): void {
    const id = update.toolCallId;
    if (id === undefined || (update.kind !== "tool_call" && update.kind !== "tool_call_update")) return;
    const entry = this.entry(id, seq);
    for (const key of ["title", "toolKind", "locations", "args", "result"] as const) {
      if (update[key] === undefined) continue;
      const previous = entry.details.get(key);
      if (previous !== undefined && previous.seq >= seq) continue;
      // Project the field rather than retaining the whole update (which may have text).
      entry.details.set(key, { seq, value: { kind: update.kind, [key]: update[key] } });
      this.dirty = true;
    }
    if (update.toolKind !== undefined && (entry.firstKind === undefined || seq < entry.firstKind.seq)) {
      entry.firstKind = { seq, value: { kind: update.kind, toolKind: update.toolKind } };
      this.dirty = true;
    }
    if (update.status !== undefined) {
      const key = SETTLED[update.status] === undefined ? "pending" : "settled";
      if (entry[key] === undefined || seq > entry[key].seq) {
        entry[key] = { seq, value: update.status };
        this.dirty = true;
      }
    }
  }

  add(events: readonly LogEvent[]): void {
    for (const event of events) {
      if (event.type === "agent.update") {
        this.update(event.seq, event.payload.update);
      } else if (event.type === "human.requested" && event.payload.kind === "permission") {
        const id = toolCallOf(event.payload.context);
        if (id === undefined) continue;
        const entry = this.entry(id, event.seq);
        if (entry.ask === undefined || event.seq > entry.ask.seq) {
          entry.ask = { seq: event.seq, value: event.payload.question };
          this.dirty = true;
        }
      } else if (event.type === "agent.permission") {
        const id = event.payload.toolCallId;
        if (id === undefined) continue;
        const entry = this.entry(id, event.seq);
        if (entry.decision === undefined || event.seq > entry.decision.seq) {
          entry.decision = { seq: event.seq, value: event.payload.decision };
          this.dirty = true;
        }
      }
    }
  }

  /** Stable by identity until a relevant, nonduplicate update changes the projection. */
  snapshot(): readonly ToolCall[] {
    if (!this.dirty) return this.cached;
    this.cached = [...this.entries]
      .sort((a, b) => a[1].first - b[1].first)
      .map(([id, entry]) => {
        const call: ToolCall = { id, tool: id, argSummary: "", state: "pending", locations: [] };
        const details = [...entry.details.values()];
        if (entry.firstKind !== undefined) details.push(entry.firstKind);
        // Fields from the same event are one update: title takes precedence over kind.
        const bySeq = new Map<number, AgentUpdate>();
        for (const detail of details) bySeq.set(detail.seq, { ...bySeq.get(detail.seq), ...detail.value });
        for (const [, update] of [...bySeq].sort((a, b) => a[0] - b[0])) apply(call, update);
        const transitions: { seq: number; apply: () => void }[] = [];
        const { ask, decision, settled, pending } = entry;
        if (ask !== undefined)
          transitions.push({
            seq: ask.seq,
            apply: () => {
              call.state = "awaiting-permission";
              call.question = ask.value;
            },
          });
        if (decision !== undefined)
          transitions.push({
            seq: decision.seq,
            apply: () => {
              call.decision = decision.value;
              delete call.question;
              call.state = refuses(decision.value) ? "failed" : "pending";
            },
          });
        for (const status of [settled, pending]) {
          if (status !== undefined)
            transitions.push({
              seq: status.seq,
              apply: () => apply(call, { kind: "tool_call_update", status: status.value }),
            });
        }
        for (const transition of transitions.sort((a, b) => a.seq - b.seq)) transition.apply();
        call.argSummary = summarizeArgs(call.args, call.locations);
        return call;
      });
    this.dirty = false;
    return this.cached;
  }
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
