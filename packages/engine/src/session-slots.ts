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
 * are open. A slot is returned exactly once (release is idempotent) by whichever comes first:
 * the step letting go of its session, the session closing, or a failed open.
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
 * Waits that can never end fail instead of hanging. A `per-run` session holds its slot until
 * its run ends, and a run cannot end while one of its own steps - or a step of a run below it
 * - waits for a slot. Every other slot comes back on its own (a `per-step` session ends with
 * its turn, which has its own timeout). So the queue keeps a wait-for check: start from every
 * waiter; drop any waiter that some full cap of its could still free a slot on, because a
 * holder there is not pinned by a run that is itself waiting; repeat until nothing drops.
 * Whoever is left waits on slots pinned by runs that wait on them in turn - the same run with
 * two per-run agents under a cap of one, a parent's per-run session and its child, or two
 * unrelated runs each pinning what the other's child needs. Those steps fail with
 * `CONFIG_INVALID` naming the cap and the agents holding it, rather than exceeding the cap or
 * waiting for ever. No deadline is needed, so a queue that will drain is never cut off,
 * however long the turns ahead of it take.
 */
import { OrcaError } from "@orca/core";

/** The caps one session open is subject to. An absent cap is unlimited. */
export interface SessionSlotCaps {
  daemon?: number | undefined;
  agent?: number | undefined;
  host?: number | undefined;
}

/** What the daemon is configured with, for the read model. Only caps that are set appear. */
export interface ConfiguredSessionLimits {
  maxAgentSessions?: number | undefined;
  agents: Record<string, number>;
  hosts: Record<string, number>;
}

export interface SessionSlotsView {
  limits: ConfiguredSessionLimits;
  inUse: { total: number; agents: Record<string, number>; hosts: Record<string, number> };
  /** Steps waiting for a slot right now. */
  queued: number;
}

export interface SessionSlotRequest {
  agentId: string;
  hostId: string;
  /**
   * The caps this open is subject to, asked again on every pass over the queue so a cap the
   * operator raised or lowered while the step waits takes effect for it too.
   */
  caps: () => SessionSlotCaps;
  /**
   * The run this step belongs to, then its parent, grandparent and so on. Slots pinned by any
   * of them cannot come back while this step waits (see "Impossible waits" above).
   */
  runs?: readonly string[] | undefined;
  /** This open becomes a `per-run` session of that run, holding its slot until the run ends. */
  pinnedTo?: string | undefined;
  /** Plan priority score (higher goes first); absent for a step outside any plan. */
  priority?: number | undefined;
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
}

interface Held {
  agentId: string;
  hostId: string;
  pinnedTo?: string | undefined;
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
        dispose: () => request.signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        if (!this.waiters.includes(waiter)) return;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.reject(new OrcaError("CANCELLED", "cancelled"));
        // Leaving the queue can unblock whoever was queued behind this waiter.
        this.pump();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  /** Grant whoever can go now. Call after anything that may have freed room (a cap raised). */
  pump(): void {
    for (const { waiter, message } of this.deadlocked()) {
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.reject(new OrcaError("CONFIG_INVALID", message));
    }
    const blocked = new Map<Key, string>();
    for (const waiter of this.ordered()) {
      const reasons = this.blockers(waiter.request, blocked);
      if (reasons.length === 0) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(this.take(waiter.request));
        continue;
      }
      for (const { key, reason } of reasons) if (!blocked.has(key)) blocked.set(key, reason);
      const reason = reasons[0]!.reason;
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
        agents: { ...configured.agents },
        hosts: { ...configured.hosts },
      },
      inUse: {
        total: this.total,
        agents: Object.fromEntries([...this.byAgent].filter(([, n]) => n > 0)),
        hosts: Object.fromEntries([...this.byHost].filter(([, n]) => n > 0)),
      },
      queued: this.waiters.length,
    };
  }

  // ------------------------------------------------------------------ internals

  /** Every full cap this request is subject to, plus any cap an earlier waiter is blocked on. */
  private blockers(request: SessionSlotRequest, queued: ReadonlyMap<Key, string>): Blocker[] {
    const out: Blocker[] = [];
    const check = (key: Key, cap: number | undefined, used: number, where: string) => {
      if (cap === undefined) return;
      if (used >= cap) out.push({ key, reason: `waiting for an agent slot: ${used} of ${cap} in use ${where}` });
      else {
        const ahead = queued.get(key);
        if (ahead !== undefined) out.push({ key, reason: ahead });
      }
    };
    const caps = request.caps();
    check(DAEMON, caps.daemon, this.total, "on this daemon");
    check(
      agentKey(request.agentId),
      caps.agent,
      this.byAgent.get(request.agentId) ?? 0,
      `for agent ${request.agentId}`,
    );
    check(hostKey(request.hostId), caps.host, this.byHost.get(request.hostId) ?? 0, `on host ${request.hostId}`);
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

  /**
   * Why this request can never be granted while the runs in `waiting` wait, or undefined when
   * some release may still reach it: a full cap of its whose every slot is a per-run session
   * pinned by one of those runs.
   */
  private stuckOn(request: SessionSlotRequest, waiting: ReadonlySet<string>): string | undefined {
    for (const { key, cap, used, where } of this.capsOf(request)) {
      if (used < cap) continue;
      const pinned = [...this.held].filter(
        (h) => h.pinnedTo !== undefined && waiting.has(h.pinnedTo) && sameKey(key, h),
      );
      if (pinned.length < cap) continue;
      return (
        `an agent slot can never be free for agent ${request.agentId}: ${used} of ${cap} in use ${where}, ` +
        `held by per-run sessions (${[...new Set(pinned.map((h) => h.agentId))].join(", ")}) of runs that cannot end ` +
        `while a step of theirs waits for a slot - this one, or one queued with it; ` +
        `raise the cap, or give those agents sessionMode: per-step`
      );
    }
    return undefined;
  }

  /** The waiters no release can ever reach (see "Waits that can never end" above). */
  private deadlocked(): { waiter: Waiter; message: string }[] {
    const stuck = new Set(this.waiters);
    const waitingRuns = () => new Set([...stuck].flatMap((w) => w.request.runs ?? []));
    for (;;) {
      const runs = waitingRuns();
      const free = [...stuck].filter((w) => this.stuckOn(w.request, runs) === undefined);
      if (free.length === 0) break;
      for (const w of free) stuck.delete(w);
    }
    if (stuck.size === 0) return [];
    const runs = waitingRuns();
    return [...stuck].map((waiter) => ({ waiter, message: this.stuckOn(waiter.request, runs)! }));
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
    };
  }
}

function sameKey(key: Key, held: Held): boolean {
  return key === DAEMON || key === agentKey(held.agentId) || key === hostKey(held.hostId);
}
