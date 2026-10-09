/** Main-owned diagnostics authority. No report content is accepted from renderer. */
export const DIAGNOSTICS_SCOPE = 1;
/** Shipping capture requires a separate independent/native acceptance change. */
export const DIAGNOSTICS_PRODUCTION_ENABLED = false;
export type DiagnosticResultCode =
  | "off"
  | "ready"
  | "export_ready"
  | "unavailable"
  | "age_uncertain"
  | "expired"
  | "capacity_limited"
  | "stale_export"
  | "publication_pending"
  | "cancelled"
  | "saved"
  | "refused"
  | "cleanup_pending"
  | "unknown_blocked"
  | "unknown_ready"
  | "acknowledged_unknown";
export interface DiagnosticsStatus {
  revision: number;
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
  activeExportHandle?: string;
  payloadReservedBytes: number;
  controlledBinaryAllocatedBytes?: number;
  controlledBinaryPeakBytes?: number;
  lastSaveOutcome?: "saved" | "refused" | "unknown";
  saveAdmittedBeforeRevocation?: boolean;
}
export type DiagnosticsResult<T> = { ok: true; value: T } | { ok: false; code: DiagnosticResultCode };
export interface DiagnosticExport {
  statusRevision: number;
  handle: string;
  byteLength: number;
  sha256: string;
  source: "current" | "previous";
  expiresInMs: number;
  tailLossPossible: boolean;
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
  prepareExport(source: "current" | "previous"): Promise<DiagnosticsResult<DiagnosticExport>>;
  cancelExport(handle: string): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  chooseDestination(handle: string): Promise<DiagnosticsResult<DiagnosticDestination>>;
  save(handle: string, destinationToken: string): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  discardPrevious(): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  retryCleanup(): Promise<DiagnosticsResult<DiagnosticsStatus>>;
  acknowledgeUnknown(operationHandle: string): Promise<DiagnosticsResult<DiagnosticsStatus>>;
}
