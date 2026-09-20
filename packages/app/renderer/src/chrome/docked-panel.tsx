/**
 * The 420px artifact panel: a grid column above the panel breakpoint, an absolute overlay
 * below it (both driven by `.orca-body`'s data attributes in components.css). No surface
 * produces an artifact to show yet, so the body is an empty state.
 *
 * It owns the `panel` keyboard scope: `[` and `]` step artifact versions, and they must
 * only do that while focus is inside here (docs/design/50-accessibility-and-keyboard.md).
 */
import type { JSX } from "react";
import { scopeProps } from "../keyboard-map.js";
import { Button, StateView, textClass } from "../ui/index.js";

export interface DockedPanelProps {
  onClose: () => void;
}

export function DockedPanel({ onClose }: DockedPanelProps): JSX.Element {
  return (
    <div className="orca-panel" {...scopeProps("panel")}>
      <div className={`orca-pane__head ${textClass("label-strong")}`}>
        <span>Panel</span>
        <span className="orca-spacer" />
        <Button tone="ghost" size="sm" onClick={onClose} aria-label="Close panel (⌘\)">
          <span className={`orca-kbd ${textClass("mono-id")}`} aria-hidden="true">
            ⌘\
          </span>
        </Button>
      </div>
      <StateView kind="empty" title="Nothing pinned" body="Artifacts open here. No surface can produce one yet." />
    </div>
  );
}
