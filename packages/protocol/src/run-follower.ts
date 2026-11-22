/**
 * Following several runs live from one notification stream (#340): the client half of the
 * operations view, kept here, node-free, so the renderer bundles it and a daemon test can
 * drive two of them against a real store.
 *
 * A followed run is an authoritative snapshot (`runs.get`, which says the `lastSeq` it is
 * current as of) plus the stream since. Four rules keep two clients that hear the same
 * runs showing the same thing, whatever order, delay or duplication their frames arrive in:
 *
 * - **A cursor, never a guess.** Every run frame carries the run's `seq`. A frame at or below
 *   the cursor is a duplicate and changes nothing.
 * - **A snapshot never goes backwards.** One older than a `run.changed` already applied is
 *   dropped and asked for again; it cannot overwrite the newer status.
 * - **A gap is noticed, then healed by a snapshot.** The daemon flushes a run's held agent
 *   output before it sends any other event of that run, so when `event.appended` with
 *   `seq = n` arrives every frame below `n` has been sent. The frames held above the cursor
 *   must then account for exactly the sequence numbers between it and `n` (an `agent.update`
 *   batch accounts for one per update). Fewer means a frame was lost or is late, and the
 *   run re-reads its snapshot - one read in flight per run, with backoff, and at most
 *   `maxResyncs` in a row before the run is shown as `stale` rather than retried forever.
 * - **State changes are read, not folded.** A `run.changed` repaints status at once; any
 *   lifecycle frame then asks, debounced, for a fresh snapshot, which is what progress,
 *   waits and ownership come from. Agent output only moves the cursor and the activity time.
 *
 * Coverage needs both `event.appended` and `agent.update`, so the stream feeding this must
 * subscribe to both (the app's store-wide subscription takes every method).
 */
import type { RunSummaryView } from "./runs.js";
import type { DaemonNotification } from "./subscriptions.js";

/**
 * Where a followed run's data stands. `live`: current as of the stream. `terminal`: finished,
 * and the snapshot includes the end. `loading` and `resyncing`: a snapshot is on its way.
 * `reconnecting`: the stream dropped, so nothing is current. `stale`: resyncing gave up; the
 * data shown is the last good snapshot and may be behind.
 */
export type FollowPhase = "loading" | "live" | "resyncing" | "reconnecting" | "stale" | "terminal";

/** What `runs.get` answers that a follower needs: the row and the sequence it is current as of. */
export interface RunSnapshot {
  run: RunSummaryView;
  lastSeq: number;
}

export interface FollowedRun {
  runId: string;
  phase: FollowPhase;
  /** The highest sequence number accounted for, `-1` before the first snapshot. */
  cursor: number;
  /** The last accepted snapshot, with any newer `run.changed` status laid over it. */
  run?: RunSummaryView;
  /** `lastSeq` of the last accepted snapshot. */
  snapshotSeq?: number;
  /** The newest event time heard, from the snapshot or the stream. */
  lastActivityAt?: string;
  /** Snapshot reads in a row that failed or were made necessary by a gap. */
  resyncs: number;
  /** Why the run is `stale`. */
  error?: string;
}

export interface FollowerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface RunFollowerOptions {
  fetch(runId: string): Promise<RunSnapshot>;
  onChange?(view: FollowedRun): void;
  /** Injected so a test decides when time passes. Defaults to `setTimeout`. */
  timers?: FollowerTimers;
  /** How long lifecycle frames are gathered before one snapshot read. */
  refreshDelayMs?: number;
  /** Snapshot reads in a row before a run is left `stale`. */
  maxResyncs?: number;
  /** Delay before the `attempt`th retry (1-based). */
  backoffMs?: (attempt: number) => number;
}

export const FOLLOW_REFRESH_DELAY_MS = 200;
export const FOLLOW_MAX_RESYNCS = 5;
const defaultBackoff = (attempt: number) => Math.min(10_000, 250 * 2 ** (attempt - 1));

const defaultTimers: FollowerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One frame held above the cursor until the frames below it are accounted for. */
interface Held {
  /** `event.appended` (one sequence number) or an `agent.update` batch. */
  kind: "event" | "batch";
  fromSeq: number;
  seq: number;
  /** Sequence numbers it accounts for. */
  count: number;
}

const LIFECYCLE = new Set<DaemonNotification["method"]>([
  "run.changed",
  "step.changed",
  "input.opened",
  "input.answered",
]);

interface Entry {
  view: FollowedRun;
  held: Map<string, Held>;
  /** The newest `run.changed` above the snapshot: laid over every later snapshot older than it. */
  change?: { seq: number; patch: Partial<RunSummaryView> };
  inFlight: boolean;
  /** Another read was asked for while one was in flight. */
  again: boolean;
  timer?: unknown;
  /** Bumped by `connectionLost` and `unfollow`, so an answer to an older read is ignored. */
  generation: number;
  /**
   * The sequence number the run's view still owes: the held event a gap left unaccounted
   * for, or a `run.changed` newer than the snapshot. Until a snapshot or exact frame coverage
   * reaches it, every read counts against `maxResyncs` and backs off - a read that answers
   * but does not close the gap is not progress.
   */
  unmet?: number | undefined;
}

/** Frames held above the cursor at most; past it they are dropped and the snapshot heals. */
export const FOLLOW_MAX_HELD = 1024;

export class RunFollower {
  private readonly entries = new Map<string, Entry>();
  private readonly timers: FollowerTimers;
  private readonly refreshDelayMs: number;
  private readonly maxResyncs: number;
  private readonly backoffMs: (attempt: number) => number;
  private connected = true;

  constructor(private readonly opts: RunFollowerOptions) {
    this.timers = opts.timers ?? defaultTimers;
    this.refreshDelayMs = opts.refreshDelayMs ?? FOLLOW_REFRESH_DELAY_MS;
    this.maxResyncs = opts.maxResyncs ?? FOLLOW_MAX_RESYNCS;
    this.backoffMs = opts.backoffMs ?? defaultBackoff;
  }

  /** Start following a run: read its snapshot, and hold its frames until the snapshot lands. */
  follow(runId: string): void {
    if (this.entries.has(runId)) return;
    const entry: Entry = {
      view: { runId, phase: this.connected ? "loading" : "reconnecting", cursor: -1, resyncs: 0 },
      held: new Map(),
      inFlight: false,
      again: false,
      generation: 0,
    };
    this.entries.set(runId, entry);
    this.changed(entry);
    if (this.connected) void this.read(entry);
  }

  unfollow(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry) return;
    this.cancel(entry);
    entry.generation++;
    this.entries.delete(runId);
  }

  get(runId: string): FollowedRun | undefined {
    const entry = this.entries.get(runId);
    return entry ? { ...entry.view } : undefined;
  }

  /** In the order they were followed. */
  list(): FollowedRun[] {
    return [...this.entries.values()].map((e) => ({ ...e.view }));
  }

  /** Every frame of the stream, for every run; frames of runs not followed are ignored. */
  notify(n: DaemonNotification): void {
    const params = n.params as { runId?: unknown; seq?: unknown; at?: unknown };
    if (typeof params.runId !== "string" || typeof params.seq !== "number") return;
    const entry = this.entries.get(params.runId);
    if (!entry || !this.connected) return;
    const seq = params.seq;
    const at = typeof params.at === "string" ? params.at : undefined;

    if (n.method === "run.changed" && seq > (entry.change?.seq ?? -1) && seq > (entry.view.snapshotSeq ?? -1)) {
      const p = n.params;
      entry.change = {
        seq,
        patch: {
          status: p.status,
          ...(p.outcome ? { outcome: p.outcome } : {}),
          ...(p.error ? { error: p.error } : {}),
        },
      };
      if (entry.view.run) entry.view.run = { ...entry.view.run, ...entry.change.patch };
    }

    if (n.method === "event.appended" || n.method === "agent.update") {
      if (seq <= entry.view.cursor) return; // a duplicate: already accounted for
      const [key, held]: [string, Held] =
        n.method === "event.appended"
          ? [`e:${seq}`, { kind: "event", fromSeq: seq, seq, count: 1 }]
          : [
              `b:${n.params.stepRunId}:${n.params.fromSeq}:${seq}`,
              { kind: "batch", fromSeq: n.params.fromSeq, seq, count: n.params.updates.length },
            ];
      if (entry.held.has(key) || entry.view.phase === "stale") return;
      if (entry.held.size >= FOLLOW_MAX_HELD) {
        // Bounded: drop what is held and let a snapshot cover it rather than grow without end.
        entry.held.clear();
        this.gap(entry, seq);
        // `gap` may have given up.
        if ((entry.view.phase as FollowPhase) === "stale") return;
      }
      entry.held.set(key, held);
      if (at && (!entry.view.lastActivityAt || at > entry.view.lastActivityAt)) entry.view.lastActivityAt = at;
      if (entry.view.snapshotSeq !== undefined) this.settle(entry);
    }

    if (LIFECYCLE.has(n.method) && entry.view.phase !== "terminal" && entry.view.phase !== "stale") this.refresh(entry);
    this.changed(entry);
  }

  /** The stream dropped: nothing shown is current until it is back and every run re-read. */
  connectionLost(): void {
    this.connected = false;
    for (const entry of this.entries.values()) {
      this.cancel(entry);
      entry.generation++;
      entry.inFlight = false;
      entry.again = false;
      entry.held.clear();
      entry.unmet = undefined;
      if (entry.view.phase !== "terminal") entry.view.phase = "reconnecting";
      this.changed(entry);
    }
  }

  /** The stream is back (a new subscription): re-read every run that is not finished. */
  connectionRestored(): void {
    this.connected = true;
    for (const entry of this.entries.values()) {
      if (entry.view.phase === "terminal") continue;
      entry.view.resyncs = 0;
      delete entry.view.error;
      entry.view.phase = entry.view.snapshotSeq === undefined ? "loading" : "resyncing";
      this.changed(entry);
      void this.read(entry);
    }
  }

  /** Try a `stale` run again on request. */
  retry(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry || entry.view.phase !== "stale" || !this.connected) return;
    entry.view.resyncs = 0;
    entry.unmet = undefined;
    delete entry.view.error;
    entry.view.phase = entry.view.snapshotSeq === undefined ? "loading" : "resyncing";
    this.changed(entry);
    void this.read(entry);
  }

  dispose(): void {
    for (const runId of [...this.entries.keys()]) this.unfollow(runId);
  }

  // ------------------------------------------------------------------ internals

  /**
   * Advance the cursor over held frames while they account for every sequence number below
   * the next held event; a shortfall is a gap.
   */
  private settle(entry: Entry): void {
    for (;;) {
      const cursor = entry.view.cursor;
      // A batch that starts exactly at the cursor and has no holes covers itself.
      const contiguous = [...entry.held].find(
        ([, h]) => h.kind === "batch" && h.fromSeq === cursor + 1 && h.seq - h.fromSeq + 1 === h.count,
      );
      if (contiguous) {
        entry.held.delete(contiguous[0]);
        this.advance(entry, contiguous[1].seq);
        continue;
      }
      const events = [...entry.held.values()].filter((h) => h.kind === "event").sort((a, b) => a.seq - b.seq);
      const next = events[0];
      if (!next) return;
      let below = 0;
      for (const h of entry.held.values()) if (h.seq < next.seq) below += h.count;
      const expected = next.seq - cursor - 1;
      if (below !== expected) {
        this.gap(entry, next.seq);
        return;
      }
      for (const [key, h] of [...entry.held]) if (h.seq <= next.seq) entry.held.delete(key);
      this.advance(entry, next.seq);
    }
  }

  private advance(entry: Entry, seq: number): void {
    entry.view.cursor = seq;
    this.met(entry);
    for (const [key, h] of [...entry.held]) if (h.seq <= seq) entry.held.delete(key);
    const ops = entry.view.run?.operations;
    if (entry.view.run && ops && seq > ops.lastSeq)
      entry.view.run = {
        ...entry.view.run,
        operations: { ...ops, lastSeq: seq, lastActivityAt: entry.view.lastActivityAt ?? ops.lastActivityAt },
      };
  }

  /** The view has caught up with what it owed: the retry budget starts again. */
  private met(entry: Entry): void {
    if (entry.unmet === undefined || entry.view.cursor < entry.unmet) return;
    entry.unmet = undefined;
    entry.view.resyncs = 0;
    delete entry.view.error;
    // Healed by the stream itself: the re-read it was waiting on is no longer needed.
    if (entry.view.phase === "resyncing" && entry.view.snapshotSeq !== undefined) {
      this.cancel(entry);
      entry.view.phase = "live";
    }
  }

  private gap(entry: Entry, at: number): void {
    entry.unmet = Math.max(entry.unmet ?? -1, at);
    // Already healing (or finished): the snapshot on its way settles what is held.
    if (entry.view.phase !== "live") return;
    entry.view.phase = "resyncing";
    entry.view.resyncs++;
    if (entry.view.resyncs > this.maxResyncs) {
      this.giveUp(entry, "Too many gaps in the run's stream");
      return;
    }
    this.schedule(entry, entry.view.resyncs > 1 ? this.backoffMs(entry.view.resyncs - 1) : 0);
  }

  private refresh(entry: Entry): void {
    if (entry.inFlight) {
      entry.again = true;
      return;
    }
    if (entry.timer === undefined) this.schedule(entry, this.refreshDelayMs);
  }

  private schedule(entry: Entry, ms: number): void {
    if (entry.timer !== undefined) this.timers.clear(entry.timer);
    const generation = entry.generation;
    entry.timer = this.timers.set(() => {
      entry.timer = undefined;
      if (generation === entry.generation) void this.read(entry);
    }, ms);
  }

  private cancel(entry: Entry): void {
    if (entry.timer !== undefined) this.timers.clear(entry.timer);
    entry.timer = undefined;
  }

  private giveUp(entry: Entry, error: string): void {
    this.cancel(entry);
    entry.view.phase = "stale";
    entry.view.error = error;
    entry.again = false;
    this.changed(entry);
  }

  private async read(entry: Entry): Promise<void> {
    if (entry.inFlight) {
      entry.again = true;
      return;
    }
    this.cancel(entry);
    entry.inFlight = true;
    entry.again = false;
    const generation = entry.generation;
    let snapshot: RunSnapshot;
    try {
      snapshot = await this.opts.fetch(entry.view.runId);
    } catch (e) {
      if (generation !== entry.generation) return;
      entry.inFlight = false;
      entry.view.resyncs++;
      if (entry.view.resyncs > this.maxResyncs) this.giveUp(entry, e instanceof Error ? e.message : String(e));
      else this.schedule(entry, this.backoffMs(entry.view.resyncs));
      this.changed(entry);
      return;
    }
    if (generation !== entry.generation) return;
    entry.inFlight = false;
    this.accept(entry, snapshot);
    if (entry.again && entry.view.phase !== "terminal" && entry.view.phase !== "stale") {
      entry.again = false;
      // A read already due (a gap's backoff) answers this too; never cut its delay short.
      if (entry.timer === undefined) this.schedule(entry, 0);
    }
    this.changed(entry);
  }

  private accept(entry: Entry, snapshot: RunSnapshot): void {
    const { view } = entry;
    // Older than the snapshot already shown: it cannot overwrite it. Ask again.
    if (view.snapshotSeq !== undefined && snapshot.lastSeq < view.snapshotSeq) {
      view.resyncs++;
      if (view.resyncs > this.maxResyncs) this.giveUp(entry, "Snapshots keep arriving older than the one shown");
      else entry.again = true;
      return;
    }
    view.snapshotSeq = snapshot.lastSeq;
    view.run = snapshot.run;
    // Older than a status the stream already said: that status stays on top, and a newer
    // snapshot is asked for so the rest of the row catches up with it.
    let behind = false;
    if (entry.change && entry.change.seq > snapshot.lastSeq) {
      view.run = { ...view.run, ...entry.change.patch };
      entry.unmet = Math.max(entry.unmet ?? -1, entry.change.seq);
      behind = true;
    } else delete entry.change;
    const at = snapshot.run.operations?.lastActivityAt;
    if (at && (!view.lastActivityAt || at > view.lastActivityAt)) view.lastActivityAt = at;
    if (snapshot.lastSeq > view.cursor) view.cursor = snapshot.lastSeq;
    for (const [key, h] of [...entry.held]) if (h.seq <= view.cursor) entry.held.delete(key);
    // A batch straddling the snapshot: when it has no holes, the part above is exact.
    for (const [key, h] of [...entry.held])
      if (h.kind === "batch" && h.fromSeq <= view.cursor && h.seq - h.fromSeq + 1 === h.count)
        entry.held.set(key, { ...h, fromSeq: view.cursor + 1, count: h.seq - view.cursor });
    // A read that owed nothing, or that reached what was owed, restarts the budget; one that
    // answered short of it spends it, so a gap no snapshot closes ends `stale`, not in a loop.
    if (entry.unmet === undefined) {
      view.resyncs = 0;
      delete view.error;
    } else this.met(entry);
    view.phase = view.run.outcome && !entry.change ? "terminal" : "live";
    this.settle(entry);
    // Behind a status the stream already said, and no gap read already on its way: ask again,
    // against the same budget.
    if (behind && view.phase === "live") {
      view.resyncs++;
      if (view.resyncs > this.maxResyncs) {
        this.giveUp(entry, "Snapshots keep arriving older than the stream");
        return;
      }
      this.schedule(entry, view.resyncs > 1 ? this.backoffMs(view.resyncs - 1) : 0);
    }
    if (view.phase === "terminal") this.cancel(entry);
  }

  private changed(entry: Entry): void {
    this.opts.onChange?.({ ...entry.view });
  }
}
