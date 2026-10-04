/** Consent, exact preview and bounded local export authority independent of execution. */
import { createHash, randomUUID } from "node:crypto";
import {
  DIAGNOSTICS_PRODUCTION_ENABLED,
  DIAGNOSTICS_SCOPE,
  type DiagnosticsResult,
  type DiagnosticsStatus,
  type DiagnosticResultCode,
  type DiagnosticPreview,
  type DiagnosticDestination,
} from "../../diagnostics-contract.js";
import { PretriggerBuffer } from "./pretrigger-buffer.js";
import { type DiagnosticPhase, type DiagnosticCode } from "./profile.js";
import {
  RECOVERY_LIMITS,
  validReading,
  type BootReading,
  type DiagnosticsClock,
  type DiagnosticsSetting,
  type ExportState,
  type RecoveryDisk,
} from "./recovery-contract.js";
import { validateDiagnosticReport } from "./report-validation.js";

export interface RecoveryControllerOptions {
  disk: RecoveryDisk;
  clock: DiagnosticsClock;
  /** Injectable for isolated tests; shipping code never enables this flag. */
  productionEnabled?: boolean;
  chooseDestination?: () => Promise<string | undefined>;
  operationTimeoutMs?: number;
}
interface Preview {
  handle: string;
  epoch: number;
  bytes: Buffer;
  digest: string;
  source: "current" | "previous";
  boot: string;
  deadline: number;
}
const success = <T>(value: T): DiagnosticsResult<T> => ({ ok: true, value });
const failure = <T>(code: DiagnosticResultCode): DiagnosticsResult<T> => ({ ok: false, code });

/** Diagnostics alone owns this bounded mutation slot. Ordinary execution never awaits it. */
export class RecoveryController {
  private setting: DiagnosticsSetting = { enabled: false, scopeVersion: DIAGNOSTICS_SCOPE, minutes: 5 };
  private ring: PretriggerBuffer;
  private epoch = 0;
  private reading: BootReading | undefined;
  private preview: Preview | undefined;
  private previewCharged = false;
  private retiredPreview: string | undefined;
  private retiredPreviewCharged = false;
  private destination: { token: string; handle: string; path: string; epoch: number } | undefined;
  private exportState: ExportState = {};
  private previousAvailable = false;
  private cleanupPending = false;
  private ageUncertain = false;
  private code: DiagnosticResultCode = "off";
  private lastCheckpoint: BootReading | undefined;
  private busy = false;
  private initialized = false;
  private initialization?: Promise<void>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private liveExport = false;
  private disableWrite: Promise<void> | undefined;
  private disableFailed = false;
  private lastSaveOutcome: "saved" | "refused" | "unknown" | undefined;
  private saveAdmittedBeforeRevocation = false;
  private payloadReservedBytes = 0;
  private saveOperation:
    { handle: string; token: string; promise: Promise<DiagnosticsResult<DiagnosticsStatus>> } | undefined;
  private readonly listeners = new Set<(status: DiagnosticsStatus) => void>();
  private readonly productionEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(private readonly options: RecoveryControllerOptions) {
    this.productionEnabled = options.productionEnabled ?? DIAGNOSTICS_PRODUCTION_ENABLED;
    this.timeoutMs = options.operationTimeoutMs ?? RECOVERY_LIMITS.operationMs;
    this.ring = this.newRing();
  }
  subscribe(listener: (status: DiagnosticsStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  initialize(): Promise<void> {
    this.initialization ??= this.bound(
      this.initializeOnce().then(() => success(true)),
      "unavailable",
      () => {
        this.code = "unavailable";
        this.cleanupPending = true;
        this.revokePreviewAuthority();
      },
    ).then(() => undefined);
    return this.initialization;
  }
  private async initializeOnce(): Promise<void> {
    this.busy = true;
    const epoch = this.epoch;
    try {
      const setting = await this.options.disk.readSetting();
      if (
        epoch === this.epoch &&
        setting.scopeVersion === DIAGNOSTICS_SCOPE &&
        typeof setting.enabled === "boolean" &&
        Number.isInteger(setting.minutes) &&
        setting.minutes >= 1 &&
        setting.minutes <= 15
      )
        this.setting = setting;
      this.exportState = await this.options.disk.readExportState();
      if (this.exportState.current) {
        this.code = "unknown_blocked";
        this.cleanupPending = true;
      }
      if (!this.setting.enabled) {
        // No creation/key access on a clean default-off profile. Adapter cleanup is bounded.
        await this.cleanupOwned();
      } else if (this.productionEnabled) {
        this.startTimer();
        const now = this.now();
        if (!now) await this.maintainHistory(undefined);
        if (!now) throw new Error("age_uncertain");
        // An unresolved export prevents new capture/promotion, not expiry of
        // existing recovery history. Maintenance creates no history authority.
        if (this.exportState.current) {
          await this.maintainHistory(now);
        }
        if (!this.exportState.current) {
          this.previousAvailable = await this.options.disk.open(now);
          if (epoch !== this.epoch || !this.setting.enabled) {
            this.previousAvailable = false;
            return;
          }
          this.ring = this.newRing();
          if (!this.ring.start()) throw new Error("age_uncertain");
          this.ageUncertain = false;
          this.code = "ready";
          this.startTimer();
        }
      } else if (!this.exportState.current) this.code = "unavailable";
    } catch {
      this.code = this.exportState.current ? "unknown_blocked" : this.ageUncertain ? "age_uncertain" : "unavailable";
      this.cleanupPending = true;
    } finally {
      this.busy = false;
      this.initialized = true;
      this.emit();
    }
  }
  status(): DiagnosticsStatus {
    const now = this.now();
    this.checkPreview(now);
    return {
      enabled: this.setting.enabled,
      productionEnabled: this.productionEnabled,
      scopeVersion: DIAGNOSTICS_SCOPE,
      minutes: this.setting.minutes,
      code: this.code,
      previous: this.setting.enabled && this.previousAvailable,
      ...(this.lastCheckpoint && now && this.lastCheckpoint.bootId === now.bootId
        ? { checkpointAgeMs: now.elapsedMs - this.lastCheckpoint.elapsedMs }
        : {}),
      tailLossPossible: true,
      cleanupPending: this.cleanupPending,
      ...(this.exportState.current ? { unknownOperation: this.exportState.current.id } : {}),
      acknowledgedUnknown: this.exportState.summary !== undefined,
      olderUnknowns: this.exportState.summary?.olderUnknowns ?? false,
      payloadReservedBytes: this.payloadReservedBytes,
      ...(this.lastSaveOutcome
        ? { lastSaveOutcome: this.lastSaveOutcome, saveAdmittedBeforeRevocation: this.saveAdmittedBeforeRevocation }
        : {}),
      ...(this.preview ? { activePreviewHandle: this.preview.handle } : {}),
    };
  }
  async setEnabled(enabled: boolean, scopeVersion: number): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    if (typeof enabled !== "boolean" || scopeVersion !== DIAGNOSTICS_SCOPE) return failure("refused");
    // Immediate logical revocation precedes ALL awaits, including an outstanding native call.
    if (!enabled) {
      this.setting = { ...this.setting, enabled: false };
      this.revokeAuthority();
      this.cleanupPending = true;
      this.code = this.liveExport ? "publication_pending" : "cleanup_pending";
      this.emit();
      // Disabled setting may be queued in the disk adapter behind already-dispatched work;
      // never report durable off/cleanup success until the write actually completes.
      const write = this.persistDisabled();
      const result = await this.bound(
        write.then(
          () => success(true),
          () => failure<boolean>("cleanup_pending"),
        ),
        "cleanup_pending",
        () => {
          this.cleanupPending = true;
          this.emit();
        },
      );
      if (!result.ok) return failure("cleanup_pending");
      if (this.busy) return success(this.status());
      return this.mutate(async () => {
        await this.cleanupOwned();
      });
    }
    await this.initialize();
    if (this.setting.enabled) return success(this.status());
    return this.mutate(async () => {
      await this.cleanupOwned();
      if (this.exportState.current || this.cleanupPending) throw new Error("cleanup_pending");
      const epoch = this.epoch;
      const next = { ...this.setting, enabled: true, scopeVersion: DIAGNOSTICS_SCOPE };
      await this.options.disk.writeSetting(next);
      if (epoch !== this.epoch) {
        await this.options.disk.writeSetting({ ...next, enabled: false });
        throw new Error("off");
      }
      this.setting = next;
      this.epoch++;
      if (!this.productionEnabled) {
        this.code = "unavailable";
        return;
      }
      const now = this.now();
      this.startTimer();
      if (!now) await this.maintainHistory(undefined);
      if (!now) throw new Error("age_uncertain");
      const openEpoch = this.epoch;
      this.previousAvailable = await this.options.disk.open(now);
      if (openEpoch !== this.epoch || !this.setting.enabled) {
        this.previousAvailable = false;
        return;
      }
      this.ring = this.newRing();
      if (!this.ring.start()) throw new Error("age_uncertain");
      this.ageUncertain = false;
      this.code = "ready";
      this.startTimer();
    });
  }
  async setMinutes(minutes: number): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 15) return failure("refused");
    await this.initialize();
    return this.mutate(async () => {
      const next = { ...this.setting, minutes };
      await this.options.disk.writeSetting(next);
      this.setting = { ...this.setting, minutes };
      this.ring.setMinutes(minutes);
    });
  }
  record(phase: DiagnosticPhase, code: DiagnosticCode): boolean {
    try {
      return this.initialized && this.setting.enabled && this.productionEnabled && this.ring.record(phase, code);
    } catch {
      return false;
    }
  }
  async checkpoint(): Promise<void> {
    if (!this.authorized() || this.busy || this.cleanupPending || this.exportState.current) return;
    await this.mutate(async () => {
      const epoch = this.epoch;
      const anchor = this.now();
      if (!anchor) await this.maintainHistory(undefined);
      if (!anchor) throw new Error("age_uncertain");
      this.previousAvailable = await this.maintainHistory(anchor);
      if (!this.authorized(epoch)) return;
      const snapshot = this.ring.snapshot();
      if (!snapshot) throw new Error("unavailable");
      this.reserve(3 * RECOVERY_LIMITS.exportBytes);
      try {
        const bytes = Buffer.from(snapshot.json);
        await this.options.disk.checkpoint(bytes, anchor, () => this.authorized(epoch));
        if (this.authorized(epoch)) this.lastCheckpoint = anchor;
      } finally {
        this.release(3 * RECOVERY_LIMITS.exportBytes);
      }
    });
  }
  async preparePreview(source: "current" | "previous"): Promise<DiagnosticsResult<DiagnosticPreview>> {
    await this.initialize();
    if (source !== "current" && source !== "previous") return failure("refused");
    if (!this.authorized()) return failure(this.setting.enabled ? "unavailable" : "off");
    if (this.busy || this.preview || this.retiredPreview) return failure("publication_pending");
    this.reserve(4 * RECOVERY_LIMITS.exportBytes);
    this.busy = true;
    const epoch = this.epoch;
    const work = (async (): Promise<DiagnosticsResult<DiagnosticPreview>> => {
      try {
        const now = this.now();
        if (!now) {
          await this.maintainHistory(undefined).catch(() => {
            this.cleanupPending = true;
          });
          return failure("age_uncertain");
        }
        let bytes: Buffer;
        let deadline = now.elapsedMs + RECOVERY_LIMITS.previewMs;
        if (source === "previous") {
          const old = await this.options.disk.previous(now);
          if (!old) {
            this.previousAvailable = false;
            return failure("expired");
          }
          if (
            !old ||
            old.anchor.bootId !== now.bootId ||
            old.anchor.elapsedMs > now.elapsedMs ||
            now.elapsedMs - old.anchor.elapsedMs >= RECOVERY_LIMITS.retentionMs
          )
            return failure("expired");
          deadline = Math.min(deadline, old.anchor.elapsedMs + RECOVERY_LIMITS.retentionMs);
          bytes = validateDiagnosticReport(old.bytes, true);
        } else {
          const snapshot = this.ring.snapshot();
          if (!snapshot) return failure("unavailable");
          bytes = validateDiagnosticReport(Buffer.from(snapshot.json));
        }
        const after = this.now();
        if (
          !this.authorized(epoch) ||
          !after ||
          after.bootId !== now.bootId ||
          after.elapsedMs >= deadline ||
          after.elapsedMs - now.elapsedMs > RECOVERY_LIMITS.prepareMs
        )
          return failure("stale_preview");
        this.preview = {
          handle: randomUUID(),
          epoch,
          bytes,
          digest: digest(bytes),
          source,
          boot: now.bootId,
          deadline,
        };
        this.previewTimer = setTimeout(
          () => {
            this.dropPreview();
            this.emit();
          },
          Math.max(1, deadline - after.elapsedMs),
        );
        this.previewTimer.unref?.();
        return success({
          handle: this.preview.handle,
          text: bytes.toString("utf8"),
          byteLength: bytes.length,
          source,
          expiresInMs: deadline - after.elapsedMs,
          tailLossPossible: source === "previous",
        });
      } catch {
        if (source === "previous") this.previousAvailable = false;
        return failure("unavailable");
      } finally {
        this.release(4 * RECOVERY_LIMITS.exportBytes);
        if (this.preview) {
          this.reserve(2 * RECOVERY_LIMITS.exportBytes);
          this.previewCharged = true;
        }
        this.busy = false;
        this.emit();
      }
    })();
    return this.bound(work, "unavailable", () => {
      this.revokePreviewAuthority();
    });
  }
  async closePreview(handle: string): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    if (this.preview?.handle === handle) this.dropPreview();
    if (this.retiredPreview === handle) this.releaseRetiredPreview();
    this.emit();
    return success(this.status());
  }
  async chooseDestination(handle: string): Promise<DiagnosticsResult<DiagnosticDestination>> {
    const preview = this.currentPreview(handle);
    if (!preview) return failure("stale_preview");
    if (this.busy || this.exportState.current)
      return failure(this.exportState.current ? this.code : "publication_pending");
    this.busy = true;
    this.destination = undefined;
    const work = (async (): Promise<DiagnosticsResult<DiagnosticDestination>> => {
      try {
        const path = await this.options.chooseDestination?.();
        if (!path) return failure("refused");
        if (
          path.length > 4096 ||
          !this.currentPreview(handle) ||
          !(await this.options.disk.validateDestination(path)) ||
          !this.currentPreview(handle)
        )
          return failure("refused");
        this.destination = { path, handle, token: randomUUID(), epoch: this.epoch };
        return success({ token: this.destination.token, displayPath: path });
      } catch {
        return failure("refused");
      } finally {
        this.busy = false;
        this.emit();
      }
    })();
    return this.bound(work, "refused", () => {
      this.destination = undefined;
      this.revokePreviewAuthority();
    });
  }
  save(handle: string, destinationToken: string): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    if (this.saveOperation?.handle === handle && this.saveOperation.token === destinationToken)
      return this.saveOperation.promise;
    const preview = this.currentPreview(handle);
    const destination = this.destination;
    if (
      !preview ||
      !destination ||
      destination.token !== destinationToken ||
      destination.handle !== handle ||
      destination.epoch !== this.epoch
    )
      return Promise.resolve(failure("stale_preview"));
    if (this.busy || this.exportState.current || this.cleanupPending) return Promise.resolve(failure(this.code));
    const promise = this.doSave(preview, destination.path);
    this.saveOperation = { handle, token: destinationToken, promise };
    return promise;
  }
  private async doSave(preview: Preview, path: string): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    this.busy = this.liveExport = true;
    this.reserve(RECOVERY_LIMITS.exportBytes);
    const id = randomUUID();
    // Outcomes belong to this operation alone. An earlier known result cannot
    // turn a new admitted-but-unresolved publication into a completed operation.
    this.lastSaveOutcome = undefined;
    this.saveAdmittedBeforeRevocation = false;
    this.destination = undefined;
    const epoch = this.epoch;
    const work = (async (): Promise<DiagnosticsResult<DiagnosticsStatus>> => {
      let dispatched = false;
      try {
        if (!(await this.options.disk.validateDestination(path)) || !this.currentPreview(preview.handle))
          return failure("refused");
        this.exportState = { ...this.exportState, current: { id, phase: "intent" } };
        await this.options.disk.writeExportState(this.exportState);
        if (!this.currentPreview(preview.handle)) throw new Error("stale_preview");
        const stage = await this.options.disk.stageExport(id, preview.bytes);
        this.exportState.current = { id, stage, phase: "staged" };
        // Adapter has already recorded identity before plaintext. Persist dispatch intent
        // before the point of no return; a crash here stays conservatively unknown.
        await this.options.disk.writeExportState({ ...this.exportState, current: { id, stage, phase: "dispatched" } });
        this.exportState.current.phase = "dispatched";
        const result = await this.options.disk.publishStage(stage, path, () => {
          const admitted =
            this.authorized(epoch) &&
            this.currentPreview(preview.handle) !== undefined &&
            digest(preview.bytes) === preview.digest;
          if (admitted) {
            dispatched = true;
            this.code = "publication_pending";
            this.emit();
          }
          return admitted;
        });
        this.lastSaveOutcome = result;
        this.saveAdmittedBeforeRevocation = dispatched && !this.authorized(epoch);
        if (result === "unknown") {
          this.exportState.current.phase = "unknown";
          await this.options.disk.writeExportState(this.exportState);
          this.code = "unknown_blocked";
          this.cleanupPending = true;
        } else {
          await this.options.disk.clearStage(stage);
          const completed: ExportState = this.exportState.summary ? { summary: this.exportState.summary } : {};
          await this.options.disk.writeExportState(completed);
          this.exportState = completed;
          this.code = result === "saved" ? "saved" : "refused";
          this.cleanupPending = false;
        }
      } catch {
        if (this.exportState.current?.id === id) {
          this.code =
            this.lastSaveOutcome === "saved" || this.lastSaveOutcome === "refused"
              ? "cleanup_pending"
              : dispatched
                ? "unknown_blocked"
                : "cleanup_pending";
          if (dispatched && this.lastSaveOutcome !== "saved" && this.lastSaveOutcome !== "refused")
            this.lastSaveOutcome = "unknown";
          this.cleanupPending = true;
        } else this.code = "refused";
      } finally {
        this.liveExport = false;
        if (!this.setting.enabled) {
          try {
            await this.cleanupOwned();
          } catch {
            this.cleanupPending = true;
          }
        }
        this.release(RECOVERY_LIMITS.exportBytes);
        this.busy = false;
        this.emit();
      }
      return success(this.status());
    })();
    return this.bound(work, "publication_pending", () => {
      if (this.lastSaveOutcome === "saved" || this.lastSaveOutcome === "refused") this.code = "cleanup_pending";
      else {
        this.code = "unknown_blocked";
        this.lastSaveOutcome = "unknown";
      }
      this.cleanupPending = true;
      // Work remains charged/busy until underlying completion; no new Save/ack.
      this.emit();
    });
  }
  async acknowledgeUnknown(id: string): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) return failure("refused");
    await this.initialize();
    if (this.exportState.summary?.id === id) return success(this.status());
    if (this.exportState.current?.id !== id || this.liveExport || this.busy) return failure("unknown_blocked");
    return this.mutate(async () => {
      await this.resolveOldStage();
      if (this.exportState.current?.id !== id || this.liveExport) throw new Error("unknown_blocked");
      const next: ExportState = {
        summary: { id, outcome: "unknown", acknowledged: true, olderUnknowns: this.exportState.summary !== undefined },
      };
      // Commit OLD proof before dropping its slot/reservation. No picker or save occurs.
      await this.options.disk.writeExportState(next);
      this.exportState = next;
      this.cleanupPending = false;
      this.saveOperation = undefined;
      this.code = "acknowledged_unknown";
      if (!this.setting.enabled) await this.cleanupOwned();
      else if (this.productionEnabled && !this.ring.enabled) {
        const epoch = this.epoch;
        const now = this.now();
        if (!now) throw new Error("age_uncertain");
        this.previousAvailable = await this.options.disk.open(now);
        if (epoch !== this.epoch || !this.setting.enabled) return;
        this.ring = this.newRing();
        if (!this.ring.start()) throw new Error("age_uncertain");
        this.ageUncertain = false;
        this.startTimer();
      }
    });
  }
  async retryCleanup(): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    await this.initialize();
    return this.mutate(async () => {
      if (this.exportState.current) {
        if (!this.setting.enabled && this.disableFailed) await this.persistDisabled();
        await this.resolveOldStage();
        if (this.lastSaveOutcome === "saved" || this.lastSaveOutcome === "refused") {
          const next: ExportState = this.exportState.summary ? { summary: this.exportState.summary } : {};
          await this.options.disk.writeExportState(next);
          this.exportState = next;
          this.cleanupPending = false;
          this.code = this.lastSaveOutcome;
          if (!this.setting.enabled) await this.cleanupOwned();
        } else {
          this.code = "unknown_ready";
        }
        // Unknown obligations remain until explicit acknowledgement, even after opt-out.
      } else if (!this.setting.enabled) {
        if (this.disableFailed) await this.persistDisabled();
        await this.cleanupOwned();
      } else {
        const now = this.now();
        if (!this.productionEnabled) throw new Error("unavailable");
        this.previousAvailable = await this.maintainHistory(now);
        await this.options.disk.clearStage();
        this.cleanupPending = false;
        this.code = this.ring.enabled ? "ready" : "unavailable";
      }
    });
  }
  async discardPrevious(): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    await this.initialize();
    if (this.preview?.source === "previous") this.dropPreview();
    this.previousAvailable = false;
    this.emit();
    return this.mutate(async () => {
      await this.options.disk.discardPrevious();
    });
  }
  revokePreviewAuthority(): void {
    this.epoch++;
    this.dropPreview();
    this.emit();
  }
  revokeAuthority(): void {
    this.options.disk.revoke();
    this.revokePreviewAuthority();
    this.ring.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.emit();
  }
  async cleanExit(): Promise<void> {
    this.revokeAuthority();
    if (this.busy) {
      this.cleanupPending = true;
      return;
    }
    await this.mutate(async () => {
      await this.options.disk.cleanExit();
    });
  }
  private persistDisabled(): Promise<void> {
    if (this.disableWrite) return this.disableWrite;
    this.disableFailed = true;
    const write = (async () => {
      // Logical revocation has already happened. Read the serialized setting
      // before persisting off so startup/a completed minutes change cannot be
      // replaced with the constructor's default retention preference.
      const persisted = await this.options.disk.readSetting();
      const next = { ...this.setting, minutes: persisted.minutes, enabled: false };
      await this.options.disk.writeSetting(next);
      if (!this.setting.enabled) this.setting = { ...this.setting, minutes: next.minutes };
    })();
    this.disableWrite = write;
    void write.then(
      () => {
        this.disableFailed = false;
        if (this.disableWrite === write) this.disableWrite = undefined;
      },
      () => {
        if (this.disableWrite === write) this.disableWrite = undefined;
      },
    );
    return write;
  }
  private async cleanupOwned(): Promise<void> {
    this.previousAvailable = false;
    if (!this.setting.enabled && this.disableWrite) await this.disableWrite;
    if (!this.setting.enabled && this.disableFailed) throw new Error("cleanup_pending");
    await this.options.disk.cleanup();
    if (this.exportState.current) {
      await this.resolveOldStage();
      this.code =
        this.lastSaveOutcome === "saved" || this.lastSaveOutcome === "refused" ? "cleanup_pending" : "unknown_ready";
      this.cleanupPending = true;
      return;
    }
    await this.options.disk.clearStage();
    // Decision 9: only completed cleanup permits dropping acknowledged summaries.
    if (this.exportState.summary) {
      await this.options.disk.writeExportState({});
      this.exportState = {};
    }
    this.cleanupPending = false;
    this.code = "off";
  }
  private async resolveOldStage(): Promise<void> {
    if (this.liveExport || !(await this.options.disk.writersStopped())) throw new Error("unknown_blocked");
    const persisted = await this.options.disk.readExportState();
    if (!persisted.current || persisted.current.id !== this.exportState.current?.id) throw new Error("unknown_blocked");
    await this.options.disk.clearStage(persisted.current.stage);
    this.exportState = persisted;
  }
  private async mutate(run: () => Promise<void>): Promise<DiagnosticsResult<DiagnosticsStatus>> {
    if (this.busy || this.disableWrite) return failure(this.liveExport ? "publication_pending" : "cleanup_pending");
    this.busy = true;
    const work = (async (): Promise<DiagnosticsResult<DiagnosticsStatus>> => {
      try {
        await run();
        return success(this.status());
      } catch {
        this.cleanupPending = true;
        this.code = this.exportState.current
          ? "unknown_blocked"
          : this.ageUncertain
            ? "age_uncertain"
            : "cleanup_pending";
        return failure(this.code);
      } finally {
        this.busy = false;
        this.emit();
      }
    })();
    return this.bound(work, "cleanup_pending", () => {
      this.cleanupPending = true;
      this.code = "cleanup_pending";
      this.emit();
    });
  }
  private async bound<T>(
    work: Promise<DiagnosticsResult<T>>,
    code: DiagnosticResultCode,
    timedOut: () => void,
  ): Promise<DiagnosticsResult<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DiagnosticsResult<T>>((resolve) => {
      timer = setTimeout(() => {
        timedOut();
        resolve(failure(code));
      }, this.timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private authorized(epoch = this.epoch): boolean {
    return this.setting.enabled && this.productionEnabled && epoch === this.epoch && this.ring.enabled;
  }
  private currentPreview(handle: string): Preview | undefined {
    this.checkPreview(this.now());
    return this.preview?.handle === handle && this.authorized(this.preview.epoch) ? this.preview : undefined;
  }
  private checkPreview(now: BootReading | undefined): void {
    if (
      this.preview &&
      (!now ||
        now.bootId !== this.preview.boot ||
        now.elapsedMs >= this.preview.deadline ||
        !this.authorized(this.preview.epoch))
    )
      this.dropPreview();
  }
  private dropPreview(): void {
    if (this.preview) {
      this.retiredPreview = this.preview.handle;
      if (this.previewCharged) {
        this.release(RECOVERY_LIMITS.exportBytes);
        this.retiredPreviewCharged = true;
      }
    }
    this.previewCharged = false;
    this.preview = undefined;
    this.destination = undefined;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
  }
  /** Called only by main after verified old document/process disposal, never renderer IPC. */
  rendererDisposed(): void {
    this.dropPreview();
    this.releaseRetiredPreview();
    this.emit();
  }
  private releaseRetiredPreview(): void {
    if (this.retiredPreviewCharged) this.release(RECOVERY_LIMITS.exportBytes);
    this.retiredPreviewCharged = false;
    this.retiredPreview = undefined;
  }
  private newRing(): PretriggerBuffer {
    return new PretriggerBuffer({
      minutes: this.setting.minutes,
      now: () => {
        const now = this.now();
        return now?.elapsedMs ?? NaN;
      },
    });
  }
  private now(): BootReading | undefined {
    try {
      const next = this.options.clock.read();
      if (
        !validReading(next) ||
        (this.reading && (next.bootId !== this.reading.bootId || next.elapsedMs < this.reading.elapsedMs))
      )
        return undefined;
      // Native adapters may reuse a mutable reading object. Anchors and prior
      // readings must keep their original scalar values across async work.
      this.reading = { bootId: next.bootId, elapsedMs: next.elapsedMs };
      return this.reading;
    } catch {
      return undefined;
    }
  }
  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, RECOVERY_LIMITS.checkpointMs);
    this.timer.unref?.();
  }
  private async tick(): Promise<void> {
    // Expiry is independent of opening a preview or a pending cleanup/export.
    // Keep one mutation in flight; a stalled adapter remains visible and fenced.
    if (!this.setting.enabled || !this.productionEnabled || this.busy) return;
    await this.mutate(async () => {
      const epoch = this.epoch;
      const now = this.now();
      const previous = await this.maintainHistory(now);
      if (epoch === this.epoch && this.setting.enabled) this.previousAvailable = previous;
    });
    await this.checkpoint();
  }
  private async maintainHistory(now: BootReading | undefined): Promise<boolean> {
    if (!now) {
      this.ageUncertain = true;
      this.previousAvailable = false;
      this.ring.stop();
      this.revokePreviewAuthority();
    }
    const previous = await this.options.disk.maintain(now);
    if (!now) throw new Error("age_uncertain");
    return previous;
  }
  private reserve(bytes: number): void {
    if (this.payloadReservedBytes + bytes > RECOVERY_LIMITS.payloadBytes) throw new Error("capacity_limited");
    this.payloadReservedBytes += bytes;
  }
  private release(bytes: number): void {
    this.payloadReservedBytes -= bytes;
  }
  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        /* UI failure has no execution effect. */
      }
    }
  }
}
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
