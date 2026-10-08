/** Shared injected app seams for #333/#334/#355. These names do not advertise daemon methods. */
import type { z } from "zod";
import type {
  AdmissionRetryResult,
  ConfigApplyParams,
  ConfigApplyResult,
  ConfigDocument,
  ConfigFieldDescription,
  ConfigGetResult,
  ConfigSetResult,
  ConfigValidationError,
  OperatorPreflightParamsSchema,
  OperatorPreflightResultSchema,
  RequestsSubmitParams,
  RequestsSubmitResult,
  RunsAdmitParams,
  RunsAdmitResult,
  WorkflowsGetResult,
  WorkflowsListResult,
} from "@orca/protocol";

export interface EditorTarget {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly epoch: number;
}
export type DocumentPath = readonly (string | number)[];
export type EditIntent =
  | { kind: "set"; path: DocumentPath; value: unknown }
  | { kind: "remove"; path: DocumentPath }
  | { kind: "insert"; path: DocumentPath; index: number; value: unknown }
  | { kind: "move"; path: DocumentPath; from: number; to: number };

/** Input semantics, independent of output defaults, on every structural node. */
export interface FieldMetadata {
  readonly acceptsAbsent: boolean | "metadata-unavailable";
  readonly acceptsNull: boolean | "metadata-unavailable";
  readonly visibility: "non-secret" | "withheld" | "metadata-unavailable";
  readonly default:
    | { state: "none" }
    | { state: "available"; value: unknown }
    | { state: "withheld" }
    | { state: "metadata-unavailable" };
}
export type FieldShape = FieldMetadata &
  (
    | { kind: "scalar"; field: ConfigFieldDescription }
    | { kind: "object"; fields: Readonly<Record<string, FieldShape>> }
    | { kind: "array"; item: FieldShape }
    | { kind: "record"; value: FieldShape }
    | { kind: "union"; discriminator: string; branches: Readonly<Record<string, FieldShape>> }
    | { kind: "unsupported"; reason: "opaque" | "metadata-unavailable" }
  );
export interface FormSchemaV1 {
  readonly version: 1;
  readonly root: FieldShape;
}
export type FieldPresence = { state: "absent" } | { state: "present"; value: unknown };
export interface ConfigCandidate {
  readonly target: EditorTarget;
  readonly document: ConfigDocument;
  readonly expectedRevision: string;
  readonly draftSequence: number;
  readonly edits: readonly EditIntent[];
}
export interface ConfigReview {
  readonly candidate: ConfigCandidate;
  readonly candidateRevision: string;
  readonly validation: readonly ConfigValidationError[];
  readonly changes: readonly {
    path: DocumentPath;
    kind: "added" | "removed" | "changed" | "moved";
    valueDisplay: "withheld" | "non-secret";
  }[];
}
/** Candidate bytes remain privately held by the authorized editor adapter. */
export interface ConfigurationPorts {
  read(): Promise<ConfigGetResult & { formSchema?: FormSchemaV1 }>;
  review(candidate: ConfigCandidate): Promise<ConfigReview>;
  save(review: ConfigReview): Promise<ConfigSetResult>;
  apply(params: ConfigApplyParams, target: EditorTarget): Promise<ConfigApplyResult>;
}

export type PreflightParams = z.input<typeof OperatorPreflightParamsSchema>;
export type PreflightResult = z.output<typeof OperatorPreflightResultSchema>;
export type LaunchCommand =
  | { mode: "direct"; params: Omit<RunsAdmitParams, "idempotencyKey" | "expectedScope"> }
  | { mode: "request"; params: Omit<RequestsSubmitParams, "idempotencyKey"> };
/** Authorized observations, never authorization tokens or a promise of native support. */
export type CheckoutEvidence =
  | { state: "unavailable"; reason: string }
  | {
      state: "verified";
      target: EditorTarget;
      configGeneration: string;
      evidenceId: string;
      profile: "prepared-local";
      repository: string;
      cwd: string;
      branch: string;
      baseCommit: string;
      asOf: string;
    }
  | {
      state: "verified";
      target: EditorTarget;
      configGeneration: string;
      evidenceId: string;
      profile: "owned-local-linux-source";
      repository: string;
      commonDirectory: string;
      baseCommit: string;
      worktreeRoot: string;
      branchPrefix: string;
      hostId: string;
      asOf: string;
    };
export interface LaunchReview {
  readonly target: EditorTarget;
  readonly draftSequence: number;
  /** User input material: private to editor/main storage, never a public summary. */
  readonly command: LaunchCommand;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly expectedWorkflowRevision: string;
  readonly expectedConfigGeneration: string;
  readonly checkout: CheckoutEvidence;
}
/** Initial receipts and outer recovery envelopes intentionally retain different shapes. */
export type LaunchResponse =
  | { kind: "direct"; receipt: RunsAdmitResult }
  | { kind: "request"; receipt: RequestsSubmitResult }
  | { kind: "retry"; receipt: AdmissionRetryResult };
export interface RetainedLaunch {
  readonly intentId: string;
  readonly operationId?: string;
  readonly admissionId?: string;
  readonly mode: "direct" | "request";
  readonly workflowId: string;
  readonly target: EditorTarget;
}
export interface GuidedLaunchPorts {
  workflows(): Promise<WorkflowsListResult>;
  workflow(id: string, version?: string): Promise<WorkflowsGetResult>;
  preflight(params: PreflightParams, target: EditorTarget): Promise<PreflightResult>;
  checkout(target: EditorTarget, generation: string): Promise<CheckoutEvidence>;
  submit(review: LaunchReview): Promise<{ intent: RetainedLaunch; response: LaunchResponse }>;
  retained(): Promise<readonly RetainedLaunch[]>;
  recover(intentId: string, action: "inspect" | "reconcile"): Promise<LaunchResponse>;
  /** Explicit main-owned confirmation; abandoning an intent never cancels its server run. */
  newWorkAfterReview(intentId: string): Promise<void>;
}
export interface LaunchNavigation {
  config(): void;
  connection(): void;
  admitted(ids: { operationId?: string; admissionId: string; requestId?: string; runId: string }): void;
  close(): void;
}

export interface TemplateAsset {
  readonly id: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly text: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly usedBy: readonly { workflowId: string; nodeId: string }[];
}
export interface TemplateCandidate {
  readonly target: EditorTarget;
  readonly sourceId?: string;
  readonly expectedRevision: string;
  readonly draftSequence: number;
  readonly id: string;
  readonly text: string;
}
export interface TemplatePreview {
  readonly target: EditorTarget;
  readonly draftSequence: number;
  readonly expectedRevision: string;
  readonly candidateRevision: string;
  readonly expectedConfigGeneration: string;
  readonly errors: readonly { path: string; message: string }[];
  readonly rendered?: string;
  readonly resolution: readonly {
    requestedId: string;
    resolvedId: string;
    kind: "base" | "pack" | "partial";
    fallback: boolean;
  }[];
  readonly changes: readonly { path: string; kind: "added" | "removed" | "changed" }[];
}
export interface TemplateAuthoringPorts {
  list(): Promise<readonly TemplateAsset[]>;
  read(sourceId: string): Promise<TemplateAsset>;
  preview(
    candidate: TemplateCandidate,
    fixture: {
      values: Readonly<Record<string, unknown>>;
      artifacts: readonly { kind: string; body: string }[];
      pack?: string;
    },
  ): Promise<TemplatePreview>;
  save(candidate: TemplateCandidate, review: TemplatePreview): Promise<TemplateAsset>;
  publish(review: TemplatePreview): Promise<ConfigApplyResult>;
  history(sourceId: string): Promise<readonly { revision: string; generation: string; at: string }[]>;
}
