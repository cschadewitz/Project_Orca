/** Desktop updates are local app operations, separate from daemon RPC. */
export type UpdateAction = "check" | "download" | "restart";
export interface UpdateSnapshot {
  phase:
    "unavailable" | "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "restarting" | "error";
  current: string;
  version?: string;
  percent?: number;
  message?: string;
  /**
   * Whether this app checks, downloads and installs on its own (#566): on by default, turned
   * off with the "Turn off automatic updates" command. Off, every step is manual as before.
   */
  automatic?: boolean;
  /** A downloaded update has waited three days for an idle moment; the header says so. */
  overdue?: boolean;
}
