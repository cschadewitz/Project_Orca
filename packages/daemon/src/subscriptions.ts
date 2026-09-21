/**
 * One client's push stream: `Orchestrator.subscribe()` on one side, notification envelopes
 * on the other. The transport (socket.ts) owns the connection and this owns what travels on
 * it, so the fan-out can be tested by handing it a `send` that pushes onto an array.
 *
 * Three things here are not obvious from the outside.
 *
 * **Resume has no gap.** `subscribe({ runId, since })` replays the log from `since + 1`
 * before the live stream takes over. Reading the log and then attaching a listener would
 * drop anything appended in between, so it is done the other way round: the listener is
 * attached first and its events buffered, the log is read, and the buffer is then flushed
 * with everything at or below the last replayed sequence number dropped. A blip therefore
 * costs latency and never data, which is the whole contract behind the cursor.
 *
 * **Agent output is coalesced.** An agent turn appends `agent.update` events as fast as the
 * agent speaks. Sending one frame each would make the socket, not the model, the slow part
 * of watching a run, so updates are held per step for `AGENT_BATCH_MS` and sent as one
 * notification carrying many; `fromSeq` and `seq` bracket what it covers.
 *
 * **Coalescing never reorders.** A held batch is flushed before any other notification for
 * the same run is sent, so a client appending as frames arrive sees the run's log in
 * sequence order - agent output never lands after the `step.completed` that ended it.
 */
import type { OrcaEvent } from "@orca/core";
import {
  AGENT_CHANGED,
  AGENT_UPDATE,
  CONFIG_CHANGED,
  PLAN_CHANGED,
  type AgentView,
  type ConfigDocument,
  type DaemonNotification,
  type NotificationMessage,
  type SubscribeParams,
} from "@orca/protocol";
import { notificationsFor, planChangeKindsFor, wants } from "./notifications.js";

/** At most one `agent.update` notification per step per this many milliseconds. */
export const AGENT_BATCH_MS = 100;

/**
 * What a subscription needs of the engine: the live feed, and the log to replay from. Stated
 * structurally rather than as `Orchestrator` so a test can drive it with an event store and
 * the daemon keeps one narrow seam onto the engine.
 */
export interface SubscriptionSource {
  subscribe(listener: (event: OrcaEvent) => void, filter?: { runId?: string | undefined }): () => void;
  /**
   * One page of a run's log. A resume asks for everything after its cursor, which on a long
   * log is a short read near the end rather than the whole file (#208) - the reconnect after
   * a blip is the common case and it is the one that must not re-read a run.
   */
  eventsRange(runId: string, range?: { after?: number | undefined }): Promise<OrcaEvent[]>;
}

/**
 * What a subscription needs to push `agent.changed`: a hook that fires when an agent's
 * handshake health moves. Stated structurally for the same reason as `SubscriptionSource`;
 * `AgentModel` is what satisfies it in the daemon.
 */
export interface AgentChangeSource {
  onChange(listener: (change: { agent: AgentView; at: string }) => void): () => void;
}

/**
 * What a subscription needs to push `config.changed`: a hook that fires when one of the two
 * configuration documents is written - by `config.set`, or by ORCA itself appending a
 * standing grant to the sidecar (ADR 0009). `ConfigModel` is what satisfies it; stated
 * structurally for the same reason as the two above.
 */
export interface ConfigChangeSource {
  onChange(
    listener: (change: { document: ConfigDocument; revision: string; path: string; at: string }) => void,
  ): () => void;
}

/** The four fields `plan.changed` is folded from. Every plan journal entry has them. */
export interface PlanJournalEntry {
  planId: string;
  seq: number;
  at: string;
  type: string;
}

/**
 * What a subscription needs to push `plan.changed`: the plan journal's own listener seam.
 * `PlanJournal` (`packages/store/src/plan-store.ts`) satisfies it structurally, so the daemon
 * keeps one narrow seam onto the store here in the same way `SubscriptionSource` is one onto
 * the engine - and a test can drive it with an array.
 *
 * It hears *this process's* writes, which is the same boundary the run feed has: a plan a CLI
 * beside the daemon changed lands on the next read, not as a push - a property of an
 * in-memory listener list rather than of the store, which re-reads under a lock (#196).
 */
export interface PlanChangeSource {
  subscribe(listener: (entry: PlanJournalEntry) => void): () => void;
}

/** Where a subscription's frames go. The socket writes them; a test collects them. */
export type SendNotification = (message: NotificationMessage) => void;

export interface SubscriptionOptions {
  id: string;
  params: SubscribeParams;
  source: SubscriptionSource;
  send: SendNotification;
  /**
   * Agent health changes, when this daemon has a registry. A subscription scoped to one run
   * ignores it: agents are a property of the process, not of a run, so a run screen would
   * only be woken by work it is not showing.
   */
  agents?: AgentChangeSource | undefined;
  /**
   * Configuration writes, when this daemon serves a workspace. A subscription scoped to one
   * run ignores it for the same reason it ignores `agent.changed`: the config is a property
   * of the workspace, not of a run.
   */
  config?: ConfigChangeSource | undefined;
  /**
   * Plan journal changes, when this daemon serves a plan. A subscription scoped to one run
   * ignores it for the same reason it ignores `agent.changed`: a plan outlives every run in
   * it, so a run screen would only be woken by work it is not showing.
   */
  plans?: PlanChangeSource | undefined;
  /** Overridable so a test can hold the batch window open or close it by hand. */
  batchMs?: number | undefined;
}

type AgentUpdateEvent = Extract<OrcaEvent, { type: "agent.update" }>;

/**
 * The agent output held for one step, waiting for its window to close. Keyed by step run id,
 * which is unique across runs; `runId` is kept so a run can be flushed without parsing keys.
 */
interface Batch {
  runId: string;
  sessionId: string;
  fromSeq: number;
  seq: number;
  updates: AgentUpdateEvent[];
  timer: ReturnType<typeof setTimeout>;
}

export class Subscription {
  readonly id: string;
  private readonly params: SubscribeParams;
  private readonly send: SendNotification;
  private readonly batchMs: number;
  private readonly batches = new Map<string, Batch>();
  private detach: (() => void) | undefined;
  private detachAgents: (() => void) | undefined;
  private detachConfig: (() => void) | undefined;
  private detachPlans: (() => void) | undefined;
  /** Events that arrived while the replay was still reading the log. */
  private buffered: OrcaEvent[] | undefined;
  private stopped = false;

  constructor(private readonly opts: SubscriptionOptions) {
    this.id = opts.id;
    this.params = opts.params;
    this.send = opts.send;
    this.batchMs = opts.batchMs ?? AGENT_BATCH_MS;
  }

  /** Attach, replay from the cursor if there is one, and return how many frames the replay sent. */
  async start(): Promise<number> {
    const { runId, since } = this.params;
    // Buffer from the first live event: attaching after the read would lose the gap.
    this.buffered = [];
    this.detach = this.opts.source.subscribe(
      (event) => {
        if (this.buffered) this.buffered.push(event);
        else this.deliver(event);
      },
      runId === undefined ? undefined : { runId },
    );
    // Agent health is the process's, not a run's, so only a store-wide subscription hears
    // it. There is nothing to replay: health is in memory, it has no sequence number, and
    // the current answer is one `agents.list` away.
    if (runId === undefined && this.opts.agents)
      this.detachAgents = this.opts.agents.onChange((change) => {
        if (this.stopped) return;
        // One of the seven since protocol 1.5 (#241), so it goes out through `emit` like the
        // rest and honours `methods` - a client that asked only for `run.changed` is not
        // woken by an agent. What it still does not carry is a `runId` or a `seq`.
        this.emit({
          method: AGENT_CHANGED,
          params: { subscriptionId: this.id, at: change.at, agent: change.agent },
        });
      });
    // `config.changed` follows `agent.changed` exactly: store-wide subscriptions only, no
    // cursor, nothing to replay. A client that finds `revision` equal to the one it already
    // holds - its own write, echoed back - re-reads nothing.
    if (runId === undefined && this.opts.config)
      this.detachConfig = this.opts.config.onChange((change) => {
        if (this.stopped) return;
        this.emit({
          method: CONFIG_CHANGED,
          params: {
            subscriptionId: this.id,
            document: change.document,
            revision: change.revision,
            path: change.path,
            at: change.at,
          },
        });
      });

    // A plan is not a run either, so the same rule: store-wide subscriptions only. There is
    // nothing to replay - `since` is a run's sequence number - and the current answer is one
    // `schedule.get` away.
    if (runId === undefined && this.opts.plans)
      this.detachPlans = this.opts.plans.subscribe((entry) => {
        if (this.stopped) return;
        this.emit({
          method: PLAN_CHANGED,
          params: {
            subscriptionId: this.id,
            planId: entry.planId,
            kinds: planChangeKindsFor(entry.type),
            seq: entry.seq,
            at: entry.at,
          },
        });
      });

    let replayed = 0;
    let through = -1;
    if (runId !== undefined && since !== undefined) {
      for (const event of await this.opts.source.eventsRange(runId, { after: since })) {
        replayed += this.deliver(event);
        through = event.seq;
      }
      // The replay is a catch-up, not live output: nothing waits in a batch window.
      this.flushAll();
    }

    const buffered = this.buffered ?? [];
    this.buffered = undefined;
    // Anything the replay already sent, the live listener also saw. Sequence numbers are
    // per-run and gap-free, so "at or below the last replayed seq" is exactly the overlap.
    for (const event of buffered) if (event.seq > through) this.deliver(event);
    return replayed;
  }

  /** Flush whatever is held and detach from the engine. Safe to call twice. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.flushAll();
    this.detach?.();
    this.detach = undefined;
    this.detachAgents?.();
    this.detachAgents = undefined;
    this.detachConfig?.();
    this.detachConfig = undefined;
    this.detachPlans?.();
    this.detachPlans = undefined;
  }

  /** Route one event, returning how many frames it produced. */
  private deliver(event: OrcaEvent): number {
    if (this.stopped) return 0;
    if (event.type === "agent.update") return this.batch(event);
    // Order over latency: anything held for this run goes first, so frames stay in seq order.
    let sent = this.flushRun(event.runId);
    for (const notification of notificationsFor(event, this.id)) sent += this.emit(notification);
    return sent;
  }

  private emit(notification: DaemonNotification): number {
    if (!wants(this.params.methods, notification.method)) return 0;
    this.send({ kind: "notification", method: notification.method, params: notification.params });
    return 1;
  }

  /** Hold one `agent.update` event, opening a window if this step has none. */
  private batch(event: AgentUpdateEvent): number {
    if (!wants(this.params.methods, AGENT_UPDATE)) return 0;
    const key = event.payload.stepRunId;
    const open = this.batches.get(key);
    if (open) {
      open.seq = event.seq;
      open.updates.push(event);
      return 0;
    }
    // A pending window must not be what keeps the process alive at shutdown.
    const timer = setTimeout(() => void this.flush(key), this.batchMs);
    timer.unref?.();
    this.batches.set(key, {
      runId: event.runId,
      sessionId: event.payload.sessionId,
      fromSeq: event.seq,
      seq: event.seq,
      updates: [event],
      timer,
    });
    return 0;
  }

  private flush(key: string): number {
    const batch = this.batches.get(key);
    if (!batch) return 0;
    this.batches.delete(key);
    clearTimeout(batch.timer);
    return this.emit({
      method: AGENT_UPDATE,
      params: {
        subscriptionId: this.id,
        runId: batch.runId,
        seq: batch.seq,
        at: batch.updates[batch.updates.length - 1]!.at,
        stepRunId: key,
        sessionId: batch.sessionId,
        fromSeq: batch.fromSeq,
        updates: batch.updates.map((e) => e.payload.update),
      },
    });
  }

  private flushRun(runId: string): number {
    let sent = 0;
    for (const [key, batch] of [...this.batches]) if (batch.runId === runId) sent += this.flush(key);
    return sent;
  }

  private flushAll(): number {
    let sent = 0;
    for (const key of [...this.batches.keys()]) sent += this.flush(key);
    return sent;
  }
}
