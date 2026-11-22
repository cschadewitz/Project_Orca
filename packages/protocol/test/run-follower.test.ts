import { describe, expect, it } from "vitest";
import {
  FollowRefusedError,
  RunFollower,
  type DaemonNotification,
  type RunSnapshot,
  type RunSummaryView,
} from "../src/index.js";

/** Timers a test advances by hand. */
class ManualTimers {
  now = 0;
  private next = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.next;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await flush();
    }
    this.now = until;
    await flush();
  }
  get size(): number {
    return this.pending.size;
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const at = (seq: number) => new Date(Date.UTC(2026, 10, 22, 9, 0, seq)).toISOString();

function row(status: RunSummaryView["status"], extra: Partial<RunSummaryView> = {}): RunSummaryView {
  return {
    id: "run-a",
    name: "Run A",
    workflowId: "wf",
    workflowVersion: "1",
    status,
    createdAt: at(0),
    ...extra,
  };
}

const appended = (seq: number, runId = "run-a", type = "step.started"): DaemonNotification =>
  ({
    method: "event.appended",
    params: { subscriptionId: "s", runId, seq, at: at(seq), event: { id: `e${seq}`, runId, seq, at: at(seq), type } },
  }) as unknown as DaemonNotification;

const batch = (fromSeq: number, seq: number, count: number, stepRunId = "s1", runId = "run-a"): DaemonNotification => ({
  method: "agent.update",
  params: {
    subscriptionId: "s",
    runId,
    seq,
    at: at(seq),
    stepRunId,
    sessionId: "x",
    fromSeq,
    updates: Array.from({ length: count }, () => ({ kind: "text", text: "." })),
  },
});

const changed = (seq: number, status: RunSummaryView["status"], outcome?: "success"): DaemonNotification => ({
  method: "run.changed",
  params: {
    subscriptionId: "s",
    runId: "run-a",
    seq,
    at: at(seq),
    status,
    event: outcome ? "run.completed" : "run.started",
    ...(outcome ? { outcome } : {}),
  },
});

/** A fetch the test answers by hand, in any order. */
function fetcher() {
  const calls: { runId: string; resolve: (s: RunSnapshot) => void; reject: (e: Error) => void }[] = [];
  const fetch = (runId: string) =>
    new Promise<RunSnapshot>((resolve, reject) => {
      calls.push({ runId, resolve, reject });
    });
  return { calls, fetch };
}

function setup(opts: { maxResyncs?: number } = {}) {
  const timers = new ManualTimers();
  const f = fetcher();
  const follower = new RunFollower({
    fetch: f.fetch,
    timers,
    refreshDelayMs: 100,
    backoffMs: () => 1000,
    ...(opts.maxResyncs ? { maxResyncs: opts.maxResyncs } : {}),
  });
  return { timers, follower, calls: f.calls };
}

describe("RunFollower", () => {
  it("holds frames until the snapshot, drops those it covers, and settles the rest", async () => {
    const { follower, calls } = setup();
    follower.follow("run-a");
    expect(follower.get("run-a")?.phase).toBe("loading");
    for (const seq of [3, 4, 5]) follower.notify(appended(seq));
    calls[0]!.resolve({ run: row("running"), lastSeq: 4 });
    await flush();
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 5, snapshotSeq: 4 });
  });

  it("ignores duplicates and frames of runs it does not follow", async () => {
    const { follower, calls } = setup();
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 2 });
    await flush();
    follower.notify(appended(3));
    follower.notify(appended(3));
    follower.notify(appended(2));
    follower.notify(appended(9, "run-b"));
    follower.notify(appended(4));
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 4, resyncs: 0 });
    expect(calls).toHaveLength(1);
  });

  it("accounts interleaved agent batches of two steps without calling them a gap", async () => {
    const { follower, calls } = setup();
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 2 });
    await flush();
    // Step 1 wrote 3 and 5, step 2 wrote 4; both batches flushed before event 6.
    follower.notify(batch(4, 4, 1, "s2"));
    follower.notify(batch(3, 5, 2, "s1"));
    follower.notify(appended(6));
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 6 });
    // A contiguous batch advances on its own.
    follower.notify(batch(7, 9, 3));
    expect(follower.get("run-a")?.cursor).toBe(9);
    expect(calls).toHaveLength(1);
  });

  it("settles agent output alone when it covers exactly, and repairs an ambiguous gap after a delay", async () => {
    const { follower, calls, timers } = setup();
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 2 });
    await flush();
    // Two steps' batches, the one with holes first: together they cover 3..5 exactly.
    follower.notify(batch(3, 5, 2, "s1"));
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 2 });
    follower.notify(batch(4, 4, 1, "s2"));
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 5 });
    // Then output from 8 with 6 and 7 never seen, and no event after it to anchor on.
    follower.notify(batch(8, 9, 2));
    expect(follower.get("run-a")).toMatchObject({ phase: "resyncing", cursor: 5, resyncs: 1 });
    await timers.advance(99);
    expect(calls).toHaveLength(1);
    await timers.advance(1);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ run: row("running"), lastSeq: 9 });
    await flush();
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 9, resyncs: 0 });
  });

  it("keeps the streamed cursor apart from the snapshot's progress watermark", async () => {
    const { follower, calls } = setup();
    follower.follow("run-a");
    const operations = {
      lastSeq: 2,
      lastActivityAt: at(2),
      progress: { attempts: 1, completed: 0, failed: 0, active: 1, waiting: 0, skipped: 0 },
      facets: {
        host: { state: "unavailable" as const, reason: "not-collected" as const },
        usage: { state: "unavailable" as const, reason: "not-collected" as const },
      },
    };
    calls[0]!.resolve({ run: row("running", { operations }), lastSeq: 2 });
    await flush();
    follower.notify(appended(3));
    follower.notify(batch(4, 4, 1));
    expect(follower.get("run-a")).toMatchObject({ cursor: 4, lastActivityAt: at(4), snapshotSeq: 2 });
    expect(follower.get("run-a")?.run?.operations).toEqual(operations);
  });

  it("re-reads on a gap, once, and goes live from the snapshot that heals it", async () => {
    const { follower, calls, timers } = setup();
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 2 });
    await flush();
    follower.notify(appended(5)); // 3 and 4 never came
    expect(follower.get("run-a")).toMatchObject({ phase: "resyncing", resyncs: 1 });
    follower.notify(appended(6)); // still healing: not a second gap
    await timers.advance(0);
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ run: row("running"), lastSeq: 5 });
    await flush();
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 6, resyncs: 0 });
  });

  it("spends the budget on reads that answer but do not close a gap, then stays stale", async () => {
    const { follower, calls, timers } = setup({ maxResyncs: 3 });
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 2 });
    await flush();
    follower.notify(appended(5)); // 3 and 4 never come, and every snapshot stops at 2
    for (let read = 1; read <= 3; read++) {
      await timers.advance(1000);
      expect(calls).toHaveLength(read + 1);
      calls[read]!.resolve({ run: row("running"), lastSeq: 2 });
      await flush();
    }
    expect(follower.get("run-a")).toMatchObject({ phase: "stale", cursor: 2 });
    // Stale holds still: frames and lifecycle changes do not start another round of reads.
    for (const seq of [6, 7, 8]) {
      follower.notify(appended(seq));
      follower.notify(changed(seq, "running"));
    }
    await timers.advance(60_000);
    expect(calls).toHaveLength(4);
    expect(follower.get("run-a")?.phase).toBe("stale");
  });

  it("restarts the budget once the stream itself covers the gap", async () => {
    const { follower, calls, timers } = setup({ maxResyncs: 3 });
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 2 });
    await flush();
    follower.notify(appended(5));
    await timers.advance(0);
    calls[1]!.resolve({ run: row("running"), lastSeq: 2 });
    await flush();
    expect(follower.get("run-a")).toMatchObject({ phase: "resyncing", resyncs: 2 });
    // The late frames arrive: exact coverage reaches the watermark, so no read is needed.
    follower.notify(appended(3));
    follower.notify(appended(4));
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 5, resyncs: 0 });
    await timers.advance(60_000);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxResyncs failed reads, shows stale, and retries on request", async () => {
    const { follower, calls, timers } = setup({ maxResyncs: 2 });
    follower.follow("run-a");
    calls[0]!.reject(new Error("daemon busy"));
    await flush();
    await timers.advance(1000);
    calls[1]!.reject(new Error("daemon busy"));
    await flush();
    await timers.advance(1000);
    calls[2]!.reject(new Error("daemon busy"));
    await flush();
    expect(follower.get("run-a")).toMatchObject({ phase: "stale", error: "daemon busy" });
    await timers.advance(60_000);
    expect(calls).toHaveLength(3);
    follower.retry("run-a");
    calls[3]!.resolve({ run: row("running"), lastSeq: 0 });
    await flush();
    expect(follower.get("run-a")?.phase).toBe("live");
  });

  it("never lets an older snapshot overwrite a newer status", async () => {
    const { follower, calls, timers } = setup();
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 4 });
    await flush();
    // The run finished; the read it triggers is answered by a snapshot taken before that.
    follower.notify(changed(5, "succeeded", "success"));
    follower.notify(appended(5, "run-a", "run.completed"));
    expect(follower.get("run-a")?.run).toMatchObject({ status: "succeeded", outcome: "success" });
    await timers.advance(100);
    calls[1]!.resolve({ run: row("running"), lastSeq: 4 });
    await flush();
    expect(follower.get("run-a")).toMatchObject({ phase: "live", run: { status: "succeeded" } });
    // A snapshot older than the one shown is refused outright, and asked for again.
    await timers.advance(0);
    calls[2]!.resolve({ run: row("running"), lastSeq: 3 });
    await flush();
    expect(follower.get("run-a")?.run?.status).toBe("succeeded");
    await timers.advance(0);
    calls[3]!.resolve({ run: row("succeeded", { outcome: "success" }), lastSeq: 5 });
    await flush();
    expect(follower.get("run-a")).toMatchObject({ phase: "terminal", cursor: 5 });
    follower.notify(changed(6, "running"));
    await timers.advance(10_000);
    expect(calls).toHaveLength(4);
  });

  it("gathers lifecycle frames into one debounced read", async () => {
    const { follower, calls, timers } = setup();
    follower.follow("run-a");
    calls[0]!.resolve({ run: row("running"), lastSeq: 0 });
    await flush();
    for (const seq of [1, 2, 3]) {
      follower.notify({
        method: "step.changed",
        params: {
          subscriptionId: "s",
          runId: "run-a",
          seq,
          at: at(seq),
          stepRunId: "s1",
          status: "running",
          event: "x",
        },
      });
      follower.notify(appended(seq));
    }
    await timers.advance(100);
    expect(calls).toHaveLength(2);
  });

  it("shows reconnecting while the stream is down, ignores answers from before, and re-reads after", async () => {
    const { follower, calls } = setup();
    follower.follow("run-a");
    follower.follow("run-done");
    calls[1]!.resolve({ run: row("succeeded", { id: "run-done", outcome: "success" }), lastSeq: 9 });
    await flush();
    follower.connectionLost();
    expect(follower.list().map((r) => r.phase)).toEqual(["reconnecting", "terminal"]);
    calls[0]!.resolve({ run: row("running"), lastSeq: 1 });
    await flush();
    expect(follower.get("run-a")?.phase).toBe("reconnecting");
    follower.notify(appended(2));
    follower.connectionRestored();
    expect(follower.get("run-a")?.phase).toBe("loading");
    // A finished run is read again too: the connection back may be another caller's.
    expect(calls.map((c) => c.runId)).toEqual(["run-a", "run-done", "run-a", "run-done"]);
    calls[2]!.resolve({ run: row("running"), lastSeq: 7 });
    calls[3]!.resolve({ run: row("succeeded", { id: "run-done", outcome: "success" }), lastSeq: 9 });
    await flush();
    expect(follower.get("run-done")?.phase).toBe("terminal");
    expect(follower.get("run-a")).toMatchObject({ phase: "live", cursor: 7 });
  });

  it("forgets a run the daemon refuses on a reconnect, finished or not, and reads it no more", async () => {
    const { follower, calls, timers } = setup();
    follower.follow("run-a");
    follower.follow("run-done");
    calls[0]!.resolve({ run: row("running"), lastSeq: 3 });
    calls[1]!.resolve({ run: row("succeeded", { id: "run-done", outcome: "success" }), lastSeq: 9 });
    await flush();
    follower.connectionLost();
    follower.connectionRestored();
    calls[2]!.reject(new FollowRefusedError("AUTH_FORBIDDEN: not permitted"));
    calls[3]!.reject(new FollowRefusedError("RUN_NOT_FOUND: run run-done not found"));
    await flush();
    for (const runId of ["run-a", "run-done"]) {
      const view = follower.get(runId)!;
      expect(view).toMatchObject({ phase: "gone", cursor: -1 });
      expect(view.run).toBeUndefined();
      expect(view.snapshotSeq).toBeUndefined();
    }
    follower.notify(appended(4));
    follower.notify(changed(5, "running"));
    await timers.advance(60_000);
    expect(calls).toHaveLength(4);
    expect(follower.get("run-a")?.run).toBeUndefined();
  });
});
