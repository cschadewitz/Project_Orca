/** Public first-run projections; directory authorization and persistence stay in main. */
import type { BridgeResult } from "./bridge.js";

export interface FirstRunReview {
  readonly id: string;
  readonly project: string;
  readonly workspace: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly sample: { id: string; version: string; revision: string };
}
export type FirstRunStatus =
  | {
      state: "recovery";
      recovery: { state: "ready" | "surviving-owned-daemon" | "unknown-writer" | "reconciled"; requestId: string };
    }
  | {
      state: "configuration-review";
      review: {
        id: string;
        revision: string;
        agentCount: number;
        checks: { agentId: string; state: "missing" | "unavailable" | "architecture" | "handshake-required" }[];
      };
    }
  | { state: "selection-required"; reason: string }
  | { state: "review"; review: FirstRunReview }
  | { state: "prepared"; project: string; workspace: string; sample: FirstRunReview["sample"] };
export interface FirstRunBridge {
  status(): Promise<BridgeResult<FirstRunStatus>>;
  choose(): Promise<BridgeResult<FirstRunStatus>>;
  prepare(id: string): Promise<BridgeResult<FirstRunStatus>>;
  prepareRecovery?(): Promise<BridgeResult<FirstRunStatus>>;
  reconcileRecovery?(id: string): Promise<BridgeResult<FirstRunStatus>>;
  reviewConfiguration?(): Promise<BridgeResult<FirstRunStatus>>;
  bindConfiguration?(id: string): Promise<BridgeResult<FirstRunStatus>>;
  connect(): Promise<BridgeResult<FirstRunStatus>>;
}
