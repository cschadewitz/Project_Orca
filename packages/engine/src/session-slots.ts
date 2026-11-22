/**
 * Agent session slots (#873): optional ceilings on how many agent sessions one daemon holds
 * open at once, for the whole daemon, for one agent and for one host.
 *
 * Every cap is optional and the default is unlimited. A cap applies only when the operator
 * wrote it in `orca.config.yaml` (`limits.maxAgentSessions`, `agents[].maxSessions`,
 * `hosts[].maxSessions`); nothing is derived from the machine.
 *
 * The queue sits at session open, not at admission: runs are still accepted at once, and a
 * step that cannot have a slot waits *before* it spawns anything. A waiting step therefore
 * holds no process and no session, so a restart loses nothing - the resumed step asks again.
 *
 * Every session is counted whether or not any cap is set, so the read model can say how many
 * are open. The cap bounds live agent processes: the caller releases a slot only once the
 * process is confirmed gone, and a slot whose teardown could not be confirmed stays held and
 * is reported (`teardownUnconfirmed`) rather than handed to the next step.
 *
 * Ordering. Waiters that belong to a plan are ordered among themselves by plan priority
 * (`computeSchedule()` score, best first); waiters outside a plan by age. Between the two,
 * age decides: the older of the oldest plan waiter and the oldest other waiter goes next,
 * and if that is the plan side it is the plan's *best* waiter that goes. So a plan cannot
 * starve a run somebody started by hand, and inside a plan priority still holds.
 *
 * A waiter is granted when every cap it is subject to has room, and no earlier waiter is
 * blocked on one of those same caps - a later step never overtakes an earlier one for the
 * same slot. Waiters on unrelated caps do not block each other (a full host does not hold
 * up a step bound for another host).
 *
 * Waits that may never end. A `per-run` session holds its slot until its run ends.
 *
 * - **Proven impossible** fails at once with `CONFIG_INVALID`: a full cap whose every slot is
 *   held by a per-run session of the waiting step's *own* run that is not already closing.
 *   A run is one token; while its step waits the run cannot move, so it cannot end and
 *   cannot release them. (Cancelling it still works: that removes the waiter.) Two per-run
 *   agents in one run under a cap of one is the common case.
 * - **Possibly stuck** is everything a wait-for check over the whole queue cannot clear: the
 *   slots in the way are pinned by runs above the step, or by runs whose own children wait.
 *   Those runs *usually* cannot end, but not provably - a `parallel` with `join: any` can
 *   finish through another branch and cancel the waiting one. So these are never failed as
 *   impossible: the wait reason says the step may never be granted, and the operator's
 *   optional `limits.agentSlotWaitMs` deadline, when set, ends the wait with `STEP_TIMEOUT`.
 *   A slot already closing is never counted as stuck: it comes back on its own.
 *
 * A queue that is merely long is never cut off, unless the operator set that deadline.
 */
import { OrcaError } from "@orca/core";

/** The caps one session open is subject to. An absent cap is unlimited. */
export interface SessionSlotCaps {
  daemon?: number | undefined;
  agent?: number | undefined;
  host?: number | undefined;
}

/** What the daemon is configured with, for the read model. Only what is set appears. */
export interface ConfiguredSessionLimits {
  maxAgentSessions?: number | undefined;
  /** How long a step may wait for a slot before it fails; absent is no deadline. */
  agentSlotWaitMs?: number | undefined;
  agents: Record<string, number>;
  hosts: Record<string, number>;
}

export interface SessionSlotsView {
  limits: ConfiguredSessionLimits;
  inUse: { total: number; agents: Record<string, number>; hosts: Record<string, number> };
  /** Steps waiting for a slot right now. */
  queued: number;
  /**
   * Slots still held because their process's exit could not be confirmed. Each one is a
   * process that may still be running; it is reported, never silently handed on.
   */
  teardownUnconfirmed: number;
}

export interface SessionSlotRequest {
  agentId: string;
  hostId: string;
  /**
   * The caps this open is subject to, asked again on every pass over the queue so a cap the
   * operator raised or lowered while the step waits takes effect for it too.
   */
  caps: () => SessionSlotCaps;
  /** The run this step belongs to, then its parent, grandparent and so on. */
  runs?: readonly string[] | undefined;
  /** This open becomes a `per-run` session of that run, holding its slot until the run ends. */
  pinnedTo?: string | undefined;
  /** Plan priority score (higher goes first); absent for a step outside any plan. */
  priority?: number | undefined;
  /** Give up after this long with `STEP_TIMEOUT`; absent waits as long as it takes. */
  deadlineMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Told why the step is waiting, once when it starts waiting and again whenever the reason
   * changes. Calls are serialized, and `acquire` resolves only after the last one settled,
   * so whatever the caller emits here lands before whatever it emits once it has the slot.
   */
  onWait?: ((reason: string) => Promise<void> | void) | undefined;
}

export interface SessionSlot {
  /** Return the slot. Safe to call any number of times; only the first counts. */
  release(): void;
  /** The session is being torn down: it will come back on its own, so nobody counts on it staying. */
  closing(): void;
  /** Its teardown could not confirm the process exited: keep it held, and report it. */
  unconfirmed(): void;
}

interface Held {
  agentId: string;
  hostId: string;
  pinnedTo?: string | undefined;
  closing?: boolean;
  unconfirmed?: boolean;
}

type Blocker = { key: Key; reason: string };

type Key = string;
const DAEMON: Key = "daemon";
const agentKey = (id: string): Key => `agent:${id}`;
const hostKey = (id: string): Key => `host:${id}`;

interface Waiter {
  seq: number;
  request: SessionSlotRequest;
  resolve(slot: SessionSlot): void;
  reject(error: Error): void;
  reason?: string;
  told: Promise<void>;
  dispose(): void;
}

export class SessionSlots {
  private total = 0;
  private readonly byAgent = new Map<string, number>();
  private readonly byHost = new Map<string, number>();
  private readonly held = new Set<Held>();
  private waiters: Waiter[] = [];
  private seq = 0;

  constructor(private readonly configured: () => ConfiguredSessionLimits = () => ({ agents: {}, hosts: {} })) {}

  /** A slot at once when one is free and nobody is queued for it; otherwise undefined. */
  tryAcquire(request: SessionSlotRequest): SessionSlot | undefined {
    if (this.blockers(request, this.queuedBlocks()).length > 0) return undefined;
    return this.take(request);
  }

  /** A slot, waiting for one when needed. Rejects with `CANCELLED` when `signal` aborts first. */
  acquire(request: SessionSlotRequest): Promise<SessionSlot> {
    const immediate = this.tryAcquire(request);
    if (immediate) return Promise.resolve(immediate);
    if (request.signal?.aborted) return Promise.reject(new OrcaError("CANCELLED", "cancelled"));
    return new Promise<SessionSlot>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        seq: this.seq++,
        request,
        told: Promise.resolve(),
        resolve: (slot) => {
          waiter.dispose();
          // Hand the slot over only after every reason the caller was told has landed.
          void waiter.told.then(
            () => resolve(slot),
            () => resolve(slot),
          );
        },
        reject: (error) => {
          waiter.dispose();
          reject(error);
        },
        dispose: () => {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
        },
      };
      const leave = (error: Error) => {
        if (!this.waiters.includes(waiter)) return;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.reject(error);
        // Leaving the queue can unblock whoever was queued behind this waiter.
        this.pump();
      };
      const onAbort = () => leave(new OrcaError("CANCELLED", "cancelled"));
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.deadlineMs !== undefined) {
        const ms = request.deadlineMs;
        timer = setTimeout(
          () =>
            leave(
              new OrcaError(
                "STEP_TIMEOUT",
                `no agent slot within ${ms}ms (limits.agentSlotWaitMs): ${waiter.reason ?? "waiting for an agent slot"}`,
              ),
            ),
          ms,
        );
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  /** Grant whoever can go now. Call after anything that may have freed room (a cap raised). */
  pump(): void {
    for (const waiter of [...this.waiters]) {
      const impossible = this.provenImpossible(waiter.request);
      if (impossible === undefined) continue;
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.reject(new OrcaError("CONFIG_INVALID", impossible));
    }
    const blocked = new Map<Key, string>();
    const uncertain = this.possiblyStuck();
    for (const waiter of this.ordered()) {
      const reasons = this.blockers(waiter.request, blocked);
      if (reasons.length === 0) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(this.take(waiter.request));
        continue;
      }
      for (const { key, reason } of reasons) if (!blocked.has(key)) blocked.set(key, reason);
      const stuck = uncertain.get(waiter);
      const reason = stuck ? `${reasons[0]!.reason}; ${stuck}` : reasons[0]!.reason;
      if (reason !== waiter.reason) {
        waiter.reason = reason;
        const onWait = waiter.request.onWait;
        if (onWait) waiter.told = waiter.told.then(() => onWait(reason)).catch(() => undefined);
      }
    }
  }

  view(): SessionSlotsView {
    const configured = this.configured();
    return {
      limits: {
        ...(configured.maxAgentSessions === undefined ? {} : { maxAgentSessions: configured.maxAgentSessions }),
        ...(configured.agentSlotWaitMs === undefined ? {} : { agentSlotWaitMs: configured.agentSlotWaitMs }),
        agents: { ...configured.agents },
        hosts: { ...configured.hosts },
      },
      inUse: {
        total: this.total,
        agents: Object.fromEntries([...this.byAgent].filter(([, n]) => n > 0)),
        hosts: Object.fromEntries([...this.byHost].filter(([, n]) => n > 0)),
      },
      queued: this.waiters.length,
      teardownUnconfirmed: [...this.held].filter((h) => h.unconfirmed).length,
    };
  }

  // ------------------------------------------------------------------ internals

  /** Every full cap this request is subject to, plus any cap an earlier waiter is blocked on. */
  private blockers(request: SessionSlotRequest, queued: ReadonlyMap<Key, string>): Blocker[] {
    const out: Blocker[] = [];
    for (const { key, cap, used, where } of this.capsOf(request)) {
      if (used >= cap) out.push({ key, reason: `waiting for an agent slot: ${used} of ${cap} in use ${where}` });
      else {
        const ahead = queued.get(key);
        if (ahead !== undefined) out.push({ key, reason: ahead });
      }
    }
    return out;
  }

  /** The caps this request is subject to, with their use and where they apply. */
  private capsOf(request: SessionSlotRequest): { key: Key; cap: number; used: number; where: string }[] {
    const caps = request.caps();
    const all = [
      { key: DAEMON, cap: caps.daemon, used: this.total, where: "on this daemon" },
      {
        key: agentKey(request.agentId),
        cap: caps.agent,
        used: this.byAgent.get(request.agentId) ?? 0,
        where: `for agent ${request.agentId}`,
      },
      {
        key: hostKey(request.hostId),
        cap: caps.host,
        used: this.byHost.get(request.hostId) ?? 0,
        where: `on host ${request.hostId}`,
      },
    ];
    return all.flatMap((c) => (c.cap === undefined ? [] : [{ ...c, cap: c.cap }]));
  }

  /** A full cap of this request's whose every slot is pinned by one of `runs` and not closing. */
  private pinnedFull(
    request: SessionSlotRequest,
    runs: ReadonlySet<string>,
  ): { used: number; cap: number; where: string; agents: string[] } | undefined {
    for (const { key, cap, used, where } of this.capsOf(request)) {
      if (used < cap) continue;
      const pinned = [...this.held].filter(
        (h) => h.pinnedTo !== undefined && !h.closing && runs.has(h.pinnedTo) && sameKey(key, h),
      );
      if (pinned.length >= cap) return { used, cap, where, agents: [...new Set(pinned.map((h) => h.agentId))] };
    }
    return undefined;
  }

  /** Why this request can never be granted, when that is proven (see the file comment). */
  private provenImpossible(request: SessionSlotRequest): string | undefined {
    const own = request.runs?.[0];
    if (own === undefined) return undefined;
    const full = this.pinnedFull(request, new Set([own]));
    if (!full) return undefined;
    return (
      `an agent slot can never be free for agent ${request.agentId}: ${full.used} of ${full.cap} in use ${full.where}, ` +
      `all held by per-run sessions of this same run (${full.agents.join(", ")}), which keep their slots until the run ends ` +
      `and the run cannot move on while this step waits; raise the cap, or give those agents sessionMode: per-step`
    );
  }

  /**
   * Waiters a wait-for check cannot clear: drop any whose full caps include a slot that is not
   * pinned by a run that is itself waiting (as some waiter's own run or ancestor), and repeat.
   * What is left may never be granted - but only may, so it is reported, not failed.
   */
  private possiblyStuck(): Map<Waiter, string> {
    const stuck = new Set(this.waiters);
    const waitingRuns = () => new Set([...stuck].flatMap((w) => w.request.runs ?? []));
    for (;;) {
      const runs = waitingRuns();
      const free = [...stuck].filter((w) => this.pinnedFull(w.request, runs) === undefined);
      if (free.length === 0) break;
      for (const w of free) stuck.delete(w);
    }
    const out = new Map<Waiter, string>();
    const runs = waitingRuns();
    for (const w of stuck) {
      const full = this.pinnedFull(w.request, runs)!;
      out.set(
        w,
        `it may never be granted: the slots are held by per-run sessions (${full.agents.join(", ")}) of runs that ` +
          `are themselves waiting on this queue` +
          (this.configured().agentSlotWaitMs === undefined
            ? `; set limits.agentSlotWaitMs to bound the wait, raise the cap, or make those agents per-step`
            : ""),
      );
    }
    return out;
  }

  /** What the waiters already queued are blocked on, so a newcomer does not overtake them. */
  private queuedBlocks(): Map<Key, string> {
    const blocked = new Map<Key, string>();
    for (const waiter of this.ordered())
      for (const { key, reason } of this.blockers(waiter.request, blocked))
        if (!blocked.has(key)) blocked.set(key, reason);
    return blocked;
  }

  /** Plan waiters by priority, other waiters by age, the two sides merged by age. */
  private ordered(): Waiter[] {
    const planned = this.waiters
      .filter((w) => w.request.priority !== undefined)
      .sort((a, b) => b.request.priority! - a.request.priority! || a.seq - b.seq);
    const other = this.waiters.filter((w) => w.request.priority === undefined).sort((a, b) => a.seq - b.seq);
    const out: Waiter[] = [];
    while (planned.length || other.length) {
      if (!other.length) out.push(planned.shift()!);
      else if (!planned.length) out.push(other.shift()!);
      else {
        const oldestPlanned = Math.min(...planned.map((w) => w.seq));
        out.push(oldestPlanned < other[0]!.seq ? planned.shift()! : other.shift()!);
      }
    }
    return out;
  }

  private take(request: SessionSlotRequest): SessionSlot {
    const { agentId, hostId } = request;
    const record: Held = { agentId, hostId, ...(request.pinnedTo ? { pinnedTo: request.pinnedTo } : {}) };
    this.held.add(record);
    this.total++;
    this.byAgent.set(agentId, (this.byAgent.get(agentId) ?? 0) + 1);
    this.byHost.set(hostId, (this.byHost.get(hostId) ?? 0) + 1);
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        this.held.delete(record);
        this.total--;
        this.byAgent.set(agentId, (this.byAgent.get(agentId) ?? 1) - 1);
        this.byHost.set(hostId, (this.byHost.get(hostId) ?? 1) - 1);
        this.pump();
      },
      closing: () => {
        if (!held || record.closing) return;
        record.closing = true;
        this.pump();
      },
      unconfirmed: () => {
        if (held) record.unconfirmed = true;
      },
    };
  }
}

function sameKey(key: Key, held: Held): boolean {
  return key === DAEMON || key === agentKey(held.agentId) || key === hostKey(held.hostId);
}
