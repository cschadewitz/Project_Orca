/**
 * The 420px artifact panel: a grid column above the panel breakpoint, an absolute overlay
 * below it (both driven by `.orca-body`'s data attributes in components.css). No surface
 * produces an artifact to show yet, so the body is an empty state.
 */
import type { JSX } from "react";
import { Button, StateView } from "../ui/index.js";

export interface DockedPanelProps {
  onClose: () => void;
}

export function DockedPanel({ onClose }: DockedPanelProps): JSX.Element {
  return (
    <div className="orca-panel">
      <div className="orca-pane__head">
        <span>Panel</span>
        <span className="orca-spacer" />
        <Button tone="ghost" size="sm" onClick={onClose} aria-label="Close panel (⌘\)">
          <span className="orca-kbd" aria-hidden="true">
            ⌘\
          </span>
        </Button>
      </div>
      <StateView kind="empty" title="Nothing pinned" body="Artifacts open here. No surface can produce one yet." />
    </div>
  );
}
