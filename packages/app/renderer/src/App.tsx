/**
 * The window chrome: title bar, sidebar, primary pane, docked panel and status bar, per
 * docs/design/10-information-architecture.md. Routing here is which of the five surfaces
 * is active; the surfaces themselves (and the per-surface object memory ⌘2 etc. should
 * restore) arrive with the issues that give each surface real content.
 */
import { useCallback, useState, type JSX } from "react";
import { SURFACES, type SurfaceId } from "./chrome/surfaces.js";
import { Sidebar } from "./chrome/sidebar.js";
import { TitleBar } from "./chrome/title-bar.js";
import { StatusBar } from "./chrome/status-bar.js";
import { PrimaryPane } from "./chrome/primary-pane.js";
import { DockedPanel } from "./chrome/docked-panel.js";
import { useConnection } from "./chrome/use-connection.js";
import { useSidebarCollapsed, usePanelOverlay } from "./chrome/use-breakpoints.js";
import { useChromeShortcuts } from "./chrome/use-chrome-shortcuts.js";
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

  const activeSurface = SURFACES.find((s) => s.id === active) ?? SURFACES[0]!;
  const gridPanel = panelOpen && !panelOverlay;
  const bodyClassName = gridPanel ? "orca-body orca-body--panel" : "orca-body";

  return (
    <div className="orca-window">
      <TitleBar
        platform={window.orca.platform}
        connection={connection}
        onOpenAttention={() => selectSurface("attention")}
      />
      <div
        className={bodyClassName}
        data-sidebar={sidebarCollapsed ? "collapsed" : undefined}
        data-panel={panelOpen && panelOverlay ? "overlay" : undefined}
      >
        <Sidebar active={active} onSelect={selectSurface} />
        {/* Keyed by surface: a switch mounts a new pane, which is what re-applies that
            surface's remembered density. */}
        <PrimaryPane key={activeSurface.id} surface={activeSurface.id}>
          <StateView kind="empty" title={activeSurface.label} body="This surface has not been built yet." />
        </PrimaryPane>
        {panelOpen ? <DockedPanel onClose={togglePanel} /> : null}
      </div>
      <StatusBar {...(connection.orcaVersion ? { orcaVersion: connection.orcaVersion } : {})} />
    </div>
  );
}
