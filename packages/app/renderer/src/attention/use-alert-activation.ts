/**
 * What happens when a person clicks an OS notification, or when a permission ask takes the
 * attention of a window that already has focus (#162).
 *
 * The main process focuses the window — that is the one thing a click is allowed to do to
 * it — and sends the alert it was about over the `alerts` channel. The renderer's half is
 * this: open Attention, where the card is.
 *
 * **The seam for #165 is `activation.item`.** It carries the input's id and its run, which
 * is exactly what an `orca://run/<id>/input/<id>` route is built from, so unit I upgrades
 * this from "open the surface" to "open that card's deep link" by routing the item instead
 * of ignoring it — the same shape G's pushed connection state left for F's reconnect seam.
 * Until then, opening the surface the card is on is the honest thing a click can do.
 */
import { useEffect } from "react";
import type { AlertActivation } from "../../../src/bridge.js";

export function useAlertActivation(onActivate: (activation: AlertActivation) => void): void {
  useEffect(() => {
    return window.orca.alerts.subscribe(onActivate);
  }, [onActivate]);
}
