/** CLI/API revision client: a retained intent key and explicit capability negotiation, never answer-note fallback. */
import { OrcaError } from "@orca/core";
import type {
  RevisionCommand,
  ReplacePendingRevisionCommand,
  PendingRevisionTarget,
  PendingRevisionView,
  RevisionResult,
} from "../../../protocol/src/revision-input.js";

export interface RevisionClient {
  capabilities: readonly string[];
  call(method: string, params: unknown): Promise<unknown>;
}
export class RevisionInputClient {
  constructor(private readonly client: RevisionClient) {}
  private require(method: string): void {
    if (!this.client.capabilities.includes(method))
      throw new OrcaError("NOT_SUPPORTED", "This adapter does not support explicit revision input");
  }
  submit(command: RevisionCommand, idempotencyKey: string): Promise<RevisionResult> {
    this.require("inputs.revise");
    return this.client.call("inputs.revise", { command, retry: { idempotencyKey } }) as Promise<RevisionResult>;
  }
  readPending(target: PendingRevisionTarget): Promise<PendingRevisionView> {
    this.require("inputs.revisionPending");
    return this.client.call("inputs.revisionPending", { target }) as Promise<PendingRevisionView>;
  }
  replacePending(command: ReplacePendingRevisionCommand, idempotencyKey: string): Promise<RevisionResult> {
    this.require("inputs.replaceRevision");
    return this.client.call("inputs.replaceRevision", {
      command,
      retry: { idempotencyKey },
    }) as Promise<RevisionResult>;
  }
}
