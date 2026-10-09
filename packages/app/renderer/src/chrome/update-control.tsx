/** Header update action, also discoverable through the keyboard command registry. */
import { useCallback, useEffect, useLayoutEffect, useState, type JSX } from "react";
import type { UpdateAction } from "../../../src/update-contract.js";
import { useKeyboard } from "../keyboard-context.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { hasUpdateDrafts } from "../update-drafts.js";
import { Button } from "../ui/index.js";
import { MacUpdateControl } from "./mac-update-control.js";
// Restoration belongs to the guarded root in this renderer document, not to a
// component subscription. The preload owns which lease may send prepare/release.
const priorInert = new WeakMap<HTMLElement, boolean>();
export function UpdateControl(): JSX.Element | null {
  const [state, setState] = useState(() => window.orca.updates.read());
  const keyboard = useKeyboard();
  const announce = useAnnounce();
  useEffect(() => window.orca.updates.subscribe(setState), []);
  useLayoutEffect(
    () =>
      window.orca.updates.prepare((locked) => {
        const root = document.querySelector<HTMLElement>(".orca-window");
        if (!root) return false;
        if (locked) {
          if (!priorInert.has(root)) priorInert.set(root, Boolean(root.inert));
          root.inert = true;
          return priorInert.get(root) === false && !hasUpdateDrafts();
        }
        const previous = priorInert.get(root);
        if (previous !== undefined) root.inert = previous;
        priorInert.delete(root);
        return true;
      }),
    [],
  );
  const action: UpdateAction = state.phase === "ready" ? "restart" : state.phase === "available" ? "download" : "check";
  const busy = ["checking", "downloading", "restarting"].includes(state.phase);
  const label =
    state.phase === "ready"
      ? `Restart to update to ${state.version ?? "downloaded version"}`
      : state.phase === "available"
        ? `Download ${state.version ?? "update"}`
        : state.phase === "downloading"
          ? `Downloading ${Math.floor(state.percent ?? 0)}%`
          : state.phase === "checking"
            ? "Checking for updates"
            : state.phase === "restarting"
              ? "Preparing restart"
              : state.phase === "error"
                ? "Retry update check"
                : state.phase === "current"
                  ? `${state.current} is current · Check again`
                  : "Check for updates";
  const act = useCallback(() => {
    if (!busy)
      void window.orca.updates.act(action).then((result) => {
        if (!result.ok) announce(result.error.message);
      });
  }, [action, busy, announce]);
  useEffect(() => {
    if (state.phase !== "unavailable") return keyboard.register({ scope: "global", label, action: act });
    return undefined;
  }, [keyboard, label, act, state.phase]);
  useEffect(() => {
    if (!["idle", "unavailable", "downloading"].includes(state.phase)) announce(state.message ?? label);
  }, [state.phase, state.message, label, announce]);
  if (state.phase === "unavailable") return window.orca.platform === "darwin" ? <MacUpdateControl /> : null;
  return (
    <Button tone="ghost" size="sm" data-app-region="no-drag" disabled={busy} title={state.message} onClick={act}>
      {label}
    </Button>
  );
}
