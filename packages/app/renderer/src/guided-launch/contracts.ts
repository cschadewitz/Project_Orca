/** Injected guided-launch contracts; canonical persistence and RPC wiring belong to the integrator. */
import type {
  RequestsSubmitParams,
  RequestsSubmitResult,
  RunsAdmitResult,
  ValidationResultView,
  WorkflowInputSchemaView,
} from "@orca/protocol";
import type {
  CheckoutEvidence,
  EditorTarget,
  LaunchCommand as SharedLaunchCommand,
  PreflightResult,
} from "../../../src/configuration-launch-contract.js";

/** App-local injection contracts. These do not register an RPC or a storage format. */
export interface LaunchTarget extends EditorTarget {
  endpointId: string;
  workspaceId: string;
  instanceId: string;
  principalId: string;
  epoch: number;
}
export interface LaunchRoot {
  id: string;
  label: string;
  /** Integrator-owned, current checkout/ownership evidence; never inferred from a path. */
  evidence: { state: "verified"; revision: string; summary: string } | { state: "unavailable"; reason: string };
}
export interface LaunchWorkflow {
  id: string;
  name: string;
  version: string;
  revision: string;
  modes: readonly ("direct" | "request")[];
  rootIds: readonly string[];
  inputSchema?: WorkflowInputSchemaView;
  provenance: readonly string[];
}
export interface LaunchContext {
  target: LaunchTarget;
  activeGeneration: string;
  /** Supplied by the shared current connection/authorization owner. */
  unavailableReason?: string;
  directReason?: string;
  requestReason?: string;
  roots: readonly LaunchRoot[];
  workflows: readonly LaunchWorkflow[];
}
export interface LaunchDraft {
  mode: "direct" | "request";
  rootId: string;
  workflowId: string;
  vars: Record<string, unknown>;
  title: string;
  body: string;
  overrides?: RequestsSubmitParams["overrides"];
}
export type LaunchCommand = SharedLaunchCommand;
export interface LaunchReview {
  target: LaunchTarget;
  draftSequence: number;
  rootId: string;
  rootRevision: string;
  workflowId: string;
  workflowVersion: string;
  workflowRevision: string;
  generation: string;
  command: LaunchCommand;
  warnings: ValidationResultView["warnings"];
  checkout?: CheckoutEvidence;
}
/** Opaque handle to the main owner's protected, exact-command intent. No renderer ledger/key. */
export interface LaunchIntent {
  id: string;
}
/** Sanitized app-local failure classification, mapped from canonical refusals by the adapter. */
export class LaunchPortFailure extends Error {
  constructor(readonly reason: "unauthorized" | "stale" | "validation" | "unavailable") {
    super("Guided launch adapter refused the operation.");
  }
}
type WithoutOperation<T> = T extends unknown ? Omit<T, "operationId"> : never;
export type LaunchReceipt = WithoutOperation<RunsAdmitResult> | RequestsSubmitResult;
export type LaunchRecoveryResult =
  | { state: "resolved"; operationId: string; replayed: boolean; result: LaunchReceipt }
  | { state: "in-progress"; operationId: string; recovery: "inspect-or-retry" };
/** Initial direct receipts carry operationId; initial Request receipts do not. */
export type LaunchInitialResult = RunsAdmitResult | RequestsSubmitResult;
export type LaunchResult = LaunchInitialResult | LaunchRecoveryResult;
export interface LaunchPorts {
  preflight(review: {
    target: LaunchTarget;
    mode: LaunchDraft["mode"];
    rootId: string;
    workflowId: string;
    workflowVersion: string;
    vars: Record<string, unknown>;
    overrides?: RequestsSubmitParams["overrides"];
  }): Promise<
    Pick<
      PreflightResult,
      | "target"
      | "workflowId"
      | "workflowVersion"
      | "expectedWorkflowRevision"
      | "expectedConfigGeneration"
      | "validation"
    > & {
      /** Guarded by the integrator's root adapter alongside coherent operator preflight. */
      rootId: string;
      rootRevision: string;
      checkout?: CheckoutEvidence;
    }
  >;
  /** Must securely persist the complete frozen command/target/root binding before sending. */
  retain?: (review: LaunchReview) => Promise<LaunchIntent>;
  /** Canonical shared owner can retain and submit atomically; a lost handle remains ambiguous. */
  launch?: (review: LaunchReview) => Promise<{ intent: LaunchIntent; response: LaunchResult }>;
  /** Must use the captured target, current authority and retained exact retry key/command. */
  submit?: (intent: LaunchIntent) => Promise<LaunchInitialResult>;
  recover(intent: LaunchIntent): Promise<LaunchResult>;
  /** Explicit user action; abandons the intent only, never cancels an admitted run. */
  abandon?: (intent: LaunchIntent) => Promise<boolean>;
  /** Main validates/restores exact target and command binding, including protected draft. */
  restore?: (
    target: LaunchTarget,
  ) => Promise<{ review: LaunchReview; intent: LaunchIntent; draft: LaunchDraft } | undefined>;
  /** Extension owned by integrator; palette-only persistence does not satisfy this seam. */
  drafts?: {
    save(target: LaunchTarget, draft: LaunchDraft): Promise<void>;
    load(target: LaunchTarget): Promise<LaunchDraft | undefined>;
  };
  navigate(receipt: Extract<LaunchReceipt, { state: "accepted" }>, target: LaunchTarget): void;
  announce(message: string): void;
}
export interface LaunchState {
  context: LaunchContext;
  draftTarget: LaunchTarget;
  draft: LaunchDraft;
  sequence: number;
  inputEpoch: number;
  phase: "editing" | "checking" | "review" | "submitting" | "recovering" | "admitted" | "blocked";
  message: string;
  errors: ValidationResultView["errors"];
  review?: LaunchReview | undefined;
  intent?: LaunchIntent | undefined;
  result?: LaunchResult | undefined;
  unresolvedReview?: LaunchReview | undefined;
}
