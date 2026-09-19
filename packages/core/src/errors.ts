/**
 * Error hierarchy. Every ORCA error carries a stable `code` so callers (CLI,
 * integrations, UIs) can branch on it without parsing messages.
 */
export type OrcaErrorCode =
  | "WORKFLOW_INVALID"
  | "WORKFLOW_NOT_FOUND"
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_RENDER"
  | "EXPRESSION_SYNTAX"
  | "EXPRESSION_EVAL"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_INVALID"
  | "AGENT_HOST_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_TRANSPORT"
  | "AGENT_PROTOCOL"
  | "RUN_NOT_FOUND"
  | "RUN_STATE"
  /** Another interpreter holds the run's single-writer lease; see store/lease-store.ts. */
  | "RUN_LEASED"
  | "CLAIM_NOT_FOUND"
  | "LEASE_NOT_FOUND"
  | "STEP_TIMEOUT"
  | "CANCELLED"
  | "HUMAN_INPUT_PENDING"
  | "NOT_SUPPORTED"
  | "CONFIG_INVALID"
  | "PLAN_NOT_FOUND"
  | "PLAN_INVALID"
  | "DEPENDENCY_CYCLE"
  | "STORE_LOCK_TIMEOUT"
  | "INTERNAL";

export class OrcaError extends Error {
  override readonly name: string = "OrcaError";
  constructor(
    readonly code: OrcaErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  toJSON(): { code: OrcaErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function isOrcaError(e: unknown, code?: OrcaErrorCode): e is OrcaError {
  return e instanceof OrcaError && (code === undefined || e.code === code);
}

/** Convert anything thrown into a serialisable shape for events/logs. */
export function describeError(e: unknown): { code: OrcaErrorCode; message: string; details?: Record<string, unknown> } {
  if (e instanceof OrcaError) return e.toJSON();
  if (e instanceof Error) return { code: "INTERNAL", message: e.message };
  return { code: "INTERNAL", message: String(e) };
}
