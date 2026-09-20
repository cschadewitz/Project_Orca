/**
 * The window chrome: title bar, sidebar, primary pane, docked panel, status bar and the
 * command palette, per docs/design/10-information-architecture.md. Routing here is which
 * of the five surfaces is active; Runs is the first one with real data behind it, and the
 * other four (and the per-surface object memory ⌘2 etc. should restore) arrive with the
 * issues that give each surface its content.
 */
import { useCallback, useEffect, useState, type JSX, type ReactNode } from "react";
import { SURFACES, type SurfaceId } from "./chrome/surfaces.js";
import { Sidebar } from "./chrome/sidebar.js";
import { TitleBar } from "./chrome/title-bar.js";
import { StatusBar } from "./chrome/status-bar.js";
import { PrimaryPane } from "./chrome/primary-pane.js";
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
import { AttentionSurface } from "./attention/attention-surface.js";
import { useAttention } from "./attention/use-attention.js";
import { useAlertActivation } from "./attention/use-alert-activation.js";
import { PaletteObjectSources } from "./palette/object-sources.js";
import { describeRoute, resolveRoute, urlForCrumb, counterpartUrl, type Route } from "./route-table.js";
import { Button, ObjectHeader, StateView, Text, textClass, type Crumb } from "./ui/index.js";

// Attention is always first: the app's default landing surface (docs/design/10-information-architecture.md).
// The data-driven half of the landing rule — Attention showing running runs when nothing is
// waiting — is still not built: the surface says nothing needs you rather than filling the
// space with runs nobody has to look at.
const DEFAULT_SURFACE: SurfaceId = "attention";

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
  const [crumbs, setCrumbs] = useState<readonly Crumb[]>([]);

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

  useDeepLinks(navigate);
  const togglePanel = useCallback(() => setPanelOpen((open) => !open), []);

  useChromeShortcuts({ onSurface: selectSurface, onTogglePanel: togglePanel });
  /* A notification was clicked, or a permission ask took the attention of a window that
     already had focus: both mean "the thing that needs you is on Attention". The card's own
     deep link is #165's, and the activation already carries what a route would be built
     from (`use-alert-activation.ts`). */
  useAlertActivation(useCallback(() => selectSurface("attention"), [selectSurface]));
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
        {/* Keyed by surface: a switch mounts a new pane, which is what re-applies that
            surface's remembered density. */}
        <PrimaryPane
          key={activeSurface.id}
          surface={activeSurface.id}
          header={
            activeSurface.id === "runs" && crumbs.length > 0 ? (
              /* Both openers go through the route table rather than through a second
                 navigation path: a crumb, a counterpart, a palette row and a pasted URL
                 are four ways of naming the same object and there is one resolver (#165).
                 A crumb with no canonical URL opens nothing, which is what `urlForCrumb`
                 answering undefined means. */
              <ObjectHeader
                crumbs={crumbs}
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
            // `onOpenRun` is omitted until there is an `orca://` route table to open a run
            // into (#165), for the same reason `CommandPalette`'s `onJump` is: `G` on a card
            // is registered only when there is somewhere for it to go.
            <AttentionSurface connection={connection.state} feed={attention} />
          ) : activeSurface.id === "runs" ? (
            <RunsSurface connection={connection.state} onCrumbs={setCrumbs} />
          ) : activeSurface.id === "agents" ? (
            <AgentsSurface connection={connection.state} />
          ) : (
            <StateView kind="empty" title={activeSurface.label} body="This surface has not been built yet." />
          )}
        </PrimaryPane>
        {panelOpen ? <DockedPanel onClose={togglePanel} /> : null}
      </div>
      <StatusBar connection={connection} />
      {/* The palette's object rows: recent runs, agents, and search over what the daemon
          can be asked for. Registered here rather than inside a surface because they are
          reads of the store rather than views of a surface's state (#206). */}
      <PaletteObjectSources onOpen={navigate} />
      {/* Last, so it is over the panel in paint order as well as in z-index. */}
      <CommandPalette controller={palette} onJump={(target) => navigate(target.url)} />
      {/* Blocking, once per detection, and last of all: a version mismatch is the one
          connection state that stops a person before they read anything. */}
      <MismatchDialog connection={connection} />
    </div>
  );

  /* The docked panel's artifact is held above every surface, so a chip on a step, a gate
     card and an `orca://artifact/spec.md@v3` deep link can all put one there; opening the
     panel itself stays the chrome's, which is what `onOpen` hands over. */
  return <ArtifactPanelProvider onOpen={() => setPanelOpen(true)}>{chrome}</ArtifactPanelProvider>;
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
