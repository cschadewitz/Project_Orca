/**
 * The desktop app's switch of its own workspace's store to SQLite, and back to files (#339). Main
 * decides whether either is offered and runs it; the renderer only shows the state and asks for
 * it. A switch restarts ORCA: the daemon is drained and stopped exactly, as for an update, and the
 * next start's daemon switches the store in place under the workspace's writer fence.
 */
export interface StoreSwitchState {
  /**
   * `unavailable`: not offered (another workspace or daemon, a daemon that cannot switch this
   * way, Windows, or not enabled in this build). `ready`: the button may be shown. `restarting`: in progress; ORCA
   * restarts at the end. `error`: blocked; `message` says why and what to do.
   */
  phase: "unavailable" | "ready" | "restarting" | "error";
  /** The connected store's metadata backend, when the daemon reported it. */
  backend?: "file" | "sqlite";
  /**
   * Which switch `ready` offers (and `restarting` runs): to SQLite from files, or back to files
   * from SQLite.
   */
  to?: "sqlite" | "files";
  /** How the switch asked for on this daemon's launch ended, as the daemon reported it. */
  last?: {
    to?: "sqlite" | "files" | undefined;
    status: "switched" | "current" | "refused";
    reason?: string | undefined;
    message?: string | undefined;
  };
  message?: string;
}
