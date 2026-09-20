/**
 * The Agents surface: who is doing the work, and are they healthy
 * (docs/design/10-information-architecture.md).
 *
 * Four decisions worth knowing before changing anything here:
 *
 * - **It is a grid of cards grouped by host, not a list of rows.** A run list is long and
 *   homogeneous, which is what `VirtualList` is for; the agents are a handful of configured
 *   processes and each one has four or five things to say, so the shape is the design
 *   system's `.orca-agent` card. Grouping is by `hostId` because "which machine is not
 *   answering" is the question a person brings to this screen, and a host that has stopped
 *   answering takes its whole group down together.
 * - **Nothing polls.** The list is read once and every later change arrives as an
 *   `agent.changed` notification over the one subscription the main process holds
 *   (`use-agents.ts`). That notification became an ordinary `DaemonNotification` in protocol
 *   1.5 (#241), so it arrives through `createNotificationStream` like every other method and
 *   there is no second path to it.
 * - **The claims are a region of their own.** They travel with `agents.list` because the
 *   surface's second question, after "is it up", is "and what is it on" — but a `ClaimView`
 *   names the work item and the *run* holding it, and names no agent, so it cannot be put on
 *   a card without inventing the link (RULES.md rule 12). It is rendered as what it is: the
 *   work being held right now, and by which run.
 * - **Nothing here writes.** `agents.ping` is a read — it spawns, handshakes and closes,
 *   touching no run, lease or log — but the button that calls it is #176's, so this surface
 *   asks nothing of `useWritability()` and offers no control at all.
 */
import { useMemo, type JSX } from "react";
import type { ConnectionState } from "@orca/design";
import type { ClaimView } from "@orca/protocol";
import { StateView, StatusChip, Text, Time, textClass } from "../ui/index.js";
import { AgentCard } from "./agent-card.js";
import { countLabel, groupByHost, transportLabel, type HostGroup } from "./agent-groups.js";
import { useAgents, type AgentsState } from "./use-agents.js";
import "./agents.css";

export interface AgentsSurfaceProps {
  /** Whether the daemon is answering. A screen nobody is updating says so rather than lying. */
  connection: ConnectionState;
}

export function AgentsSurface({ connection }: AgentsSurfaceProps): JSX.Element {
  const { state, reload } = useAgents();
  const live = connection === "live";

  const agents = state.phase === "ready" ? state.agents : undefined;
  const groups = useMemo(() => (agents ? groupByHost(agents) : []), [agents]);

  return (
    <div className="orca-agents">
      {/* Last-known data, said out loud: the values stay, the banner says not to trust their
          freshness (docs/design/40-connection-states.md). */}
      {!live && state.phase === "ready" && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">Not connected — this is the last the daemon said about these agents.</Text>
        </div>
      )}

      {state.phase === "ready" && (
        <div className="orca-agents__summary">
          <Text style="caption">{countLabel(state.agents.length, groups.length)}</Text>
        </div>
      )}

      <Body state={state} groups={groups} live={live} connection={connection} onRetry={reload} />
    </div>
  );
}

interface BodyProps {
  state: AgentsState;
  groups: readonly HostGroup[];
  live: boolean;
  connection: ConnectionState;
  onRetry: () => void;
}

/** The groups and the claims, or the one state view that stands in for them. */
function Body({ state, groups, live, connection, onRetry }: BodyProps): JSX.Element {
  if (state.phase === "loading") return <StateView kind="loading" title="Loading agents" />;

  if (state.phase === "error") {
    /* A daemon that never answered is `disconnected`, not an error: nothing is broken and
       there is nothing to report but the absence of a daemon. */
    return connection === "live" ? (
      <StateView
        kind="error"
        title="Could not load the agents"
        body={`${state.error.code}: ${state.error.message}`}
        action={{ label: "Try again", onClick: onRetry }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to read agents from"
        /* No backticks: `StateView`'s body is one type style, so markup for mono would
           render as the characters themselves. */
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: onRetry }}
      />
    );
  }

  if (state.agents.length === 0) {
    return (
      <StateView
        kind="empty"
        title="No agents configured"
        body="Add one under agents: in orca.yaml, and it appears here with its host."
      />
    );
  }

  return (
    <div className="orca-agents__body">
      {groups.map((group) => (
        <HostSection key={group.hostId} group={group} live={live} />
      ))}
      <Claims claims={state.claims} asOf={state.asOf} live={live} />
    </div>
  );
}

/** One host and its agents. The heading is the id; the transport is the second thing. */
function HostSection({ group, live }: { group: HostGroup; live: boolean }): JSX.Element {
  const transport = transportLabel(group.hostType);
  const count = `${group.agents.length} ${group.agents.length === 1 ? "agent" : "agents"}`;

  return (
    <section className="orca-agents__host" aria-label={`Host ${group.hostId || "unknown"}`}>
      <div className="orca-agents__host-head">
        {/* A host id is an id, so it is mono (rule 8) — one type class per element, which is
            why this is an `h2` with `mono-strong` rather than a `Text style="heading"`. An
            agent whose host has left the config has no id at all, and the heading says so
            rather than leaving the group nameless (rule 12). */}
        <h2 className={`orca-agents__host-id ${textClass("mono-strong")}`}>
          {group.hostId === "" ? "No configured host" : group.hostId}
        </h2>
        {transport !== undefined && (
          <Text style="caption" className="orca-agents__transport">
            {transport}
          </Text>
        )}
        <Text style="caption" className="orca-agents__host-count">
          {count}
        </Text>
      </div>
      <div className="orca-agents__grid">
        {group.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} live={live} />
        ))}
      </div>
    </section>
  );
}

interface ClaimsProps {
  claims: readonly ClaimView[];
  asOf: string;
  live: boolean;
}

/**
 * What is being worked right now. A claim outlives the step that took it, so the question a
 * person actually asks of it is "is the run holding this still alive?" — which is why the
 * owning run's status is on the row and why a claim whose run has gone says so.
 *
 * The work item and the run are two objects and the path between them is `ObjectHeader`'s
 * counterparts ("the work item it claims", "runs that attempted this"). Those menus need
 * somewhere to navigate to, and the route table is #165's — so the row names both objects
 * and leaves the navigation to land in one place rather than growing a private one here,
 * exactly as the command palette leaves out `onJump`.
 */
function Claims({ claims, asOf, live }: ClaimsProps): JSX.Element {
  return (
    <section className="orca-agents__claims" aria-label="Claimed work">
      <div className="orca-agents__host-head">
        <Text style="heading" as="h2">
          Claimed work
        </Text>
        <Text style="caption" className="orca-agents__host-count">
          {/* Read once with the list and not moved by a push: a claim changes when a run
              takes or releases one, which is not a change in agent health. */}
          as of <Time at={new Date(asOf)} show={live ? "both" : "absolute"} />
        </Text>
      </div>
      {claims.length === 0 ? (
        <Text style="caption" className="orca-agents__none">
          Nothing is claimed right now.
        </Text>
      ) : (
        <ul className="orca-agents__claim-list">
          {claims.map((claim) => (
            <li key={`${claim.workItemId}:${claim.owner.runId}`} className="orca-agents__claim">
              <span className={`orca-id ${textClass("mono-id")}`}>{claim.workItemId}</span>
              <span className={`orca-agents__claim-title ${textClass("label")}`}>{claim.workItem?.title ?? ""}</span>
              {/* `DisplayStatus` and the design's `RunStatus` are the same eight words,
                  pinned against each other in packages/protocol/test — so no fold and no
                  cast here. */}
              <StatusChip status={claim.owner.status} className="orca-agents__claim-status" />
              <span className={`orca-id ${textClass("mono-id")} orca-agents__claim-run`}>
                {claim.owner.name ?? claim.owner.runId}
              </span>
              <Time at={new Date(claim.claimedAt)} show={live ? "both" : "absolute"} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
