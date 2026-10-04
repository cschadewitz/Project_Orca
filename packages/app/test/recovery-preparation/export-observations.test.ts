import { describe, expect, it } from "vitest";
import { assertExportObservations } from "./export-observations.js";
import type { CleanupEvidence, ExportObservation } from "./export-observations.js";

const priorBytes = Uint8Array.from([123, 10, 125, 10]);
const safe: CleanupEvidence = { writersStopped: true, stagingIdentityVerified: true, cleanupConfirmed: true };
const ack = (): ExportObservation => ({
  kind: "acknowledgement",
  operationId: "old",
  committed: true,
  evidence: { ...safe },
  automaticEffects: 0,
});
const release = (): ExportObservation => ({ kind: "release", operationId: "old", evidence: { ...safe } });
const dispatch = (): ExportObservation => ({
  kind: "dispatch",
  operationId: "new",
  previousUnknown: "old",
  destinationToken: "fresh-token",
  saveHandle: "fresh-save",
  freshlySelected: true,
  explicitSave: true,
  destinationExists: false,
  atomicNoReplace: true,
  currentAuthority: true,
});
const snapshot = (): Extract<ExportObservation, { kind: "snapshot" }> => ({
  kind: "snapshot",
  currentRecords: 1,
  summaryRecords: 1,
  replacementCopies: 1,
  cleanupBytesIncludingCopies: 8192,
  controlEntries: 16,
  controlBytesIncludingCopies: 65536,
  summary: { operationId: "old", outcome: "unknown", acknowledged: true, olderUnknowns: false },
  priorExportBytes: priorBytes.slice(),
  oldOutcome: "unknown",
  oldReservationHeld: false,
  oldOperationId: "old",
});
const legal = (): ExportObservation[] => [ack(), release(), dispatch(), snapshot()];
const check = (trace: ExportObservation[]) => assertExportObservations(trace, priorBytes, ["old-token"]);
const optOut = (): Extract<ExportObservation, { kind: "opt-out" }> => ({
  kind: "opt-out",
  logicalRevoked: true,
  durablyDisabled: true,
});
const removeSummary = (): Extract<ExportObservation, { kind: "summary-removal" }> => ({
  kind: "summary-removal",
  committed: true,
  evidence: { ...safe },
  unresolvedOperations: 0,
});
const cleared = (): Extract<ExportObservation, { kind: "snapshot" }> => ({
  ...snapshot(),
  kind: "snapshot",
  currentRecords: 0,
  summaryRecords: 0,
  summary: null,
});

// These mutations verify the oracle, not a real export implementation.
describe("export observation oracle (not runtime acceptance)", () => {
  it("accepts safe durable acknowledgement, separate fresh save and unchanged earlier unknown", () => {
    expect(() => check(legal())).not.toThrow();
    expect(() => check([ack(), ack(), release(), dispatch(), snapshot()])).not.toThrow();
  });

  it.each(["writersStopped", "stagingIdentityVerified", "cleanupConfirmed"] as const)(
    "rejects premature acknowledgement or release when %s is false",
    (field) => {
      const acknowledgement = ack();
      const reservation = release();
      if (acknowledgement.kind !== "acknowledgement" || reservation.kind !== "release") throw new Error("fixture");
      acknowledgement.evidence[field] = false;
      reservation.evidence[field] = false;
      expect(() => check([acknowledgement])).toThrow();
      expect(() => check([ack(), reservation])).toThrow();
    },
  );

  it("holds a live timed-out unknown without acknowledging or silently releasing", () => {
    const pending = snapshot();
    if (pending.kind !== "snapshot") throw new Error("fixture");
    pending.summary = null;
    pending.summaryRecords = 0;
    pending.oldReservationHeld = true;
    expect(() => check([pending])).not.toThrow();
    pending.oldReservationHeld = false;
    expect(() => check([pending])).toThrow("silently released");
  });

  it("rejects nondurable acknowledgement, restart bypass and duplicate release", () => {
    const failed = ack();
    if (failed.kind !== "acknowledgement") throw new Error("fixture");
    failed.committed = false;
    expect(() => check([failed, release()])).toThrow("durable acknowledgement");
    expect(() => check([failed, dispatch()])).toThrow("durable acknowledgement");
    expect(() => check([ack(), { kind: "restart" }, release()])).toThrow("restart safety");
    expect(() => check([ack(), release(), { kind: "restart" }, dispatch()])).toThrow("restart safety");
    expect(() =>
      check([
        ack(),
        { kind: "restart" },
        { kind: "revalidated", fixedSlotSafeAndEmpty: true, noCurrentWriter: true },
        release(),
        dispatch(),
        snapshot(),
      ]),
    ).not.toThrow();
    expect(() => check([ack(), release(), release()])).toThrow("duplicate reservation");
  });

  it("rejects automatic acknowledgement effects and repeated Save dispatches", () => {
    const automatic = ack();
    const duplicate = dispatch();
    if (automatic.kind !== "acknowledgement" || duplicate.kind !== "dispatch") throw new Error("fixture");
    automatic.automaticEffects = 1;
    expect(() => check([automatic])).toThrow("triggered");
    expect(() => check([...legal(), dispatch()])).toThrow("duplicate native");
    duplicate.operationId = "different-id";
    duplicate.destinationToken = "another-token";
    expect(() => check([...legal(), duplicate])).toThrow("repeated Save");
  });

  it.each(["mutatedOperationId", "releasedOperationId"] as const)(
    "rejects stale callback %s and earlier-unknown relabeling",
    (field) => {
      const callback: ExportObservation = {
        kind: "callback",
        operationId: "old",
        mutatedOperationId: null,
        releasedOperationId: null,
        summaryUnchanged: true,
      };
      expect(() => check([...legal(), callback])).not.toThrow();
      callback[field] = "new";
      expect(() => check([...legal(), callback])).toThrow("newer");
      callback[field] = "old";
      expect(() => check([...legal(), callback])).toThrow("acknowledged operation");
      callback[field] = null;
      callback.summaryUnchanged = false;
      expect(() => check([...legal(), callback])).toThrow("summary");
      const changed = snapshot();
      if (changed.kind !== "snapshot") throw new Error("fixture");
      changed.oldOutcome = "saved";
      expect(() => check([...legal(), changed])).toThrow("relabeled");
    },
  );

  it.each(["reused-token", "not-fresh", "existing-file", "overwrite", "revoked", "no-explicit-save"])(
    "rejects %s on fresh save",
    (fault) => {
      const save = dispatch();
      if (save.kind !== "dispatch") throw new Error("fixture");
      if (fault === "reused-token") save.destinationToken = "old-token";
      if (fault === "not-fresh") save.freshlySelected = false;
      if (fault === "existing-file") save.destinationExists = true;
      if (fault === "overwrite") save.atomicNoReplace = false;
      if (fault === "revoked") save.currentAuthority = false;
      if (fault === "no-explicit-save") save.explicitSave = false;
      expect(() => check([ack(), release(), save])).toThrow();
    },
  );

  it("rejects changed prior export bytes, unauthorized summary removal and extra private summary fields", () => {
    const changed = snapshot();
    if (changed.kind !== "snapshot") throw new Error("fixture");
    changed.priorExportBytes = Uint8Array.of(0);
    expect(() => check([ack(), release(), changed])).toThrow("prior export changed");
    changed.priorExportBytes = priorBytes;
    Object.assign(changed.summary!, { destinationPath: "synthetic-private-path" });
    expect(() => check([ack(), release(), changed])).toThrow("unexpected summary fields");
    changed.summary = null;
    changed.summaryRecords = 0;
    expect(() => check([ack(), release(), changed])).toThrow("summary lost");
  });

  it("accepts proven opt-out cleanup before summary removal and retains that absence across restart", () => {
    const off = [ack(), release(), optOut(), removeSummary(), cleared()];
    expect(() => check([...off, { kind: "restart" }, cleared(), { kind: "restart" }, cleared()])).not.toThrow();
    const resurrected = { ...snapshot(), kind: "snapshot" as const, currentRecords: 0 };
    expect(() => check([...off, { kind: "restart" }, resurrected])).toThrow("removed summary recreated");
    expect(() => check([...off, ack()])).toThrow("stale acknowledgement");
    expect(() => check([...off, dispatch()])).toThrow("save after opt-out");
  });

  it("summary removal does not release an acknowledged operation's reservation", () => {
    const held = cleared();
    held.oldReservationHeld = true;
    expect(() => check([ack(), optOut(), removeSummary(), held])).not.toThrow();
    expect(() => check([ack(), optOut(), removeSummary(), cleared()])).toThrow("silently released");
    expect(() => check([ack(), optOut(), removeSummary(), held, release(), cleared()])).not.toThrow();
    expect(() => check([ack(), optOut(), removeSummary(), held, { kind: "restart" }, release()])).toThrow(
      "restart safety",
    );
  });

  it("retains the predecessor summary when its removal is not durably committed", () => {
    const failed = removeSummary();
    failed.committed = false;
    const retained = { ...snapshot(), kind: "snapshot" as const, currentRecords: 0 };
    expect(() => check([ack(), release(), optOut(), failed, { kind: "restart" }, retained])).not.toThrow();
    expect(() => check([ack(), release(), optOut(), failed, cleared()])).toThrow("summary lost");
  });

  it("rejects removal without both logical revocation and durable opt-out", () => {
    expect(() => check([ack(), release(), removeSummary()])).toThrow("durable opt-out");
    const unconfirmed = optOut();
    unconfirmed.logicalRevoked = false;
    expect(() => check([ack(), release(), unconfirmed, removeSummary()])).toThrow("authority not revoked");
    const notPersisted = optOut();
    notPersisted.durablyDisabled = false;
    expect(() => check([ack(), release(), notPersisted, removeSummary()])).toThrow("durable opt-out");
    expect(() => check([ack(), release(), removeSummary(), optOut()])).toThrow("durable opt-out");
  });

  it.each(["writersStopped", "stagingIdentityVerified", "cleanupConfirmed"] as const)(
    "rejects opt-out summary removal when %s proof is missing",
    (field) => {
      const unsafe = removeSummary();
      unsafe.evidence[field] = false;
      expect(() => check([ack(), release(), optOut(), unsafe])).toThrow();
      const held = { ...snapshot(), kind: "snapshot" as const, currentRecords: 0 };
      expect(() => check([ack(), release(), optOut(), held])).not.toThrow();
    },
  );

  it("preserves a stopped and cleaned but unacknowledged current obligation during opt-out", () => {
    const pending = removeSummary();
    pending.unresolvedOperations = 1;
    expect(() => check([...legal(), optOut(), pending])).toThrow("bypassed unresolved operation");
    expect(() => check([...legal(), optOut(), snapshot()])).not.toThrow();
    const recreatedCurrent = cleared();
    recreatedCurrent.currentRecords = 1;
    expect(() => check([ack(), release(), optOut(), removeSummary(), recreatedCurrent])).toThrow(
      "unresolved operation after completed opt-out cleanup",
    );
  });

  it("late callbacks cannot restore removed metadata or release a cleaned reservation", () => {
    const callback: Extract<ExportObservation, { kind: "callback" }> = {
      kind: "callback",
      operationId: "old",
      mutatedOperationId: null,
      releasedOperationId: null,
      summaryUnchanged: true,
    };
    const off = [ack(), release(), optOut(), removeSummary(), { kind: "restart" as const }];
    expect(() => check([...off, callback, cleared()])).not.toThrow();
    callback.summaryUnchanged = false;
    expect(() => check([...off, callback])).toThrow("callback changed prior unknown summary");
    callback.summaryUnchanged = true;
    callback.mutatedOperationId = "old";
    expect(() => check([...off, callback])).toThrow("callback changed completed opt-out cleanup");
    callback.mutatedOperationId = null;
    callback.releasedOperationId = "old";
    expect(() => check([...off, callback])).toThrow("callback changed completed opt-out cleanup");
  });

  it.each([
    ["currentRecords", 2],
    ["summaryRecords", 2],
    ["replacementCopies", 2],
    ["cleanupBytesIncludingCopies", 8193],
    ["controlEntries", 17],
    ["controlBytesIncludingCopies", 65537],
  ] as const)("rejects unbounded %s", (field, value) => {
    const exceeded = snapshot();
    if (exceeded.kind !== "snapshot") throw new Error("fixture");
    exceeded[field] = value;
    expect(() => check([ack(), release(), exceeded])).toThrow();
  });

  it("saturates earlier unknown history in one boolean summary", () => {
    const nextAck = ack();
    const nextSummary = snapshot();
    if (nextAck.kind !== "acknowledgement" || nextSummary.kind !== "snapshot" || nextSummary.summary === null)
      throw new Error("fixture");
    nextAck.operationId = "new";
    nextSummary.summary.operationId = "new";
    nextSummary.summary.olderUnknowns = true;
    expect(() => check([...legal(), nextAck, nextSummary])).not.toThrow();
    nextSummary.summary.olderUnknowns = false;
    expect(() => check([...legal(), nextAck, nextSummary])).toThrow("invalid unknown summary");
    expect(() => check([...legal(), nextAck, ack()])).toThrow("stale acknowledgement");
  });
});

// The seven implementation categories are exercised by recovery-integration.test.ts
// using actual NodeRecoveryDisk, RecoveryController and Linux no-replace publication.
// Model-only observation tests above remain separate from native acceptance.
