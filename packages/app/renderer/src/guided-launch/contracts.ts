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
  LaunchSelectionProvenance,
  PreflightParams,
  PreflightResult,
} from "../../../src/configuration-launch-contract.js";
import type { ProtectedStorageReason } from "../../../src/bridge.js";
import type { RequestOverrideChoices } from "./request-overrides.js";

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
  /** Recovery has its own authorization; losing launch grants does not revoke inspection. */
  recoveryReason?: string;
  recoveryAction?: "inspect" | "reconcile";
  roots: readonly LaunchRoot[];
  workflows: readonly LaunchWorkflow[];
  overrideChoices?: RequestOverrideChoices;
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
  /** Names proven non-sensitive by this exact review's metadata, never by a later schema. */
  visibleInputs?: readonly string[];
  checkout?: CheckoutEvidence;
  selectionProvenance?: LaunchSelectionProvenance;
}
/** Opaque handle to the main owner's protected, exact-command intent. No renderer ledger/key. */
export interface LaunchIntent {
  id: string;
}
/** Sanitized app-local failure classification, mapped from canonical refusals by the adapter. */
export class LaunchPortFailure extends Error {
  constructor(
    readonly reason: "unauthorized" | "stale" | "validation" | "unavailable" | "protected-storage",
    /** Only for `protected-storage`: the main process's cause and its recovery guidance. */
    readonly storage?: ProtectedStorageRefusalView,
  ) {
    super("Guided launch adapter refused the operation.");
  }
}
/** A fail-closed protected-storage refusal (#857). Nothing was retained or sent. */
export interface ProtectedStorageRefusalView {
  reason: ProtectedStorageReason;
  message: string;
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
    expectedWorkflowRevision?: string;
    expectedConfigGeneration?: string;
    vars: Record<string, unknown>;
    overrides?: RequestsSubmitParams["overrides"];
    request?: PreflightParams["request"];
  }): Promise<
    Pick<
      PreflightResult,
      | "target"
      | "workflowId"
      | "workflowVersion"
      | "expectedWorkflowRevision"
      | "expectedConfigGeneration"
      | "validation"
      | "inputSchema"
      | "selections"
      | "itemWorkflow"
      | "templatePack"
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
  /** Lookup must match the complete frozen review in protected main storage; never infer by workflow. */
  resolveIntent?: (review: LaunchReview) => Promise<LaunchIntent | undefined>;
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
  /** Session-only editor text, including invalid JSON; never placed in a command or preferences. */
  inputText: Readonly<Record<string, string>>;
  /** Includes protected reads and confirmations even when the visible phase does not change. */
  busy: boolean;
  /** Session protection is monotonic; unclassified restored input names are always withheld. */
  withheldInputs: readonly string[];
  phase: "editing" | "checking" | "review" | "submitting" | "recovering" | "admitted" | "blocked";
  message: string;
  errors: ValidationResultView["errors"];
  review?: LaunchReview | undefined;
  intent?: LaunchIntent | undefined;
  result?: LaunchResult | undefined;
  unresolvedReview?: LaunchReview | undefined;
  /** Set when protected storage refused before anything was sent; the review stays ready to retry. */
  storageRefusal?: ProtectedStorageRefusalView | undefined;
}
