/**
 * Custom title bar: app name, the waiting affordance, the connection state, the ⌘K
 * affordance. The whole bar is a drag region (-webkit-app-region: drag in
 * components.css); interactive children opt back out via data-app-region="no-drag".
 */
import type { JSX } from "react";
import { STATUS_PRESENTATION } from "@orca/design";
import { ConnectionIndicator } from "../ui/index.js";
import type { Connection } from "./use-connection.js";

export interface TitleBarProps {
  platform: string;
  connection: Connection;
  /** Hidden at zero — the count itself is #161. */
  waitingCount?: number;
  onOpenAttention: () => void;
}

export function TitleBar({ platform, connection, waitingCount, onOpenAttention }: TitleBarProps): JSX.Element {
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
      <span className="orca-kbd" aria-hidden="true">
        ⌘K
      </span>
    </div>
  );
}
