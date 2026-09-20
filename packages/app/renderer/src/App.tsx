/**
 * The window chrome: title bar, sidebar, primary pane, docked panel, status bar and the
 * command palette, per docs/design/10-information-architecture.md. Routing here is which
 * of the five surfaces is active; Runs is the first one with real data behind it, and the
 * other four (and the per-surface object memory ⌘2 etc. should restore) arrive with the
 * issues that give each surface its content.
 */
import { useCallback, useState, type JSX } from "react";
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
import { CommandPalette } from "./palette/command-palette.js";
import { useCommandPalette } from "./palette/use-command-palette.js";
import { RunsSurface } from "./runs/runs-surface.js";
import { AgentsSurface } from "./agents/agents-surface.js";
import { StateView } from "./ui/index.js";

// Attention is always first: the app's default landing surface (docs/design/10-information-architecture.md).
// The data-driven half of the landing rule — Attention showing running runs when nothing is
// waiting — needs real gate/run data that no protocol method serves yet.
const DEFAULT_SURFACE: SurfaceId = "attention";

export function App(): JSX.Element {
  const [active, setActive] = useState<SurfaceId>(DEFAULT_SURFACE);
  const [panelOpen, setPanelOpen] = useState(false);

  const connection = useConnection();
  const sidebarCollapsed = useSidebarCollapsed();
  const panelOverlay = usePanelOverlay();

  const selectSurface = useCallback((id: SurfaceId) => setActive(id), []);
  const togglePanel = useCallback(() => setPanelOpen((open) => !open), []);

  useChromeShortcuts({ onSurface: selectSurface, onTogglePanel: togglePanel });
  useEscapeClosesTopLayer();
  const palette = useCommandPalette();

  const activeSurface = SURFACES.find((s) => s.id === active) ?? SURFACES[0]!;
  const gridPanel = panelOpen && !panelOverlay;
  const bodyClassName = gridPanel ? "orca-body orca-body--panel" : "orca-body";

  /* Only the overlaid panel is transient: as a grid column it is part of the layout, and
     Esc must not close what a person put there to read alongside the pane. */
  useTransientLayer(panelOpen && panelOverlay, { name: "docked-panel", close: togglePanel });

  return (
    <div className="orca-window">
      <TitleBar
        platform={window.orca.platform}
        onOpenAttention={() => selectSurface("attention")}
        onOpenPalette={palette.openPalette}
      />
      {/* Under the chrome and over every surface: the state is one state, so the bar that
          says the data is last-known is drawn once rather than by each screen (#163). The
          five seconds of silence in front of it are the main process's. */}
      <ConnectionBanner connection={connection} />
      <div
        className={bodyClassName}
        data-sidebar={sidebarCollapsed ? "collapsed" : undefined}
        data-panel={panelOpen && panelOverlay ? "overlay" : undefined}
      >
        <Sidebar active={active} onSelect={selectSurface} />
        {/* Keyed by surface: a switch mounts a new pane, which is what re-applies that
            surface's remembered density. */}
        <PrimaryPane key={activeSurface.id} surface={activeSurface.id}>
          {activeSurface.id === "runs" ? (
            <RunsSurface connection={connection.state} />
          ) : activeSurface.id === "agents" ? (
            <AgentsSurface connection={connection.state} />
          ) : (
            <StateView kind="empty" title={activeSurface.label} body="This surface has not been built yet." />
          )}
        </PrimaryPane>
        {panelOpen ? <DockedPanel onClose={togglePanel} /> : null}
      </div>
      <StatusBar connection={connection} />
      {/* Last, so it is over the panel in paint order as well as in z-index; `onJump` is
          omitted until the `orca://` route table exists (#165). */}
      <CommandPalette controller={palette} />
      {/* Blocking, once per detection, and last of all: a version mismatch is the one
          connection state that stops a person before they read anything. */}
      <MismatchDialog connection={connection} />
    </div>
  );
}
