/** Bounded durable continuation admission; receipts are not run statuses. */
import type { RetryAuthority, RetryOptions, RetryResult } from "./admission-retry.js";

export interface ContinuationCommand {
  runId: string;
  expectedBoundary: string;
  decision?: { requestId: string; optionId: string; note?: string };
}
export interface ContinuationReceipt {
  operationId: string;
  continuationId: string;
  runId: string;
  expectedBoundary: string;
  state: "prepared" | "accepted" | "blocked" | "settled";
  blockedReason?: "authority-unavailable" | "leased" | "unsafe-boundary" | "generation-unavailable";
}
export interface ContinuationService {
  admit(
    command: ContinuationCommand,
    retry: RetryOptions,
    authority: RetryAuthority<ContinuationCommand>,
  ): Promise<RetryResult<ContinuationReceipt>>;
  inspect(continuationId: string): Promise<ContinuationReceipt>;
  reconcile(continuationId: string, authority: RetryAuthority<ContinuationCommand>): Promise<ContinuationReceipt>;
}
