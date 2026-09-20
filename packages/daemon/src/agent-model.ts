/**
 * The agent surface's model: `agents.list` and `agents.ping`, plus the change hook the
 * `agent.changed` notification hangs off.
 *
 * It sits beside `ReadModel` rather than inside it because health is not a projection of the
 * store. It lives in this process's memory (`AgentHealthTracker`), it is the same object the
 * engine writes to as it opens sessions, and `agents.ping` *creates* some of it by spawning
 * an agent. None of that is a read of a log, and a class called a read model should not be
 * the place a subprocess gets started.
 *
 * It is available to a read-only daemon all the same. `agents.ping` opens a session, shakes
 * hands and closes: no run, no lease, no event appended. What it changes is health, which
 * nobody else owns and which no `--read-only` promise is about.
 *
 * Claims come back with the list because the surface's second question, after "is it up", is
 * "and what is it working on", and a claim is the only record of that which outlives a step.
 * They are projected by `ReadModel` so there is one `ClaimView` in the daemon and not two.
 */
import type { AgentRegistry, AgentHealth } from "@orca/agents";
import { describeError, type Clock } from "@orca/core";
import type { Orchestrator } from "@orca/engine";
import type { AgentsListResult, AgentsPingParams, AgentsPingResult, AgentView } from "@orca/protocol";
import type { ReadModel } from "./read-model.js";

export interface AgentModelOptions {
  orchestrator: Orchestrator;
  /** Supplies the `claims` half of `agents.list`; without it the list carries none. */
  reads?: ReadModel | undefined;
  /** Defaults to the orchestrator's own clock, so a test can pin every `asOf`. */
  clock?: Clock | undefined;
}

/** What a run-driven change carries with it, so `agent.changed` can name the run. */
export interface AgentChange {
  agent: AgentView;
  at: string;
}

export class AgentModel {
  private readonly orc: Orchestrator;
  private readonly reads: ReadModel | undefined;
  private readonly clock: Clock;

  constructor(opts: AgentModelOptions) {
    this.orc = opts.orchestrator;
    this.reads = opts.reads;
    this.clock = opts.clock ?? opts.orchestrator.clock;
  }

  private get registry(): AgentRegistry {
    return this.orc.agents;
  }

  /**
   * Be told when an agent's health changes. One listener on the tracker, however many
   * subscriptions are open - see `AgentHealthTracker.onChange` for why this is a listener
   * and why `lastSeenAt` moving is not a change.
   */
  onChange(listener: (change: AgentChange) => void): () => void {
    return this.registry.health.onChange((health) =>
      listener({ agent: agentView(health, this.registry), at: health.lastContact ?? this.clock.isoNow() }),
    );
  }

  /**
   * Every *configured* agent with its health, and what is claimed right now. An agent this
   * process has never contacted is `unknown` rather than absent: the card has a state to
   * render instead of a fabricated default, and a freshly restarted daemon says `unknown`
   * for all of them because health does not survive a restart and must not pretend to.
   */
  async agentsList(): Promise<AgentsListResult> {
    const registry = this.registry;
    const agents = registry.listHealth().map((h) => agentView(h, registry));
    const claims = this.reads ? (await this.reads.claimsList({})).claims : [];
    return { agents, claims, asOf: this.clock.isoNow() };
  }

  /**
   * Spawn the agent, complete the ACP handshake, close, and record what happened - the same
   * thing a step does when it opens a session, done deliberately rather than as a side
   * effect. The handshake runs in *this* process, so what it proves is that the daemon can
   * reach the agent, which is the question the button is asking.
   *
   * A failed handshake is a result and not an error: "this agent is down, and here is why"
   * is exactly what the caller wanted to know, and an error envelope would lose the health
   * that was recorded alongside it. `openAcpSession` goes through `Orchestrator.sessionFactory`
   * so a test can hand it one that does not spawn anything.
   */
  async ping(params: AgentsPingParams): Promise<AgentsPingResult> {
    const registry = this.registry;
    // A selector that resolves to nothing *is* an error: there is no agent to report on.
    const { agent, host } = registry.resolve(params.agentId);
    const cwd = params.cwd ?? host.spec.workspaceRoot ?? (host.spec.type === "local" ? process.cwd() : "/tmp");
    const handshake = registry.health.begin(agent.id);
    try {
      const session = await this.orc.sessionFactory({
        host,
        agent,
        cwd,
        logger: this.orc.logger,
        clock: this.clock,
      });
      const health = handshake.ok();
      await session.close().catch(() => undefined);
      return {
        agent: agentView(health, registry),
        ok: true,
        ...(health.roundTripMs === undefined ? {} : { roundTripMs: health.roundTripMs }),
        asOf: this.clock.isoNow(),
      };
    } catch (e) {
      const health = handshake.failed(e);
      const { code, message } = describeError(e);
      return { agent: agentView(health, registry), ok: false, error: { code, message }, asOf: this.clock.isoNow() };
    }
  }
}

/**
 * Health plus the configuration it is health *of*. `hostId` and `roles` come from the spec
 * rather than the tracker, because the tracker is keyed by id and knows nothing else; an
 * agent whose spec has gone (a config edit between the handshake and the read) keeps its
 * health and loses its host, which is truer than dropping the row.
 *
 * `hostType` comes from the host that spec names, and is omitted when there is no such host
 * to ask - which is the same edit, one step further on. A card that cannot say `local` or
 * `ssh` says neither rather than the commoner of the two (RULES.md rule 12).
 */
function agentView(health: AgentHealth, registry: AgentRegistry): AgentView {
  const spec = registry.listAgents().find((a) => a.id === health.agentId);
  const hostType = spec && registry.hasHost(spec.hostId) ? registry.host(spec.hostId).spec.type : undefined;
  return {
    id: health.agentId,
    hostId: spec?.hostId ?? "",
    ...(hostType === undefined ? {} : { hostType }),
    roles: [...(spec?.roles ?? [])],
    state: health.state,
    consecutiveFailures: health.consecutiveFailures,
    // `lastHandshakeAt` on the wire, `lastContact` in the tracker: the wire name says which
    // of the two timestamps it is, and the tracker's predates the second one (#227).
    ...(health.lastContact === undefined ? {} : { lastHandshakeAt: health.lastContact }),
    ...(health.lastSeenAt === undefined ? {} : { lastSeenAt: health.lastSeenAt }),
    ...(health.roundTripMs === undefined ? {} : { roundTripMs: health.roundTripMs }),
    ...(health.lastError ? { lastError: health.lastError } : {}),
  };
}
