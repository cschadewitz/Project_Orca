/**
 * The 420px artifact panel: a grid column above the panel breakpoint, an absolute overlay
 * below it (both driven by `.orca-body`'s data attributes in components.css).
 *
 * What it shows is not its own state. The artifact is an address held in a context above
 * every surface (`artifacts/panel-context.tsx`), because opening one is something a step's
 * chip, a gate card and an `orca://artifact/spec.md@v3` deep link all have to be able to
 * do, and none of them is inside this subtree. The panel reads that address and renders
 * `ArtifactPanel` over it; with nothing open it is an empty state, and `⌘\` still closes it.
 *
 * It owns the `panel` keyboard scope: `[` and `]` step artifact versions, and they must
 * only do that while focus is inside here (docs/design/50-accessibility-and-keyboard.md).
 * The registrations themselves are `ArtifactPanel`'s — they are about an artifact, and
 * there is nothing to step when none is open.
 */
import type { JSX } from "react";
import { ArtifactPanel } from "../artifacts/artifact-panel.js";
import { useArtifactPanel } from "../artifacts/panel-context.js";
import { scopeProps } from "../keyboard-map.js";
import { Button, StateView, Text, textClass } from "../ui/index.js";

export interface DockedPanelProps {
  onClose: () => void;
}

export function DockedPanel({ onClose }: DockedPanelProps): JSX.Element {
  const { target } = useArtifactPanel();

  return (
    <div className="orca-panel" {...scopeProps("panel")}>
      <div className={`orca-pane__head ${textClass("label-strong")}`}>
        <span>Panel</span>
        {target !== undefined && (
          <Text style="caption" className="orca-faint">
            {`${target.name}@v${target.version}`}
          </Text>
        )}
        <span className="orca-spacer" />
        <Button tone="ghost" size="sm" onClick={onClose} aria-label="Close panel (⌘\)">
          <span className={`orca-kbd ${textClass("mono-id")}`} aria-hidden="true">
            ⌘\
          </span>
        </Button>
      </div>
      {target === undefined ? (
        <StateView kind="empty" title="Nothing pinned" body="Artifacts open here — click one on a step." />
      ) : (
        <ArtifactPanel target={target} />
      )}
    </div>
  );
}
