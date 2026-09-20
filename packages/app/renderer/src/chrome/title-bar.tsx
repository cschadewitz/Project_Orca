/**
 * Custom title bar: app name, the waiting affordance, the ⌘K affordance. The whole bar is a
 * drag region (-webkit-app-region: drag in components.css); interactive children opt back
 * out via data-app-region="no-drag".
 *
 * The connection indicator used to sit here and now lives in the status bar (#163), which
 * is where docs/design/40-connection-states.md puts it and where the detail each state
 * carries has room. `status-waiting` is still the one status permitted in this bar (rule 6),
 * and the waiting affordance is what it is for.
 */
import type { JSX } from "react";
import { STATUS_PRESENTATION } from "@orca/design";
import { shortcutLabel } from "../keyboard-map.js";
import { OPEN_PALETTE_KEY } from "../palette/use-command-palette.js";
import { Button, textClass } from "../ui/index.js";

export interface TitleBarProps {
  platform: string;
  /**
   * Tier 1 and tier 2 summed — `InputsListResult.waiting`, which the daemon sends so that
   * no client recounts it (#161). Hidden at zero, and `status-waiting` is the one status
   * this bar is allowed to show (rule 6).
   */
  waitingCount?: number;
  onOpenAttention: () => void;
  onOpenPalette: () => void;
}

export function TitleBar({ platform, waitingCount, onOpenAttention, onOpenPalette }: TitleBarProps): JSX.Element {
  return (
    <div className={`orca-titlebar ${textClass("label")}`} data-platform={platform}>
      <span className={`orca-titlebar__brand ${textClass("label-strong")}`}>ORCA</span>
      {waitingCount ? (
        <button
          type="button"
          className={`orca-titlebar__attn ${textClass("caption")}`}
          data-app-region="no-drag"
          onClick={onOpenAttention}
        >
          <span aria-hidden="true">{STATUS_PRESENTATION.waiting.glyph}</span>
          {waitingCount} waiting
        </button>
      ) : null}
      <span className="orca-spacer" />
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
        <kbd className={`orca-kbd ${textClass("mono-id")}`}>{shortcutLabel(OPEN_PALETTE_KEY, platform)}</kbd>
      </Button>
    </div>
  );
}
