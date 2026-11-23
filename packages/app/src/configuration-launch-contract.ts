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
  /**
   * Each agent's capability set (#335) as the candidate would make it, against the running
   * configuration's: ids and deciding scopes only. Absent when either side has no set to
   * report (an older daemon, or a candidate the schema refuses).
   */
  readonly capabilities?: readonly AgentCapabilityPreview[];
}
export interface AgentCapabilityPreview {
  readonly agent: string;
  readonly entries: readonly {
    readonly kind: "mcpServer" | "skill";
    readonly id: string;
    /** The scope that decides it in the candidate; for a removed entry, the one that did. */
    readonly source: string;
    readonly change: "added" | "removed" | "unchanged" | "source-changed";
  }[];
  /** Selections that change nothing (dotted paths), from the candidate. */
  readonly warnings: readonly string[];
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
/** Safe resolved selections from the exact guarded preflight, retained with its command. */
export type LaunchSelectionProvenance = Pick<PreflightResult, "selections" | "itemWorkflow" | "templatePack">;
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
  readonly selectionProvenance?: LaunchSelectionProvenance | undefined;
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
  /** Authorized opaque source identity; never an arbitrary renderer-supplied path. */
  readonly key: string;
  readonly revision: string;
  /** Existing front-matter label, not immutable lookup identity. */
  readonly version: string;
  readonly requires: readonly string[];
  readonly partials: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly usedBy: readonly { workflowId: string; nodeId: string }[];
  readonly source: { state: "available"; text: string } | { state: "withheld" };
}
export interface TemplateAuthoringSnapshot {
  readonly target: EditorTarget;
  readonly catalogRevision: string;
  /** Config-file revision for the existing config.apply command. */
  readonly configRevision: string;
  readonly generation: string;
  readonly assets: readonly TemplateAsset[];
  readonly write: { state: "available" } | { state: "unavailable"; reason: string };
}
/** Initial binding saves exactly one source; no sequential emulation of an atomic batch. */
export interface TemplateCandidate {
  readonly target: EditorTarget;
  readonly key: string;
  readonly expectedSourceRevision: string;
  readonly expectedCatalogRevision: string;
  readonly expectedConfigGeneration: string;
  readonly draftSequence: number;
  readonly text: string;
}
export interface TemplateReviewFence {
  readonly target: EditorTarget;
  readonly draftSequence: number;
  readonly key: string;
  readonly expectedSourceRevision: string;
  readonly expectedCatalogRevision: string;
  readonly candidateRevision: string;
  readonly expectedConfigGeneration: string;
}
export interface TemplateDiagnostic {
  readonly key?: string;
  readonly code: "duplicate-id" | "missing-id" | "front-matter" | "reference" | "compatibility" | "invalid";
  readonly message: string;
}
export interface TemplateReview extends TemplateReviewFence {
  readonly errors: readonly TemplateDiagnostic[];
  /** Empty errors never establish compatibility. */
  readonly compatibility: "compatible" | "incompatible" | "unavailable";
  readonly changes: readonly string[];
}
export interface TemplatePreview extends TemplateReview {
  /** A missing renderer result cannot be presented as a successful empty prompt. */
  readonly prompt:
    | { state: "unavailable"; reason: string }
    | {
        state: "rendered";
        text: string;
        resolution: readonly {
          requestedId: string;
          resolvedId: string;
          kind: "base" | "pack" | "partial";
          fallback: boolean;
        }[];
      };
}
export interface TemplateFixtureInputs {
  readonly values: Readonly<Record<string, unknown>>;
  readonly artifacts: Readonly<Record<string, string>>;
}
export interface TemplateSaveReceipt extends TemplateReviewFence {
  readonly status: "saved";
  readonly sourceRevision: string;
  /** Source save does not activate configuration; generation is unchanged. */
  readonly snapshot: TemplateAuthoringSnapshot;
}
export type TemplateSaveResult =
  | TemplateSaveReceipt
  | { status: "conflict" | "invalid" | "denied" | "uncertain"; errors: readonly TemplateDiagnostic[] };
export interface TemplatePublicationReview extends TemplateReviewFence {
  readonly saved: TemplateSaveReceipt;
  readonly compatibility: "compatible" | "incompatible" | "unavailable";
  readonly errors: readonly TemplateDiagnostic[];
  /** The adapter additionally verifies exact saved catalog/content before forwarding. */
  readonly apply: ConfigApplyParams;
}
export type TemplateHistory =
  | { state: "unavailable"; reason: string }
  | {
      state: "available";
      target: EditorTarget;
      key: string;
      catalogRevision: string;
      entries: readonly { revision: string; generation?: string; at: string }[];
    };
export type TemplateVariant =
  | { state: "unsupported"; reason: string }
  | {
      state: "derived";
      target: EditorTarget;
      expectedCatalogRevision: string;
      expectedConfigGeneration: string;
      /** Service-allocated opaque new source key; no file write or activation. */
      key: string;
      text: string;
    };
export interface TemplateVariantRequest {
  readonly target: EditorTarget;
  readonly key: string;
  readonly expectedSourceRevision: string;
  readonly expectedCatalogRevision: string;
  readonly expectedConfigGeneration: string;
  readonly pack: string;
}
export interface TemplateAuthoringPorts {
  read(): Promise<TemplateAuthoringSnapshot>;
  validate(candidate: TemplateCandidate): Promise<TemplateReview>;
  preview(
    candidate: TemplateCandidate,
    id: string,
    pack: string | undefined,
    fixtures: TemplateFixtureInputs,
  ): Promise<TemplatePreview>;
  /** Both mutation ports stay absent until authoritative guarded services exist. */
  save?: (candidate: TemplateCandidate, review: TemplateReview) => Promise<TemplateSaveResult>;
  publicationReview?: (saved: TemplateSaveReceipt) => Promise<TemplatePublicationReview>;
  publish?: (review: TemplatePublicationReview) => Promise<ConfigApplyResult>;
  history?: (key: string, snapshot: TemplateAuthoringSnapshot) => Promise<TemplateHistory>;
  /** Accepted parser and source-range edits preserve comments/unknown metadata. */
  variant?: (request: TemplateVariantRequest) => Promise<TemplateVariant>;
}
