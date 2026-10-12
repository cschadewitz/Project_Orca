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
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type JSX,
} from "react";
import { CHROME_GLYPHS, type ConnectionState } from "@orca/design";
import { CLAIMS_RELEASE_METHOD, type ClaimView } from "@orca/protocol";
import { useMethodPresent, useWritability } from "../chrome/use-connection.js";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import { useTransientLayer } from "../layers-context.js";
import { PolicyPanel } from "../config/policy-editor.js";
import { Button, StateView, StatusChip, Text, Time, textClass } from "../ui/index.js";
import { AgentCard } from "./agent-card.js";
import {
  claimSubject,
  countLabel,
  groupByHost,
  phraseText,
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
 *
 * **Which row is asking is held here rather than on the row**, because only one may ask at
 * a time: arming a second row has to disarm the first, and a flag per row could only do that
 * by every row watching every other. A claim that has left the list, or a list that has lost
 * its `claims.release`, has nothing armed.
 */
function Claims({ claims, asOf, live, feed, canRelease }: ClaimsProps): JSX.Element {
  const [armed, setArmed] = useState<string | undefined>(undefined);
  /* By id, and only if it is still the armed one: a row disarming itself must not disarm a
     different row that was armed in the same event — focus leaving row A *for* row B's
     Release is exactly that event. */
  const disarm = useCallback(
    (workItemId: string) => setArmed((current) => (current === workItemId ? undefined : current)),
    [],
  );

  useEffect(() => {
    if (armed === undefined) return;
    if (!canRelease || !claims.some((claim) => claim.workItemId === armed)) setArmed(undefined);
  }, [armed, canRelease, claims]);

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
            <ClaimRow
              key={`${claim.workItemId}:${claim.owner.runId}`}
              claim={claim}
              live={live}
              feed={feed}
              canRelease={canRelease}
              armed={armed === claim.workItemId}
              onArm={setArmed}
              onDisarm={disarm}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ClaimRowProps {
  claim: ClaimView;
  live: boolean;
  feed: AgentsFeed;
  canRelease: boolean;
  /** This row is the one asking "release this?" — at most one row in the list is. */
  armed: boolean;
  onArm: (workItemId: string) => void;
  onDisarm: (workItemId: string) => void;
}

/**
 * One claim, and its **Release**: a row with two states rather than a row with a popover.
 *
 * **At rest** the control is a quiet `Release` — the default tone, not the danger one,
 * because status colour is the only saturation a resting screen carries (the brand book) and
 * a red outline on every row says "something is wrong here" about rows where nothing is. A
 * claim the daemon will refuse has the same button disabled with the reason on it
 * (`releaseRefusal`): `owner.releasable` predicts the refusal exactly, and offering a
 * confirmation for a call that will fail is a worse lie than saying so up front. There is no
 * **Force release** here — see the file header.
 *
 * **Armed** — after `Release` is pressed — the row asks, in place, the way the palette's
 * destructive rows ask (docs/design/60-implementation.md): it takes the danger tone, the
 * control becomes **Keep** and **✕ Confirm release**, and the row grows into its declared
 * two-line variant to say what releasing does, under itself (`releaseConsequence`). Nothing
 * has been sent. Keep comes first and takes focus, so a second `Enter` keeps the claim; the
 * destructive choice is the one a person moved to and read, never the one they landed on
 * (docs/design/20-attention-and-gates.md: the destructive option is never focused by
 * default). Confirm leads with `✕` as well as the colour (rule 4), names the work item, and
 * is described by the consequence, so a screen reader hears the sentence a sighted person
 * reads.
 *
 * It replaced a confirmation `Menu`, which put the sentence in an item's eyebrow-styled
 * `hint` — uppercase and unwrapped, so a menu wider than the window — and focused the
 * destructive item first, so `Release` then `Enter` released. A popover over a list also
 * asks the question somewhere other than the row it is about.
 *
 * **Disarming** is every way out of the question: **Keep**, `Esc` (the row puts itself on
 * the transient layer stack while armed, so the one global `Esc` unwinds it like any other
 * transient thing), focus leaving the row, or another row being armed (`Claims`). The first
 * two hand focus back to `Release`; the last two leave it where the person put it.
 */
function ClaimRow({ claim, live, feed, canRelease, armed, onArm, onDisarm }: ClaimRowProps): JSX.Element {
  const id = claim.workItemId;
  const writability = useWritability();
  const refusal = releaseRefusal(claim);
  const blocked = refusal ?? (writability.can ? undefined : writability.reason);
  const busy = feed.releasing.has(id);
  /* Asking only while the answer could still be sent: a release already under way, a refusal
     that arrived with a re-read or a connection that went away takes the question with it. */
  const asking = canRelease && armed && blocked === undefined && !busy;
  const note = feed.release?.workItemId === id ? feed.release : undefined;
  const subject = claimSubject(claim);
  const consequence = releaseConsequence(claim);
  const consequenceId = useId();
  const row = useRef<HTMLLIElement>(null);

  /* Whether focus has landed in the armed controls yet. Until it has, a `focusout` from the
     row is the resting `Release` leaving the document as the row re-renders — which some
     engines report as focus leaving — and not the person moving away. */
  const settled = useRef(false);
  /* Set by the disarms that start inside the row — Keep, `Esc`, Confirm — which hand focus
     back to `Release` (now busy, after a Confirm). A disarm *caused* by focus leaving must
     not pull it back. */
  const restore = useRef(false);

  const disarm = (refocus: boolean): void => {
    restore.current = refocus;
    onDisarm(id);
  };

  useTransientLayer(asking, { name: "release-confirm", close: () => disarm(true) });

  // A question the row can no longer ask is withdrawn, not kept armed for when it can.
  useEffect(() => {
    if (armed && !asking) onDisarm(id);
  }, [armed, asking, id, onDisarm]);

  /* Layout, not passive: focus moves on the frame the controls change, so a fast second
     `Enter` lands on Keep rather than on a button that has already gone. */
  useLayoutEffect(() => {
    const element = row.current;
    if (asking) {
      element?.querySelector<HTMLElement>("[data-release-keep]")?.focus();
      settled.current = true;
      return;
    }
    settled.current = false;
    if (restore.current) {
      restore.current = false;
      element?.querySelector<HTMLElement>("[data-release-trigger]")?.focus();
    }
  }, [asking]);

  const onBlur = (event: ReactFocusEvent<HTMLLIElement>): void => {
    if (!asking || !settled.current) return;
    const next = event.relatedTarget;
    if (next !== null && event.currentTarget.contains(next)) return;
    // The window lost focus, not the row: the person comes back to the same question.
    if (next === null && !document.hasFocus()) return;
    disarm(false);
  };

  const confirm = (): void => {
    disarm(true);
    feed.releaseClaim(id);
  };

  const className = [
    "orca-agents__claim",
    /* The two-line variant only where there is a second line to draw — the consequence while
       the row asks, or a release's result after it — never a row that grew (rule 9). */
    asking || note !== undefined ? "orca-agents__claim--note" : "",
    asking ? "orca-agents__claim--armed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li className={className} ref={row} onBlur={onBlur}>
      <span className={`orca-id ${textClass("mono-id")}`}>{id}</span>
      <span className={`orca-agents__claim-title ${textClass("label")}`} title={claim.workItem?.title}>
        {claim.workItem?.title ?? ""}
      </span>
      {/* `DisplayStatus` and the design's `RunStatus` are the same eight words, pinned
          against each other in packages/protocol/test — so no fold and no cast here.
          `aligned` makes the statuses one column down the list. */}
      <StatusChip status={claim.owner.status} aligned />
      <span className={`orca-id ${textClass("mono-id")} orca-agents__claim-run`}>
        {claim.owner.name ?? claim.owner.runId}
      </span>
      <Time at={new Date(claim.claimedAt)} show={live ? "both" : "absolute"} />
      {canRelease &&
        (asking ? (
          /* A group named as the question, so a screen reader entering it on the way to
             Keep hears what is being asked and what it would do. */
          <span
            role="group"
            className="orca-agents__claim-ask"
            aria-label={`Release ${subject.text}?`}
            aria-describedby={consequenceId}
          >
            <Button size="sm" className="orca-agents__claim-keep" data-release-keep="" onClick={() => disarm(true)}>
              Keep
            </Button>
            <Button
              size="sm"
              tone="danger"
              className="orca-agents__claim-confirm"
              aria-label={`Confirm release of ${subject.text}`}
              aria-describedby={consequenceId}
              onClick={confirm}
            >
              {/* Decorative: the words say it, and colour is not the only channel. */}
              <span className="orca-agents__claim-glyph" aria-hidden="true">
                {CHROME_GLYPHS.danger}
              </span>
              Confirm release
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            className="orca-agents__claim-release"
            data-release-trigger=""
            /* Named by the work, not the id: ten rows of "Release" are ten identical
               controls, and the title is what a person knows the work by. */
            aria-label={`Release ${subject.text}`}
            disabled={blocked !== undefined || busy}
            {...(blocked === undefined ? {} : { disabledReason: blocked })}
            onClick={() => onArm(id)}
          >
            Release
          </Button>
        ))}
      {asking ? (
        <span
          id={consequenceId}
          className={`orca-agents__claim-note orca-agents__claim-consequence ${textClass("caption")}`}
          title={phraseText(consequence)}
        >
          {consequence.map((phrase, at) =>
            phrase.machine ? (
              <span key={at} className={`orca-mono ${textClass("mono-id")}`}>
                {phrase.text}
              </span>
            ) : (
              <Fragment key={at}>{phrase.text}</Fragment>
            ),
          )}
        </span>
      ) : (
        /* The result, on the row it was about. Not a live region — `use-agents.ts` already
           said it into the app's one announcer. */
        note !== undefined && (
          <span
            className={`orca-agents__claim-note ${textClass("caption")}${note.failed ? " orca-agents__claim-note--failed" : ""}`}
          >
            {note.message}
          </span>
        )
      )}
    </li>
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
 *
 * The release row is the Plan surface's release row in every respect but scope
 * (`plan/use-plan-writes.ts`): its id is drawn in mono (`labelMachine`, rule 8), and it is a
 * destructive command, so it sinks below the safe ones and the first `Enter` arms it rather
 * than running it (`tone`, `confirm`). It had neither, which made it the one destructive
 * palette row that could be the first row on screen and run on a single keystroke.
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
        labelMachine: workItemId,
        detail: "Takes the work item back from the run holding it; the item goes back to the scheduler",
        tone: "danger",
        confirm: `Release ${workItemId} — confirm`,
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
