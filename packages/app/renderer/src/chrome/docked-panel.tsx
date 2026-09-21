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
import type { JSX, ReactNode } from "react";
import { ArtifactPanel } from "../artifacts/artifact-panel.js";
import { useArtifactPanel } from "../artifacts/panel-context.js";
import { scopeProps } from "../keyboard-map.js";
import { Button, StateView, Text, textClass } from "../ui/index.js";

export interface DockedPanelProps {
  onClose: () => void;
  /**
   * What the surface on screen has put in the dock, when it is not an artifact: the Plan
   * inspector (#170, and #171's relationship inspector after it). The dock is "a Plan
   * surface as well as a Runs surface" as of option B
   * (docs/design/80-dependency-graph-options.md), and a surface hands its panel up the
   * same way it hands up its crumbs — the panel is the chrome's, on every screen.
   *
   * It wins over the artifact when both exist: it is about what is selected *now*, and an
   * artifact opened on Runs is not what a person switching to Plan is looking at.
   */
  content?: { label: string; body: ReactNode } | undefined;
}

export function DockedPanel({ onClose, content }: DockedPanelProps): JSX.Element {
  const { target } = useArtifactPanel();

  return (
    <div className="orca-panel" {...scopeProps("panel")}>
      <div className={`orca-pane__head ${textClass("label-strong")}`}>
        <span>{content?.label ?? "Panel"}</span>
        {content === undefined && target !== undefined && (
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
      {/* The dock's scroll region, and the dock's rather than the content's (#275). A
          surface hands up a `body` without knowing how tall the column is or whether it is
          a grid column or an overlay, so the one thing it cannot decide is whether it needs
          a scroller — and a panel that clips what a person put there to read is the worst
          version of that. `.orca-panel__body` is the region; the head above it stays put. */}
      <div className="orca-panel__body">
        {content !== undefined ? (
          content.body
        ) : target === undefined ? (
          <StateView kind="empty" title="Nothing pinned" body="Artifacts open here — click one on a step." />
        ) : (
          <ArtifactPanel target={target} />
        )}
      </div>
    </div>
  );
}
