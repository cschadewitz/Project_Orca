/**
 * The desktop app's switch of its own workspace's store to SQLite (#339). Main decides whether
 * it is offered and runs it; the renderer only shows the state and asks for it. The switch
 * restarts ORCA: the daemon is drained and stopped exactly, as for an update, and the next
 * start's daemon switches the store in place under the workspace's writer fence.
 */
export interface StoreSwitchState {
  /**
   * `unavailable`: not offered (another workspace or daemon, already on SQLite, Windows, or not
   * enabled in this build). `ready`: the button may be shown. `restarting`: in progress; ORCA
   * restarts at the end. `error`: blocked; `message` says why and what to do.
   */
  phase: "unavailable" | "ready" | "restarting" | "error";
  /** The connected store's metadata backend, when the daemon reported it. */
  backend?: "file" | "sqlite";
  /** How the switch asked for on this daemon's launch ended, as the daemon reported it. */
  last?: { status: "switched" | "current" | "refused"; reason?: string | undefined; message?: string | undefined };
  message?: string;
}
