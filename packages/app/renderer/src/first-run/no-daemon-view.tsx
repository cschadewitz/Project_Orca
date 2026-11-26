/**
 * The first screen with no daemon behind it. In the desktop app the daemon is the app's own, started for
 * the workspace chosen in Project setup, so "run orca serve" is the wrong advice there (#1109, #1192).
 * This reads Project setup's status and says why the workspace did not open and where to fix it. Without
 * the setup bridge, or against a daemon named by ORCA_DAEMON_URL, it keeps the command-line advice.
 */
import { useEffect, useState, type JSX } from "react";
import type { FirstRunStatus } from "../../../src/first-run-contract.js";
import { StateView } from "../ui/index.js";

const SERVE = "Start one with orca serve, then try again.";

/** What the first screen says for a Project setup state. Exported for tests. */
export function noDaemonReason(status: FirstRunStatus): string {
  switch (status.state) {
    case "selection-required":
      return status.changedConfiguration
        ? status.reason
        : "Set up a project in Config. The app then starts its own local daemon for it.";
    case "prepared":
      return "The app's local daemon for this workspace is not running. In Config, under Project setup, choose Connect selected local workspace.";
    case "recovery":
      return "The last session for this workspace needs recovery before it reopens. Open Config and review it under Project setup.";
    case "review":
    case "configuration-review":
      return "Finish project setup in Config.";
  }
}

export function NoDaemonView({
  title,
  onRetry,
  onOpenConfig,
}: {
  title: string;
  onRetry: () => void;
  onOpenConfig?: () => void;
}): JSX.Element {
  const bridge = window.orca.firstRun;
  const external = window.orca.workspace.read().source === "env";
  const [status, setStatus] = useState<FirstRunStatus>();
  useEffect(() => {
    if (!bridge || external) return;
    let alive = true;
    bridge.status().then(
      (result) => {
        if (alive && result.ok) setStatus(result.result);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, external]);
  if (!bridge || external)
    return (
      <StateView kind="disconnected" title={title} body={SERVE} action={{ label: "Try again", onClick: onRetry }} />
    );
  return (
    <StateView
      kind="disconnected"
      title={status?.state === "selection-required" && status.changedConfiguration ? "Workspace did not reopen" : title}
      body={status ? noDaemonReason(status) : "Open Config to set up or reopen a workspace."}
      action={onOpenConfig ? { label: "Open Config", onClick: onOpenConfig } : { label: "Try again", onClick: onRetry }}
    />
  );
}
