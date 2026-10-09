/** Main-owned diagnostics authority. No report content is accepted from renderer. */
export const DIAGNOSTICS_SCOPE = 1;
/** Shipping capture requires a separate independent/native acceptance change. */
export const DIAGNOSTICS_PRODUCTION_ENABLED = false;
/** One in-flight block; main, IPC/preload and context-bridge copies are admitted. */
export const DIAGNOSTIC_PREVIEW_BLOCK_BYTES = 16_384;
export const DIAGNOSTIC_PREVIEW_MAX_BYTES = 1_048_576;
export type DiagnosticResultCode =
  | "off"
  | "ready"
  | "unavailable"
  | "age_uncertain"
  | "expired"
  | "capacity_limited"
  | "stale_preview"
  | "publication_pending"
  | "saved"
  | "refused"
  | "cleanup_pending"
  | "unknown_blocked"
  | "unknown_ready"
  | "acknowledged_unknown";
export interface DiagnosticsStatus {
  enabled: boolean;
  productionEnabled: boolean;
  scopeVersion: number;
  minutes: number;
  code: DiagnosticResultCode;
  previous: boolean;
  checkpointAgeMs?: number;
  tailLossPossible: boolean;
  cleanupPending: boolean;
  unknownOperation?: string;
  acknowledgedUnknown: boolean;
  olderUnknowns: boolean;
  activePreviewHandle?: string;
  payloadReservedBytes: number;
  controlledBinaryAllocatedBytes?: number;
  controlledBinaryPeakBytes?: number;
  lastSaveOutcome?: "saved" | "refused" | "unknown";
  saveAdmittedBeforeRevocation?: boolean;
}
export type DiagnosticsResult<T> = { ok: true; value: T } | { ok: false; code: DiagnosticResultCode };
export interface DiagnosticPreview {
  handle: string;
  byteLength: number;
  source: "current" | "previous";
  expiresInMs: number;
  tailLossPossible: boolean;
}
export interface DiagnosticPreviewBlock {
  handle: string;
  offset: number;
  bytes: Uint8Array;
}
export interface DiagnosticDestination {
  token: string;
  displayPath: string;
}
export interface DiagnosticsBridge {
  subscribe(listener: (status: DiagnosticsStatus) => void): () => void;
  status(): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  setEnabled(enabled: boolean, scopeVersion: number): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  setMinutes(minutes: number): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  preparePreview(source: "current" | "previous"): Promise<DiagnosticsResult<DiagnosticPreview>>;
  readPreviewBlock(handle: string, offset: number): Promise<DiagnosticsResult<DiagnosticPreviewBlock>>;
  releasePreviewBlock(handle: string, offset: number): Promise<DiagnosticsResult<boolean>>;
  closePreview(handle: string): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  chooseDestination(handle: string): Promise<DiagnosticsResult<DiagnosticDestination>>;
  save(handle: string, destinationToken: string): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  discardPrevious(): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  retryCleanup(): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  acknowledgeUnknown(operationHandle: string): Promise<DiagnosticsResult<DiagnosticsStatus>>;
}
