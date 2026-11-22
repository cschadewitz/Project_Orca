/**
 * The event timeline's arithmetic, with no React and no bridge in it: one event to one
 * row, a page of events to a list of rows, and two lists merged without a gap or a
 * duplicate.
 *
 * The event log is the source of truth and this is the projection of it (#157). Three
 * decisions are baked in here rather than in the component, because each is the kind of
 * thing a DOM test reads badly and a plain test reads well:
 *
 * - **`seq` is identity.** Sequence numbers are per run and gap-free, so merging two
 *   pages is a merge on `seq` and nothing else. That is what makes "page backwards from
 *   disk" and "tail forwards from the push channel" the same list.
 * - **Consecutive agent updates are one row.** The daemon already coalesces them on the
 *   wire (at most one `agent.update` notification per step per 100ms, many updates
 *   inside), so a replayed run has to coalesce too or replay and live would draw the same
 *   log differently — and "replay is the same code path as live" is the whole point of
 *   docs/design/60-implementation.md's event-sourced section. A coalesced row spans
 *   `fromSeq`..`seq`.
 * - **The subject comes first.** A truncated row still has to mean something (rule 13), so
 *   every summary starts with the node the event is about. Most `step.*` and `agent.*`
 *   events carry a `stepRunId` and no node id, so the name is resolved from the
 *   `step.scheduled` events in the same log and from the run's own projection; an
 *   unresolved one falls back to the step run id, which is at least addressable.
 */
import type { RunStatus } from "@orca/design";
import type { AgentUpdateParams, RunsEventsResult } from "@orca/protocol";
import { counted } from "../../ui/count.js";

type OrcaEvent = RunsEventsResult["events"][number];

/**
 * `decision.resolved.source` for a gate a policy settled with nobody asked.
 *
 * The row names the source and **not the condition**: `autoApproveWhen` is configuration,
 * it is not on the event, and printing the expression a policy might have used would be
 * inventing data the log does not carry (docs/design/RULES.md rule 12).
 */
export const AUTO_GATE_SOURCE = "gate:auto";

export interface TimelineEntry {
  /**
   * The store's own event id, shown in `mono-id` on hover and copied from the row's menu.
   *
   * Absent on a coalesced row: `agent.update` arrives as a batch of `AgentUpdateSummary`
   * values with a `fromSeq` and a `seq` and **no event ids**, so a live batch has no one id
   * to copy. Those rows offer the sequence range instead, which is what addresses them.
   */
  eventId?: string | undefined;
  /** The last sequence number this row stands for; its identity in the list. */
  seq: number;
  /** The first, when the row is coalesced. Equal to `seq` otherwise. */
  fromSeq: number;
  at: string;
  /** The ORCA event type, verbatim: `step.started`, `agent.update`, … */
  kind: string;
  /** One line, subject first. */
  summary: string;
  status?: RunStatus;
  stepRunId?: string;
  /** How many events the row stands for. 1 unless it coalesced a run of agent updates. */
  count: number;
  /** A gate a policy settled: drawn quietly, and it never raises a count (#157). */
  autoApproved?: boolean;
}

/** A stable DOM id per row; `aria-activedescendant` names it. */
export const timelineRowId = (seq: number): string => `timeline-row-${seq}`;

/** Node ids by step run id, from the `step.scheduled` events in a page. */
export function nodeNames(events: readonly OrcaEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type === "step.scheduled") names.set(event.payload.stepRunId, event.payload.nodeId);
  }
  return names;
}

/** The step run an event is about, or `undefined` for the run-level ones. */
export function stepOf(event: OrcaEvent): string | undefined {
  const payload = event.payload as { stepRunId?: string };
  return typeof payload.stepRunId === "string" ? payload.stepRunId : undefined;
}

/**
 * A page of events as rows, oldest first, with consecutive agent updates for one step
 * collapsed into one.
 *
 * `names` resolves a step run id to its node id; pass the map the run's own `runs.get`
 * projection gives plus `nodeNames` over the page, so a page that does not contain the
 * `step.scheduled` still names its steps.
 */
export function toEntries(events: readonly OrcaEvent[], names: ReadonlyMap<string, string>): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    const previous = entries[entries.length - 1];
    if (
      event.type === "agent.update" &&
      previous?.kind === "agent.update" &&
      previous.stepRunId === event.payload.stepRunId
    ) {
      // Extend the run rather than adding a row: the batch's last event is its identity.
      entries[entries.length - 1] = {
        ...previous,
        eventId: undefined,
        seq: event.seq,
        at: event.at,
        count: previous.count + 1,
        summary: updatesSummary(subjectOf(event, names), previous.count + 1),
      };
      continue;
    }
    entries.push(toEntry(event, names));
  }
  return entries;
}

/** One event as one row. */
export function toEntry(event: OrcaEvent, names: ReadonlyMap<string, string>): TimelineEntry {
  const stepRunId = stepOf(event);
  const auto = event.type === "decision.resolved" && event.payload.source === AUTO_GATE_SOURCE;
  const status = statusOf(event);
  return {
    eventId: event.id,
    seq: event.seq,
    fromSeq: event.seq,
    at: event.at,
    kind: event.type,
    summary: summarise(event, subjectOf(event, names)),
    ...(status === undefined ? {} : { status }),
    ...(stepRunId === undefined ? {} : { stepRunId }),
    count: 1,
    ...(auto ? { autoApproved: true } : {}),
  };
}

/**
 * One `agent.update` notification as one row: the batch the daemon coalesced, drawn once.
 *
 * The notification carries `fromSeq` and `seq` and the updates between them, and no event
 * ids — so this row is addressed by its sequence range rather than by an id.
 */
export function agentUpdateEntry(params: AgentUpdateParams, names: ReadonlyMap<string, string>): TimelineEntry {
  const subject = names.get(params.stepRunId) ?? params.stepRunId;
  return {
    seq: params.seq,
    fromSeq: params.fromSeq,
    at: params.at,
    kind: "agent.update",
    summary: updatesSummary(subject, params.updates.length),
    stepRunId: params.stepRunId,
    count: params.updates.length,
  };
}

/**
 * Two lists of rows as one, oldest first, with no gap and no duplicate.
 *
 * `prepended` is how many rows landed *in front of* what was already held, which is what
 * the list substrate's `shiftBy` needs: after a backward page every index moved down by
 * that many, and a scroll offset left alone would throw a person back by exactly the page
 * they just asked to see.
 */
export function mergeEntries(
  held: readonly TimelineEntry[],
  incoming: readonly TimelineEntry[],
): { entries: TimelineEntry[]; prepended: number } {
  if (incoming.length === 0) return { entries: [...held], prepended: 0 };

  const bySeq = new Map<number, TimelineEntry>();
  for (const entry of held) bySeq.set(entry.seq, entry);
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const firstHeld = held[0];
  if (firstHeld === undefined) return { entries, prepended: 0 };
  // Every held entry is in `bySeq`, so the first one is always found: its index is the count
  // of rows that landed in front of it, and there is no -1 case to default (#251).
  return { entries, prepended: entries.findIndex((entry) => entry.seq === firstHeld.seq) };
}

/** The lowest sequence number the list holds — the anchor the next backward page uses. */
export function earliestSeq(entries: readonly TimelineEntry[]): number | undefined {
  const first = entries[0];
  return first === undefined ? undefined : first.fromSeq;
}

/** The highest sequence number applied — the cursor the sticky header says it is current to. */
export function appliedSeq(entries: readonly TimelineEntry[]): number | undefined {
  const last = entries[entries.length - 1];
  return last === undefined ? undefined : last.seq;
}

/** The event kinds present, in the order they first appear: the filter menu's items. */
export function kindsOf(entries: readonly TimelineEntry[]): string[] {
  const kinds: string[] = [];
  for (const entry of entries) if (!kinds.includes(entry.kind)) kinds.push(entry.kind);
  return kinds;
}

/* ---------- what a row says ---------- */

/** The node the event is about, or the step run id when nothing names it, or the run. */
function subjectOf(event: OrcaEvent, names: ReadonlyMap<string, string>): string {
  if (event.type === "step.scheduled") return event.payload.nodeId;
  const stepRunId = stepOf(event);
  if (stepRunId === undefined) return "Run";
  return names.get(stepRunId) ?? stepRunId;
}

const updatesSummary = (subject: string, count: number): string =>
  count === 1 ? `${subject}, agent output` : `${subject}, ${counted(count, "agent update")}`;

/** `CODE: message`, the way a person reads an error they have to act on. */
const said = (error: { code: string; message: string }): string => `${error.code}: ${error.message}`;

/**
 * One line per event type, subject first. Sentence case, no exclamation, no emoji
 * (rule 13); nothing derived that the payload does not carry (rule 12).
 */
export function summarise(event: OrcaEvent, subject: string): string {
  switch (event.type) {
    case "run.created":
      return `Run created from ${event.payload.workflowId} v${event.payload.workflowVersion}`;
    case "run.started":
      return "Run started";
    case "run.paused":
      return event.payload.reason === undefined ? "Run paused" : `Run paused, ${event.payload.reason}`;
    case "run.resumed":
      return "Run resumed";
    case "run.completed":
      return `Run completed, ${event.payload.outcome}`;
    case "run.failed":
      return `Run failed, ${said(event.payload.error)}`;
    case "run.cancelled":
      return event.payload.reason === undefined ? "Run cancelled" : `Run cancelled, ${event.payload.reason}`;
    case "vars.set":
      return `Variables set, ${Object.keys(event.payload.vars).join(", ")}`;

    case "step.scheduled":
      return `${subject} scheduled, attempt ${event.payload.attempt}`;
    case "step.started":
      return `${subject} started`;
    case "step.inputs":
      return `${subject} read ${counted(event.payload.artifactIds.length, "artifact")}`;
    case "step.waiting":
      return event.payload.detail === undefined
        ? `${subject} waiting on ${event.payload.on}`
        : `${subject} waiting on ${event.payload.on}, ${event.payload.detail}`;
    case "step.completed":
      return `${subject} completed`;
    case "step.failed":
      return `${subject} failed, ${said(event.payload.error)}${event.payload.willRetry ? ", retrying" : ""}`;
    case "step.cancelled":
      return `${subject} cancelled`;
    case "step.skipped":
      return `${subject} skipped, ${event.payload.reason}`;
    case "step.effect.reviewed":
      return event.payload.decision === "run-again"
        ? `${subject} reviewed, may run again`
        : `${subject} reviewed, abandoned`;

    case "agent.session.opened":
      return `${subject} opened a session with ${event.payload.agentId}`;
    case "agent.turn.started":
      return `${subject} prompted the agent, ${event.payload.promptPreview}`;
    case "agent.update":
      return updatesSummary(subject, 1);
    case "agent.permission":
      return `${subject} asked to ${event.payload.title}, ${event.payload.decision}`;
    case "agent.turn.completed":
      return `${subject} turn ended, ${event.payload.stopReason}`;
    case "agent.session.closed":
      return event.payload.error === undefined
        ? `${subject} closed its session`
        : `${subject} session closed, ${said(event.payload.error)}`;

    case "artifact.recorded":
      return `${subject} recorded ${event.payload.artifact.name} v${event.payload.artifact.version}`;
    case "artifact.rejected":
      return `${subject} rejected a ${event.payload.kind} artifact, ${event.payload.reason}`;
    case "plan.signals.rejected":
      return `${subject} had ${counted(event.payload.issues.length, "planning signal")} rejected`;

    case "decision.resolved":
      return event.payload.source === AUTO_GATE_SOURCE
        ? `${subject} auto-approved as ${event.payload.choice}, by ${AUTO_GATE_SOURCE}`
        : `${subject} resolved to ${event.payload.choice}, by ${event.payload.source}`;
    case "loop.iteration":
      return `${subject} iteration ${event.payload.iteration}`;
    case "child.spawned":
      return event.payload.branch === undefined
        ? `${subject} spawned ${event.payload.childRunId}`
        : `${subject} spawned ${event.payload.childRunId} for ${event.payload.branch}`;
    case "child.finished":
      return `${subject} child ${event.payload.childRunId} ${event.payload.status}`;
    case "branch.skipped":
      return `${subject} skipped ${event.payload.branch}, ${event.payload.reason}`;

    case "human.requested":
      return `${subject} asked, ${event.payload.question}`;
    case "revision.recorded":
      return `Correction ${event.payload.state ?? "boundary recorded"}`;
    case "continuation.recorded":
      return `Continuation ${event.payload.state}`;
    case "human.answered":
      return `${subject} answered ${event.payload.answer}`;
  }
}

/**
 * The status a row draws its marker from — and the only three the minimap gutter marks.
 *
 * Deliberately not every event: a timeline where every row carried a status would be a
 * column of colour saying nothing, and the gutter exists to find the failure four thousand
 * rows down (docs/design/30-long-running-content.md).
 */
export function statusOf(event: OrcaEvent): RunStatus | undefined {
  switch (event.type) {
    case "run.started":
    case "step.started":
      return "running";
    case "run.paused":
      return "held";
    case "run.completed":
      // `RunOutcome` has three values, not two (#249). Folding `cancelled` into `failed`
      // put a red tick in the minimap for a run a person stopped on purpose - and the same
      // run ending through `run.cancelled` below drew it correctly, so the log disagreed
      // with itself about what had happened.
      switch (event.payload.outcome) {
        case "success":
          return "succeeded";
        case "cancelled":
          return "cancelled";
        default:
          return "failed";
      }
    case "run.failed":
    case "step.failed":
      return "failed";
    case "run.cancelled":
    case "step.cancelled":
      return "cancelled";
    case "step.completed":
      return "succeeded";
    case "step.waiting":
    case "human.requested":
      return "waiting";
    default:
      return undefined;
  }
}
