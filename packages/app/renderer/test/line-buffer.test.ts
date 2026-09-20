/**
 * The output buffer without a DOM: what a stream of `agent.update` events becomes, how
 * often it is allowed to commit, and what happens at the two boundaries — a line that is
 * too long, and a buffer that has trimmed.
 *
 * The commit-budget test is the one this module exists for. Forty lines a second for ten
 * seconds is a real agent on a real step, and a renderer that committed once per event
 * would do four hundred React renders for it. The floor is one commit per 100ms
 * (docs/design/60-implementation.md, "Streaming"), so ten seconds may cost a hundred and
 * in practice costs fewer, because a commit lands on the first frame after the floor has
 * passed rather than on the floor itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ELLIPSIS,
  LINE_CHAR_LIMIT,
  OutputBuffer,
  collapse,
  foldLabel,
  toneOf,
  updatesOf,
  updatesOfNotification,
  type AgentUpdate,
  type BufferedUpdate,
  type LineRow,
  type OutputRow,
} from "../src/step/line-buffer.js";

const chunk = (text: string, kind = "agent_message_chunk"): AgentUpdate => ({ kind, text });

const at = (seq: number, text: string, kind?: string): BufferedUpdate => ({
  seq,
  update: kind === undefined ? chunk(text) : chunk(text, kind),
});

const lines = (rows: readonly OutputRow[]): LineRow[] => rows.filter((r): r is LineRow => r.kind === "line");
const texts = (rows: readonly OutputRow[]): string[] => lines(rows).map((r) => r.text);

/** A buffer whose frames are ordinary timers, so `vi.useFakeTimers` drives them. */
function buffer(options: { limit?: number } = {}): OutputBuffer {
  return new OutputBuffer({
    ...options,
    schedule: (callback) => setTimeout(callback, 16) as unknown as number,
    cancel: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("turning events into lines", () => {
  it("joins chunks into a line and closes it on the newline, keeping the seq that started it", () => {
    const b = buffer();
    b.load([at(4, "hello "), at(5, "world\n"), at(6, "second\n")]);

    expect(texts(b.items)).toEqual(["hello world", "second"]);
    // The line's number is the event that *started* it — which is the event a `before`
    // cursor has to name to fetch that line again.
    expect(lines(b.items).map((r) => r.seq)).toEqual([4, 6]);
  });

  it("keeps an unterminated line open and goes on growing it", () => {
    const b = buffer();
    b.load([at(1, "par")]);
    expect(texts(b.items)).toEqual(["par"]);
    b.load([at(2, "tial")]);
    expect(texts(b.items)).toEqual(["partial"]);
  });

  it("ends a line when the tone changes: a thought and an answer are not one line", () => {
    const b = buffer();
    b.load([at(1, "thinking", "agent_thought_chunk"), at(2, "answering")]);
    expect(lines(b.items).map((r) => [r.text, r.tone])).toEqual([
      ["thinking", "dim"],
      ["answering", "out"],
    ]);
  });

  it("drops an event it has already taken, so a replayed page cannot duplicate a line", () => {
    const b = buffer();
    b.load([at(1, "one\n"), at(2, "two\n")]);
    b.load([at(2, "two\n"), at(3, "three\n")]);
    expect(texts(b.items)).toEqual(["one", "two", "three"]);
  });

  it("reads a tool call's title as one line, and a failure as an error line", () => {
    expect(toneOf({ kind: "tool_call", title: "read", status: "failed" })).toBe("err");
    const b = buffer();
    b.load([{ seq: 1, update: { kind: "tool_call", title: "read src/app.ts" } }]);
    expect(texts(b.items)).toEqual(["read src/app.ts"]);
  });
});

describe("a line that is too long", () => {
  it("collapses at 2,000 characters and says how many were left off, with U+2026", () => {
    const long = "x".repeat(LINE_CHAR_LIMIT + 84_102);
    const capped = collapse(long);
    expect(capped.text).toHaveLength(LINE_CHAR_LIMIT);
    expect(capped.folded).toBe(84_102);
    expect(foldLabel(capped.folded)).toBe(`${ELLIPSIS} 84,102 more characters`);
    // U+2026, the bundled ellipsis — not the midline U+22EF, which no bundled face carries.
    expect(ELLIPSIS).toBe("…");
  });

  it("counts what it leaves off across chunks rather than starting the count again", () => {
    const b = buffer();
    b.load([at(1, "y".repeat(LINE_CHAR_LIMIT + 10)), at(2, "y".repeat(5)), at(3, "\n")]);
    const [line] = lines(b.items);
    expect(line?.text).toHaveLength(LINE_CHAR_LIMIT);
    expect(line?.folded).toBe(15);
  });
});

describe("the buffer's cap and the boundary it leaves", () => {
  it("holds the last n events and names the sequence number the rest are before", () => {
    const b = buffer({ limit: 10 });
    b.load(Array.from({ length: 25 }, (_, i) => at(i, `line ${i}\n`)));

    expect(b.eventCount).toBe(10);
    expect(texts(b.items)).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i + 15}`));
    // The cursor `runs.events({ before })` takes: the oldest event still held.
    expect(b.trimmedBefore).toBe(15);
  });

  it("pages earlier output back in across the boundary with no gap and no duplicate", () => {
    const b = buffer({ limit: 10 });
    b.load(Array.from({ length: 25 }, (_, i) => at(i, `line ${i}\n`)));
    expect(b.trimmedBefore).toBe(15);

    // The page `runs.events({ before: 15, limit: 5 })` would answer with: events 10-14.
    const added = b.prepend(
      Array.from({ length: 5 }, (_, i) => at(10 + i, `line ${10 + i}\n`)),
      10,
    );

    expect(added).toBe(5);
    expect(b.trimmedBefore).toBe(10);
    const all = texts(b.items);
    expect(all).toEqual(Array.from({ length: 15 }, (_, i) => `line ${i + 10}`));
    expect(new Set(all).size).toBe(all.length);
  });

  /**
   * A page is built in a scratch buffer, which counts its own keys from zero — so the rows
   * it produces have to be re-keyed on the way in or they arrive wearing keys the held rows
   * are already using. React de-duplicates a repeated key by reusing the element, which in a
   * virtualised log means a line drawn against another line's `seq`: the trim boundary and
   * the `before` cursor are both read off the row under the reader.
   */
  it("gives the page rows keys of their own, not the ones the held rows are using", () => {
    const b = buffer({ limit: 10 });
    b.load(Array.from({ length: 25 }, (_, i) => at(i, `line ${i}\n`)));
    b.mark("paused", "2026-03-01T09:00:10.000Z");
    b.prepend(
      Array.from({ length: 5 }, (_, i) => at(10 + i, `line ${10 + i}\n`)),
      10,
    );

    const keys = b.items.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("takes the marker away when the page reached the start of the output", () => {
    const b = buffer({ limit: 5 });
    b.load(Array.from({ length: 8 }, (_, i) => at(i, `line ${i}\n`)));
    b.prepend(
      Array.from({ length: 3 }, (_, i) => at(i, `line ${i}\n`)),
      undefined,
    );
    expect(b.trimmedBefore).toBeUndefined();
    expect(texts(b.items)).toHaveLength(8);
  });
});

describe("the reconnect seam", () => {
  it("marks where the stream stopped and where it came back, and never twice over", () => {
    const b = buffer();
    b.load([at(1, "before\n")]);
    b.mark("paused", "2026-03-01T09:00:10.000Z");
    b.mark("paused", "2026-03-01T09:00:11.000Z");
    b.mark("reconnected", "2026-03-01T09:00:12.000Z");
    b.load([at(2, "after\n")]);

    expect(b.items.map((r) => r.kind)).toEqual(["line", "paused", "reconnected", "line"]);
  });
});

describe("the commit budget", () => {
  it("costs under a hundred commits for forty lines a second over ten seconds", () => {
    vi.useFakeTimers();
    const b = buffer();
    let commits = 0;
    b.subscribe(() => {
      commits++;
    });

    // Forty lines a second for ten seconds: 400 events, one every 25ms.
    for (let i = 0; i < 400; i++) {
      b.push([at(i, `line ${i}\n`)]);
      vi.advanceTimersByTime(25);
    }
    vi.advanceTimersByTime(200);

    expect(lines(b.items)).toHaveLength(400);
    /* The floor is one commit per 100ms, so ten seconds is a hundred and that is the
       whole of the budget: 400 events cost at most a quarter as many renders. The number
       is exact rather than approximate because the first commit waits the floor out like
       every other one — a free leading commit would make it 101. */
    expect(commits).toBeLessThanOrEqual(100);
    // And it is not debouncing: a stream that kept going still got committed throughout.
    expect(commits).toBeGreaterThan(40);
  });

  it("commits nothing until a frame runs, so a push is never a render", () => {
    vi.useFakeTimers();
    const b = buffer();
    let commits = 0;
    b.subscribe(() => {
      commits++;
    });

    b.push([at(1, "a\n"), at(2, "b\n")]);
    expect(commits).toBe(0);
    expect(b.items).toHaveLength(0);

    // One frame is not enough: the frame that runs before the 100ms floor has passed asks
    // for another rather than committing.
    vi.advanceTimersByTime(16);
    expect(commits).toBe(0);

    vi.advanceTimersByTime(100);
    expect(commits).toBe(1);
    expect(texts(b.items)).toEqual(["a", "b"]);
  });
});

describe("reading events off the wire", () => {
  it("takes only the agent updates out of a page of the log", () => {
    const page = [
      { id: "e1", seq: 1, runId: "r", at: "", type: "step.started", payload: { stepRunId: "s", inputArtifactIds: [] } },
      {
        id: "e2",
        seq: 2,
        runId: "r",
        at: "",
        type: "agent.update",
        payload: { stepRunId: "s", sessionId: "x", update: chunk("out\n") },
      },
    ] as unknown as Parameters<typeof updatesOf>[0];

    expect(updatesOf(page).map((u) => u.seq)).toEqual([2]);
  });

  it("numbers a coalesced batch from fromSeq, so every line in it stays addressable", () => {
    const params = {
      subscriptionId: "sub",
      runId: "r",
      seq: 12,
      at: "",
      stepRunId: "s",
      sessionId: "x",
      fromSeq: 10,
      updates: [chunk("a\n"), chunk("b\n"), chunk("c\n")],
    } satisfies Parameters<typeof updatesOfNotification>[0];

    expect(updatesOfNotification(params).map((u) => u.seq)).toEqual([10, 11, 12]);
  });
});
