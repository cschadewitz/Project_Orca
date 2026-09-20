/** Host construction from config (`local` / `ssh`) and the registry the engine looks agents up in. */
import {
  describeError,
  OrcaError,
  systemClock,
  type AgentSelector,
  type AgentSpec,
  type Clock,
  type HostSpec,
} from "@orca/core";
import type { AgentHost } from "../host.js";
import { LocalHost } from "./local-host.js";
import { SshHost } from "./ssh-host.js";

export function createHost(spec: HostSpec): AgentHost {
  switch (spec.type) {
    case "local":
      return new LocalHost(spec);
    case "ssh":
      return new SshHost(spec);
  }
}

// ------------------------------------------------------------ handshake health

/**
 * How an agent answered the last time ORCA tried to talk to it.
 *
 * - `unknown` - never contacted in this process. It is a real state, not a missing
 *   one: health is held in memory only (see `AgentHealthTracker`), so a freshly
 *   started daemon says `unknown` for every agent rather than claiming `ok`.
 * - `ok` - the handshake succeeded first time.
 * - `degraded` - the handshake succeeded, but only after a failed one. There is
 *   deliberately **no latency rule**: ORCA has no data yet for a defensible
 *   round-trip bound over ssh, and a wrong bound paints healthy agents amber. The
 *   round trip is recorded regardless, so a bound can be added once real numbers
 *   exist.
 * - `down` - the last handshake failed (a spawn that never came up, a timeout, a
 *   protocol error).
 */
export type AgentHealthState = "unknown" | "ok" | "degraded" | "down";

/** Handshake health for one agent: the state, when it was last established and what it cost. */
export interface AgentHealth {
  agentId: string;
  state: AgentHealthState;
  /**
   * ISO time of the last handshake attempt, successful or not. Absent while `unknown`. This
   * is what `state`, `roundTripMs` and `consecutiveFailures` are all about, and it is
   * `lastHandshakeAt` on the wire (#227).
   */
  lastContact?: string;
  /**
   * ISO time of the last sign of life of any kind - a handshake, or a line of output from a
   * session opened long before (`touch`). Never older than `lastContact`, and usually newer:
   * a per-run pooled session handshakes once and then talks for an hour, so a card that read
   * `lastContact` alone would say an agent mid-sentence was last heard from at 09:04 (#227).
   */
  lastSeenAt?: string;
  /**
   * Round trip of the last *successful* handshake, in ms - spawn through `initialize`
   * and `session/new`. It survives a later failure, so a `down` agent still reports what
   * it cost when it last worked; absent until one succeeds.
   */
  roundTripMs?: number;
  /** Failed handshakes since the last successful one. Non-zero exactly while `down`. */
  consecutiveFailures: number;
  /** Why the last handshake failed. Kept only while `down`. */
  lastError?: { code: string; message: string };
}

/** Recording the two ends of one handshake, with the round trip measured by the tracker. */
export interface HandshakeRecorder {
  ok(): AgentHealth;
  failed(error: unknown): AgentHealth;
}

/** Told the new health whenever a handshake succeeds or fails. See `AgentHealthTracker.onChange`. */
export type AgentHealthListener = (health: AgentHealth) => void;

function unknownHealth(agentId: string): AgentHealth {
  return { agentId, state: "unknown", consecutiveFailures: 0 };
}

/**
 * Handshake health per agent, derived from work that already happens rather than polled:
 * every session the engine opens is a successful handshake and every spawn that fails is
 * evidence of the opposite. Nothing here spawns an agent nobody asked for.
 *
 * In-process only, and deliberately so: persisting it would put state in the store that the
 * event log does not own. The accepted cost is that a restart forgets everything and every
 * agent reads `unknown` again until first contact.
 */
export class AgentHealthTracker {
  private readonly byAgent = new Map<string, AgentHealth>();
  private readonly listeners = new Set<AgentHealthListener>();

  constructor(private readonly clock: Clock = systemClock) {}

  /**
   * Be told when an agent's handshake health changes. A listener, not a poll: the daemon's
   * `agent.changed` notification hangs off this, and a poller would have to run whether or
   * not anything was watching and would still be a tick behind the thing it watched.
   *
   * It fires on `recordHandshake` and `recordFailure` and deliberately **not** on `touch`.
   * `touch` runs once per coalesced batch of agent output; a notification each would be the
   * firehose the daemon's 100 ms `agent.update` window exists to avoid, and what it moves -
   * `lastSeenAt` - is a number a surface can read on its next `agents.list` without anyone
   * having been told.
   */
  onChange(listener: AgentHealthListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** A listener that throws must not take down the handshake that told it. */
  private changed(health: AgentHealth): AgentHealth {
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...health });
      } catch {
        // Health is a side-effect of a session opening; a bad listener is not that session's problem.
      }
    }
    return { ...health };
  }

  /** Health for one agent; `unknown` for one never contacted in this process. */
  get(agentId: string): AgentHealth {
    return { ...(this.byAgent.get(agentId) ?? unknownHealth(agentId)) };
  }

  /** Every agent contacted in this process, in first-contact order. */
  list(): AgentHealth[] {
    return [...this.byAgent.values()].map((h) => ({ ...h }));
  }

  /**
   * Start timing a handshake. Call `ok()` when the session is open or `failed(e)` when the
   * spawn or the ACP handshake threw; the round trip is the span between.
   */
  begin(agentId: string): HandshakeRecorder {
    const started = this.clock.now();
    return {
      ok: () => this.recordHandshake(agentId, this.clock.now() - started),
      failed: (error: unknown) => this.recordFailure(agentId, error),
    };
  }

  /**
   * A handshake completed. It is `degraded` rather than `ok` when a handshake with this
   * agent failed since the last successful one - that is what "only after a retry" means,
   * and the engine's step retry budget is what produces the retry.
   */
  recordHandshake(agentId: string, roundTripMs: number): AgentHealth {
    const prior = this.byAgent.get(agentId);
    const at = this.clock.isoNow();
    const health: AgentHealth = {
      agentId,
      state: prior && prior.consecutiveFailures > 0 ? "degraded" : "ok",
      lastContact: at,
      lastSeenAt: at,
      roundTripMs,
      consecutiveFailures: 0,
    };
    this.byAgent.set(agentId, health);
    return this.changed(health);
  }

  /** A spawn or handshake failed. The agent is `down` until one succeeds. */
  recordFailure(agentId: string, error: unknown): AgentHealth {
    const prior = this.byAgent.get(agentId) ?? unknownHealth(agentId);
    const { code, message } = describeError(error);
    const at = this.clock.isoNow();
    const health: AgentHealth = {
      agentId,
      state: "down",
      lastContact: at,
      lastSeenAt: at,
      ...(prior.roundTripMs !== undefined ? { roundTripMs: prior.roundTripMs } : {}),
      consecutiveFailures: prior.consecutiveFailures + 1,
      lastError: { code, message },
    };
    this.byAgent.set(agentId, health);
    return this.changed(health);
  }

  /**
   * An agent said something. Moves `lastSeenAt` and nothing else - not `state`, not
   * `consecutiveFailures`, not `lastContact` - because output over an existing session is
   * evidence the session is alive, not evidence of a new handshake.
   *
   * It has to be cheap: it is called once per coalesced batch of agent output, which is
   * often. A map lookup and one field, no listeners, no allocation for an agent that has
   * never been contacted (there is no session to be speaking over, so there is nothing to
   * record).
   */
  touch(agentId: string): void {
    const health = this.byAgent.get(agentId);
    if (health) health.lastSeenAt = this.clock.isoNow();
  }

  /** Forget everything, as a restart would. Listeners survive: they belong to the watcher. */
  reset(): void {
    this.byAgent.clear();
  }
}

/** Resolves hosts and agents from config; the engine's single lookup point. */
export class AgentRegistry {
  private readonly hosts = new Map<string, AgentHost>();
  private readonly agents = new Map<string, AgentSpec>();
  private readonly roles = new Map<string, string>();
  /** Handshake health for the agents in this registry; fed by whoever opens a session. */
  readonly health: AgentHealthTracker;

  constructor(clock: Clock = systemClock) {
    this.health = new AgentHealthTracker(clock);
  }

  addHost(host: AgentHost): this {
    this.hosts.set(host.id, host);
    return this;
  }
  addAgent(spec: AgentSpec): this {
    this.agents.set(spec.id, spec);
    return this;
  }
  mapRole(role: string, agentId: string): this {
    this.roles.set(role, agentId);
    return this;
  }
  static fromConfig(
    cfg: { hosts: HostSpec[]; agents: AgentSpec[]; roles: Record<string, string> },
    opts: { clock?: Clock } = {},
  ): AgentRegistry {
    const r = new AgentRegistry(opts.clock);
    for (const h of cfg.hosts) r.addHost(createHost(h));
    for (const a of cfg.agents) r.addAgent(a);
    for (const [role, id] of Object.entries(cfg.roles)) r.mapRole(role, id);
    return r;
  }

  host(id: string): AgentHost {
    const h = this.hosts.get(id);
    if (!h)
      throw new OrcaError("AGENT_HOST_NOT_FOUND", `host '${id}' not configured`, { known: [...this.hosts.keys()] });
    return h;
  }
  hasHost(id: string): boolean {
    return this.hosts.has(id);
  }
  listHosts(): AgentHost[] {
    return [...this.hosts.values()];
  }
  listAgents(): AgentSpec[] {
    return [...this.agents.values()];
  }

  /**
   * Handshake health for every *configured* agent, in `listAgents()` order - what the
   * Agents surface reads. An agent this process has never contacted is `unknown` rather
   * than absent, so the card has a state to render instead of a fabricated default.
   */
  listHealth(): AgentHealth[] {
    return [...this.agents.keys()].map((id) => this.health.get(id));
  }

  canResolve(selector: AgentSelector): boolean {
    try {
      this.resolve(selector);
      return true;
    } catch {
      return false;
    }
  }

  resolve(selector: AgentSelector): { agent: AgentSpec; host: AgentHost } {
    let id: string | undefined;
    if (typeof selector === "string") id = selector;
    else if ("id" in selector) id = selector.id;
    else {
      id = this.roles.get(selector.role) ?? [...this.agents.values()].find((a) => a.roles.includes(selector.role))?.id;
      if (!id)
        throw new OrcaError("AGENT_NOT_FOUND", `no agent fills role '${selector.role}'`, { role: selector.role });
    }
    const agent = this.agents.get(id);
    if (!agent)
      throw new OrcaError("AGENT_NOT_FOUND", `agent '${id}' not configured`, { known: [...this.agents.keys()] });
    return { agent, host: this.host(agent.hostId) };
  }
}
