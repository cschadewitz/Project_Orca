/**
 * The window chrome: title bar, sidebar, primary pane, docked panel, status bar and the
 * command palette, per docs/design/10-information-architecture.md. Routing here is which
 * of the five surfaces is active; Runs is the first one with real data behind it, and the
 * other four (and the per-surface object memory ⌘2 etc. should restore) arrive with the
 * issues that give each surface its content.
 */
import { useCallback, useEffect, useState, type JSX, type ReactNode } from "react";
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
import { ConfigProvider } from "./config/config-context.js";
import { ConfigSurface } from "./config/config-surface.js";
import { AttentionSurface } from "./attention/attention-surface.js";
import { WorkflowSurface } from "./workflow/workflow-surface.js";
import { PlanSurface, type PlanHeader, type PlanPanel } from "./plan/index.js";
import { useAttention } from "./attention/use-attention.js";
import { InlineAsksProvider } from "./attention/inline-asks.js";
import { useAlertActivation } from "./attention/use-alert-activation.js";
import type { AlertActivation } from "../../src/bridge.js";
import { PaletteObjectSources } from "./palette/object-sources.js";
import { PaletteStartRun } from "./palette/start-run.js";
import {
  describeRoute,
  gateUrl,
  resolveRoute,
  runUrl,
  urlForCrumb,
  counterpartUrl,
  type Route,
} from "./route-table.js";
import { Button, ObjectHeader, StateView, Text, textClass, type Crumb } from "./ui/index.js";

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
  /** A URL this version of the app does not understand; said out loud rather than dropped. */
  const [unresolved, setUnresolved] = useState<string | undefined>(undefined);
  /** A counterpart the app cannot follow yet, in words — see `DeepLinkLanding`. */
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined);
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
      setHeader({ surface: "config", crumbs: reported.crumbs, actions: reported.actions }),
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

  const selectSurface = useCallback((id: SurfaceId) => setActive(id), []);

  /**
   * Open an `orca://` URL. The surface is selected first and always — including for
   * `orca://item/…` and `orca://workflow/…`, whose surfaces do not exist until v0.5.0 and
   * v0.6.0, because landing on an unbuilt surface with the id in hand is honest and
   * dropping the link is not (docs/design/10-information-architecture.md).
   */
  const navigate = useCallback((url: string) => {
    const next = resolveRoute(url);
    if (!next) {
      setUnresolved(url);
      return;
    }
    setUnresolved(undefined);
    setUnavailable(undefined);
    setRoute(next);
    setActive(next.surface);
  }, []);

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
        if (item?.inputId) navigate(gateUrl(item.inputId));
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
      {/* Under the chrome and over every surface: the state is one state, so the bar that
          says the data is last-known is drawn once rather than by each screen (#163). The
          five seconds of silence in front of it are the main process's. */}
      <ConnectionBanner connection={connection} />
      {/* Where a link that arrived lands. A deep link to an object the daemon cannot
          currently produce "lands on the object's screen in its disconnected state with the
          id shown, never on a blank window or a generic error". */}
      <DeepLinkLanding
        route={route}
        unresolved={unresolved}
        unavailable={unavailable}
        live={connection.state === "live"}
        onDismiss={() => {
          setRoute(undefined);
          setUnresolved(undefined);
          setUnavailable(undefined);
        }}
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
                  else setUnavailable(`${counterpart.label} is not something this app can open yet.`);
                }}
              />
            ) : undefined
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
            <RunsSurface
              connection={connection.state}
              onCrumbs={setCrumbs}
              open={
                route?.kind === "run"
                  ? {
                      runId: route.runId,
                      ...(route.step ? { nodeId: route.step.nodeId } : {}),
                      ...(route.step?.attempt ? { attempt: route.step.attempt } : {}),
                    }
                  : route?.kind === "artifact" && route.runId
                    ? { runId: route.runId }
                    : undefined
              }
            />
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
            />
          ) : activeSurface.id === "agents" ? (
            /* `onOpen` is the route table's, as everywhere else: the policy panel's link to
               the Config form is a link to another object and there is one resolver (#165). */
            <AgentsSurface connection={connection.state} onOpen={navigate} />
          ) : activeSurface.id === "config" && route?.kind === "workflow" ? (
            /* The workflow viewer lands on Config, which is where the route table has always
               put `orca://workflow/…` — "how the system is wired, and what the workflows
               are" (docs/design/10-information-architecture.md). A person reaches a workflow
               by link, by the run header's "the workflow it executes", or from the palette;
               with no workflow named, Config shows its own two documents (#175). */
            <WorkflowSurface
              workflowId={route.workflowId}
              runId={route.runId}
              connection={connection.state}
              onHeader={onWorkflowHeader}
            />
          ) : activeSurface.id === "config" ? (
            /* Its own header rather than the chrome's: the two documents Config shows are
               its objects, and the segmented control that switches between the form and the
               raw text is an action on the one in view (#175). A workflow route lands on the
               viewer above (#177) rather than on a config document. */
            <ConfigSurface
              connection={connection.state}
              {...(route?.kind === "config" ? { open: route.document } : {})}
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
        <InlineAsksProvider feed={attention}>{chrome}</InlineAsksProvider>
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

interface DeepLinkLandingProps {
  route: Route | undefined;
  unresolved: string | undefined;
  unavailable: string | undefined;
  live: boolean;
  onDismiss: () => void;
}

/**
 * What a link that arrived says about itself.
 *
 * Three cases and each one is a different sentence, because "nothing happened" is the
 * failure this component exists to prevent:
 *
 * - a counterpart the app cannot follow yet — say which, rather than swallow the click;
 * - a URL this version does not understand — say the URL, because a newer app may know it;
 * - a URL that arrived while no daemon is answering — the disconnected landing, naming the
 *   object it is holding, which is the information architecture's rule;
 * - a URL that resolved — name what was opened, so a person who pasted a link can see the
 *   app agreed about which object they meant.
 */
function DeepLinkLanding({
  route,
  unresolved,
  unavailable,
  live,
  onDismiss,
}: DeepLinkLandingProps): JSX.Element | null {
  if (unavailable !== undefined) {
    return (
      <Landing onDismiss={onDismiss}>
        <Text style="caption">{unavailable}</Text>
      </Landing>
    );
  }
  if (unresolved !== undefined) {
    return (
      <Landing onDismiss={onDismiss}>
        <Text style="caption">This app does not know how to open</Text>
        <span className={`orca-mono ${textClass("mono-id")}`}>{unresolved}</span>
      </Landing>
    );
  }
  if (route === undefined) return null;
  const { type, id } = describeRoute(route);
  return (
    <Landing onDismiss={onDismiss}>
      <Text style="caption">{live ? `Opened ${type}` : `No daemon is answering, so this ${type} cannot be read:`}</Text>
      <span className={`orca-mono ${textClass("mono-id")}`}>{id}</span>
    </Landing>
  );
}

/** The bar itself: one weight, one dismissal, and never a live region — it is not urgent. */
function Landing({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }): JSX.Element {
  return (
    <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
      {children}
      <span className="orca-spacer" />
      <Button size="sm" tone="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
