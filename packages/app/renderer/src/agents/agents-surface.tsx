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
 * - **It writes two things, and only two (#176).** A claim is released here, and an agent's
 *   permission policy is edited in a panel — which is the Config surface's editor mounted
 *   beside the cards, over the Config surface's own draft model, because a second copy of
 *   `use-config.ts` would be a second answer to "what is unsaved" (`config/policy-editor.tsx`).
 *   Both controls are absent rather than disabled where there is nothing to send to, and
 *   each asks for the method it calls: `useMethodPresent("claims.release")` here,
 *   `config.set` in the panel. They travel together behind `--read-only`, but they are two
 *   dispatch tables — a daemon with no plan answers neither `claims.release` nor the other
 *   four plan writes while still driving runs — and `hello.methods` is the only thing that
 *   says so (ADR 0008).
 * - **There is no "force release" here, deliberately.** `claims.release --force` takes an
 *   item away from a run that could still resume, which is a decision with no undo, and a
 *   keyless palette row is the wrong amount of friction for it. It stays a CLI act; a claim
 *   the daemon will refuse says so on the control instead (`releaseRefusal`).
 *
 * And one thing the issue asked for that cannot be built: **an auto-approval count.** Nothing
 * in ORCA counts how often a permission rule fired — `decidePermission` runs per tool call
 * and keeps no total, on the wire or off it — so there is no number to put beside a policy
 * (RULES.md rule 12).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ConnectionState } from "@orca/design";
import { CLAIMS_RELEASE_METHOD, type ClaimView } from "@orca/protocol";
import { useMethodPresent, useWritability } from "../chrome/use-connection.js";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import { PolicyPanel } from "../config/policy-editor.js";
import { Button, Menu, StateView, StatusChip, Text, Time, textClass } from "../ui/index.js";
import { AgentCard } from "./agent-card.js";
import {
  countLabel,
  groupByHost,
  releaseConsequence,
  releaseRefusal,
  transportLabel,
  type HostGroup,
} from "./agent-groups.js";
import { useAgents, type AgentsFeed, type AgentsState } from "./use-agents.js";
import "./agents.css";

export interface AgentsSurfaceProps {
  /** Whether the daemon is answering. A screen nobody is updating says so rather than lying. */
  connection: ConnectionState;
  /**
   * Open an `orca://` URL — the chrome's route table (#165). The policy panel uses it to
   * send a person to the Config form, which is where a *configured* rule is edited.
   */
  onOpen?: (url: string) => void;
}

export function AgentsSurface({ connection, onOpen }: AgentsSurfaceProps): JSX.Element {
  const feed = useAgents();
  const { state, reload } = feed;
  const live = connection === "live";
  const canRelease = useMethodPresent(CLAIMS_RELEASE_METHOD);

  /** Whose policy the panel is showing, or nothing. One panel, whichever card opened it. */
  const [policyFor, setPolicyFor] = useState<string | undefined>(undefined);

  const agents = state.phase === "ready" ? state.agents : undefined;
  const groups = useMemo(() => (agents ? groupByHost(agents) : []), [agents]);
  const claims = state.phase === "ready" ? state.claims : EMPTY_CLAIMS;

  const openPolicy = useCallback((agentId: string) => setPolicyFor(agentId), []);
  usePaletteActions(agents, claims, canRelease, openPolicy, feed.releaseClaim);

  return (
    /* The scope the two keyless commands register in: they are actions on an object on this
       screen, and `card` is the scope the palette ranks first when focus is on one. */
    <div className="orca-agents" {...scopeProps("card")}>
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

      <div className={policyFor === undefined ? "orca-agents__split" : "orca-agents__split orca-agents__split--panel"}>
        <Body
          state={state}
          groups={groups}
          live={live}
          connection={connection}
          onRetry={reload}
          feed={feed}
          canRelease={canRelease}
          onEditPermissions={openPolicy}
        />
        {/* Mounted only while it is open, and keyed by nothing: switching agents keeps the
            same panel — and therefore the same draft — rather than remounting `useConfig`
            and throwing away an unsaved grant edit. */}
        {policyFor !== undefined && (
          <PolicyPanel
            agentId={policyFor}
            live={live}
            {...(onOpen ? { onOpen } : {})}
            onClose={() => setPolicyFor(undefined)}
          />
        )}
      </div>
    </div>
  );
}

const EMPTY_CLAIMS: readonly ClaimView[] = [];

interface BodyProps {
  state: AgentsState;
  groups: readonly HostGroup[];
  live: boolean;
  connection: ConnectionState;
  onRetry: () => void;
  feed: AgentsFeed;
  canRelease: boolean;
  onEditPermissions: (agentId: string) => void;
}

/** The groups and the claims, or the one state view that stands in for them. */
function Body({
  state,
  groups,
  live,
  connection,
  onRetry,
  feed,
  canRelease,
  onEditPermissions,
}: BodyProps): JSX.Element {
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
        <HostSection key={group.hostId} group={group} live={live} onEditPermissions={onEditPermissions} />
      ))}
      <Claims claims={state.claims} asOf={state.asOf} live={live} feed={feed} canRelease={canRelease && live} />
    </div>
  );
}

/** One host and its agents. The heading is the id; the transport is the second thing. */
function HostSection({
  group,
  live,
  onEditPermissions,
}: {
  group: HostGroup;
  live: boolean;
  onEditPermissions: (agentId: string) => void;
}): JSX.Element {
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
          <AgentCard key={agent.id} agent={agent} live={live} onEditPermissions={() => onEditPermissions(agent.id)} />
        ))}
      </div>
    </section>
  );
}

interface ClaimsProps {
  claims: readonly ClaimView[];
  asOf: string;
  live: boolean;
  feed: AgentsFeed;
  /** False where there is no `claims.release` to call: the control is absent, not disabled. */
  canRelease: boolean;
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
 *
 * Since #176 the row also carries the one write it can offer: **Release**, which takes the
 * item back from a run that cannot resume (#88). The claims themselves are still read once
 * with the list and moved by no push — a release journals nothing, so there is nothing to
 * listen for, and `use-agents.ts` re-reads them once after the call instead.
 */
function Claims({ claims, asOf, live, feed, canRelease }: ClaimsProps): JSX.Element {
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
            <li
              key={`${claim.workItemId}:${claim.owner.runId}`}
              /* The two-line variant only where there is a second line to draw: a note from
                 a release. Every other row is the one-line row (RULES.md rule 9). */
              className={`orca-agents__claim${
                feed.release?.workItemId === claim.workItemId ? " orca-agents__claim--note" : ""
              }`}
            >
              <span className={`orca-id ${textClass("mono-id")}`}>{claim.workItemId}</span>
              <span className={`orca-agents__claim-title ${textClass("label")}`}>{claim.workItem?.title ?? ""}</span>
              {/* `DisplayStatus` and the design's `RunStatus` are the same eight words,
                  pinned against each other in packages/protocol/test — so no fold and no
                  cast here. `aligned` makes the statuses one column down the list. */}
              <StatusChip status={claim.owner.status} aligned />
              <span className={`orca-id ${textClass("mono-id")} orca-agents__claim-run`}>
                {claim.owner.name ?? claim.owner.runId}
              </span>
              <Time at={new Date(claim.claimedAt)} show={live ? "both" : "absolute"} />
              {canRelease && (
                <Release
                  claim={claim}
                  busy={feed.releasing.has(claim.workItemId)}
                  onRelease={() => feed.releaseClaim(claim.workItemId)}
                />
              )}
              {/* The result, on the row it was about. Not a live region — `use-agents.ts`
                  already said it into the app's one announcer. */}
              {feed.release?.workItemId === claim.workItemId && (
                <span
                  className={`orca-agents__claim-note ${textClass("caption")}${feed.release.failed ? " orca-agents__claim-note--failed" : ""}`}
                >
                  {feed.release.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * **Release**, and the confirmation `orca claims release` also asks for.
 *
 * The confirmation is a `Menu`, because every popover in this app is one (AGENTS.md) and
 * because what it needs is exactly what a menu is: a short list of choices with the
 * consequence written beside the one that acts. It states the work item, the run it is taken
 * from and what happens next, so that the destructive choice is the one a person read rather
 * than the one they landed on.
 *
 * A claim the daemon will refuse gets no menu at all: the button is disabled with the reason
 * on it (`releaseRefusal`), because `owner.releasable` predicts the refusal exactly and
 * offering a confirmation for a call that will fail is a worse lie than saying so up front.
 * There is no **Force release** here — see the file header.
 */
function Release({ claim, busy, onRelease }: { claim: ClaimView; busy: boolean; onRelease: () => void }): JSX.Element {
  const writability = useWritability();
  const refusal = releaseRefusal(claim);
  const blocked = refusal ?? (writability.can ? undefined : writability.reason);

  if (blocked !== undefined || busy) {
    return (
      <Button
        size="sm"
        tone="danger"
        className="orca-agents__claim-release"
        disabled
        {...(blocked === undefined ? {} : { disabledReason: blocked })}
      >
        Release
      </Button>
    );
  }

  return (
    <Menu
      label={`Release ${claim.workItemId}`}
      items={[
        { id: "release", label: `Release ${claim.workItemId}`, hint: releaseConsequence(claim) },
        { id: "keep", label: "Keep the claim" },
      ]}
      onChoose={(item) => {
        if (item.id === "release") onRelease();
      }}
      triggerClassName={`orca-btn orca-btn--danger orca-btn--sm orca-agents__claim-release ${textClass("caption")}`}
    >
      Release
    </Menu>
  );
}

/**
 * The two palette-only commands this surface owns (#176, #178).
 *
 * Keyless on purpose (#205): the design's keyboard table is short, and neither "edit this
 * agent's permissions" nor "release this claim" is worth one of the letters left — but both
 * are worth doing, so they register with no key and the palette becomes the way to them.
 * They are registered per *object*, one row per agent and one per releasable claim, because
 * "actions on the current object" is what the palette's first section means and a single
 * "Release claim" row would have to ask which one afterwards.
 *
 * A claim the daemon would refuse gets no row: the palette lists commands that do something.
 */
function usePaletteActions(
  agents: readonly { id: string }[] | undefined,
  claims: readonly ClaimView[],
  canRelease: boolean,
  onEditPermissions: (agentId: string) => void,
  onRelease: (workItemId: string) => void,
): void {
  const keyboard = useKeyboard();
  /* The lists themselves, and not one string the effects split back apart. Joining ids on a
     separator only holds while no id can contain it — the separator here had to be a NUL
     byte to be sure of that — and the round trip was only ever there to keep the effects
     from re-registering on every re-read. `useIds` does that directly: it hands back the
     same array while the ids in it are the same ones. */
  const agentIds = useIds(useMemo(() => (agents ?? []).map((agent) => agent.id), [agents]));
  const claimIds = useIds(
    useMemo(() => claims.filter((claim) => claim.owner.releasable).map((claim) => claim.workItemId), [claims]),
  );

  useEffect(() => {
    const off = agentIds.map((id) =>
      keyboard.register({
        scope: "card",
        label: `Edit permissions for ${id}`,
        detail: "Opens the agent's permission policy, with its written grants editable",
        action: () => onEditPermissions(id),
      }),
    );
    return () => off.forEach((unregister) => unregister());
  }, [agentIds, keyboard, onEditPermissions]);

  useEffect(() => {
    if (!canRelease) return;
    const off = claimIds.map((workItemId) =>
      keyboard.register({
        scope: "card",
        label: `Release claim on ${workItemId}`,
        detail: "Takes the work item back from the run holding it; the item goes back to the scheduler",
        action: () => onRelease(workItemId),
      }),
    );
    return () => off.forEach((unregister) => unregister());
  }, [claimIds, keyboard, onRelease, canRelease]);
}

/**
 * The same array back while it holds the same ids, so an effect keyed on it does not
 * re-register a palette row every time the list is re-read.
 *
 * A push rebuilds the agents and the claims — that is what `agent.changed` is for — and the
 * rebuilt arrays are new objects holding the same strings. The commands over them only
 * change when the *ids* do, which is the comparison this makes.
 */
function useIds(ids: readonly string[]): readonly string[] {
  const held = useRef<readonly string[]>(ids);
  if (held.current.length !== ids.length || ids.some((id, at) => held.current[at] !== id)) held.current = ids;
  return held.current;
}
