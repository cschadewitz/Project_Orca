/** Desktop updates are local app operations, separate from daemon RPC. */
export type UpdateAction = "check" | "download" | "restart";
export interface UpdateSnapshot {
  phase:
    "unavailable" | "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "restarting" | "error";
  current: string;
  version?: string;
  percent?: number;
  message?: string;
}
