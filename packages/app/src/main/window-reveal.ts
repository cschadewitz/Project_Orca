/**
 * When a new window becomes visible (#858).
 *
 * The window is created hidden and shown on `ready-to-show`, so that it opens on a painted
 * page rather than on a blank frame. On its own that is a promise the platform does not keep
 * everywhere: under a Wayland compositor, which is what stock Ubuntu 24.04 Desktop runs and
 * what Electron picks there by default, a hidden toplevel is not mapped, so the compositor
 * sends it no frame callbacks, Chromium never presents a first frame, and `ready-to-show`
 * often never fires. The page has loaded, the renderer and the daemon are running, and
 * nothing is on screen. It does not happen every time (the first frame sometimes gets out
 * before the throttling starts), which is why a first launch could show a window and the
 * next one not.
 *
 * So `ready-to-show` stays the fast path, and two deadlines back it up:
 *
 * - **after the page has loaded** (`did-finish-load`, or `did-fail-load` for the main
 *   frame), a short grace for the first paint, then show anyway;
 * - **from creation**, a longer deadline, then show anyway, in case the load itself never
 *   reports. A visible window that is still loading can be looked at, closed and reported;
 *   an invisible one only looks like an app that did not start.
 *
 * Whichever comes first shows the window once; the others do nothing. A window that was
 * closed or already shown is left alone. Showing a hidden Wayland window maps it, after
 * which frames flow and `ready-to-show` arrives late and harmlessly.
 *
 * A plain function over the few window members it uses, so the decision can be tested with
 * a fake window and fake timers (`test/window-reveal.test.ts`).
 */

/** Grace for the first paint once the page has loaded. */
export const REVEAL_AFTER_LOAD_MS = 500;
/** The latest a new window stays hidden, whatever the page is doing. */
export const REVEAL_DEADLINE_MS = 4_000;

type FailLoadListener = (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void;

/** The parts of a `BrowserWindow` this needs. */
export interface RevealableWindow {
  once(event: "ready-to-show" | "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  webContents: {
    once(event: "did-finish-load", listener: () => void): unknown;
    on(event: "did-fail-load", listener: FailLoadListener): unknown;
    off(event: "did-fail-load", listener: FailLoadListener): unknown;
  };
}

export interface RevealTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type RevealReason = "ready-to-show" | "after-load" | "deadline";

/**
 * Show `win` on its first paint, or at the latest when one of the deadlines above passes.
 * `onReveal` is told which one it was, so a fallback can be logged.
 */
export function revealWhenReady(
  win: RevealableWindow,
  options: {
    afterLoadMs?: number;
    deadlineMs?: number;
    timers?: RevealTimers;
    onReveal?: (reason: RevealReason) => void;
  } = {},
): void {
  const afterLoadMs = options.afterLoadMs ?? REVEAL_AFTER_LOAD_MS;
  const deadlineMs = options.deadlineMs ?? REVEAL_DEADLINE_MS;
  const timers: RevealTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let settled = false;
  const pending: unknown[] = [];

  // Idempotent, and never touches a destroyed window: by `closed` its webContents is gone,
  // and a throw from a main-process listener is an error dialog on every close.
  const settle = () => {
    if (settled) return;
    settled = true;
    for (const handle of pending.splice(0)) timers.clearTimeout(handle);
    if (!win.isDestroyed()) win.webContents.off("did-fail-load", onFailLoad);
  };
  const reveal = (reason: RevealReason) => {
    if (settled) return;
    settle();
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    options.onReveal?.(reason);
  };
  const afterLoad = () => {
    if (!settled) pending.push(timers.setTimeout(() => reveal("after-load"), afterLoadMs));
  };
  function onFailLoad(_event: unknown, _code: number, _description: string, _url: string, isMainFrame: boolean) {
    if (isMainFrame) afterLoad();
  }

  win.once("ready-to-show", () => reveal("ready-to-show"));
  win.once("closed", settle);
  win.webContents.once("did-finish-load", afterLoad);
  win.webContents.on("did-fail-load", onFailLoad);
  pending.push(timers.setTimeout(() => reveal("deadline"), deadlineMs));
}

/**
 * What to log for how a window was shown. The after-load path is how a window appears under a
 * Wayland compositor (above), which is every stock Ubuntu 24.04 launch, so it is not news, and
 * printing a "fallback" warning for it on every first launch read as a fault (#1109). Only the
 * creation deadline, where the page itself never reported loading, is worth a warning.
 */
export function revealWarning(reason: RevealReason): string | undefined {
  return reason === "deadline"
    ? "[orca] window shown by the deadline fallback; the page did not report loading or a first paint"
    : undefined;
}
