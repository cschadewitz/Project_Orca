/**
 * The event timeline's arithmetic, without a DOM: one event to one row, a run of agent
 * updates to one row, and two pages merged with no gap and no duplicate.
 *
 * The paging half is the point of the big fixture. #157 asks for ten thousand events and
 * both directions, and the walk below is the real thing: `serveEvents` answers with the
 * daemon's own `before` semantics, `toEntries` turns each page into rows and `mergeEntries`
 * folds them together, all the way back to sequence zero. What it asserts is that the union
 * is exactly the log — every sequence number once, in order — which is what "no gap and no
 * duplicate" means.
 */
import { describe, expect, it } from "vitest";
import type { AgentUpdateParams, RunsEventsResult } from "@orca/protocol";
import {
  AUTO_GATE_SOURCE,
  agentUpdateEntry,
  appliedSeq,
  earliestSeq,
  kindsOf,
  mergeEntries,
  nodeNames,
  statusOf,
  toEntries,
  toEntry,
  type TimelineEntry,
} from "../src/runs/timeline/timeline-entries.js";
import { EVENTS } from "./fixtures.js";
import { AUTO_SEQ, EVENT_COUNT, MANY_EVENTS, MANY_RUN_ID, UPDATES_PER_NODE, serveEvents } from "./fixtures-events.js";

type OrcaEvent = RunsEventsResult["events"][number];

const PARENT = EVENTS["run-parent"]!;
const names = nodeNames(PARENT);

describe("an event as a row", () => {
  it("names the step, not its id, and puts the subject first", () => {
    const rows = toEntries(PARENT, names);
    expect(rows.map((row) => row.summary)).toEqual([
      "Run created from sdlc v2",
      "Run started",
      "build scheduled, attempt 1",
      "build started",
      "build opened a session with claude",
      "build failed, AGENT_TRANSPORT: agent went away, retrying",
      "build scheduled, attempt 2",
      "build started",
      "build opened a session with claude",
      "build recorded spec v1",
      "build completed",
      "fanout scheduled, attempt 1",
      "fanout started",
      "fanout spawned run-child-ok for auth-ui",
      "fanout spawned run-child-gone for auth-docs",
      "fanout skipped auth-perf, dependency",
      "fanout waiting on child-run, run-child-ok,run-child-gone",
    ]);
  });

  it("carries the event id, the kind verbatim and the step it is about", () => {
    const row = toEntries(PARENT, names)[5]!;
    expect(row.eventId).toBe("evt-run-parent-5");
    expect(row.kind).toBe("step.failed");
    expect(row.stepRunId).toBe("s-build-1");
    expect(row.status).toBe("failed");
    expect(row.count).toBe(1);
    expect(row.fromSeq).toBe(row.seq);
  });

  it("gives a status to the transitions that have one, and to no others", () => {
    const withStatus = toEntries(PARENT, names).filter((row) => row.status !== undefined);
    expect(withStatus.map((row) => `${row.kind}=${row.status}`)).toEqual([
      "run.started=running",
      "step.started=running",
      "step.failed=failed",
      "step.started=running",
      "step.completed=succeeded",
      "step.started=running",
      "step.waiting=waiting",
    ]);
    expect(statusOf(PARENT[0]!)).toBeUndefined();
  });

  it("falls back to the step run id when nothing names the node", () => {
    const orphan = toEntry(PARENT[3]!, new Map());
    expect(orphan.summary).toBe("s-build-1 started");
  });

  it("lists the kinds it holds, in the order they first appear", () => {
    expect(kindsOf(toEntries(PARENT, names)).slice(0, 4)).toEqual([
      "run.created",
      "run.started",
      "step.scheduled",
      "step.started",
    ]);
  });
});

/**
 * The line each event type draws, which is a contract of its own: the log is the source of
 * truth and the timeline shows all of it, so most of these types reach a person only
 * through this switch. The fixtures above hold the seven or eight an SDLC run happens to
 * emit; the rest are asserted here or nowhere.
 *
 * Every row is subject first (rule 13), sentence case, and says nothing the payload does
 * not carry (rule 12) — the two `counted` cases are here because "1 artifacts" is the kind
 * of wrong a person notices and a test does not, unless it asks.
 *
 * A new event type does not need adding here to be safe: `summarise` switches over the
 * whole union with no default, so an unhandled type fails the build rather than drawing a
 * blank row. It needs adding here to be *worded*.
 */
describe("what a row says, per event type", () => {
  const STEP = "s-build-1";
  const SESSION = "sess-1";
  const AT = "2026-03-01T09:00:00.000Z";
  const NAMES = new Map([[STEP, "build"]]);
  const GONE = { code: "AGENT_TRANSPORT", message: "agent went away" };
  const WORKSPACE = { hostId: "local", cwd: "/work/orca" };
  const SPEC = {
    id: "art-1",
    kind: "spec",
    name: "spec",
    mediaType: "text/markdown",
    contentHash: "sha256:9f2",
    size: 1_204,
    version: 2,
    producedBy: { runId: "run-words", stepRunId: STEP },
    parents: [],
    data: {},
    createdAt: AT,
  };

  /** An event without the four fields the store assigns; `stored` puts those back. */
  type EventBody = {
    [T in OrcaEvent["type"]]: { type: T; payload: Extract<OrcaEvent, { type: T }>["payload"] };
  }[OrcaEvent["type"]];

  const stored = (body: EventBody): OrcaEvent => ({ id: "evt-1", seq: 1, runId: "run-words", at: AT, ...body });

  const LINES: ReadonlyArray<{ event: EventBody; reads: string }> = [
    {
      event: {
        type: "run.created",
        payload: { workflowId: "sdlc", workflowVersion: "2", workspace: WORKSPACE, vars: {} },
      },
      reads: "Run created from sdlc v2",
    },
    { event: { type: "run.started", payload: {} }, reads: "Run started" },
    { event: { type: "run.paused", payload: {} }, reads: "Run paused" },
    { event: { type: "run.paused", payload: { reason: "the lease lapsed" } }, reads: "Run paused, the lease lapsed" },
    { event: { type: "run.resumed", payload: {} }, reads: "Run resumed" },
    { event: { type: "run.completed", payload: { outcome: "success" } }, reads: "Run completed, success" },
    { event: { type: "run.failed", payload: { error: GONE } }, reads: "Run failed, AGENT_TRANSPORT: agent went away" },
    { event: { type: "run.cancelled", payload: {} }, reads: "Run cancelled" },
    { event: { type: "run.cancelled", payload: { reason: "asked to stop" } }, reads: "Run cancelled, asked to stop" },
    {
      event: { type: "vars.set", payload: { vars: { branch: "feat/sso", reviewer: "casey" } } },
      reads: "Variables set, branch, reviewer",
    },

    {
      event: { type: "step.scheduled", payload: { stepRunId: STEP, nodeId: "build", nodeType: "agent", attempt: 2 } },
      reads: "build scheduled, attempt 2",
    },
    { event: { type: "step.started", payload: { stepRunId: STEP, inputArtifactIds: [] } }, reads: "build started" },
    {
      event: { type: "step.inputs", payload: { stepRunId: STEP, artifactIds: ["art-1"] } },
      reads: "build read 1\u00a0artifact",
    },
    {
      event: { type: "step.inputs", payload: { stepRunId: STEP, artifactIds: ["art-1", "art-2"] } },
      reads: "build read 2\u00a0artifacts",
    },
    {
      event: { type: "step.waiting", payload: { stepRunId: STEP, on: "child-run" } },
      reads: "build waiting on child-run",
    },
    {
      event: { type: "step.waiting", payload: { stepRunId: STEP, on: "human", detail: "approve the plan" } },
      reads: "build waiting on human, approve the plan",
    },
    {
      event: { type: "step.completed", payload: { stepRunId: STEP, result: { artifactIds: [], data: {} } } },
      reads: "build completed",
    },
    {
      event: { type: "step.failed", payload: { stepRunId: STEP, error: GONE, willRetry: true } },
      reads: "build failed, AGENT_TRANSPORT: agent went away, retrying",
    },
    {
      event: { type: "step.failed", payload: { stepRunId: STEP, error: GONE, willRetry: false } },
      reads: "build failed, AGENT_TRANSPORT: agent went away",
    },
    { event: { type: "step.cancelled", payload: { stepRunId: STEP } }, reads: "build cancelled" },
    {
      event: { type: "step.skipped", payload: { stepRunId: STEP, reason: "the branch it needed failed" } },
      reads: "build skipped, the branch it needed failed",
    },

    {
      event: {
        type: "agent.session.opened",
        payload: { stepRunId: STEP, sessionId: SESSION, agentId: "claude", hostId: "local", cwd: "/work/orca" },
      },
      reads: "build opened a session with claude",
    },
    {
      event: {
        type: "agent.turn.started",
        payload: {
          stepRunId: STEP,
          sessionId: SESSION,
          promptHash: "sha256:1a4",
          promptPreview: "Implement the SSO callback",
          followUp: 0,
        },
      },
      reads: "build prompted the agent, Implement the SSO callback",
    },
    {
      event: {
        type: "agent.update",
        payload: {
          stepRunId: STEP,
          sessionId: SESSION,
          update: { kind: "agent_message_chunk", text: "reading src/auth.ts" },
        },
      },
      reads: "build, agent output",
    },
    {
      event: {
        type: "agent.permission",
        payload: { stepRunId: STEP, sessionId: SESSION, title: "write src/auth.ts", decision: "allowed" },
      },
      reads: "build asked to write src/auth.ts, allowed",
    },
    {
      event: {
        type: "agent.turn.completed",
        payload: { stepRunId: STEP, sessionId: SESSION, stopReason: "end_turn", durationMs: 4_200 },
      },
      reads: "build turn ended, end_turn",
    },
    {
      event: { type: "agent.session.closed", payload: { stepRunId: STEP, sessionId: SESSION } },
      reads: "build closed its session",
    },
    {
      event: { type: "agent.session.closed", payload: { stepRunId: STEP, sessionId: SESSION, error: GONE } },
      reads: "build session closed, AGENT_TRANSPORT: agent went away",
    },

    {
      event: { type: "artifact.recorded", payload: { stepRunId: STEP, artifact: SPEC } },
      reads: "build recorded spec v2",
    },
    {
      event: {
        type: "artifact.rejected",
        payload: {
          stepRunId: STEP,
          kind: "spec",
          path: "/work/orca/spec.md",
          reason: "no verdict in the front matter",
        },
      },
      reads: "build rejected a spec artifact, no verdict in the front matter",
    },
    {
      event: {
        type: "plan.signals.rejected",
        payload: { stepRunId: STEP, artifactId: "art-1", issues: ["unknown node"] },
      },
      reads: "build had 1\u00a0planning signal rejected",
    },
    {
      event: {
        type: "plan.signals.rejected",
        payload: { stepRunId: STEP, artifactId: "art-1", issues: ["unknown node", "a cycle"] },
      },
      reads: "build had 2\u00a0planning signals rejected",
    },

    {
      event: { type: "decision.resolved", payload: { stepRunId: STEP, choice: "approve", source: AUTO_GATE_SOURCE } },
      reads: `build auto-approved as approve, by ${AUTO_GATE_SOURCE}`,
    },
    {
      event: { type: "decision.resolved", payload: { stepRunId: STEP, choice: "approve", source: "human" } },
      reads: "build resolved to approve, by human",
    },
    { event: { type: "loop.iteration", payload: { stepRunId: STEP, iteration: 3 } }, reads: "build iteration 3" },
    {
      event: { type: "child.spawned", payload: { stepRunId: STEP, childRunId: "run-child-ok" } },
      reads: "build spawned run-child-ok",
    },
    {
      event: { type: "child.spawned", payload: { stepRunId: STEP, childRunId: "run-child-ok", branch: "auth-ui" } },
      reads: "build spawned run-child-ok for auth-ui",
    },
    {
      event: { type: "child.finished", payload: { stepRunId: STEP, childRunId: "run-child-ok", status: "completed" } },
      reads: "build child run-child-ok completed",
    },
    {
      event: { type: "branch.skipped", payload: { stepRunId: STEP, branch: "auth-perf", reason: "dependency" } },
      reads: "build skipped auth-perf, dependency",
    },

    {
      event: {
        type: "human.requested",
        payload: {
          stepRunId: STEP,
          requestId: "req-1",
          kind: "decision",
          question: "Ship the callback?",
          options: [],
          context: {},
        },
      },
      reads: "build asked, Ship the callback?",
    },
    {
      event: { type: "human.answered", payload: { stepRunId: STEP, requestId: "req-1", answer: "approve" } },
      reads: "build answered approve",
    },
  ];

  it.each(LINES)("$event.type: $reads", ({ event, reads }) => {
    expect(toEntry(stored(event), NAMES).summary).toBe(reads);
  });

  it("reads a finished run's marker off its outcome, not off the fact that it ended", () => {
    expect(toEntry(stored({ type: "run.completed", payload: { outcome: "success" } }), NAMES).status).toBe("succeeded");
    expect(toEntry(stored({ type: "run.completed", payload: { outcome: "failure" } }), NAMES).status).toBe("failed");
    // The third outcome, which used to read as a failure (#249): a run somebody stopped is
    // not a run that broke, and the gutter is where that difference is looked for.
    expect(toEntry(stored({ type: "run.completed", payload: { outcome: "cancelled" } }), NAMES).status).toBe(
      "cancelled",
    );
  });

  it("marks the transitions the gutter has to find, and no others", () => {
    const marked = LINES.filter(({ event }) => statusOf(stored(event)) !== undefined).map(
      ({ event }) => `${event.type}=${statusOf(stored(event))}`,
    );
    expect(new Set(marked)).toEqual(
      new Set([
        "run.started=running",
        "run.paused=held",
        "run.completed=succeeded",
        "run.failed=failed",
        "run.cancelled=cancelled",
        "step.started=running",
        "step.waiting=waiting",
        "step.completed=succeeded",
        "step.failed=failed",
        "step.cancelled=cancelled",
        "human.requested=waiting",
      ]),
    );
  });
});

describe("an auto-approved gate", () => {
  const auto = MANY_EVENTS[AUTO_SEQ]!;

  it("names the source and not the condition", () => {
    const row = toEntry(auto, new Map([["s-gate-auto", "approve"]]));
    expect(row.autoApproved).toBe(true);
    expect(row.summary).toBe(`approve auto-approved as approve, by ${AUTO_GATE_SOURCE}`);
    // `autoApproveWhen` is configuration and is not on the event; a row that printed it
    // would be inventing data ORCA never sent (rule 12).
    expect(row.summary).not.toContain("when");
  });

  it("is an ordinary decision when a person settled it", () => {
    const byHand = { ...auto, payload: { ...auto.payload, source: "human" } } as OrcaEvent;
    const row = toEntry(byHand, new Map([["s-gate-auto", "approve"]]));
    expect(row.autoApproved).toBeUndefined();
    expect(row.summary).toBe("approve resolved to approve, by human");
  });
});

describe("a coalesced batch", () => {
  it("is one row for a run of agent updates, spanning their sequence numbers", () => {
    // The first node's updates: five in a row, between its session and its completion.
    const page = MANY_EVENTS.slice(0, 11);
    const rows = toEntries(page, new Map([["s-0", "node-0"]]));

    expect(rows.map((row) => row.kind)).toEqual([
      "run.created",
      "run.started",
      "step.scheduled",
      "step.started",
      "agent.session.opened",
      "agent.update",
      "step.completed",
    ]);
    const batch = rows[5]!;
    expect(batch.count).toBe(UPDATES_PER_NODE);
    expect(batch.summary).toBe(`node-0, ${UPDATES_PER_NODE}\u00a0agent updates`);
    expect(batch.fromSeq).toBe(5);
    expect(batch.seq).toBe(9);
    // No one id addresses five events, so the row is addressed by its range instead.
    expect(batch.eventId).toBeUndefined();
  });

  it("draws a live batch the same way it draws a replayed one", () => {
    const params: AgentUpdateParams = {
      subscriptionId: "sub-1",
      runId: MANY_RUN_ID,
      seq: 9,
      at: MANY_EVENTS[9]!.at,
      fromSeq: 5,
      stepRunId: "s-0",
      sessionId: "sess-0",
      updates: Array.from({ length: UPDATES_PER_NODE }, (_unused, i) => ({
        kind: "agent_message_chunk",
        text: `${i}`,
      })),
    };
    const live = agentUpdateEntry(params, new Map([["s-0", "node-0"]]));
    const replayed = toEntries(MANY_EVENTS.slice(0, 11), new Map([["s-0", "node-0"]]))[5]!;

    expect(live.summary).toBe(replayed.summary);
    expect([live.fromSeq, live.seq]).toEqual([replayed.fromSeq, replayed.seq]);
    expect(live.count).toBe(replayed.count);
  });

  it("falls back to the step run id when the batch arrives for a step no page has named", () => {
    // Live output can outrun the page that would name the step — a `step.scheduled` the
    // client has not read yet. The row still has to address something.
    const params: AgentUpdateParams = {
      subscriptionId: "sub-1",
      runId: MANY_RUN_ID,
      seq: 5,
      at: MANY_EVENTS[5]!.at,
      fromSeq: 5,
      stepRunId: "s-0",
      sessionId: "sess-0",
      updates: [{ kind: "agent_message_chunk", text: "0" }],
    };
    expect(agentUpdateEntry(params, new Map()).summary).toBe("s-0, agent output");
  });
});

describe("merging pages", () => {
  it("has no anchor and no cursor before the first page arrives", () => {
    // An empty list is the opening state of every run screen, not an error: `undefined`
    // is "do not ask for a page before anything" rather than sequence zero.
    expect(earliestSeq([])).toBeUndefined();
    expect(appliedSeq([])).toBeUndefined();
  });

  it("takes the first page whole, with nothing in front of it", () => {
    const page = toEntries(MANY_EVENTS.slice(0, 20), new Map());
    expect(mergeEntries([], page)).toEqual({ entries: page, prepended: 0 });
  });

  it("leaves the list alone when the page came back empty", () => {
    // The end of the log going backwards: a merge that moved nothing must report no shift,
    // or the list scrolls for a page that was never drawn.
    const held = toEntries(MANY_EVENTS.slice(0, 20), new Map());
    expect(mergeEntries(held, [])).toEqual({ entries: held, prepended: 0 });
  });

  it("reports how many rows landed in front, which is what shiftBy needs", () => {
    const held = toEntries(MANY_EVENTS.slice(20, 30), new Map());
    const earlier = toEntries(MANY_EVENTS.slice(10, 20), new Map());
    const { entries, prepended } = mergeEntries(held, earlier);

    expect(prepended).toBe(earlier.length);
    expect(entries.slice(0, earlier.length)).toEqual(earlier);
  });

  it("drops a duplicate rather than doubling a row", () => {
    const page = toEntries(MANY_EVENTS.slice(0, 20), new Map());
    const { entries, prepended } = mergeEntries(page, page);
    expect(entries).toHaveLength(page.length);
    expect(prepended).toBe(0);
  });

  it("appends a live event without disturbing the page under it", () => {
    const held = toEntries(MANY_EVENTS.slice(0, 20), new Map());
    const next = toEntry(MANY_EVENTS[20]!, new Map());
    const { entries, prepended } = mergeEntries(held, [next]);
    expect(prepended).toBe(0);
    expect(entries[entries.length - 1]).toEqual(next);
  });

  it("pages ten thousand events backwards with no gap and no duplicate", () => {
    const LIMIT = 200;

    // The newest page first, which is where a person opens a run.
    let page = serveEvents(MANY_EVENTS, { runId: MANY_RUN_ID, before: Number.MAX_SAFE_INTEGER, limit: LIMIT });
    let entries: readonly TimelineEntry[] = toEntries(page.events, new Map());
    expect(page.lastSeq).toBe(EVENT_COUNT - 1);
    expect(appliedSeq(entries)).toBe(EVENT_COUNT - 1);

    let pages = 1;
    let prependedTotal = 0;
    while (page.hasMore) {
      const before = earliestSeq(entries)!;
      page = serveEvents(MANY_EVENTS, { runId: MANY_RUN_ID, before, limit: LIMIT });
      const merged = mergeEntries(entries, toEntries(page.events, new Map()));
      entries = merged.entries;
      prependedTotal += merged.prepended;
      pages += 1;
      expect(pages).toBeLessThan(EVENT_COUNT); // a page that made no progress would spin
    }

    expect(pages).toBe(Math.ceil(EVENT_COUNT / LIMIT));
    expect(earliestSeq(entries)).toBe(0);
    expect(appliedSeq(entries)).toBe(EVENT_COUNT - 1);

    // Every event, once, in order — with the coalesced runs of agent updates standing for
    // the events between their `fromSeq` and their `seq`.
    const covered: number[] = [];
    for (const entry of entries) for (let seq = entry.fromSeq; seq <= entry.seq; seq += 1) covered.push(seq);
    expect(covered).toEqual(Array.from({ length: EVENT_COUNT }, (_unused, i) => i));
    expect(prependedTotal).toBe(
      entries.length -
        toEntries(
          serveEvents(MANY_EVENTS, { runId: MANY_RUN_ID, before: Number.MAX_SAFE_INTEGER, limit: LIMIT }).events,
          new Map(),
        ).length,
    );
  });

  it("pages forwards from the start to the end the same way", () => {
    const LIMIT = 500;
    let page = serveEvents(MANY_EVENTS, { runId: MANY_RUN_ID, limit: LIMIT });
    let entries: readonly TimelineEntry[] = toEntries(page.events, new Map());

    while (page.hasMore) {
      const after = appliedSeq(entries)!;
      page = serveEvents(MANY_EVENTS, { runId: MANY_RUN_ID, after, limit: LIMIT });
      entries = mergeEntries(entries, toEntries(page.events, new Map())).entries;
    }

    const covered = new Set<number>();
    for (const entry of entries) for (let seq = entry.fromSeq; seq <= entry.seq; seq += 1) covered.add(seq);
    expect(covered.size).toBe(EVENT_COUNT);
    expect(entries.map((e) => e.seq)).toEqual([...entries].sort((a, b) => a.seq - b.seq).map((e) => e.seq));
  });
});
