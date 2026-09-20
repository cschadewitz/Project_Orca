/**
 * What happens when a person clicks an OS notification, or when a permission ask takes the
 * attention of a window that already has focus (#162).
 *
 * The main process focuses the window — that is the one thing a click is allowed to do to
 * it — and sends the alert it was about over the `alerts` channel. The renderer's half is
 * this: open Attention, where the card is.
 *
 * `activation.item` is what makes it a link rather than a surface change: it carries the
 * input's id and its run, so `App.tsx` builds the same `orca://` URL a person could have
 * pasted and hands it to the one route table every other arrival goes through (#165). An
 * alert whose item has since been answered carries none, and then opening the surface is
 * all that is left to say about it.
 */
import { useEffect } from "react";
import type { AlertActivation } from "../../../src/bridge.js";

export function useAlertActivation(onActivate: (activation: AlertActivation) => void): void {
  useEffect(() => {
    return window.orca.alerts.subscribe(onActivate);
  }, [onActivate]);
}
