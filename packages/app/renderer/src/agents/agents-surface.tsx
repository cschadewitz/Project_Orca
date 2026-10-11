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
import {
  Button,
  MachineText,
  ObjectId,
  StateView,
  StatusChip,
  Text,
  Time,
  textClass,
  useIdTails,
} from "../ui/index.js";
import { AgentCard } from "./agent-card.js";
import {
  claimSubject,
  countLabel,
  focusAfterLeaving,
  groupByHost,
  phraseText,
  releaseCommand,
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
 *
 * **Where focus goes when a row leaves is decided here too**, because only the list knows
 * which rows are left. A release the daemon took is followed by the re-read, the claim is not
 * in it, and the row unmounts with the busy Release that Confirm handed focus to — which
 * drops a keyboard user on the page body, with no way back to where they were. So the row
 * reports, on its way out, that it was holding focus (`ClaimRow`), and the list puts focus on
 * the Release of the row that took its place: the next one, or the one before it when it was
 * the last (`focusAfterLeaving`), or the section itself when the list is now empty. A row that
 * leaves *without* focus reports nothing — a person who moved on while the release was in
 * flight keeps focus wherever they took it — and a refused release leaves its row in the
 * list, so focus simply stays on that row's Release.
 *
 * **And the result moves up to the section.** With its row gone, a release's result is the
 * section's caption line, under the heading, until the next release says something else. It
 * is said in the app's one live region whether or not the row survives (`use-agents.ts`); the
 * line is for reading, not for hearing a second time.
 */
function Claims({ claims, asOf, live, feed, canRelease }: ClaimsProps): JSX.Element {
  const [armed, setArmed] = useState<string | undefined>(undefined);
  /* Every work item and run the list names, so no two rows show one token (`useIdTails`). */
  const tailOf = useIdTails(useMemo(() => claims.flatMap((claim) => [claim.workItemId, claim.owner.runId]), [claims]));
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

  const section = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const keys = useMemo(() => claims.map(claimKey), [claims]);
  /* The rows as the last commit drew them, and the one that left it holding focus — written
     by the row's own unmount, in the same commit as the effect below that reads it. */
  const drawn = useRef(keys);
  const leftHoldingFocus = useRef<string | undefined>(undefined);
  const onLeaveHoldingFocus = useCallback((key: string) => {
    leftHoldingFocus.current = key;
  }, []);

  /* Layout, not passive: the row has just gone and focus is on the body, and moving it in the
     same frame means there is never a painted moment, or a keystroke, with it there. */
  useLayoutEffect(() => {
    const before = drawn.current;
    drawn.current = keys;
    const gone = leftHoldingFocus.current;
    leftHoldingFocus.current = undefined;
    if (gone === undefined || keys.includes(gone)) return;
    // Something in this same commit has already put focus somewhere: it is not lost.
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const at = focusAfterLeaving(before, keys, gone);
    const release =
      at === undefined
        ? null
        : (list.current?.children[at]?.querySelector<HTMLElement>("[data-release-trigger]") ?? null);
    (release ?? section.current)?.focus();
  }, [keys]);

  /* Only once its row has left: while the row is still there the result is on the row, which
     is where a refusal — a release that leaves its row in place — always stays. */
  const report = feed.release;
  const orphaned =
    report !== undefined && !claims.some((claim) => claim.workItemId === report.workItemId) ? report : undefined;

  return (
    /* Focusable from script and never a `Tab` stop: it is where focus goes when the last row
       leaves, so a person lands on the heading of the list they were in and on the line saying
       it is now empty. */
    <section ref={section} className="orca-agents__claims" aria-label="Claimed work" tabIndex={-1}>
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
      {orphaned !== undefined && (
        /* Not a live region: `use-agents.ts` has already said it into the app's one announcer.
           Its own line rather than a clause in the "as of" caption beside the heading, which
           is one line and does not wrap — and the daemon's note is a sentence whose second
           half is the useful half. It names its work item, so it reads without the row. */
        <Text
          style="caption"
          className={`orca-agents__claims-note${orphaned.failed ? " orca-agents__claims-note--failed" : ""}`}
        >
          {orphaned.message}
        </Text>
      )}
      {claims.length === 0 ? (
        <Text style="caption" className="orca-agents__none">
          Nothing is claimed right now.
        </Text>
      ) : (
        <ul ref={list} className="orca-agents__claim-list">
          {claims.map((claim) => (
            <ClaimRow
              key={claimKey(claim)}
              claim={claim}
              tailOf={tailOf}
              live={live}
              feed={feed}
              canRelease={canRelease}
              armed={armed === claim.workItemId}
              onArm={setArmed}
              onDisarm={disarm}
              onLeaveHoldingFocus={onLeaveHoldingFocus}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A row's identity in the list: the work item and the run holding it, because the same item
 * claimed again by another run is another row. It is the React key, and the name the focus
 * bookkeeping in `Claims` uses, so the two cannot disagree about which row left.
 */
function claimKey(claim: ClaimView): string {
  return `${claim.workItemId}:${claim.owner.runId}`;
}

interface ClaimRowProps {
  claim: ClaimView;
  /** The tail each id is drawn with, decided over the whole list. */
  tailOf: (id: string) => string;
  live: boolean;
  feed: AgentsFeed;
  canRelease: boolean;
  /** This row is the one asking "release this?" — at most one row in the list is. */
  armed: boolean;
  onArm: (workItemId: string) => void;
  onDisarm: (workItemId: string) => void;
  /** Said once, as the row unmounts, if focus was inside it: the list decides where it goes. */
  onLeaveHoldingFocus: (key: string) => void;
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
 *
 * **Leaving** — the claim gone from a re-read — the row says whether it was holding focus,
 * and `Claims` moves it to a row that is still there.
 */
function ClaimRow({
  claim,
  tailOf,
  live,
  feed,
  canRelease,
  armed,
  onArm,
  onDisarm,
  onLeaveHoldingFocus,
}: ClaimRowProps): JSX.Element {
  const id = claim.workItemId;
  const rowKey = claimKey(claim);
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

  /* The last moment the row can tell whether it holds focus. A layout effect's cleanup runs
     before React takes the row out of the document, so a focused Release is still in it here;
     a moment later focus is on the body, and a row that had it looks like one that never did.
     Nothing changes these two while the row is mounted — the key is the one React keys it by,
     the callback is stable — so this runs once, on the way out. */
  useLayoutEffect(() => {
    const element = row.current;
    return () => {
      if (element?.contains(document.activeElement)) onLeaveHoldingFocus(rowKey);
    };
  }, [rowKey, onLeaveHoldingFocus]);

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
      {/* The work item by the name a person knows it by, then its token — never a raw id
          column first: three items minted in one millisecond printed as three identical
          26-character heads. An item with no title is its token alone. */}
      <span className={`orca-agents__claim-title ${textClass("label")}`} title={claim.workItem?.title}>
        <ObjectId
          id={id}
          kind="workItem"
          tail={tailOf(id)}
          {...(claim.workItem?.title ? { name: claim.workItem.title } : {})}
        />
      </span>
      {/* `DisplayStatus` and the design's `RunStatus` are the same eight words, pinned
          against each other in packages/protocol/test — so no fold and no cast here.
          `aligned` makes the statuses one column down the list. */}
      <StatusChip status={claim.owner.status} aligned />
      {/* The run holding it, the same way: its name, then its token — runs of one workflow
          share a name, and the token is what tells them apart. */}
      <span className={`orca-agents__claim-run ${textClass("label")}`}>
        <ObjectId
          id={claim.owner.runId}
          kind="run"
          tail={tailOf(claim.owner.runId)}
          {...(claim.owner.name === undefined ? {} : { name: claim.owner.name })}
        />
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
            phrase.machine ? <MachineText key={at} text={phrase.text} /> : <Fragment key={at}>{phrase.text}</Fragment>,
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
 * (`plan/use-plan-writes.ts`), worded once by `releaseCommand`: the work item by its title
 * and its token (`labelMachine`, rule 8), never its raw id, and it is a destructive command,
 * so it sinks below the safe ones and the first `Enter` arms it rather than running it
 * (`tone`, `confirm`). It had neither, which made it the one destructive palette row that
 * could be the first row on screen and run on a single keystroke.
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
  /* The commands by their labels, which carry the title and the token: a title that changes
     re-registers its row, and a re-read that changes nothing re-registers none. */
  const releases = useMemo(() => claims.filter((claim) => claim.owner.releasable).map(releaseCommand), [claims]);
  const releaseLabels = useIds(useMemo(() => releases.map((command) => command.label), [releases]));
  const held = useRef(releases);
  held.current = releases;

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
    const off = held.current.map((command) =>
      keyboard.register({
        scope: "card",
        ...command,
        detail: "Takes the work item back from the run holding it; the item goes back to the scheduler",
        tone: "danger",
        action: () => onRelease(command.objectId),
      }),
    );
    return () => off.forEach((unregister) => unregister());
  }, [releaseLabels, keyboard, onRelease, canRelease]);
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
