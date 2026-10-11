/**
 * The output pane's buffer: a step's `agent.update` events in, fixed-height rows of log
 * out, at most one commit per 100ms.
 *
 * It is a plain module with no React and no DOM for the reason the rest of a surface's
 * arithmetic is (docs/design/60-implementation.md, "The shape of a surface"): this is the
 * part most likely to be wrong and least well read by a DOM test. Four decisions are worth
 * knowing before changing it.
 *
 * - **Events, not lines, are what is counted.** The buffer holds the last
 *   {@link EVENT_BUFFER_LIMIT} *events*, which is what
 *   docs/design/30-long-running-content.md specifies: one `agent.update` can render many
 *   lines, so 50,000 events is a larger buffer than 50,000 lines, not a smaller one. The
 *   reason to count them this way is that the trim boundary has to be addressable —
 *   `trimmedBefore` is a sequence number `runs.events({ before })` understands, and a line
 *   boundary is not a thing the wire can name.
 * - **A line's number is its event's `seq`.** Not an ordinal. An absolute line number is a
 *   thing ORCA cannot supply once the front of the buffer has been trimmed or a page has
 *   been loaded in front of it, and inventing one is what rule 12 forbids; `seq` is real,
 *   it repeats when one event rendered several lines, and it is the number a person needs
 *   to correlate a line with the log. `component-api.d.ts` said `n`; this is the
 *   correction it asks for when an implementation diverges.
 * - **A chunk is not a line.** ACP streams `agent_message_chunk`s that are fragments of a
 *   line, and the daemon coalesces them into one `agent.update` per step per 100ms without
 *   joining them. So the buffer carries an open line across events and closes it on a
 *   newline; the open line keeps the `seq` of the event that *started* it, which is the
 *   event a `before` cursor has to name to fetch it again.
 * - **Commits are rate-limited, not debounced.** An agent producing forty lines a second
 *   must not cost forty React commits: `push` queues, a frame is requested, and the frame
 *   commits only once {@link COMMIT_INTERVAL_MS} has passed since the last one — otherwise
 *   it asks for another frame. Debouncing instead would stall a steady stream for as long
 *   as it kept going, which is the one thing a live log must not do.
 */
import type { AgentUpdateParams, RunsEventsResult } from "@orca/protocol";
import { unit } from "../ui/count.js";

/** `AgentUpdateSummary`, reached through the protocol: the app may not import `@orca/core`. */
export type AgentUpdate = AgentUpdateParams["updates"][number];
/** One event of a run's log, reached the same way. */
export type LogEvent = RunsEventsResult["events"][number];

/**
 * How many events of a step's output the renderer holds, verbatim from
 * docs/design/30-long-running-content.md. The full log stays on disk and
 * **Load earlier output** pages back into it.
 */
export const EVENT_BUFFER_LIMIT = 50_000;

/**
 * Where a single line stops being a line and becomes an affordance. A base64 blob or a
 * minified bundle can otherwise own a screen, and a row that wrapped would not be a
 * fixed-height row at all (rule 9).
 */
export const LINE_CHAR_LIMIT = 2_000;

/** U+2026, the bundled ellipsis — not the midline U+22EF, which no bundled face carries. */
export const ELLIPSIS = "…";

/** The floor on how often the list is handed a new `items` array. */
export const COMMIT_INTERVAL_MS = 100;

/** How a line is coloured. ACP carries no stdout/stderr split, so this is derived, not read. */
export type LineTone = "out" | "dim" | "err";

/** One line of agent output. */
export interface LineRow {
  kind: "line";
  /** Stable across commits, so React keeps the element when the row after it arrives. */
  key: string;
  /** The `seq` of the event that started this line: the gutter, and the `before` cursor. */
  seq: number;
  text: string;
  tone: LineTone;
  /** Characters left off the end; `0` when the line is whole. */
  folded: number;
}

/**
 * The stream stopped where this row is, and started again where the next one is. Both are
 * rows rather than a banner because *where* the gap falls is the whole of what they say
 * (docs/design/40-connection-states.md).
 */
export interface SeamRow {
  kind: "paused" | "reconnected";
  key: string;
  /** ISO 8601 — the moment the connection changed, rendered as `hh:mm:ss`. */
  at: string;
}

export type OutputRow = LineRow | SeamRow;

/** ACP statuses that mean the update reports a failure; everything else is ordinary output. */
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "denied"]);
/** ACP update kinds the pane renders quietly: an agent thinking is not an agent saying. */
const DIM_KINDS = new Set(["agent_thought_chunk", "plan", "tool_call", "tool_call_update", "user_message_chunk"]);

/** The tone an update's lines take. Failure wins over kind: a failed tool call is not quiet. */
export function toneOf(update: AgentUpdate): LineTone {
  if (update.status !== undefined && FAILED_STATUSES.has(update.status)) return "err";
  return DIM_KINDS.has(update.kind) ? "dim" : "out";
}

/**
 * The text an update contributes to the stream. `text` is the agent's own; a tool call has
 * none, and its `title` is the one line the stream shows for it (the call's arguments and
 * result belong to its `ToolCallRow`, not to the log).
 */
export function textOf(update: AgentUpdate): string | undefined {
  if (update.text !== undefined) return update.text;
  if (update.kind === "tool_call" && update.title !== undefined) return `${update.title}\n`;
  return undefined;
}

/** `…  84,102 more characters` — the affordance a long line collapses to. */
export function foldLabel(folded: number): string {
  return `${ELLIPSIS} ${unit(folded.toLocaleString("en-US"), folded === 1 ? "more character" : "more characters")}`;
}

/** Cut a line at the limit, reporting what was left off rather than wrapping it. */
export function collapse(text: string): { text: string; folded: number } {
  return text.length > LINE_CHAR_LIMIT
    ? { text: text.slice(0, LINE_CHAR_LIMIT), folded: text.length - LINE_CHAR_LIMIT }
    : { text, folded: 0 };
}

/** One event as the buffer takes it: the sequence number and the update inside it. */
export interface BufferedUpdate {
  seq: number;
  update: AgentUpdate;
}

/**
 * Every `agent.update` in a page of `runs.events`, in the order the log holds them. Other
 * event types in the page are not output and are skipped here; the step header and the
 * tool-call list read them (`tool-calls.ts`).
 */
export function updatesOf(events: readonly LogEvent[]): BufferedUpdate[] {
  const updates: BufferedUpdate[] = [];
  for (const event of events) {
    if (event.type !== "agent.update") continue;
    updates.push({ seq: event.seq, update: event.payload.update });
  }
  return updates;
}

/** An `agent.update` notification's batch, which carries `fromSeq` … `seq` inclusive. */
export function updatesOfNotification(params: AgentUpdateParams): BufferedUpdate[] {
  // The batch's first event is `fromSeq` and its last is `seq`, gap-free in between, so the
  // n-th update's own sequence number is `fromSeq + n` — which is what makes a line
  // addressable even though the frame coalesced several events into one.
  return params.updates.map((update, i) => ({ seq: params.fromSeq + i, update }));
}

/** The clock and the frame scheduler, injectable so a test can drive both. */
export interface BufferOptions {
  /** How many events to hold. Defaults to {@link EVENT_BUFFER_LIMIT}. */
  limit?: number;
  /** The floor between commits. Defaults to {@link COMMIT_INTERVAL_MS}. */
  intervalMs?: number;
  now?: () => number;
  schedule?: (callback: () => void) => number;
  cancel?: (handle: number) => void;
}

/** An event's place in `rows`, so trimming can drop whole events rather than half a line. */
interface EventMark {
  seq: number;
  /** Index in `rows` of the first row this event produced. */
  at: number;
}

/**
 * The buffer itself. One per step pane: `push` from the notification stream, `prepend` from
 * a **Load earlier output** page, `subscribe` to be handed a new `rows` array per commit.
 */
export class OutputBuffer {
  private rows: OutputRow[] = [];
  private marks: EventMark[] = [];
  private queue: BufferedUpdate[] = [];
  private listeners = new Set<(rows: readonly OutputRow[]) => void>();
  private frame: number | undefined;
  /**
   * Set at construction rather than left at `-Infinity`, so the *first* commit waits the
   * floor out like every other one. A free leading commit would make a ten-second stream
   * cost one more than the floor allows, which is a small lie about a number the design
   * states exactly.
   */
  private lastCommit: number;
  private nextKey = 0;
  /** Lines ever opened, which never goes down — what "412 new lines" is counted against. */
  private appended = 0;
  /** The open line: a chunk that has not met its newline yet. */
  private open: { row: LineRow; index: number } | undefined;
  private trimmed: number | undefined;
  /** Highest `seq` taken in, so a replayed page cannot append the same event twice. */
  private highest = -1;

  private readonly limit: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(options: BufferOptions = {}) {
    this.limit = options.limit ?? EVENT_BUFFER_LIMIT;
    this.intervalMs = options.intervalMs ?? COMMIT_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
    this.lastCommit = this.now();
  }

  /** The rows as they stand, whether or not a commit has been handed out for them. */
  get items(): readonly OutputRow[] {
    return this.rows;
  }

  /**
   * The sequence number the front of the buffer was trimmed at, or `undefined` while
   * nothing has been dropped. Pass it to `runs.events({ before })` to page backwards.
   */
  get trimmedBefore(): number | undefined {
    return this.trimmed;
  }

  /** How many events the buffer is holding — the number the 50,000 cap is about. */
  get eventCount(): number {
    return this.marks.length;
  }

  /**
   * How many lines have ever been opened. It only goes up, including past a trim, which is
   * what makes "↓ 412 new lines" a count of what arrived rather than of what survived.
   */
  get linesAppended(): number {
    return this.appended;
  }

  subscribe(listener: (rows: readonly OutputRow[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Queue a batch. Nothing is committed here; a frame is asked for and does the work. */
  push(updates: readonly BufferedUpdate[]): void {
    if (updates.length === 0) return;
    this.queue.push(...updates);
    this.request();
  }

  /**
   * Take a page that was read rather than pushed, and commit it now. Used for the first
   * read of a step: a pane that waited a frame to show a log it already had would flash an
   * empty pane for no reason.
   */
  load(updates: readonly BufferedUpdate[]): void {
    this.queue.push(...updates);
    this.drain();
    this.commit();
  }

  /**
   * A page from in front of the buffer, oldest first. Returns how many rows landed, which
   * is what the surface passes to `VirtualList.shiftBy` so the reader keeps their place.
   *
   * `before` is the cursor the *next* page back would use — the page's own `prevCursor`,
   * or `undefined` when the page reached the start of the step's output and the marker row
   * goes away. It is the caller's rather than derived here because the cursor is a
   * sequence number in the whole log, and the buffer only ever sees the `agent.update`
   * events in it.
   */
  prepend(updates: readonly BufferedUpdate[], before: number | undefined): number {
    const front = new OutputBuffer({ limit: this.limit, now: this.now });
    for (const update of updates) front.take(update);
    front.closeOpen();
    // `front` is a scratch buffer and starts its own key counter at zero, so its rows would
    // collide with the ones already held — the page a person just asked for is exactly the
    // case where React would then reuse the wrong element and draw a line's text against
    // another line's `seq`. Keys are this buffer's to hand out; re-key on the way in.
    const added = front.rows.map((row) => this.rekey(row));

    if (added.length > 0) {
      this.rows = [...added, ...this.rows];
      const shift = added.length;
      this.marks = [...front.marks, ...this.marks.map((mark) => ({ seq: mark.seq, at: mark.at + shift }))];
      if (this.open) this.open = { row: this.open.row, index: this.open.index + shift };
    }

    // Trimming is deliberately not re-applied: a person who asked for earlier output
    // should not have it dropped out from under them on arrival.
    this.trimmed = before;
    this.commit();
    return added.length;
  }

  /** The same row under a key from this buffer's counter — see `prepend`. */
  private rekey(row: OutputRow): OutputRow {
    return row.kind === "line" ? { ...row, key: `line-${this.nextKey++}` } : { ...row, key: `seam-${this.nextKey++}` };
  }

  /**
   * Mark the stream stopping or starting again, at the point it happened. Committed at
   * once: a seam that waited for the next line would land in the wrong place when the next
   * line never comes.
   */
  mark(kind: SeamRow["kind"], at: string): void {
    this.drain();
    this.closeOpen();
    const last = this.rows[this.rows.length - 1];
    // Two of the same in a row say nothing the first did not — a connection that blips
    // twice while a step produces nothing must not stack up markers.
    if (last?.kind === kind) return;
    this.rows = [...this.rows, { kind, key: `seam-${this.nextKey++}`, at }];
    this.commit();
  }

  /** Drop everything: a different step is being shown. */
  clear(): void {
    this.stop();
    this.rows = [];
    this.marks = [];
    this.queue = [];
    this.open = undefined;
    this.trimmed = undefined;
    this.highest = -1;
    this.appended = 0;
    this.commit();
  }

  /** Release the pending frame. The listeners are the caller's to unsubscribe. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private stop(): void {
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined;
  }

  private request(): void {
    if (this.frame !== undefined) return;
    this.frame = this.schedule(() => {
      this.frame = undefined;
      if (this.now() - this.lastCommit < this.intervalMs) {
        // Not yet. Ask for another frame rather than a timer: the commit should land with
        // the browser's paint, and a stream that is still arriving will ask again anyway.
        this.request();
        return;
      }
      this.drain();
      this.commit();
    });
  }

  private drain(): void {
    if (this.queue.length === 0) return;
    const queued = this.queue;
    this.queue = [];
    // One new array per commit, not per line: `rows` is rebuilt once here and handed out
    // by identity, which is what lets the list skip re-rendering rows nothing touched.
    this.rows = [...this.rows];
    for (const update of queued) this.take(update);
    this.trim();
  }

  /** Fold one event into `rows`, continuing an open line where there is one. */
  private take({ seq, update }: BufferedUpdate): void {
    if (seq <= this.highest) return;
    this.highest = seq;
    const text = textOf(update);
    this.marks.push({ seq, at: this.rows.length });
    if (text === undefined || text === "") return;

    const tone = toneOf(update);
    // A change of tone ends the line: an agent's thought and its answer are not one line
    // that happens to change colour half way along.
    if (this.open && this.open.row.tone !== tone) this.closeOpen();

    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] ?? "";
      const terminated = i < segments.length - 1;
      if (this.open) {
        /* The cap is applied to the line, not to the chunk: a line already at the limit
           goes on counting what it is leaving off rather than starting again. */
        const prev = this.open.row;
        const room = Math.max(0, LINE_CHAR_LIMIT - prev.text.length);
        const kept = segment.slice(0, room);
        const row: LineRow = {
          ...prev,
          text: prev.text + kept,
          folded: prev.folded + (segment.length - kept.length),
        };
        this.rows[this.open.index] = row;
        this.open = terminated ? undefined : { row, index: this.open.index };
      } else if (terminated || segment !== "") {
        const capped = collapse(segment);
        const row: LineRow = { kind: "line", key: `line-${this.nextKey++}`, seq, tone, ...capped };
        this.appended++;
        this.rows.push(row);
        if (!terminated) this.open = { row, index: this.rows.length - 1 };
      }
    }
  }

  /** Stop growing the open line. It stays in `rows`; it is only no longer appended to. */
  private closeOpen(): void {
    this.open = undefined;
  }

  private trim(): void {
    if (this.marks.length <= this.limit) return;
    const drop = this.marks.length - this.limit;
    const cut = this.marks[drop]?.at ?? 0;
    this.rows = this.rows.slice(cut);
    this.marks = this.marks.slice(drop).map((mark) => ({ seq: mark.seq, at: mark.at - cut }));
    if (this.open) this.open = { row: this.open.row, index: this.open.index - cut };
    // The oldest event still held: `runs.events({ before })` takes the events immediately
    // in front of it, which is exactly the page **Load earlier output** wants.
    this.trimmed = this.marks[0]?.seq;
  }

  private commit(): void {
    this.lastCommit = this.now();
    for (const listener of [...this.listeners]) listener(this.rows);
  }
}
