/** Explicit approval and deferral of the exact main-owned Mac candidate; absent owner hides controls. */
import { useCallback, useEffect, useState, type JSX } from "react";
import { useAnnounce } from "../a11y/announce-context.js";
import { useKeyboard } from "../keyboard-context.js";
import { Button } from "../ui/index.js";
import type { MacUpdateView } from "../../../src/mac-update-contract.js";

const unavailable: MacUpdateView = { phase: "unavailable" };
export function MacUpdateControl(): JSX.Element | null {
  const [state, setState] = useState(() => window.orca.macUpdates?.read() ?? unavailable);
  const announce = useAnnounce();
  const keyboard = useKeyboard();
  useEffect(() => window.orca.macUpdates?.subscribe(setState), []);
  const act = useCallback(
    (action: "approve" | "defer") => {
      if (!state.offerId || !state.manifestSha256) return;
      void window.orca.macUpdates
        ?.act({ action, offerId: state.offerId, manifestSha256: state.manifestSha256 })
        .then((result) => {
          // Main pushes authoritative transitions. A late action reply cannot overwrite a newer offer/defer.
          if (!result.ok) announce(result.error.message);
        });
    },
    [state.offerId, state.manifestSha256, announce],
  );
  const approve = state.phase === "available";
  const defer = ["available", "downloading", "waiting", "preparing"].includes(state.phase);
  const label = approve
    ? `Approve automatic update and restart to ${state.version}`
    : state.phase === "waiting"
      ? "Update waiting for safe idle"
      : state.phase === "downloading"
        ? "Downloading approved update"
        : state.phase === "preparing"
          ? "Preparing approved update"
          : state.phase === "recovery-required"
            ? "Update outcome unknown · Recovery required"
            : state.phase === "awaiting-restart"
              ? "Update restart requested"
              : state.phase === "failed"
                ? "Update did not proceed"
                : state.phase === "deferred"
                  ? "Update deferred"
                  : state.phase === "activating"
                    ? "Activating approved update"
                    : "Update unavailable";
  useEffect(() => {
    if (!approve) return;
    const unregister = keyboard.register({ scope: "global", label, action: () => act("approve") });
    return unregister;
  }, [approve, keyboard, label, act]);
  useEffect(() => {
    if (defer) return keyboard.register({ scope: "global", label: "Defer Mac update", action: () => act("defer") });
    return undefined;
  }, [defer, keyboard, act]);
  useEffect(() => {
    if (!["unavailable", "idle", "downloading"].includes(state.phase)) announce(label);
  }, [state.phase, label, announce]);
  if (!state.offerId || ["unavailable", "idle", "deferred"].includes(state.phase)) return null;
  const details = `Candidate ${state.manifestSha256}; channel ${state.channel}; compatibility ${state.compatibilityPlanId}; recovery ${state.recoveryPlanId}. Approval allows automatic installation and restart once work and drafts are safe.`;
  return (
    <>
      <Button
        tone="ghost"
        size="sm"
        data-app-region="no-drag"
        disabled={!approve}
        title={details}
        onClick={() => act("approve")}
      >
        {label}
      </Button>
      {defer && (
        <Button tone="ghost" size="sm" data-app-region="no-drag" onClick={() => act("defer")}>
          Defer
        </Button>
      )}
    </>
  );
}
