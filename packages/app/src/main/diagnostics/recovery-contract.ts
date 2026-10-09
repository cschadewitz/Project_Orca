/** Storage boundary owned by the lead; adapters never access daemon/execution state. */
export interface BootReading {
  bootId: string;
  elapsedMs: number;
}
export interface DiagnosticsSetting {
  enabled: boolean;
  scopeVersion: number;
  minutes: number;
}
export interface StoredCheckpoint {
  bytes: Buffer;
  anchor: BootReading;
  dispose?(): void;
}
export interface StageIdentity {
  device: string;
  inode: string;
}
export interface ExportSummary {
  id: string;
  outcome: "unknown";
  acknowledged: true;
  olderUnknowns: boolean;
}
export interface ExportState {
  current?: { id: string; stage?: StageIdentity; phase: "intent" | "staged" | "dispatched" | "unknown" };
  summary?: ExportSummary;
}
export interface RecoveryDisk {
  /** Synchronous consent fence; no filesystem/key access and no new authority. */
  revoke(): void;
  readSetting(): Promise<DiagnosticsSetting>;
  writeSetting(setting: DiagnosticsSetting): Promise<void>;
  /** Verify control authority; promote eligible unclean current, retain previous on clean exit. */
  open(now: BootReading): Promise<boolean>;
  /** Authenticate committed authority, expire prior history and remove only unreferenced artifacts. */
  maintain(now: BootReading | undefined): Promise<boolean>;
  checkpoint(bytes: Buffer, anchor: BootReading, admit: () => boolean): Promise<void>;
  previous(now: BootReading): Promise<StoredCheckpoint | undefined>;
  discardPrevious(): Promise<void>;
  cleanExit(): Promise<void>;
  /** Remove owned history/keys only, preserving setting and unresolved export metadata. */
  cleanup(): Promise<void>;
  readExportState(): Promise<ExportState>;
  writeExportState(state: ExportState): Promise<void>;
  stageExport(id: string, bytes: Buffer): Promise<StageIdentity>;
  clearStage(identity?: StageIdentity): Promise<void>;
  /** Validate parent/ownership/nonexistent filename and same filesystem before plaintext. */
  validateDestination(destination: string): Promise<boolean>;
  /** Atomic native no-replace publication; admission callback runs at dispatch. */
  publishStage(
    identity: StageIdentity,
    destination: string,
    admit: () => boolean,
  ): Promise<"saved" | "refused" | "unknown">;
  /** Evidence covers every process/native writer; not a PID/timeout heuristic. */
  writersStopped(): Promise<boolean>;
}
export interface DiagnosticsClock {
  read(): BootReading | undefined;
}
export function validReading(value: BootReading | undefined): value is BootReading {
  return (
    value !== undefined &&
    typeof value.bootId === "string" &&
    value.bootId.length > 0 &&
    value.bootId.length <= 128 &&
    Number.isSafeInteger(value.elapsedMs) &&
    value.elapsedMs >= 0
  );
}
export const RECOVERY_LIMITS = Object.freeze({
  retainedBytes: 4 * 1_048_576,
  exportBytes: 1_048_576,
  controlBytes: 65_536,
  cleanupBytes: 8192,
  entries: 16,
  payloadBytes: 8 * 1_048_576,
  retentionMs: 86_400_000,
  previewMs: 300_000,
  checkpointMs: 5000,
  prepareMs: 2000,
  operationMs: 10_000,
});
