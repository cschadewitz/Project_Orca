/** Server-internal retry contracts. Keys identify intent, never authority or execution. */
import type { MutationActor } from "../events/events.js";
import type { OrcaError, OrcaErrorCode } from "../errors.js";
import type { SubmissionAuthority, SubmissionCommand, SubmissionResult } from "./request.js";

export interface RetryOptions {
  idempotencyKey?: string;
}
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RetryOperationKind =
  "request.submit" | "run.admit" | "revision.submit" | "revision.replace" | "run.continue";
export type RetryResult<T> =
  | { state: "resolved"; operationId: string; replayed: boolean; result: T }
  | { state: "in-progress"; operationId: string; recovery: "inspect-or-retry" };
export interface RetryAuthority<C> {
  readonly principalId: string;
  readonly workspaceId: string;
  authorize(command: C): Promise<void>;
}
export interface RetryContext {
  readonly operationId: string;
  readBinding(): Promise<Record<string, JsonValue> | undefined>;
  bind(binding: Record<string, JsonValue>): Promise<void>;
  reauthorize(): Promise<void>;
}
export interface RetryOperation<C, R> {
  readonly kind: RetryOperationKind;
  canonicalize(command: C): JsonValue;
  /** Trusted, bounded, effect-free validation before a fresh claim is published.
   * Runs under the claim catalog mutex; any operation fence must already be held.
   * Existing claims (including conflicts) skip this check.
   */
  validateFresh?(command: C): Promise<void>;
  prepare(command: C, context: RetryContext): Promise<R>;
  recover(command: C, context: RetryContext): Promise<R>;
}
export interface RetryClaims {
  execute<C, R>(
    operation: RetryOperation<C, R>,
    command: C,
    retry: RetryOptions,
    authority: RetryAuthority<C>,
  ): Promise<RetryResult<R>>;
}
export interface DirectAdmissionCommand {
  workflowId: string;
  vars?: Record<string, unknown> | undefined;
  workflowVersion?: string | undefined;
  expectedWorkflowRevision?: string | undefined;
  expectedConfigGeneration?: string | undefined;
  requestId?: string | undefined;
  workItemId?: string | undefined;
}
export type DirectAdmissionResult =
  | { state: "prepared"; admissionId: string }
  | { state: "accepted"; admissionId: string; runId: string }
  | {
      state: "recoverable-failure";
      admissionId: string;
      runId?: string;
      failure: { code: OrcaErrorCode; message: string; recovery: "reconcile" };
    };
export interface DirectAdmissionAuthority {
  readonly workspaceId: string;
  readonly actor: MutationActor;
  authorize(command: DirectAdmissionCommand): Promise<void>;
  onRunAdmitted(runId: string): Promise<void>;
  /** Verify existing exact durable ownership without attributing or repairing it. */
  verifyRunAdmitted?(runId: string): Promise<void>;
}
export interface RetrySafeAdmissions {
  submit(
    command: SubmissionCommand,
    retry: RetryOptions,
    authority: SubmissionAuthority,
  ): Promise<RetryResult<SubmissionResult>>;
  admitRun(
    command: DirectAdmissionCommand,
    retry: RetryOptions,
    authority: DirectAdmissionAuthority,
  ): Promise<RetryResult<DirectAdmissionResult>>;
}

/** Composition supplies reserved OrcaError codes; no alternate error hierarchy. */
export interface RetryFaults {
  conflict(): OrcaError;
  limit(): OrcaError;
}
export interface RetryLimits {
  maxClaimsPerWorkspace: number;
  maxClaimsPerPrincipal: number;
}
export interface RetryScope {
  workspaceId: string;
  principalId: string;
  kind: RetryOperationKind;
}
/** All fields, including comparison and result, are protected execution material. */
export interface RetryRecord extends RetryScope {
  operationId: string;
  command: JsonValue;
  canonical: string;
  binding?: Record<string, JsonValue> | undefined;
  result?: JsonValue | undefined;
  phase: "claimed" | "bound" | "accepted";
}
export interface RetryClaimStore {
  claim(
    scope: RetryScope,
    key: string | undefined,
    command: JsonValue,
    canonical: string,
    /** Server-internal only; invoked after a lookup miss, before any claim mutation. */
    validateFresh?: () => Promise<void>,
  ): Promise<{ record: RetryRecord; fresh: boolean }>;
  read(operationId: string): Promise<RetryRecord | undefined>;
  lock<T>(operationId: string, action: () => Promise<T>): Promise<T>;
  write(record: RetryRecord): Promise<void>;
  /** Fixed-size discovery; cursor is persisted by the store, no whole-ledger scan. */
  batch(): Promise<string[]>;
}
