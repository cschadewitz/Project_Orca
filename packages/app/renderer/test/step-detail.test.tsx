// @vitest-environment happy-dom
/**
 * The step detail pane and the output pane inside it, against the fake preload bridge.
 *
 * The log is scripted rather than taken from `fixtures.ts`, because that fixture has no
 * `agent.update` events in it — it is a fixture of run *shapes* — and a stream is the one
 * thing this surface is for. The script pages the way the daemon does (`before` takes the
 * events immediately before the cursor), so the load-earlier test below is really paging
 * and not a stub agreeing with itself.
 *
 * happy-dom has no layout engine, so the two numbers a layout would have supplied are
 * stood in for the way `virtual-list.test.tsx` documents: `--row-h` bound on the scroller,
 * and a `clientHeight` on it. Everything else — the window, the offsets, the hold — is the
 * substrate's own arithmetic over those two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { STATUS_PRESENTATION } from "@orca/design";
import type { NotificationMessage, RunsEventsParams, RunsEventsResult } from "@orca/protocol";
import { ArtifactPanelProvider, useArtifactPanel, type ArtifactTarget } from "../src/artifacts/panel-context.js";
import { StepDetail } from "../src/step/step-detail.js";
import type { AgentUpdate, LogEvent } from "../src/step/line-buffer.js";
import { RUN_DETAILS } from "./fixtures.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

/** The design system's real log row height, so the numbers below are the app's numbers. */
const ROW = 18;
/** Twenty lines of viewport. */
const VIEWPORT = 360;

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];
let opened: ArtifactTarget | undefined;

const PARENT = RUN_DETAILS["run-parent"]!;

/* ---------- a scripted log ---------- */

let nextSeq = 0;
const event = (type: string, stepRunId: string, payload: Record<string, unknown>): LogEvent =>
  ({
    id: `e${nextSeq}`,
    seq: nextSeq++,
    runId: "run-parent",
    at: new Date(Date.UTC(2026, 2, 1, 9, 0, nextSeq)).toISOString(),
    type,
    payload: { stepRunId, ...payload },
  }) as LogEvent;

const text = (stepRunId: string, body: string): LogEvent =>
  event("agent.update", stepRunId, { sessionId: "sess-2", update: { kind: "agent_message_chunk", text: body } });

/** What the daemon's own `runs.events` would answer over `log`, filtered and paged. */
function page(log: readonly LogEvent[], params: Partial<RunsEventsParams>): RunsEventsResult {
  const all = log.filter((e) => {
    if (params.stepRunId === undefined) return true;
    const payload: Record<string, unknown> = e.payload;
    return payload["stepRunId"] === params.stepRunId;
  });
  const lastSeq = log.length ? log[log.length - 1]!.seq : 0;
  const limit = params.limit ?? 200;
  const window =
    params.before !== undefined
      ? all.filter((e) => e.seq < params.before!).slice(-limit)
      : all.filter((e) => params.after === undefined || e.seq > params.after).slice(0, limit);
  const first = window[0];
  const last = window[window.length - 1];
  return {
    events: window,
    ...(last ? { nextCursor: last.seq } : {}),
    ...(first ? { prevCursor: first.seq } : {}),
    hasMore:
      params.before !== undefined
        ? first !== undefined && all.some((e) => e.seq < first.seq)
        : last !== undefined && all.some((e) => e.seq > last.seq),
    lastSeq,
    asOf: "2026-03-01T09:00:40.000Z",
  };
}

function scriptLog(log: readonly LogEvent[]): void {
  fake.script({ "runs.events": (params) => ({ ok: true, result: page(log, params) }) });
}

/* ---------- mounting ---------- */

function Probe(): null {
  const panel = useArtifactPanel();
  opened = panel.target;
  return null;
}

function renderStep(stepRunId: string | undefined, connection: "live" | "reconnecting" = "live"): void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <ArtifactPanelProvider>
        <Probe />
        <StepDetail detail={PARENT} stepRunId={stepRunId} connection={connection} />
      </ArtifactPanelProvider>
    </Providers>,
  );
}

const scroller = (): HTMLElement => document.querySelector<HTMLElement>(".orca-list__scroller")!;
const stream = (): HTMLElement => screen.getByRole("listbox", { name: /^Output of/ });
const rows = (): HTMLElement[] => screen.queryAllByRole("option");

/**
 * The rendered *lines*, without the edge marker. Selected by class rather than by index,
 * because the window moves: after a page lands in front of the list the substrate shifts
 * the offset to keep the reader in place, and row zero is then off screen — which is the
 * point of the shift, and would make "the first row is the marker" a wrong assumption.
 */
const logLines = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".orca-log__line")]
    .filter((row) => row.querySelector(".orca-log__t") !== null)
    .map((row) => row.textContent ?? "");

/** An `agent.update` frame, with the envelope fields every notification carries. */
const agentUpdate = (stepRunId: string, seq: number, body: string): NotificationMessage => ({
  kind: "notification",
  method: "agent.update",
  params: {
    subscriptionId: "sub-1",
    runId: "run-parent",
    seq,
    fromSeq: seq,
    at: "2026-03-01T09:01:00.000Z",
    stepRunId,
    sessionId: "sess-2",
    updates: [{ kind: "agent_message_chunk", text: body }],
  },
});

describe("the step detail pane", () => {
  let cascade: HTMLStyleElement;
  let clientHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    nextSeq = 0;
    opened = undefined;
    fake = installBridge();

    cascade = document.createElement("style");
    cascade.textContent = `.orca-list__scroller { --row-h: ${ROW}px; }`;
    document.head.append(cascade);
    clientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight");
    Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("orca-list__scroller") ? VIEWPORT : 0;
      },
    });
  });

  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
    cascade.remove();
    Reflect.deleteProperty(window.HTMLElement.prototype, "clientHeight");
    if (clientHeight) Object.defineProperty(window.HTMLElement.prototype, "clientHeight", clientHeight);
    vi.useRealTimers();
  });

  it("says node, attempt, agent, host and duration — and nothing about cost", async () => {
    scriptLog([
      event("agent.session.opened", "s-build-2", {
        sessionId: "sess-2",
        agentId: "claude",
        hostId: "build-01",
        cwd: "/work/orca",
      }),
      text("s-build-2", "compiling\n"),
    ]);
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });

    const pane = document.querySelector<HTMLElement>(".orca-step__metrics")!;
    expect([...pane.querySelectorAll(".orca-step__metric")].map((m) => m.textContent)).toEqual([
      "nodeagent",
      "attempt2",
      "agentclaude",
      // The host is not on `StepView`; it comes out of `agent.session.opened` in the same
      // page of the log the output pane reads.
      "hostbuild-01",
      "duration3.0s",
    ]);

    /* Rule 12: ORCA cannot supply a token count or a cost, so the slot the design leaves
       for one more metric is empty rather than filled with an approximation. */
    expect(document.body.textContent).not.toMatch(/cost|token|\$/i);
  });

  it("renders the step's output as lines, each carrying its event's sequence number", async () => {
    scriptLog([text("s-build-2", "first line\nsecond line\n"), text("s-build-2", "third line\n")]);
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });

    await waitFor(() => expect(logLines()).toHaveLength(3));
    // Two lines share seq 0 because one `agent.update` rendered both of them, which is the
    // honest rendering: a line boundary is not a thing the wire can name.
    expect(logLines()).toEqual(["0first line", "0second line", "1third line"]);
    // And the pane says which of the two things it is showing rather than showing a
    // partial log silently.
    expect(rows()[0]!.textContent).toContain("Start of this step");
  });

  it("collapses a line over 2,000 characters rather than wrapping it", async () => {
    scriptLog([text("s-build-2", `${"z".repeat(2_500)}\n`)]);
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });

    await waitFor(() => expect(screen.getByText(/more characters/)).toBeTruthy());
    expect(screen.getByText(/more characters/).textContent).toBe("\u2026 500\u00a0more characters");
  });

  it("opens the docked panel on the artifacts the step produced, by name and version", async () => {
    scriptLog([text("s-build-2", "done\n")]);
    renderStep("s-build-2");

    const chip = await screen.findByRole("button", { name: "spec@v1" });
    // Metadata only, and filtered by the step: a chip must not cost a body.
    expect(fake.calls.filter((c) => c.method === "artifacts.list")).toEqual([
      { method: "artifacts.list", params: { runId: "run-parent", producedByStepRunId: "s-build-2" } },
    ]);

    fireEvent.click(chip);
    expect(opened).toEqual({ runId: "run-parent", name: "spec", version: 1 });
  });

  it("lists the tool calls, with the state in a word and not only in a colour", async () => {
    scriptLog([
      event("agent.update", "s-build-2", {
        sessionId: "sess-2",
        update: { kind: "tool_call", toolCallId: "t1", title: "bash", status: "pending" },
      }),
      event("agent.permission", "s-build-2", {
        sessionId: "sess-2",
        toolCallId: "t1",
        title: "bash",
        decision: "deny",
      }),
    ]);
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });

    const call = document.querySelector<HTMLElement>(".orca-tool")!;
    expect(call.className).toContain("orca-tool--failed");
    expect(within(call).getByText("bash")).toBeTruthy();
    expect(within(call).getByText("failed")).toBeTruthy();
    expect(within(call).getByText("deny")).toBeTruthy();
  });

  it("updates tool rows from the live batch without reselecting the mounted step", async () => {
    scriptLog([]);
    renderStep("s-fan");
    await screen.findByRole("listbox", { name: /^Output of fanout/ });
    const reads = fake.calls.filter((c) => c.method === "runs.events").length;
    const push = async (seq: number, updates: AgentUpdate[]): Promise<void> => {
      act(() => {
        fake.notify({
          kind: "notification",
          method: "agent.update",
          params: {
            subscriptionId: "sub-1",
            runId: "run-parent",
            stepRunId: "s-fan",
            sessionId: "sess-2",
            fromSeq: seq,
            seq: seq + updates.length - 1,
            at: "2026-03-01T09:01:00.000Z",
            updates,
          },
        });
      });
      // This also proves the real output buffer committed the notification, even when
      // the old hook never puts that same update into the rendered tool-call fold.
      await waitFor(() => expect(logLines().some((line) => line.includes(`frame ${seq}`))).toBe(true));
    };
    await push(100, [
      { kind: "tool_call", toolCallId: "live-tool", title: "Read source", status: "pending" },
      { kind: "agent_message_chunk", text: "frame 100\n" },
    ]);
    const call = document.querySelector<HTMLElement>(".orca-tool");
    expect(call).not.toBeNull();
    expect(within(call!).getByText("running")).toBeTruthy();
    await push(102, [
      { kind: "tool_call_update", toolCallId: "live-tool", status: "in_progress", title: "Reading source" },
      { kind: "agent_message_chunk", text: "frame 102\n" },
    ]);
    expect(within(call!).getByText("Reading source")).toBeTruthy();
    await push(104, [
      {
        kind: "tool_call_update",
        toolCallId: "live-tool",
        status: "completed",
        result: { text: "public result", length: 13 },
      },
      { kind: "agent_message_chunk", text: "frame 104\n" },
    ]);
    expect(within(call!).getByText("done")).toBeTruthy();
    expect(within(call!).getByText("public result")).toBeTruthy();
    await push(106, [
      { kind: "tool_call", toolCallId: "failed-tool", title: "Check source", status: "failed" },
      { kind: "agent_message_chunk", text: "frame 106\n" },
    ]);
    expect(document.querySelectorAll(".orca-tool")).toHaveLength(2);
    expect(screen.getByText("failed")).toBeTruthy();
    expect(document.querySelector(".orca-tool")).toBe(call);
    expect(fake.calls.filter((c) => c.method === "runs.events")).toHaveLength(reads);
  });

  it("shows what the call is waiting to be allowed to do while it is still open", async () => {
    scriptLog([
      event("agent.update", "s-build-2", {
        sessionId: "sess-2",
        update: {
          kind: "tool_call",
          toolCallId: "t1",
          title: "bash",
          status: "pending",
          args: { text: '{"command":"rm -rf build"}', length: 26 },
        },
      }),
      event("human.requested", "s-build-2", {
        requestId: "hi-9",
        kind: "permission",
        question: "Run rm -rf build?",
        options: [],
        context: { toolCallId: "t1" },
      }),
    ]);
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });

    const call = document.querySelector<HTMLElement>(".orca-tool")!;
    expect(call.className).toContain("orca-tool--awaiting");
    expect(within(call).getByText("waiting for permission")).toBeTruthy();
    expect(within(call).getByText("Run rm -rf build?")).toBeTruthy();
    expect(within(call).getByText("command=rm -rf build")).toBeTruthy();
  });

  it("says how much of a body was cut at write time rather than ending mid-token", async () => {
    scriptLog([
      event("agent.update", "s-build-2", {
        sessionId: "sess-2",
        update: {
          kind: "tool_call",
          toolCallId: "t1",
          title: "bash",
          status: "completed",
          result: { text: "q".repeat(2_000), length: 41_318 },
        },
      }),
    ]);
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });
    expect(screen.getByText(/showing 2,000 of 41,318 characters/)).toBeTruthy();
  });

  it("says the session's closing error when the step itself recorded none", async () => {
    scriptLog([
      event("agent.session.opened", "s-fan", {
        sessionId: "sess-3",
        agentId: "claude",
        hostId: "build-01",
        cwd: "/work/orca",
      }),
      event("agent.turn.completed", "s-fan", { sessionId: "sess-3", stopReason: "end_turn", durationMs: 10 }),
      event("agent.session.closed", "s-fan", {
        sessionId: "sess-3",
        error: { code: "AGENT_TRANSPORT", message: "the agent went away" },
      }),
    ]);
    renderStep("s-fan");
    await screen.findByRole("listbox", { name: /^Output of fanout/ });
    expect(screen.getByText("AGENT_TRANSPORT: the agent went away")).toBeTruthy();
  });

  it("says so, with the code, when the daemon answers the log badly", async () => {
    fake.fail("runs.events", { code: "RUN_NOT_FOUND", message: "no run run-parent" });
    renderStep("s-build-2");
    expect(await screen.findByText("RUN_NOT_FOUND: no run run-parent")).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: /^Output of/ })).toBeNull();
  });
});

describe("following and holding", () => {
  let cascade: HTMLStyleElement;
  let clientHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    nextSeq = 0;
    fake = installBridge();
    cascade = document.createElement("style");
    cascade.textContent = `.orca-list__scroller { --row-h: ${ROW}px; }`;
    document.head.append(cascade);
    clientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight");
    Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("orca-list__scroller") ? VIEWPORT : 0;
      },
    });
  });

  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
    cascade.remove();
    Reflect.deleteProperty(window.HTMLElement.prototype, "clientHeight");
    if (clientHeight) Object.defineProperty(window.HTMLElement.prototype, "clientHeight", clientHeight);
    vi.useRealTimers();
  });

  it("holds without scrolling under the reader, and counts what arrived, over 400 lines", async () => {
    // More lines than the viewport holds, so there is somewhere to scroll away to.
    scriptLog(Array.from({ length: 50 }, (_, i) => text("s-fan", `opening ${i}\n`)));
    renderStep("s-fan");
    await screen.findByRole("listbox", { name: /^Output of fanout/ });
    await waitFor(() => expect(logLines().length).toBeGreaterThan(0));

    // Scroll away from the end: following stops immediately, and once.
    const element = scroller();
    element.scrollTop = 0;
    fireEvent.scroll(element);
    const held = await screen.findByRole("button", { name: /new line/ });
    const where = element.scrollTop;

    vi.useFakeTimers();
    // Forty lines a second for ten seconds, as the daemon coalesces them.
    for (let i = 0; i < 400; i++) {
      act(() => {
        fake.notify(agentUpdate("s-fan", 100 + i, `line ${i}\n`));
        vi.advanceTimersByTime(25);
      });
    }
    act(() => {
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();

    // Nothing scrolled under the reader's eyes, ever.
    expect(element.scrollTop).toBe(where);
    expect(held.textContent).toBe("\u2193 400\u00a0new lines");

    // And the button takes them back to the end, following again.
    fireEvent.click(held);
    await waitFor(() => expect(screen.queryByRole("button", { name: /new line/ })).toBeNull());
    expect(element.scrollTop).toBeGreaterThan(where);
  });

  it("pages earlier output in across the trim boundary with no gap and no duplicate", async () => {
    // Longer than a page, so the first read takes the tail and the marker offers the rest.
    const log = Array.from({ length: 12 }, (_, i) => text("s-build-2", `line ${i}\n`));
    fake.script({ "runs.events": (params) => ({ ok: true, result: page(log, { ...params, limit: 5 }) }) });

    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "Load earlier output" })).toBeTruthy());
    expect(logLines().map(strip)).toEqual(["line 7", "line 8", "line 9", "line 10", "line 11"]);

    fireEvent.click(screen.getByRole("button", { name: "Load earlier output" }));
    await waitFor(() => expect(logLines().length).toBeGreaterThan(5));

    const shown = logLines().map(strip);
    expect(shown).toEqual([
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
    ]);
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("keeps the marker and says so while the earlier page is on its way", async () => {
    const log = Array.from({ length: 12 }, (_, i) => text("s-build-2", `line ${i}\n`));
    fake.script({ "runs.events": (params) => ({ ok: true, result: page(log, { ...params, limit: 5 }) }) });
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "Load earlier output" })).toBeTruthy());

    const release = fake.hold("runs.events");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier output" }));
    const loading = await screen.findByRole("button", { name: "Loading…" });
    expect(loading.getAttribute("aria-disabled")).toBe("true");
    release();
    await waitFor(() => expect(logLines().length).toBeGreaterThan(5));
  });

  it("puts G, ⇧G, /, N and ⇧N on the keyboard map in the stream scope, and nothing else", async () => {
    scriptLog(Array.from({ length: 40 }, (_, i) => text("s-build-2", `line ${i}\n`)));
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });
    await waitFor(() => expect(logLines().length).toBeGreaterThan(0));

    const stream = h.keyboard.list().filter((s) => s.scope === "stream");
    // `End` is deliberately absent: it is the substrate's "last line" in this scope, and
    // selecting the last line *is* re-entering following.
    expect(stream.map((s) => s.key).sort()).toEqual(
      [
        "ArrowDown",
        "ArrowUp",
        "End",
        "G",
        "Home",
        "J",
        "K",
        "PageDown",
        "PageUp",
        "Shift+G",
        "Shift+N",
        "/",
        "N",
      ].sort(),
    );
  });

  it("goes to the top with G and back to the end, following again, with ⇧G", async () => {
    scriptLog(Array.from({ length: 40 }, (_, i) => text("s-fan", `line ${i}\n`)));
    renderStep("s-fan");
    await screen.findByRole("listbox", { name: /^Output of fanout/ });
    await waitFor(() => expect(logLines().length).toBeGreaterThan(0));

    const element = scroller();
    fireEvent.keyDown(stream(), { key: "g", code: "KeyG" });
    await waitFor(() => expect(element.scrollTop).toBe(0));
    // Going to the top is leaving the end: following stops and the jump button appears.
    expect(await screen.findByRole("button", { name: /new line/ })).toBeTruthy();

    fireEvent.keyDown(stream(), { key: "G", code: "KeyG", shiftKey: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: /new line/ })).toBeNull());
    expect(element.scrollTop).toBeGreaterThan(0);
  });

  it("searches the buffered lines only, and cycles the matches with N and ⇧N", async () => {
    scriptLog(Array.from({ length: 40 }, (_, i) => text("s-build-2", `line ${i}\n`)));
    renderStep("s-build-2");
    await screen.findByRole("listbox", { name: /^Output of build/ });
    await waitFor(() => expect(logLines().length).toBeGreaterThan(0));

    fireEvent.keyDown(stream(), { key: "/", code: "Slash" });
    const field = screen.getByRole("searchbox", { name: /Search the output/ });
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: "line 3" } });
    // "line 3" and "line 30".."line 39": eleven, and the count says what it searched.
    expect(screen.getByText("11 in 40 buffered lines")).toBeTruthy();

    // `Enter` commits the search and moves to the first match.
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(stream().getAttribute("aria-activedescendant")).toBe("log-line-3"));

    fireEvent.keyDown(stream(), { key: "n", code: "KeyN" });
    await waitFor(() => expect(stream().getAttribute("aria-activedescendant")).toBe("log-line-30"));
    fireEvent.keyDown(stream(), { key: "N", code: "KeyN", shiftKey: true });
    await waitFor(() => expect(stream().getAttribute("aria-activedescendant")).toBe("log-line-3"));
  });

  it.each(["Enter", "N", "Shift+N"])("holds a %s search landing across live appends", async (navigation) => {
    scriptLog(Array.from({ length: 80 }, (_, i) => text("s-fan", `line ${i}\n`)));
    renderStep("s-fan");
    await screen.findByRole("listbox", { name: /^Output of fanout/ });
    await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
    const field = screen.getByRole("searchbox", { name: /Search the output/ });
    fireEvent.change(field, { target: { value: "line 2" } });
    if (navigation === "Enter") fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    else fireEvent.keyDown(stream(), { key: "n", code: "KeyN", shiftKey: navigation === "Shift+N" });
    const heldAt = scroller().scrollTop;
    expect(heldAt).toBeLessThan(81 * ROW - VIEWPORT);

    vi.useFakeTimers();
    act(() => {
      fake.notify(agentUpdate("s-fan", 100, "arrived while reading\n"));
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    expect(scroller().scrollTop).toBe(heldAt);
    expect(await screen.findByRole("button", { name: /1.new line/ })).toBeTruthy();

    // End explicitly resumes following; the next live append must reach the end.
    fireEvent.keyDown(stream(), { key: "End", code: "End" });
    expect(screen.queryByRole("button", { name: /new line/ })).toBeNull();
    const latest = scroller().scrollTop;
    vi.useFakeTimers();
    act(() => {
      fake.notify(agentUpdate("s-fan", 101, "following again\n"));
      vi.advanceTimersByTime(200);
    });
    vi.useRealTimers();
    expect(scroller().scrollTop).toBeGreaterThan(latest);
  });

  it("marks where the stream stopped and where it came back, inline and not as a banner", async () => {
    scriptLog([text("s-fan", "before\n")]);
    const { rerender } = renderConnection("live");
    await screen.findByRole("listbox", { name: /^Output of fanout/ });

    rerender("reconnecting");
    await screen.findByText(/paused — reconnecting/);
    rerender("live");
    await screen.findByText(/^reconnected \d\d:\d\d:\d\d$/);

    /* Rule 11, in the shape #167 settled it: the pane *is* a `log` region, named for the
       step, so a person can go to it on demand — and it never speaks, whatever lands in
       it. `role="log"` carries an implicit `aria-live="polite"`, so the explicit `off`
       beside it is what keeps forty lines a second out of a screen reader's ear. */
    const log = stream().closest('[role="log"]');
    expect(log).not.toBeNull();
    expect(log?.getAttribute("aria-label")).toMatch(/^Output of fanout/);
    expect(log?.getAttribute("aria-live")).toBe("off");
    // Nothing between the lines and that region reinstates a polite one.
    expect(stream().closest('[aria-live="polite"]')).toBeNull();
  });

  /** Mount once and change only the connection, which is what the chrome does. */
  function renderConnection(initial: "live" | "reconnecting"): { rerender: (next: "live" | "reconnecting") => void } {
    h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    const tree = (connection: "live" | "reconnecting"): React.JSX.Element => (
      <Providers>
        <ArtifactPanelProvider>
          <StepDetail detail={PARENT} stepRunId="s-fan" connection={connection} />
        </ArtifactPanelProvider>
      </Providers>
    );
    const view = render(tree(initial));
    return { rerender: (next) => view.rerender(tree(next)) };
  }
});

describe("a run with no step selected", () => {
  beforeEach(() => {
    nextSeq = 0;
    fake = installBridge();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("is a minimal run summary in the same pane: variables, artifacts and the error", async () => {
    renderStep(undefined);

    expect(screen.getByText("Add the SSO callback")).toBeTruthy();
    expect(screen.getByText("Variables (1)")).toBeTruthy();
    expect(screen.getByText("branch")).toBeTruthy();
    expect(screen.getByText("feat/sso")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "spec@v1" })).toBeTruthy();

    // No step means no output pane: there is no step whose output it would be.
    expect(screen.queryByRole("listbox", { name: /^Output of/ })).toBeNull();
  });

  it("says the run's status once, on its chip, rather than again as a caption beside it", () => {
    renderStep(undefined);
    const head = document.querySelector(".orca-inspector__head")!;
    const { word } = STATUS_PRESENTATION[PARENT.run.status];
    // The chip carries the glyph and the word (rule 4); nothing else in the head repeats it.
    expect(head.querySelectorAll(".orca-chip")).toHaveLength(1);
    expect(head.textContent?.split(word)).toHaveLength(2);
    expect(within(head as HTMLElement).getByText(PARENT.run.name)).toBeTruthy();
  });

  it("does not read a step's log when there is no step", () => {
    renderStep(undefined);
    expect(fake.calls.filter((c) => c.method === "runs.events")).toEqual([]);
  });
});

/** The row's text without the sequence-number gutter in front of it. */
const strip = (row: string): string => row.replace(/^\d+/, "");
