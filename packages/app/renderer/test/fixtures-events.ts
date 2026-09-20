/**
 * A run with a long log, for the half of the timeline that `fixtures.ts` cannot exercise:
 * paging.
 *
 * `fixtures.ts` is a small store taken from a real `ReadModel` run — seventeen events for
 * `run-parent`, twelve for `run-gate` — which is exactly right for asserting what a row
 * says and useless for asserting that a list pages. #157 asks for ten thousand events and
 * both directions, so this file generates them, and `serveEvents` below answers
 * `runs.events` over any log with the same semantics the daemon has.
 *
 * The log is deterministic and its shape is the shape a real one has: a run that opens,
 * runs a node at a time (scheduled, started, a session, five agent updates, completed), and
 * ends on a gate a policy settled and a completion. The five consecutive `agent.update`
 * events per node are there on purpose — they are what the timeline coalesces into one row,
 * so a page boundary that falls inside a run of them is a case this fixture actually has.
 *
 * `fake-bridge.ts` answers from `fixtures.ts`; a test that wants this run scripts the three
 * read methods with the constants here.
 */
import type { RunSummaryView, RunsEventsParams, RunsEventsResult, RunsGetResult } from "@orca/protocol";

type OrcaEvent = RunsEventsResult["events"][number];

/** The same clock `fixtures.ts` uses, so two fixtures in one test do not disagree. */
export const START = Date.UTC(2026, 2, 1, 9, 0, 0);

/** The run this log belongs to. Not in `fixtures.ts`'s store: a test scripts it in. */
export const MANY_RUN_ID = "run-many";

/** Ten thousand events, which is #157's number. */
export const EVENT_COUNT = 10_000;

/** How many `agent.update` events each node emits in a row — what a timeline coalesces. */
export const UPDATES_PER_NODE = 5;

/** The events one node contributes: scheduled, started, a session, the updates, completed. */
const PER_NODE = 4 + UPDATES_PER_NODE;

const WORKSPACE = { hostId: "local", cwd: "/work/orca", repo: "orca", branch: "main" } as const;

/**
 * The `decision.resolved` source that means a policy settled the gate and nobody was asked.
 * Stated here as well as in `timeline-entries.ts` so the fixture and the renderer can
 * disagree in a test rather than agree by sharing one constant.
 */
export const AUTO_SOURCE = "gate:auto";

function buildLog(): OrcaEvent[] {
  const events: OrcaEvent[] = [];
  const push = (type: string, payload: unknown): void => {
    events.push({
      id: `evt-many-${events.length}`,
      seq: events.length,
      runId: MANY_RUN_ID,
      at: new Date(START + events.length * 1000).toISOString(),
      type,
      payload,
    } as OrcaEvent);
  };

  push("run.created", {
    workflowId: "sdlc",
    workflowVersion: "2",
    requestId: "req-many",
    workspace: WORKSPACE,
    vars: { branch: "feat/long" },
  });
  push("run.started", {});

  // Two events are held back for the gate and the completion at the end.
  let node = 0;
  while (events.length + PER_NODE <= EVENT_COUNT - 2) {
    const stepRunId = `s-${node}`;
    const sessionId = `sess-${node}`;
    push("step.scheduled", { stepRunId, nodeId: `node-${node}`, nodeType: "agent", attempt: 1 });
    push("step.started", { stepRunId, inputArtifactIds: [] });
    push("agent.session.opened", { stepRunId, sessionId, agentId: "claude", hostId: "local", cwd: WORKSPACE.cwd });
    for (let i = 0; i < UPDATES_PER_NODE; i += 1) {
      push("agent.update", { stepRunId, sessionId, update: { kind: "agent_message_chunk", text: `line ${i}` } });
    }
    push("step.completed", { stepRunId, result: { artifactIds: [], data: {} } });
    node += 1;
  }
  // Whatever is left over, as run-level events, so the count is exactly EVENT_COUNT.
  while (events.length < EVENT_COUNT - 2) push("vars.set", { vars: { tick: events.length } });

  /* The gate a policy settled. It names its *source* and not the condition, because
     `autoApproveWhen` is configuration and never reaches the event log — which is the
     thing the timeline must not invent (docs/design/RULES.md rule 12). */
  push("decision.resolved", { stepRunId: "s-gate-auto", choice: "approve", source: AUTO_SOURCE });
  push("run.completed", { outcome: "success" });
  return events;
}

export const MANY_EVENTS: readonly OrcaEvent[] = buildLog();

/** The sequence number of the auto-approved gate: second from the end, by construction. */
export const AUTO_SEQ = EVENT_COUNT - 2;

/** How many nodes the log got through, for a test that wants to name one. */
export const MANY_NODES = Math.floor((EVENT_COUNT - 2 - 2) / PER_NODE);

export const MANY_RUN: RunSummaryView = {
  id: MANY_RUN_ID,
  name: "Long run",
  workflowId: "sdlc",
  workflowVersion: "2",
  status: "succeeded",
  outcome: "success",
  createdAt: new Date(START).toISOString(),
  startedAt: new Date(START + 1000).toISOString(),
  finishedAt: new Date(START + EVENT_COUNT * 1000).toISOString(),
  durationMs: (EVENT_COUNT - 1) * 1000,
  requestId: "req-many",
};

/** `runs.get` for it: every step the log scheduled, so the timeline can name them. */
export const MANY_DETAIL: RunsGetResult = {
  run: MANY_RUN,
  workspace: WORKSPACE,
  vars: { branch: "feat/long" },
  steps: Array.from({ length: MANY_NODES }, (_unused, node) => ({
    id: `s-${node}`,
    runId: MANY_RUN_ID,
    nodeId: `node-${node}`,
    nodeType: "agent",
    attempt: 1,
    status: "succeeded" as const,
    scheduledAt: new Date(START + node * PER_NODE * 1000).toISOString(),
    inputArtifactIds: [],
    outputArtifactIds: [],
    children: [],
    skippedBranches: [],
  })),
  artifacts: [],
  lastSeq: EVENT_COUNT - 1,
  asOf: new Date(START + EVENT_COUNT * 1000).toISOString(),
};

/**
 * `runs.events` over a log, with the daemon's own semantics — the same ones
 * `fake-bridge.ts` implements over `fixtures.ts`, restated here so a test can point the
 * fake at a different log without the fake learning about this file.
 *
 * `before` takes the `limit` events *immediately* before the cursor, so it slices from the
 * end; `after` walks forward; both answer oldest first.
 */
export function serveEvents(
  log: readonly OrcaEvent[],
  params: Partial<RunsEventsParams> & { runId: string },
  defaultLimit = 200,
): RunsEventsResult {
  const lastSeq = log.length ? log[log.length - 1]!.seq : 0;
  const typed = params.types?.length ? log.filter((e) => params.types!.includes(e.type)) : log;
  const filtered =
    params.stepRunId === undefined
      ? typed
      : typed.filter((e) => (e.payload as { stepRunId?: string }).stepRunId === params.stepRunId);
  const limit = params.limit ?? defaultLimit;

  const window =
    params.before !== undefined
      ? filtered.filter((e) => e.seq < params.before!).slice(-limit)
      : filtered.filter((e) => params.after === undefined || e.seq > params.after).slice(0, limit);

  const first = window[0];
  const last = window[window.length - 1];
  const hasMore =
    params.before !== undefined
      ? first !== undefined && filtered.some((e) => e.seq < first.seq)
      : last !== undefined && filtered.some((e) => e.seq > last.seq);

  return {
    events: [...window],
    ...(last ? { nextCursor: last.seq } : {}),
    ...(first ? { prevCursor: first.seq } : {}),
    hasMore,
    lastSeq,
    asOf: MANY_DETAIL.asOf,
  };
}
