/**
 * Custom title bar: app name, the waiting affordance, the connection state, the ⌘K
 * affordance. The whole bar is a drag region (-webkit-app-region: drag in
 * components.css); interactive children opt back out via data-app-region="no-drag".
 */
import type { JSX } from "react";
import { STATUS_PRESENTATION } from "@orca/design";
import { shortcutLabel } from "../keyboard-map.js";
import { OPEN_PALETTE_KEY } from "../palette/use-command-palette.js";
import { Button, ConnectionIndicator } from "../ui/index.js";
import type { Connection } from "./use-connection.js";

export interface TitleBarProps {
  platform: string;
  connection: Connection;
  /** Hidden at zero — the count itself is #161. */
  waitingCount?: number;
  onOpenAttention: () => void;
  onOpenPalette: () => void;
}

export function TitleBar({
  platform,
  connection,
  waitingCount,
  onOpenAttention,
  onOpenPalette,
}: TitleBarProps): JSX.Element {
  return (
    <div className="orca-titlebar" data-platform={platform}>
      <span className="orca-titlebar__brand">ORCA</span>
      {waitingCount ? (
        <button type="button" className="orca-titlebar__attn" data-app-region="no-drag" onClick={onOpenAttention}>
          <span aria-hidden="true">{STATUS_PRESENTATION.waiting.glyph}</span>
          {waitingCount} waiting
        </button>
      ) : null}
      <span className="orca-spacer" />
      <span data-app-region="no-drag">
        <ConnectionIndicator state={connection.state} since={connection.since} />
      </span>
      {/* The palette is reachable by mouse as well as by ⌘K — "nothing is reachable by
          keyboard alone or by mouse alone" (docs/design/50-accessibility-and-keyboard.md). */}
      <Button
        tone="ghost"
        size="sm"
        data-app-region="no-drag"
        aria-keyshortcuts={platform === "darwin" ? "Meta+K" : "Control+K"}
        onClick={onOpenPalette}
      >
        Commands
        <kbd className="orca-kbd">{shortcutLabel(OPEN_PALETTE_KEY, platform)}</kbd>
      </Button>
    </div>
  );
}
