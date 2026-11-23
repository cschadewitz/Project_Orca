/** Public first-run projections; directory authorization and persistence stay in main. */
import type { BridgeResult } from "./bridge.js";

/** Observations only. Neither a command name nor readable bytes attest installed provider compatibility. */
export interface FirstRunAgentCheck {
  readonly agentId: string;
  readonly state: "missing" | "unavailable" | "architecture" | "handshake-required";
  readonly evidence: {
    readonly configuredRoute:
      "claude-code-acp-candidate" | "codex-acp-candidate" | "opencode-acp-candidate" | "unverified";
    readonly support: "unknown";
    readonly version: "unknown";
    readonly architecture: "unknown" | "mismatch";
    readonly acp: "not-checked";
    readonly signIn: "unknown";
    readonly exactCommand: "unsupported";
  };
}
export interface FirstRunReview {
  readonly id: string;
  readonly project: string;
  readonly workspace: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly creation?: { parent: string; kind: "private-child" };
  readonly sample: { id: string; version: string; revision: string };
}
export type FirstRunStatus =
  | {
      state: "recovery";
      recovery:
        | { state: "ready" | "surviving-owned-daemon" | "unknown-writer" | "reconciled"; requestId: string }
        /** The last session ended uncleanly before this computer restarted; only the person can mark it ended. */
        | { state: "previous-boot"; attemptId: string };
    }
  | {
      state: "configuration-review";
      review: {
        id: string;
        revision: string;
        agentCount: number;
        checks: FirstRunAgentCheck[];
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
  endPreviousSession?(attemptId: string): Promise<BridgeResult<FirstRunStatus>>;
  reviewConfiguration?(): Promise<BridgeResult<FirstRunStatus>>;
  cancelConfigurationReview?(): Promise<BridgeResult<FirstRunStatus>>;
  bindConfiguration?(id: string): Promise<BridgeResult<FirstRunStatus>>;
  connect(): Promise<BridgeResult<FirstRunStatus>>;
}
