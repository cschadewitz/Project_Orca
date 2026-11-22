/**
 * Error hierarchy. Every ORCA error carries a stable `code` so callers (CLI,
 * integrations, UIs) can branch on it without parsing messages.
 */
export type OrcaErrorCode =
  | "RETRY_CONFLICT"
  | "RETRY_LIMIT"
  | "WORKFLOW_INVALID"
  /** Launch vars failed the selected workflow revision's input schema; details has errors and warnings. */
  | "WORKFLOW_INPUT_INVALID"
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
  /**
   * The model a run selected is neither in the agent session's `category: "model"` option nor,
   * for an agent that offers none, in its configured `models`. `details.available` lists what is.
   */
  | "AGENT_MODEL_NOT_FOUND"
  /**
   * A run's recorded workflow version is neither in the workflow-version store nor the version
   * on disk. `details` carries `id`, `version` and `available` (what is stored, plus the current).
   */
  | "WORKFLOW_VERSION_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "RUN_STATE"
  /** Expected revision/destination/attempt no longer accepts this mutation. */
  | "REVISION_STALE"
  | "CONTINUATION_STALE"
  /**
   * A step that may have acted outside ORCA was interrupted, and nobody has reviewed it (#357).
   * Nothing runs it again until an operator marks it to run again or abandons the run.
   * `details` has `runId`, `stepRunId` and `nodeId`.
   */
  | "EFFECT_REVIEW_REQUIRED"
  /**
   * An operator abandoned that step after reviewing it (#357): nothing may run it again, even
   * while the run's cancellation is still to finish. `details` as for EFFECT_REVIEW_REQUIRED.
   */
  | "EFFECT_ABANDONED"
  /**
   * The recovery asked for is not possible for this run now (#357): a checkpoint attempt of a
   * run that did not fail, whose pin, inputs or artifacts are gone, or with an unreviewed step.
   * `details` has `runId`, `blockers` (RecoveryBlocker codes) and `checkpointStepRunId` when known.
   */
  | "RECOVERY_BLOCKED"
  /** Another interpreter holds the run's single-writer lease; see store/lease-store.ts. */
  | "RUN_LEASED"
  | "CLAIM_NOT_FOUND"
  | "LEASE_NOT_FOUND"
  | "STEP_TIMEOUT"
  | "CANCELLED"
  | "HUMAN_INPUT_PENDING"
  | "NOT_SUPPORTED"
  | "CONFIG_INVALID"
  /**
   * A configuration document moved between the read the caller based its edit on and the
   * write, detected *under* the writer's lock. `details` carries `expectedRevision` and
   * `actualRevision`, both content hashes (`""` for a file that is not there); the daemon
   * maps it onto the protocol's `CONFIG_STALE` fault.
   */
  | "CONFIG_STALE"
  | "PLAN_NOT_FOUND"
  | "PLAN_INVALID"
  | "DEPENDENCY_CYCLE"
  | "STORE_LOCK_TIMEOUT"
  /** An append the step depended on failed: a torn log, a full disk, a store directory that went away. */
  | "STORE_WRITE"
  /**
   * The store's recorded format cannot be opened by this build (#566): written by a newer ORCA,
   * older than the supported window, or a damaged marker. `details.reason` says which; the store
   * is left unchanged.
   */
  | "STORE_FORMAT"
  /**
   * A delegated step (#883) that the remote daemon, or the way to it, refuses for a reason a
   * retry cannot fix: a refused credential, an incompatible protocol, a daemon that admits no
   * runs, a workflow it does not have or will not run for this parent, a changed host key.
   * `details.reason` names which and `details.profile` the remote. Not retried.
   */
  | "DELEGATION_REFUSED"
  /**
   * The remote run a delegated step started finished without success. `details` carries the
   * remote `runId`, its `outcome` and its error, when it reported one. Retried like any step
   * failure: a retry is a new step attempt and so a new remote run.
   */
  | "DELEGATED_RUN_FAILED"
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

/** Shared retry refusals contain no key or command material. */
export const admissionRetryFaults = {
  conflict: () => new OrcaError("RETRY_CONFLICT", "Retry key is already bound to a different command"),
  limit: () => new OrcaError("RETRY_LIMIT", "Admission retry quota reached; existing receipts remain recoverable"),
};
