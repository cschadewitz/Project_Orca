/** Injected observation boundary. The shipped adapter refuses every production source without I/O. */
import type { ServiceAlias } from "./policy.js";

export type ReadRequest =
  | { kind: "host"; host: "agent-01"; mount: "root" }
  | { kind: "service"; host: "agent-01"; service: ServiceAlias }
  | { kind: "logs"; host: "agent-01"; service: ServiceAlias; windowSeconds: number };
export interface ReadBudget {
  signal: AbortSignal;
  maxBytes: number;
  maxRecords: number;
  deadlineMs: number;
}
export interface ObservationAdapter {
  /**
   * Trusted implementation boundary, NOT a plugin loaded from a caller-supplied path.
   * Enforce budgets while reading, before allocating/decoding; honor abort promptly.
   * Return one bounded UTF-8 JSON observation, or null for an unsupported source.
   * Never perform mutation, return errors with source content, or broaden privileges.
   */
  read(request: ReadRequest, budget: ReadBudget): Promise<Uint8Array | null>;
}
export const unavailableAdapter: ObservationAdapter = Object.freeze({
  async read(): Promise<null> {
    return null;
  },
});
