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
    expect(batch.summary).toBe(`node-0, ${UPDATES_PER_NODE} agent updates`);
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
});

describe("merging pages", () => {
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
