/**
 * The window chrome: title bar, sidebar, primary pane, docked panel, status bar and the
 * command palette, per docs/design/10-information-architecture.md. Routing here is which
 * of the surfaces (`chrome/surfaces.ts`, from `semantics.json`'s `surface` map) is
 * active, and what a deep link or the palette asked each one to show.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Announcer } from "./a11y/announcer.js";
import { SURFACES, type SurfaceId } from "./chrome/surfaces.js";
import { Sidebar } from "./chrome/sidebar.js";
import { TitleBar } from "./chrome/title-bar.js";
import { StatusBar } from "./chrome/status-bar.js";
import { PrimaryPane } from "./chrome/primary-pane.js";
import { PaneSplitter } from "./chrome/pane-splitter.js";
import { DockedPanel } from "./chrome/docked-panel.js";
import { useConnection } from "./chrome/use-connection.js";
import { ConnectionBanner, MismatchDialog } from "./chrome/connection-banner.js";
import { useSidebarCollapsed, usePanelOverlay } from "./chrome/use-breakpoints.js";
import { useChromeShortcuts } from "./chrome/use-chrome-shortcuts.js";
import { useEscapeClosesTopLayer, useTransientLayer } from "./layers-context.js";
import { ArtifactPanelProvider } from "./artifacts/panel-context.js";
import { CommandPalette } from "./palette/command-palette.js";
import { useCommandPalette } from "./palette/use-command-palette.js";
import { RunsSurface } from "./runs/runs-surface.js";
import { AgentsSurface } from "./agents/agents-surface.js";
import { MachinesSurface } from "./machines/machines-surface.js";
import { ConfigProvider } from "./config/config-context.js";
import { ConfigSurface } from "./config/config-surface.js";
import { AttentionSurface } from "./attention/attention-surface.js";
import { WorkflowSurface } from "./workflow/workflow-surface.js";
import { WorkflowsSurface } from "./workflow/workflows-surface.js";
import { PlanSurface, type PlanHeader, type PlanPanel } from "./plan/index.js";
import { useAttention } from "./attention/use-attention.js";
import { InlineAsksProvider } from "./attention/inline-asks.js";
import { useAlertActivation } from "./attention/use-alert-activation.js";
import type { AlertActivation } from "../../src/bridge.js";
import { PaletteObjectSources } from "./palette/object-sources.js";
import { GuidedLaunchProvider } from "./guided-launch/launch-context.js";
import { GuidedLaunchRoute } from "./guided-launch/launch-route.js";
import { PaletteGuidedLaunch } from "./guided-launch/palette-launch.js";
import { PaletteStartRun } from "./palette/start-run.js";
import {
  describeRoute,
  configUrl,
  launchUrl,
  gateUrl,
  resolveRoute,
  runUrl,
  urlForCrumb,
  counterpartUrl,
  type Route,
} from "./route-table.js";
import { Button, ObjectHeader, ObjectId, StateView, Text, textClass, type Crumb } from "./ui/index.js";

// Attention is always first: the app's default landing surface (docs/design/10-information-architecture.md).
// The data-driven half of the landing rule — Attention showing running runs when nothing is
// waiting — is still not built: the surface says nothing needs you rather than filling the
// space with runs nobody has to look at.
const DEFAULT_SURFACE: SurfaceId = "attention";

/** One empty trail, so a surface with no object does not remount the header every render. */
const NO_CRUMBS: readonly Crumb[] = [];

export function App(): JSX.Element {
  const [active, setActive] = useState<SurfaceId>(DEFAULT_SURFACE);
  /* Where a URL led. The route table resolves every `orca://` URL — a cold start's, an
     `open-url`, a second launch's, and the palette's jump row — and this is the one place
     the answer is held, so all four select the same object (#165). */
  const [route, setRoute] = useState<Route | undefined>(undefined);
  // A route object represents one explicit navigation, including repeated identical URLs.
  // Chrome renders must not create another request and reclaim the reader's selection.
  const openRunRoute = useMemo(
    () =>
      route?.kind === "run"
        ? {
            runId: route.runId,
            ...(route.step ? { nodeId: route.step.nodeId } : {}),
            ...(route.step?.attempt ? { attempt: route.step.attempt } : {}),
          }
        : route?.kind === "artifact" && route.runId
          ? { runId: route.runId }
          : undefined,
    [route],
  );
  /* What a link could not do, said out loud rather than dropped — see `LinkNotice`. Held
     apart from `route`: dismissing the sentence is not leaving the place it was about, and
     on Workflows the route is what puts the viewer on screen rather than the list. */
  const [notice, setNotice] = useState<LinkProblem | undefined>(undefined);
  const [panelOpen, setPanelOpen] = useState(false);
  /* The object header is the chrome's, on every screen that has an object
     (docs/design/10-information-architecture.md): one breadcrumb in the app, drawn in one
     place. A surface hands up the crumbs for whatever it has selected and the chrome draws
     them into `PrimaryPane`'s header slot — Runs is the first surface with an object to put
     there. */
  /* …and the controls for it: the workflow viewer's version text, its `◷ pinned` chip and
     its overlay picker are the header's actions (#177).

     The surface that reported them is held with them, and the header is drawn only while
     that is the surface on screen. Clearing on the way to a new surface does not work and
     the reason is React's: a surface reports from an effect, and a child's effects run
     before its parent's — so a `setCrumbs([])` in the navigation would run *after* the
     surface it was switching to had already said what it had, and throw it away. */
  const [header, setHeader] = useState<{
    surface: SurfaceId;
    crumbs: readonly Crumb[];
    actions: ReactNode;
    /* Plan's segmented mode control (#170): a variant of the header rather than a control
       in the surface, because a mode switch keeps the object and the header is what says
       which object is on screen. */
    mode?: PlanHeader["mode"];
  }>({
    surface: DEFAULT_SURFACE,
    crumbs: [],
    actions: null,
  });
  const crumbs = header.surface === active ? header.crumbs : NO_CRUMBS;
  const setCrumbs = useCallback(
    (next: readonly Crumb[]) => setHeader({ surface: "runs", crumbs: next, actions: null }),
    [],
  );
  const onWorkflowHeader = useCallback(
    (reported: { crumbs: readonly Crumb[]; actions: ReactNode }) =>
      setHeader({ surface: "workflows", crumbs: reported.crumbs, actions: reported.actions }),
    [],
  );
  const onPlanHeader = useCallback(
    (reported: PlanHeader) =>
      setHeader({ surface: "plan", crumbs: reported.crumbs, actions: reported.actions, mode: reported.mode }),
    [],
  );
  /* What Plan has put in the dock. Held here because the docked panel is above every
     surface, exactly as the artifact it otherwise shows is. */
  const [planInspector, setPlanInspector] = useState<PlanPanel | null>(null);
  /* Selecting a row opens the inspector, which means opening the dock it is drawn in —
     the same act the artifact panel's `onOpen` performs for a chip on a step. Closing it
     again is `⌘\`; selecting another row opens it once more, because that press is a
     person asking to see what the row waits for.

     A *selection* is what opens it, never a change of content. The inspector re-renders
     when the dependencies and risks behind it land, a tick after the click, and when a
     `plan.changed` frame moves them again later — and a dock that reopened on each of
     those would take back the `⌘\` a person had just pressed. The surface says which kind
     of report this is; the dock only has to believe it.

     The panel names itself: a work item, a risk (#172), a decision (#173) or a relationship
     (#171) — the dock's head says which rather than calling everything a work item. */
  const showInspector = useCallback((content: PlanPanel | null, options: { open: boolean }) => {
    setPlanInspector(content);
    if (content !== null && options.open) setPanelOpen(true);
  }, []);

  const connection = useConnection();
  /* Read by `navigate` when a link arrives, without making the opener a new function on
     every connection change: whether a daemon was answering *then* is what the landing says. */
  const live = useRef(connection.state === "live");
  live.current = connection.state === "live";
  /* A link that landed with no daemon answering stops being a problem once one answers: the
     surface it landed on reads the object then, and the sentence would be out of date. */
  useEffect(() => {
    if (connection.state === "live") setNotice((current) => (current?.kind === "offline" ? undefined : current));
  }, [connection.state]);
  /* What needs a person, read *here* rather than inside the Attention surface, because the
     title bar and the sidebar carry the same number and it is only one number
     (docs/design/20-attention-and-gates.md). A count hook of its own beside the surface's
     own read would be a second answer to one question, and the two would differ by exactly
     one for as long as a push took to reach both. It is also what keeps the count live on
     every screen: the chrome is mounted whichever surface is showing. */
  const attention = useAttention();
  // Zero until the daemon has answered, which both bars render as nothing at all: a count
  // is a fact and there is not one yet.
  const waitingCount = attention.state.phase === "ready" ? attention.state.waiting : 0;
  const sidebarCollapsed = useSidebarCollapsed();
  const panelOverlay = usePanelOverlay();

  /* The Workflows nav item means the list: arriving there by the rail leaves whichever
     workflow a link last opened, rather than reopening it (#181). Every other surface keeps
     its route, as it always has. */
  const selectSurface = useCallback((id: SurfaceId) => {
    setActive(id);
    if (id === "workflows") setRoute((current) => (current?.kind === "workflow" ? undefined : current));
  }, []);

  /**
   * Open an `orca://` URL. The surface is selected first and always — including for
   * `orca://item/…` and `orca://workflow/…`, whose surfaces do not exist until v0.5.0 and
   * v0.6.0, because landing on an unbuilt surface with the id in hand is honest and
   * dropping the link is not (docs/design/10-information-architecture.md).
   *
   * A link that worked says nothing: the object header names what is open, and a bar
   * repeating it on every row clicked, crumb followed and palette jump was an alert with
   * nothing to report. A link that did not work says why.
   */
  const navigate = useCallback((url: string) => {
    const next = resolveRoute(url);
    if (!next) {
      setNotice({ kind: "unresolved", url });
      return;
    }
    setRoute(next);
    setActive(next.surface);
    setNotice(live.current ? undefined : { kind: "offline", ...describeRoute(next) });
  }, []);

  const closeLaunch = useCallback(() => {
    setRoute(undefined);
    setNotice(undefined);
    setActive("config");
  }, []);

  /* Plan is the one surface that reports a link's object is not there (#170): a work item
     the plan does not hold. The others do not say so yet (docs/reviews/2026-10-10-design-conformance.md). */
  const onPlanMissing = useCallback((id: string) => setNotice({ kind: "missing", type: "work item", id }), []);

  /* Held rather than written inline: Plan memoises its inspector on the callbacks it was
     handed, and a fresh arrow on every render of the chrome would be a fresh inspector on
     every render, which is a fresh `onInspector` call, which is another render. */
  const openRun = useCallback((runId: string) => navigate(runUrl(runId)), [navigate]);

  useDeepLinks(navigate);
  const togglePanel = useCallback(() => setPanelOpen((open) => !open), []);

  useChromeShortcuts({ onSurface: selectSurface, onTogglePanel: togglePanel });
  /* A notification was clicked, or a permission ask took the attention of a window that
     already had focus. The activation carries the alert it was about, so it goes through the
     same route table every other arrival does (#165): a waiting ask lands on its card, a
     failure lands on its run, and an alert whose item has since been answered lands on the
     surface, which is all that is left to say about it. */
  useAlertActivation(
    useCallback(
      (activation: AlertActivation) => {
        const item = activation.item;
        // An alert from a machine that is not focused cannot open a route here: every route
        // reads the focused daemon. Machines is where that machine's work is (#882).
        if (item?.machine && !item.machine.focused) selectSurface("machines");
        else if (item?.inputId) navigate(gateUrl(item.inputId));
        else if (item?.runId) navigate(runUrl(item.runId));
        else selectSurface("attention");
      },
      [navigate, selectSurface],
    ),
  );
  useEscapeClosesTopLayer();
  const palette = useCommandPalette();

  const activeSurface = SURFACES.find((s) => s.id === active) ?? SURFACES[0]!;
  const gridPanel = panelOpen && !panelOverlay;
  const bodyClassName = gridPanel ? "orca-body orca-body--panel" : "orca-body";

  /* Only the overlaid panel is transient: as a grid column it is part of the layout, and
     Esc must not close what a person put there to read alongside the pane. */
  useTransientLayer(panelOpen && panelOverlay, { name: "docked-panel", close: togglePanel });

  /* Bound rather than returned, and then wrapped at the bottom of this function: the
     provider is a wrap, and re-indenting the whole tree to nest it would make every line
     of the chrome a line this change touched. */
  const chrome = (
    <div className="orca-window">
      <TitleBar
        platform={window.orca.platform}
        waitingCount={waitingCount}
        onOpenAttention={() => selectSurface("attention")}
        onOpenPalette={palette.openPalette}
      />
      <div
        className={bodyClassName}
        data-sidebar={sidebarCollapsed ? "collapsed" : undefined}
        data-panel={panelOpen && panelOverlay ? "overlay" : undefined}
      >
        <Sidebar active={active} onSelect={selectSurface} waitingCount={waitingCount} />
        {/* The first of the app's pane boundaries (#276), and a grid item between the two it
            separates. Not rendered below `bp-sidebar-collapse`: there the rail is icons and its
            width is the breakpoint's, so a boundary offered there would be a control fighting a
            layout rule. */}
        {!sidebarCollapsed && <PaneSplitter boundary="sidebar" label="Resize the sidebar" />}
        {/* Keyed by surface: a switch mounts a new pane, which is what re-applies that
            surface's remembered density. */}
        <PrimaryPane
          key={activeSurface.id}
          surface={activeSurface.id}
          header={
            crumbs.length > 0 ? (
              /* Both openers go through the route table rather than through a second
                 navigation path: a crumb, a counterpart, a palette row and a pasted URL
                 are four ways of naming the same object and there is one resolver (#165).
                 A crumb with no canonical URL opens nothing, which is what `urlForCrumb`
                 answering undefined means. */
              <ObjectHeader
                crumbs={crumbs}
                {...(header.surface === active && header.mode ? { mode: header.mode } : {})}
                actions={header.actions}
                onOpen={(crumb) => {
                  const url = urlForCrumb(crumbs, crumb);
                  if (url) navigate(url);
                }}
                onOpenCounterpart={(crumb, counterpart) => {
                  const url = counterpartUrl(crumbs, crumb, counterpart);
                  /* Three of the four counterparts are queries over data the header does
                     not hold, and the surfaces that answer them are v0.5.0's. Saying so is
                     what a person gets instead of a menu item that did nothing. */
                  if (url) navigate(url);
                  else
                    setNotice({
                      kind: "unavailable",
                      text: `${counterpart.label} is not something this app can open yet.`,
                    });
                }}
              />
            ) : undefined
          }
          notices={
            <>
              {/* Drawn by the chrome, once, under whichever header is showing: the state is
                  one state (#163), and the bar that says the data is last-known goes where
                  docs/design/40 puts it. The five seconds of silence in front of it are the
                  main process's. */}
              <ConnectionBanner connection={connection} />
              {/* What a link could not do. One that worked says nothing; one to an object the
                  daemon cannot currently produce "lands on the object's screen in its
                  disconnected state with the id shown, never on a blank window or a generic
                  error". */}
              <LinkNotice problem={notice} onDismiss={() => setNotice(undefined)} />
            </>
          }
        >
          {activeSurface.id === "attention" ? (
            /* `onOpenRun` is `G` and a card's run name, and it goes through the route table
               the rest of the app arrives by. It is a prop rather than a call into the router
               because the card registers `G` only when there is somewhere for it to go. */
            <AttentionSurface
              connection={connection.state}
              feed={attention}
              onOpenRun={(runId) => navigate(runUrl(runId))}
            />
          ) : activeSurface.id === "runs" ? (
            /* A `run` route selects the row; an `artifact` route names the run that
               produced it, which is the run to land on while the panel opens over it. */
            <RunsSurface connection={connection.state} onCrumbs={setCrumbs} open={openRunRoute} onOpen={navigate} />
          ) : activeSurface.id === "plan" ? (
            /* `orca://item/<slug-or-id>` lands here with the item selected and its
               explanation open, which is the information architecture's promise for that
               URL and was the one line in it that named an unbuilt surface. */
            <PlanSurface
              connection={connection.state}
              capabilities={connection.capabilities}
              open={route?.kind === "item" ? route.itemId : undefined}
              focus={route?.kind === "plan" ? { mode: route.mode, id: route.focus } : undefined}
              onHeader={onPlanHeader}
              onInspector={showInspector}
              onOpenRun={openRun}
              onMissing={onPlanMissing}
            />
          ) : activeSurface.id === "agents" ? (
            /* `onOpen` is the route table's, as everywhere else: the policy panel's link to
               the Config form is a link to another object and there is one resolver (#165). */
            <AgentsSurface connection={connection.state} onOpen={navigate} />
          ) : activeSurface.id === "workflows" ? (
            /* Workflows has its own place in the rail since the editor (#181): with no
               workflow named it is the list of them, and `orca://workflow/…` - a link, the
               run header's "the workflow it executes", the palette, a row of the list - is
               the viewer, or the editor with `?edit`. Keyed by the workflow, so following a
               link from one workflow to another starts the viewer afresh. */
            route?.kind === "workflow" ? (
              <WorkflowSurface
                key={route.workflowId}
                workflowId={route.workflowId}
                runId={route.runId}
                {...(route.edit ? { edit: true } : {})}
                connection={connection.state}
                onHeader={onWorkflowHeader}
              />
            ) : (
              <WorkflowsSurface connection={connection.state} onOpen={navigate} onHeader={onWorkflowHeader} />
            )
          ) : activeSurface.id === "config" ? (
            /* Its own header rather than the chrome's: the two documents Config shows are
               its objects, and the segmented control that switches between the form and the
               raw text is an action on the one in view (#175). A workflow route lands on the
               Workflows surface above (#177, #181) rather than on a config document. */
            <ConfigSurface
              connection={connection.state}
              {...(window.orca.guidedLaunch ? { onLaunch: () => navigate(launchUrl()) } : {})}
              {...(route?.kind === "launch"
                ? { launch: <GuidedLaunchRoute onConfiguration={() => navigate(configUrl())} onClose={closeLaunch} /> }
                : {})}
              {...(route?.kind === "config" ? { open: route.document } : {})}
            />
          ) : activeSurface.id === "machines" ? (
            /* Every daemon at once (#882). Only the focused one's objects open, through the
               same route table as everywhere else; the rest are read-only rows. */
            <MachinesSurface
              onOpenRun={(runId) => navigate(runUrl(runId))}
              onOpenInput={(inputId) => navigate(gateUrl(inputId))}
            />
          ) : (
            <StateView kind="empty" title={activeSurface.label} body="This surface has not been built yet." />
          )}
        </PrimaryPane>
        {/* The dock's boundary, and only while the dock is a grid column: an overlaid panel is
            the layout a narrow window falls back to, and it floats over the pane rather than
            trading width with it, so there is nothing there to drag (#276). */}
        {gridPanel && <PaneSplitter boundary="panel" label="Resize the panel" />}
        {panelOpen ? (
          <DockedPanel
            onClose={togglePanel}
            content={active === "plan" && planInspector !== null ? planInspector : undefined}
          />
        ) : null}
      </div>
      <StatusBar connection={connection} />
      {/* The app's one polite live region (#167). Here, and only here: a region per surface
          would announce the same failure twice whenever two of them were mounted, and the
          chrome is the only thing mounted on every screen. It says step transitions and
          terminal states; streaming output is never announced (rule 11). */}
      <Announcer />
      {/* The palette's object rows: recent runs, agents, and search over what the daemon
          can be asked for. Registered here rather than inside a surface because they are
          reads of the store rather than views of a surface's state (#206). */}
      <PaletteObjectSources onOpen={navigate} />
      {/* And the one write that belongs to no surface: start a run of any registered
          workflow, from wherever a person is standing (#178). */}
      {window.orca.guidedLaunch && <PaletteGuidedLaunch onOpen={navigate} />}
      <PaletteStartRun onOpen={navigate} />
      {/* Last, so it is over the panel in paint order as well as in z-index. */}
      <CommandPalette controller={palette} onJump={(target) => navigate(target.url)} />
      {/* Blocking, once per detection, and last of all: a version mismatch is the one
          connection state that stops a person before they read anything. */}
      <MismatchDialog connection={connection} />
    </div>
  );

  /* Two wraps, for the same reason: both are held above every surface because more than one
     surface reaches them. The docked panel's artifact, so that a chip on a step, a gate card
     and an `orca://artifact/spec.md@v3` deep link can all put one there — opening the panel
     itself stays the chrome's, which is what `onOpen` hands over. And the waiting feed, so
     that a step parked on a gate renders the *same* card the Attention list does without a
     second `inputs.list` and a second opinion about the one count (#161). */
  /* And a third, for a reason of its own: the configuration draft. `ConfigSurface` is
     unmounted by the surface switch above like every other screen, and a draft that
     disappeared because somebody looked at a run would be the app throwing away what a
     person typed. It is held here, outside the switch, and both of its consumers — the
     Config surface and the Agents surface's policy panel — read the one model
     (`config/config-context.tsx`). */
  return (
    <ArtifactPanelProvider onOpen={() => setPanelOpen(true)}>
      <ConfigProvider>
        <GuidedLaunchProvider active={active === "config" && route?.kind === "launch"} onOpen={navigate}>
          <InlineAsksProvider feed={attention}>{chrome}</InlineAsksProvider>
        </GuidedLaunchProvider>
      </ConfigProvider>
    </ArtifactPanelProvider>
  );
}

/**
 * Every `orca://` URL the main process has for this window: the one it was opened for, then
 * every one that arrives while it is open.
 *
 * The cold-start URL is *taken* rather than read, and taken before subscribing, for the
 * same reason the connection snapshot is read before subscribing: a link is delivered once,
 * so a reload must not replay it and drag a person back to a place they have left.
 */
function useDeepLinks(navigate: (url: string) => void): void {
  useEffect(() => {
    const waiting = window.orca.deepLink.take();
    if (waiting !== undefined) navigate(waiting);
    return window.orca.deepLink.subscribe(navigate);
  }, [navigate]);
}

/** Something a link could not do. A link that worked is not one of these, and says nothing. */
type LinkProblem =
  /** A URL this version does not understand. */
  | { kind: "unresolved"; url: string }
  /** A counterpart the app cannot follow yet, in words. */
  | { kind: "unavailable"; text: string }
  /** A URL that arrived while no daemon was answering. */
  | { kind: "offline"; type: string; id: string }
  /** A URL whose surface says the object is not there. */
  | { kind: "missing"; type: string; id: string };

/**
 * What a link that could not be honoured says about itself.
 *
 * Four cases and each one is a different sentence, because "nothing happened" is the
 * failure this component exists to prevent:
 *
 * - a counterpart the app cannot follow yet — say which, rather than swallow the click;
 * - a URL this version does not understand — say the URL, because a newer app may know it;
 * - a URL that arrived while no daemon is answering — the disconnected landing, naming the
 *   object it is holding, which is the information architecture's rule;
 * - a URL to an object the surface does not have — name the id it was holding, because "a
 *   link is never dropped and never answered with something that was not asked for".
 *
 * A link that resolved used to say "Opened …" too, on every row, crumb and palette jump. The
 * object header already names what is open, so that was a bar with nothing to report, drawn
 * in the stale banner's colours.
 *
 * Only the disconnected landing is drawn as stale, because it is the one that is about the
 * data. The other three are about the link, and are the plain banner.
 */
function LinkNotice({
  problem,
  onDismiss,
}: {
  problem: LinkProblem | undefined;
  onDismiss: () => void;
}): JSX.Element | null {
  if (problem === undefined) return null;
  switch (problem.kind) {
    case "unavailable":
      return (
        <Landing onDismiss={onDismiss}>
          <Text style="caption">{problem.text}</Text>
        </Landing>
      );
    case "unresolved":
      return (
        <Landing onDismiss={onDismiss}>
          <Text style="caption">This app does not know how to open</Text>
          <span className={`orca-mono ${textClass("mono-id")}`}>{problem.url}</span>
        </Landing>
      );
    case "missing":
      return (
        <Landing onDismiss={onDismiss}>
          <Text style="caption">{`No ${problem.type} here matches`}</Text>
          {/* The id the link named, whole: it is what a person compares against the one they
              meant, so it is never cut to a token here. */}
          <ObjectId id={problem.id} variant="full" />
        </Landing>
      );
    case "offline":
      return (
        <Landing stale onDismiss={onDismiss}>
          <Text style="caption">{`No daemon is answering, so this ${problem.type} cannot be read:`}</Text>
          <ObjectId id={problem.id} variant="full" />
        </Landing>
      );
  }
}

/**
 * The bar itself: one weight, one dismissal. Dismissing it hides the sentence and nothing
 * else — the surface the link landed on stays where it is.
 */
function Landing({
  children,
  stale = false,
  onDismiss,
}: {
  children: ReactNode;
  stale?: boolean;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className={`orca-banner ${textClass("caption")}${stale ? " orca-banner--stale" : ""}`} role="status">
      {children}
      <span className="orca-spacer" />
      <Button size="sm" tone="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
