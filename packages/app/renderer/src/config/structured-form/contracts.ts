/** Provisional app-local seams for isolated #333 controls; no new RPC or flattened schema adapter. */
import type {
  ConfigFieldDescription,
  ConfigSetParams,
  ConfigSetResult,
  ConfigApplyParams,
  ConfigApplyResult,
  ConfigValidationError,
} from "@orca/protocol";
import type { BridgeResult } from "../../../../src/bridge.js";

export type DocumentPath = readonly (string | number)[];
export interface EditorTarget {
  readonly workspaceId: string;
  readonly instanceId: string;
  readonly epoch: number;
}
export type EditIntent =
  | { readonly kind: "set"; readonly path: DocumentPath; readonly value: unknown }
  | { readonly kind: "remove"; readonly path: DocumentPath }
  | { readonly kind: "insert"; readonly path: DocumentPath; readonly index: number; readonly value: unknown }
  | { readonly kind: "move"; readonly path: DocumentPath; readonly from: number; readonly to: number };

/** Sensitivity is mandatory: the old descriptor has no evidence a value is safe to display. */
export interface FieldMetadata {
  readonly acceptsAbsent: boolean | "metadata-unavailable";
  readonly acceptsNull: boolean | "metadata-unavailable";
  readonly visibility: "non-secret" | "withheld" | "metadata-unavailable";
  readonly default:
    | { readonly state: "none" }
    | { readonly state: "available"; readonly value: unknown }
    | { readonly state: "withheld" }
    | { readonly state: "metadata-unavailable" };
}
export type FieldShape = FieldMetadata &
  (
    | { readonly kind: "scalar"; readonly field: ConfigFieldDescription }
    | { readonly kind: "object"; readonly fields: Readonly<Record<string, FieldShape>> }
    | { readonly kind: "array"; readonly item: FieldShape }
    | {
        readonly kind: "record";
        readonly value: FieldShape;
        readonly keyFormat?: string | undefined;
        readonly valueKind?: "env" | undefined;
      }
    | {
        readonly kind: "union";
        readonly discriminator: string;
        readonly branches: Readonly<Record<string, FieldShape>>;
      }
    | { readonly kind: "unsupported"; readonly reason: "opaque" | "metadata-unavailable" }
  );
export interface FieldError {
  readonly path: DocumentPath;
  readonly message: string;
}
export type EditAccess = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface ConfigCandidate {
  readonly target: EditorTarget;
  readonly document: "config";
  readonly expectedRevision: string;
  readonly draftSequence: number;
  readonly edits: readonly EditIntent[];
}
export interface ChangeSummary {
  readonly path: DocumentPath;
  readonly kind: EditIntent["kind"];
}

/** The integrator must prove lowering preserves original YAML nodes/comments and ordered indices. */
export interface StructuredEditorPorts {
  readonly lowering: {
    readonly preservesComments: true;
    lower: (candidate: ConfigCandidate) => Promise<{ status: "ready"; text: string } | { status: "unsupported" }>;
  };
  /** Current target/method/authority checks, repeated after awaits and before each write. */
  access: (action: "validate" | "save" | "apply", candidate: ConfigCandidate) => EditAccess;
  /** Authoritative classification must cover raw and structured policy changes in integration. */
  policyChange: (candidate: ConfigCandidate) => boolean;
  set: (params: ConfigSetParams) => Promise<BridgeResult<ConfigSetResult>>;
  apply: (params: ConfigApplyParams) => Promise<BridgeResult<ConfigApplyResult>>;
  /** Must return authorized, value-free errors, including precise reference paths where allowed. */
  safeErrors: (errors: readonly ConfigValidationError[]) => readonly FieldError[];
}
