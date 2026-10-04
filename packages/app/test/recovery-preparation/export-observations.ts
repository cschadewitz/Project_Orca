/**
 * Test-only observation oracle, not a coordinator or a production bridge.
 * A future real-adapter harness must obtain native liveness, durable records,
 * filesystem bytes and dispatch counts independently of the controller's status.
 * Passing hand-written traces tests this oracle only, never export acceptance.
 */
export interface CleanupEvidence {
  writersStopped: boolean;
  stagingIdentityVerified: boolean;
  cleanupConfirmed: boolean;
}

export interface UnknownSummary {
  operationId: string;
  outcome: "unknown";
  acknowledged: true;
  olderUnknowns: boolean;
}

export type ExportObservation =
  | {
      kind: "acknowledgement";
      operationId: string;
      committed: boolean;
      evidence: CleanupEvidence;
      automaticEffects: number;
    }
  | { kind: "release"; operationId: string; evidence: CleanupEvidence }
  | { kind: "restart" }
  | { kind: "revalidated"; fixedSlotSafeAndEmpty: boolean; noCurrentWriter: boolean }
  | {
      kind: "dispatch";
      operationId: string;
      previousUnknown: string;
      destinationToken: string;
      saveHandle: string;
      freshlySelected: boolean;
      explicitSave: boolean;
      destinationExists: boolean;
      atomicNoReplace: boolean;
      currentAuthority: boolean;
    }
  | {
      kind: "callback";
      operationId: string;
      mutatedOperationId: string | null;
      releasedOperationId: string | null;
      summaryUnchanged: boolean;
    }
  | {
      kind: "snapshot";
      currentRecords: number;
      summaryRecords: number;
      replacementCopies: number;
      cleanupBytesIncludingCopies: number;
      controlEntries: number;
      controlBytesIncludingCopies: number;
      summary: UnknownSummary | null;
      priorExportBytes: Uint8Array;
      oldOutcome: string;
      oldReservationHeld: boolean;
      oldOperationId: string;
    };

function requireObservation(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireSafe(evidence: CleanupEvidence): void {
  requireObservation(evidence.writersStopped, "writers still able to write");
  requireObservation(evidence.stagingIdentityVerified, "staging identity unsafe or unknown");
  requireObservation(evidence.cleanupConfirmed, "cleanup unresolved");
}

function bounded(value: number, ceiling: number, name: string): void {
  requireObservation(Number.isSafeInteger(value) && value >= 0 && value <= ceiling, name);
}

/** Assert a complete instrumented schedule; observation completeness is the adapter's obligation. */
export function assertExportObservations(
  observations: readonly ExportObservation[],
  priorExportBytes: Uint8Array,
  oldDestinationTokens: readonly string[],
): void {
  const acknowledged = new Set<string>();
  const revalidated = new Set<string>();
  const released = new Set<string>();
  const dispatched = new Set<string>();
  const tokens = new Set(oldDestinationTokens);
  const saveHandles = new Set<string>();
  let latestUnknown: string | null = null;
  let olderUnknowns = false;
  for (const observation of observations) {
    switch (observation.kind) {
      case "acknowledgement":
        requireObservation(observation.automaticEffects === 0, "acknowledgement triggered picker/save/consent");
        if (observation.committed) {
          requireSafe(observation.evidence);
          if (!acknowledged.has(observation.operationId)) {
            olderUnknowns ||= latestUnknown !== null;
            latestUnknown = observation.operationId;
          } else {
            requireObservation(latestUnknown === observation.operationId, "stale acknowledgement mutated history");
          }
          acknowledged.add(observation.operationId);
          revalidated.add(observation.operationId);
        }
        break;
      case "restart":
        revalidated.clear();
        break;
      case "revalidated":
        requireObservation(
          observation.fixedSlotSafeAndEmpty && observation.noCurrentWriter,
          "restart fixed slot unsafe or writer unresolved",
        );
        for (const operationId of acknowledged) revalidated.add(operationId);
        break;
      case "release":
        requireSafe(observation.evidence);
        requireObservation(acknowledged.has(observation.operationId), "release before durable acknowledgement");
        requireObservation(revalidated.has(observation.operationId), "restart safety not re-established");
        requireObservation(!released.has(observation.operationId), "duplicate reservation release");
        released.add(observation.operationId);
        break;
      case "dispatch":
        requireObservation(acknowledged.has(observation.previousUnknown), "save before durable acknowledgement");
        requireObservation(revalidated.has(observation.previousUnknown), "restart safety not re-established");
        requireObservation(released.has(observation.previousUnknown), "old reservation still held");
        requireObservation(!acknowledged.has(observation.operationId), "old operation ID reused");
        requireObservation(!dispatched.has(observation.operationId), "duplicate native dispatch");
        requireObservation(!saveHandles.has(observation.saveHandle), "repeated Save allocated another operation");
        requireObservation(
          observation.freshlySelected && !tokens.has(observation.destinationToken),
          "destination token reused",
        );
        requireObservation(
          !observation.destinationExists && observation.atomicNoReplace,
          "destination overwrite possible",
        );
        requireObservation(observation.explicitSave, "missing separate explicit Save action");
        requireObservation(observation.currentAuthority, "save without current consent/preview authority");
        dispatched.add(observation.operationId);
        saveHandles.add(observation.saveHandle);
        tokens.add(observation.destinationToken);
        break;
      case "callback":
        requireObservation(
          observation.mutatedOperationId === null || observation.mutatedOperationId === observation.operationId,
          "callback mutated newer operation",
        );
        requireObservation(
          observation.releasedOperationId === null || observation.releasedOperationId === observation.operationId,
          "callback released newer reservation",
        );
        requireObservation(
          !acknowledged.has(observation.operationId) ||
            (observation.mutatedOperationId === null && observation.releasedOperationId === null),
          "acknowledged operation changed by callback",
        );
        requireObservation(observation.summaryUnchanged, "callback changed prior unknown summary");
        break;
      case "snapshot": {
        bounded(observation.currentRecords, 1, "too many current records");
        bounded(observation.summaryRecords, 1, "too many summaries");
        bounded(observation.replacementCopies, 1, "too many replacement copies");
        bounded(observation.cleanupBytesIncludingCopies, 8192, "cleanup sub-budget exceeded");
        bounded(observation.controlEntries, 16, "control entry limit exceeded");
        bounded(observation.controlBytesIncludingCopies, 65536, "total control budget exceeded");
        requireObservation(
          observation.cleanupBytesIncludingCopies <= observation.controlBytesIncludingCopies,
          "cleanup subset exceeds total control bytes",
        );
        requireObservation(
          Buffer.from(observation.priorExportBytes).equals(Buffer.from(priorExportBytes)),
          "prior export changed",
        );
        requireObservation(observation.oldOutcome === "unknown", "earlier unknown relabeled");
        requireObservation(
          observation.oldReservationHeld || released.has(observation.oldOperationId),
          "reservation silently released",
        );
        const summary = observation.summary;
        requireObservation(observation.summaryRecords === (summary === null ? 0 : 1), "summary accounting mismatch");
        requireObservation((latestUnknown === null) === (summary === null), "prior unknown summary lost");
        if (summary !== null) {
          requireObservation(
            Object.keys(summary).sort().join(",") === "acknowledged,olderUnknowns,operationId,outcome",
            "unexpected summary fields",
          );
          requireObservation(
            summary.operationId === latestUnknown &&
              summary.outcome === "unknown" &&
              summary.acknowledged === true &&
              typeof summary.olderUnknowns === "boolean" &&
              summary.olderUnknowns === olderUnknowns,
            "invalid unknown summary",
          );
        }
        break;
      }
    }
  }
}
