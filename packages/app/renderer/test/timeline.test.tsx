// @vitest-environment happy-dom
/**
 * The event timeline against the fake bridge, over the ten-thousand-event run in
 * `fixtures-events.ts` (#157).
 *
 * The paging test is the one that matters and it is deliberately literal: it clicks "load
 * earlier events" until the button goes away and asserts the count reaches exactly ten
 * thousand, which is what "no gap and no duplicate" looks like from outside — a gap would
 * leave it short and a duplicate would take it past. It also asserts that the rows on
 * screen do not move while it happens, because a backward page that did not call the
 * substrate's `shiftBy` would throw the reader back by exactly the page they asked for.
 *
 * The rest is what a row says: the kind verbatim, the event id in the copy menu, the
 * sequence range where a coalesced batch has no id, and the auto-approved gate naming its
 * source rather than a condition nobody sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NotificationMessage, RunsEventsResult } from "@orca/protocol";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { PAGE } from "../src/runs/timeline/use-run-events.js";
import { AUTO_GATE_SOURCE } from "../src/runs/timeline/timeline-entries.js";
import {
  AUTO_SOURCE,
  EVENT_COUNT,
  MANY_DETAIL,
  MANY_EVENTS,
  MANY_RUN,
  MANY_RUN_ID,
  UPDATES_PER_NODE,
  serveEvents,
} from "./fixtures-events.js";
import { installBridge, harness, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { parseId } from "../src/ui/object-id-model.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

/** Point every read method at the long run, which `fixtures.ts`'s store does not hold. */
function serveLongRun(): void {
  fake.script({
    "runs.list": () => ({ ok: true, result: { runs: [MANY_RUN], total: 1, asOf: MANY_DETAIL.asOf } }),
    "runs.get": () => ({ ok: true, result: MANY_DETAIL }),
    "runs.events": (params) => ({ ok: true, result: serveEvents(MANY_EVENTS, params) }),
  });
}

const tree = (): HTMLElement => screen.getByRole("tree", { name: "Run tree" });
const timeline = (): HTMLElement => screen.getByRole("listbox", { name: "Event timeline" });
const entries = (): HTMLElement[] => within(timeline()).queryAllByRole("option");
const count = (): string => document.querySelector(".orca-runs__timeline-bar .orca-runs__count")!.textContent ?? "";
const cursor = (): string => document.querySelector(".orca-runs__cursor")!.textContent ?? "";
const earlierButton = (): HTMLElement | null => screen.queryByRole("button", { name: /earlier events/ });

/** Mount, select the only run, and wait for its newest page. */
async function openTimeline(): Promise<void> {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <RunsSurface connection="live" />
    </Providers>,
  );
  await screen.findByRole("tree", { name: "Run tree" });
  await act(async () => {
    fireEvent.keyDown(tree(), { key: "j", code: "KeyJ" });
  });
  await screen.findByRole("listbox", { name: "Event timeline" });
  await waitFor(() => expect(entries().length).toBeGreaterThan(0));
}

describe("the event timeline", () => {
  beforeEach(() => {
    fake = installBridge();
    serveLongRun();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("opens on the newest page of the log, which is where the last thing that happened is", async () => {
    await openTimeline();

    const calls = fake.calls.filter((c) => c.method === "runs.events");
    expect(calls).toHaveLength(1);
    /* `runs.events` has no "newest page" anchor, so the newest page is asked for as
       everything before a sequence number no run can reach. Worth #208's attention. */
    expect(calls[0]!.params).toEqual({ runId: MANY_RUN_ID, before: Number.MAX_SAFE_INTEGER, limit: PAGE });

    expect(count()).toBe(`${PAGE} events`);
    expect(cursor()).toBe(`as of event ${EVENT_COUNT - 1}`);
  });

  it("pages ten thousand events backwards with no gap and no duplicate, without moving what is on screen", async () => {
    await openTimeline();
    const onScreen = entries().map((row) => row.id);

    // This button persists until the last page. Re-running the document-wide accessible
    // name query twice per page dominated this 50-page test under parallel load (#228).
    const button = earlierButton()!;
    let pages = 1;
    while (button.isConnected) {
      const held = count();
      await act(async () => {
        fireEvent.click(button);
      });
      await waitFor(() => expect(count()).not.toBe(held));
      pages += 1;
      expect(pages).toBeLessThanOrEqual(EVENT_COUNT / PAGE);
    }

    expect(pages).toBe(EVENT_COUNT / PAGE);
    // Exactly the log: a gap would leave this short, a duplicate would take it past.
    expect(count()).toBe(`${EVENT_COUNT} events`);
    // And the reader is where they were — the substrate's `shiftBy` held the window.
    expect(entries().map((row) => row.id)).toEqual(onScreen);
    expect(cursor()).toBe(`as of event ${EVENT_COUNT - 1}`);
  });

  it("never asks for a page it already has", async () => {
    await openTimeline();
    await act(async () => {
      fireEvent.click(earlierButton()!);
    });
    await waitFor(() => expect(count()).toBe(`${PAGE * 2} events`));

    const anchors = fake.calls
      .filter((c) => c.method === "runs.events")
      .map((c) => (c.params as { before?: number }).before);
    expect(anchors).toEqual([Number.MAX_SAFE_INTEGER, EVENT_COUNT - PAGE]);
  });

  it("draws an auto-approved gate quietly, naming the source and not the condition", async () => {
    await openTimeline();

    const auto = document.querySelector(".orca-runs__auto")!;
    expect(auto.textContent).toContain(`by ${AUTO_GATE_SOURCE}`);
    expect(AUTO_GATE_SOURCE).toBe(AUTO_SOURCE);
    // `autoApproveWhen` is configuration, it is not on the event, and the row does not
    // pretend otherwise (docs/design/RULES.md rule 12).
    expect(auto.textContent).not.toContain("when");
    expect(auto.classList.contains("orca-timeline-entry")).toBe(true);
  });

  it("says the event kind verbatim, names the row by its sequence number, and copies the id from a Menu", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await openTimeline();

    const last = entries()[entries().length - 1]!;
    expect(within(last).getByText("run.completed")).toBeTruthy();

    /* The row is `#<seq>`, not an id tail: the sequence is the run's own cursor, and it
       orders. The event id is one step away in the menu, as its token, and copied whole. */
    const seq = EVENT_COUNT - 1;
    const trigger = within(last).getByRole("button", { name: `Event #${seq}` });
    expect(trigger.textContent).toBe(`#${seq}`);
    expect(last.textContent).not.toContain(`evt-many-${seq}`);
    fireEvent.click(trigger);
    const copyId = screen.getByRole("menuitem", {
      name: `Copy the event id event ${parseId(`evt-many-${seq}`).tail()}`,
    });
    expect(copyId.querySelector(".orca-objid__kind")?.textContent).toBe("✦");
    expect(screen.getByRole("menuitem", { name: `Copy the sequence number ${seq}` })).toBeTruthy();
    fireEvent.click(copyId);
    expect(writeText).toHaveBeenCalledWith(`evt-many-${seq}`);
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("draws a run of agent updates as one row, addressed by its sequence range", async () => {
    await openTimeline();

    const batch = entries().find((row) => (row.textContent ?? "").includes(`${UPDATES_PER_NODE} agent updates`))!;
    expect(batch).toBeTruthy();
    // No one event id addresses five events, so the row offers the range instead.
    const trigger = within(batch).getByRole("button", { name: /^Event #\d+-\d+$/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: /^Copy the sequence range \d+-\d+$/ })).toBeTruthy();
  });

  it("filters by event kind, locally, and says how much of the log is left", async () => {
    await openTimeline();

    fireEvent.click(screen.getByRole("button", { name: /Filter by event kind/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "run.completed" }));

    await waitFor(() => expect(entries()).toHaveLength(1));
    expect(count()).toBe(`1 of ${PAGE} events`);
    // Local: the daemon was not asked again.
    expect(fake.calls.filter((c) => c.method === "runs.events")).toHaveLength(1);
  });

  it("tails forwards from event.appended and from a coalesced agent.update", async () => {
    await openTimeline();
    // The list is a window over the log, so what grows is the log and the cursor, not the
    // number of rows in the document.
    expect(count()).toBe(`${PAGE} events`);

    act(() => fake.notify(appended(EVENT_COUNT)));
    await waitFor(() => expect(cursor()).toBe(`as of event ${EVENT_COUNT}`));
    expect(count()).toBe(`${PAGE + 1} events`);
    expect(entries()[entries().length - 1]!.textContent).toContain("Run resumed");

    act(() => fake.notify(agentBatch(EVENT_COUNT + 1, EVENT_COUNT + 6)));
    await waitFor(() => expect(cursor()).toBe(`as of event ${EVENT_COUNT + 6}`));
    // One row for the batch, not one per update — the daemon coalesced it on purpose, and
    // the count is of events rather than of rows.
    expect(entries()[entries().length - 1]!.textContent).toContain("6 agent updates");
    expect(count()).toBe(`${PAGE + 7} events`);
  });

  it("selects the step a row is about, and the tree follows", async () => {
    await openTimeline();

    // A `step.completed` row, which names the node it is about.
    const row = entries().find((r) => (r.textContent ?? "").includes("step.completed"))!;
    fireEvent.click(row);

    await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));
    // The sticky header now says which step the timeline is on.
    expect(document.querySelector(".orca-runs__timeline-head")!.textContent).toMatch(/^node-\d+/);
  });

  it("says so when the daemon cannot answer, and retries on demand", async () => {
    fake.fail("runs.events", { code: "STORE_UNAVAILABLE", message: "the store is locked" });
    h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    render(
      <Providers>
        <RunsSurface connection="live" />
      </Providers>,
    );
    await screen.findByRole("tree", { name: "Run tree" });
    await act(async () => {
      fireEvent.keyDown(tree(), { key: "j", code: "KeyJ" });
    });

    expect(await screen.findByText("Could not load the event log")).toBeTruthy();
    expect(screen.getByText("STORE_UNAVAILABLE: the store is locked")).toBeTruthy();

    serveLongRun();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    await screen.findByRole("listbox", { name: "Event timeline" });
  });

  it("has nothing to show until a run is selected", async () => {
    h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    render(
      <Providers>
        <RunsSurface connection="live" />
      </Providers>,
    );
    await screen.findByRole("tree", { name: "Run tree" });

    expect(screen.getByText("No run selected")).toBeTruthy();
    expect(fake.calls.filter((c) => c.method === "runs.events")).toHaveLength(0);
  });
});

type OrcaEvent = RunsEventsResult["events"][number];

/** An `event.appended` frame carrying one more event at the end of the log. */
function appended(seq: number): NotificationMessage {
  const event: OrcaEvent = {
    id: `evt-many-${seq}`,
    seq,
    runId: MANY_RUN_ID,
    at: "2026-03-01T12:00:00.000Z",
    type: "run.resumed",
    payload: {},
  };
  return {
    kind: "notification",
    method: "event.appended",
    params: { subscriptionId: "sub-1", runId: MANY_RUN_ID, seq, at: event.at, event },
  };
}

/** One coalesced `agent.update`: a batch of updates with a sequence range and no ids. */
function agentBatch(fromSeq: number, seq: number): NotificationMessage {
  return {
    kind: "notification",
    method: "agent.update",
    params: {
      subscriptionId: "sub-1",
      runId: MANY_RUN_ID,
      seq,
      at: "2026-03-01T12:00:01.000Z",
      fromSeq,
      stepRunId: "s-0",
      sessionId: "sess-0",
      updates: Array.from({ length: seq - fromSeq + 1 }, (_unused, i) => ({
        kind: "agent_message_chunk",
        text: `line ${i}`,
      })),
    },
  };
}
